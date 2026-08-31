"use strict";

/**
 * Командная строка анализатора: `rsl-plus check`.
 *
 * Она отвечает только за анализ переданных файлов и за разбираемый ответ. Ни
 * Git, ни история, ни сравнение ревизий сюда не входят: этим занимается тот,
 * кто вызывает команду, и решение о судьбе изменений принимает он же — потому
 * и коды возврата не зависят от находок.
 *
 * Проверяется поведение, а не умение Node запустить файл: вызывается тот же
 * runRslCli, который зовёт тонкий файл в bin.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const url = require("url");

const serverModulePath = require.resolve("../server/out/server");

require.cache[serverModulePath] = {
    id: serverModulePath,
    filename: serverModulePath,
    loaded: true,
    exports: {
        getTree: () => [],
        GetFileByNameRequest: () => undefined
    }
};

const { runRslCli } = require("../server/out/cli/main");
const {
    RSL_CHECK_EXIT
} = require("../server/out/cli/checkCommand");
const {
    rslPathFromUri
} = require("../server/out/analysis/projectAnalysis");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

/*
 * Путь из URI обязан остаться абсолютным.
 *
 * Проверка выглядит формальной, но ловит настоящую ошибку, которую на Windows
 * не видно через файловую систему. Ручное срезание `file:///` уносило вместе с
 * ним корень: `file:///tmp/lib.mac` превращался в `tmp/lib.mac`, и на Linux
 * зависимость искалась относительно текущего каталога. На Windows та же
 * строка давала `d:/lib.mac` и работала, поэтому полный набор здесь молчал, а
 * на Linux падал.
 */
test("путь из URI остаётся абсолютным", () => {
    /*
     * Разбор URI по правилам POSIX — явно, а не «как получится на этой
     * машине». Иначе проверка молчала бы на Windows: `file:///d:/lib.mac`
     * даёт годный путь даже при неверном разборе.
     */
    assert.strictEqual(
        url.fileURLToPath("file:///tmp/project/lib.mac", { windows: false }),
        "/tmp/project/lib.mac",
        "корень пути обязан сохраниться"
    );

    /* Круговой путь на своей платформе: то, чем ядро пользуется на деле. */
    const sample = path.resolve(os.tmpdir(), "проект каталог", "lib.mac");

    assert.strictEqual(
        rslPathFromUri(url.pathToFileURL(sample).toString()),
        sample,
        "пробелы и не-ASCII обязаны пережить дорогу туда и обратно"
    );
    assert.ok(path.isAbsolute(rslPathFromUri(
        url.pathToFileURL(sample).toString()
    )));
});

/** Проект на диске: контекст, зависимости и проверяемые файлы. */
async function createProject(files) {
    const directory = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "rsl-cli-")
    );

    for (const [name, content] of Object.entries(files)) {
        const target = path.join(directory, name);

        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, content, "utf8");
    }

    return directory;
}

/** Запуск команды: stdout и stderr раздельно, как в настоящем процессе. */
function run(argv, cwd) {
    const stdout = [];
    const stderr = [];
    const code = runRslCli(argv, cwd || process.cwd(), {
        stdout: line => stdout.push(line),
        stderr: line => stderr.push(line)
    });

    return { code, stdout, stderr, out: stdout.join("\n") };
}

const BASIC = {
    "common.mac": "Macro Shared(value)\n  return value;\nEnd;\n",
    "src/payment.mac": [
        "Import common;",
        "",
        "Macro Pay()",
        "  Var amount = 0;",
        "  amount = amount;",
        "  return Shared(amount);",
        "End;",
        ""
    ].join("\n"),
    "src/clean.mac": "Macro Clean()\n  return 1;\nEnd;\n"
};

/* ─────────────────────────────── интерфейс ─────────────────────────────── */

test("один файл и несколько файлов", async () => {
    const project = await createProject(BASIC);

    try {
        const single = run([
            "check", "--context", project, "src/payment.mac"
        ]);

        assert.strictEqual(single.code, RSL_CHECK_EXIT.ok);
        assert.ok(
            single.out.includes("src/payment.mac"),
            "проверенный файл обязан быть в ответе: " + single.out
        );

        const both = run([
            "check", "--context", project,
            "src/payment.mac", "src/clean.mac"
        ]);

        assert.ok(
            both.out.includes("Итого: файлов 2"),
            "оба файла обязаны попасть в итог: " + both.out
        );
        assert.ok(
            !both.out.includes("src/clean.mac"),
            "чистый файл с полным контекстом не выводится: " + both.out
        );
    } finally {
        await fs.promises.rm(project, { recursive: true, force: true });
    }
});

test("порядок аргументов и дубли не меняют ответ", async () => {
    const project = await createProject(BASIC);

    try {
        const forward = run([
            "check", "--context", project, "--format", "jsonl",
            "src/payment.mac", "src/clean.mac"
        ]);
        const backward = run([
            "check", "--context", project, "--format", "jsonl",
            "src/clean.mac", "src/payment.mac"
        ]);
        const duplicated = run([
            "check", "--context", project, "--format", "jsonl",
            "src/payment.mac", "src/clean.mac", "src/payment.mac"
        ]);

        assert.strictEqual(
            backward.out,
            forward.out,
            "порядок аргументов не имеет права менять ответ"
        );
        assert.strictEqual(
            duplicated.out,
            forward.out,
            "повторённый файл не имеет права удвоить ответ"
        );
    } finally {
        await fs.promises.rm(project, { recursive: true, force: true });
    }
});

test("абсолютные пути, относительные и пробелы в именах", async () => {
    const project = await createProject({
        ...BASIC,
        "с пробелом/оплата счёта.mac":
            "Macro Spaced()\n  Var v = 1;\n  v = v;\n  return v;\nEnd;\n"
    });

    try {
        const relative = run([
            "check", "--context", project, "src/payment.mac"
        ]);
        const absolute = run([
            "check", "--context", project,
            path.join(project, "src", "payment.mac")
        ]);

        assert.strictEqual(
            absolute.out,
            relative.out,
            "абсолютный путь обязан дать тот же ответ"
        );

        const spaced = run([
            "check", "--context", project, "с пробелом/оплата счёта.mac"
        ]);

        assert.ok(
            spaced.out.includes("с пробелом/оплата счёта.mac"),
            "путь с пробелами обязан работать: " + spaced.out
        );
    } finally {
        await fs.promises.rm(project, { recursive: true, force: true });
    }
});

test("отказы: без контекста, без файлов, вне контекста, чужой параметр", async () => {
    const project = await createProject(BASIC);

    try {
        for (const [what, argv] of [
            ["без --context", ["check", "src/payment.mac"]],
            ["без файлов", ["check", "--context", project]],
            [
                "файл вне контекста",
                ["check", "--context", project, "../снаружи.mac"]
            ],
            [
                "неизвестный параметр",
                ["check", "--context", project, "--что-то", "src/payment.mac"]
            ],
            [
                "summary вместе с jsonl",
                [
                    "check", "--context", project, "--summary",
                    "--format", "jsonl", "src/payment.mac"
                ]
            ]
        ]) {
            const result = run(argv);

            assert.strictEqual(
                result.code,
                RSL_CHECK_EXIT.badArguments,
                what + ": обязан быть код неверных аргументов"
            );
            assert.strictEqual(
                result.stdout.length,
                0,
                what + ": в stdout не имеет права попасть ничего"
            );
            assert.ok(
                result.stderr.length > 0,
                what + ": причина обязана уйти в stderr"
            );
        }
    } finally {
        await fs.promises.rm(project, { recursive: true, force: true });
    }
});

test("нечитаемый проверяемый файл даёт свой код", async () => {
    const project = await createProject(BASIC);

    try {
        const result = run([
            "check", "--context", project, "src/нет-такого.mac"
        ]);

        assert.strictEqual(result.code, RSL_CHECK_EXIT.unreadableFile);
        assert.strictEqual(
            result.stdout.length,
            0,
            "в stdout не имеет права попасть ничего"
        );
    } finally {
        await fs.promises.rm(project, { recursive: true, force: true });
    }
});

/* ──────────────────────────────── контекст ─────────────────────────────── */

test("зависимости грузятся, но их сообщения не публикуются", async () => {
    const project = await createProject({
        /* В зависимости своя ошибка: она не имеет права попасть в ответ. */
        "common.mac": [
            "Macro Shared(value)",
            "  Var own = 1;",
            "  own = own;",
            "  return value;",
            "End;",
            ""
        ].join("\n"),
        "src/payment.mac": [
            "Import common;",
            "",
            "Macro Pay()",
            "  return Shared(1);",
            "End;",
            ""
        ].join("\n")
    });

    try {
        const result = run([
            "check", "--context", project, "--format", "jsonl",
            "src/payment.mac"
        ]);
        const records = result.stdout.map(line => JSON.parse(line));

        assert.ok(
            records.every(record =>
                record.record === "run" ||
                record.record === "summary" ||
                record.file === "src/payment.mac"),
            "в ответе обязан быть только проверяемый файл: " + result.out
        );
        assert.ok(
            !result.out.includes("common.mac"),
            "сообщения зависимости не публикуются: " + result.out
        );
    } finally {
        await fs.promises.rm(project, { recursive: true, force: true });
    }
});

test("транзитивная и общая зависимость грузятся по разу", async () => {
    const project = await createProject({
        "deep.mac": "Macro Deep()\n  return 1;\nEnd;\n",
        "middle.mac": "Import deep;\nMacro Middle()\n  return Deep();\nEnd;\n",
        "src/first.mac":
            "Import middle;\nMacro First()\n  return Middle();\nEnd;\n",
        "src/second.mac":
            "Import middle;\nMacro Second()\n  return Middle();\nEnd;\n"
    });

    try {
        const result = run([
            "check", "--context", project, "--format", "jsonl",
            "src/first.mac", "src/second.mac"
        ]);
        const loaded = result.stderr.find(line =>
            line.startsWith("Загружено зависимостей"));

        assert.ok(loaded, "число загруженных зависимостей обязано быть в stderr");
        /* Два проверяемых плюс middle и deep — по одному разу каждый. */
        assert.ok(
            /Загружено зависимостей: 4$/u.test(loaded),
            "общая зависимость грузится один раз: " + loaded
        );

        for (const record of result.stdout.map(line => JSON.parse(line))) {
            if (record.record === "file") {
                assert.strictEqual(
                    record.status,
                    "complete",
                    record.file + ": контекст обязан быть полным"
                );
            }
        }
    } finally {
        await fs.promises.rm(project, { recursive: true, force: true });
    }
});

test("циклический импорт не зацикливает анализ", async () => {
    const project = await createProject({
        "a.mac": "Import b;\nMacro FromA()\n  return 1;\nEnd;\n",
        "b.mac": "Import a;\nMacro FromB()\n  return 1;\nEnd;\n",
        "src/main.mac": "Import a;\nMacro Run()\n  return FromA();\nEnd;\n"
    });

    try {
        const result = run([
            "check", "--context", project, "src/main.mac"
        ]);

        assert.strictEqual(result.code, RSL_CHECK_EXIT.ok);
    } finally {
        await fs.promises.rm(project, { recursive: true, force: true });
    }
});

test("отсутствующая и неоднозначная зависимость помечают контекст", async () => {
    const project = await createProject({
        "one/shared.mac": "Macro Shared()\n  return 1;\nEnd;\n",
        "two/shared.mac": "Macro Shared()\n  return 2;\nEnd;\n",
        "src/missing.mac":
            "Import нетакого;\nMacro Run()\n  return 1;\nEnd;\n",
        "src/ambiguous.mac":
            "Import shared;\nMacro Run()\n  return 1;\nEnd;\n"
    });

    try {
        const result = run([
            "check", "--context", project, "--format", "jsonl",
            "src/missing.mac", "src/ambiguous.mac"
        ]);

        assert.strictEqual(
            result.code,
            RSL_CHECK_EXIT.ok,
            "неполный контекст не имеет права менять код возврата"
        );

        const files = result.stdout
            .map(line => JSON.parse(line))
            .filter(record => record.record === "file");

        assert.strictEqual(files.length, 2);

        for (const file of files) {
            assert.strictEqual(
                file.status,
                "incomplete",
                file.file + ": контекст обязан быть неполным"
            );
            assert.ok(
                file.issues.length > 0,
                file.file + ": причина неполноты обязана быть названа"
            );
        }

        assert.ok(
            files.some(file => file.issues.some(issue =>
                issue.code === "ambiguous-import")),
            "неоднозначный импорт обязан быть назван своей причиной"
        );
    } finally {
        await fs.promises.rm(project, { recursive: true, force: true });
    }
});

test("объявление зависимости влияет на диагностику проверяемого файла", async () => {
    const withDependency = await createProject({
        "globals.mac": "Var SharedFlag;\n",
        /*
         * В области есть своё объявление: проверка необъявленного имени
         * включается только там, где автор вообще пользуется Var.
         */
        "src/main.mac": [
            "Import globals;",
            "Macro Run()",
            "  Var own = 0;",
            "  SharedFlag = own;",
            "  return own;",
            "End;",
            ""
        ].join("\n")
    });
    const without = await createProject({
        "src/main.mac": [
            "Macro Run()",
            "  Var own = 0;",
            "  SharedFlag = own;",
            "  return own;",
            "End;",
            ""
        ].join("\n")
    });

    try {
        const withDep = run([
            "check", "--context", withDependency, "--format", "jsonl",
            "src/main.mac"
        ]);
        const withoutDep = run([
            "check", "--context", without, "--format", "jsonl",
            "src/main.mac"
        ]);

        const codesOf = result => result.stdout
            .map(line => JSON.parse(line))
            .filter(record => record.record === "diagnostic")
            .map(record => record.code);

        assert.ok(
            codesOf(withoutDep).includes("undeclared-variable"),
            "без объявления имя обязано быть необъявленным: " + withoutDep.out
        );
        assert.ok(
            !codesOf(withDep).includes("undeclared-variable"),
            "объявление зависимости обязано снять сообщение: " + withDep.out
        );
    } finally {
        await fs.promises.rm(withDependency, {
            recursive: true,
            force: true
        });
        await fs.promises.rm(without, { recursive: true, force: true });
    }
});

/* ─────────────────────────── человекочитаемый ──────────────────────────── */

test("текстовый вывод компактен и считает верно", async () => {
    const project = await createProject(BASIC);

    try {
        const result = run([
            "check", "--context", project, "src/payment.mac"
        ]);
        const lines = result.stdout;

        assert.ok(
            lines.every(line => line.length > 0),
            "пустых строк быть не должно: " + JSON.stringify(lines)
        );
        assert.ok(
            !result.out.includes("END FILE"),
            "служебных разделителей быть не должно"
        );

        const header = lines[0];
        const body = lines.slice(1, -1);

        assert.ok(
            header.startsWith("src/payment.mac ("),
            "путь выводится один раз перед группой: " + header
        );
        assert.ok(
            body.every(line => line.startsWith("  ")),
            "каждая диагностика — одна строка с отступом: " +
                JSON.stringify(body)
        );
        assert.ok(
            body.every(line => /^ {2}\d+:\d+-\d+:\d+ [EWIH] \S+ — /u.test(line)),
            "строка диагностики обязана иметь один и тот же вид: " +
                JSON.stringify(body)
        );

        const total = lines[lines.length - 1];

        assert.ok(
            total.startsWith("Итого: файлов 1, сообщений " + body.length),
            "итог обязан совпадать с числом сообщений: " + total
        );
    } finally {
        await fs.promises.rm(project, { recursive: true, force: true });
    }
});

test("краткий режим не выводит отдельных сообщений", async () => {
    const project = await createProject(BASIC);

    try {
        const result = run([
            "check", "--context", project, "--summary",
            "src/payment.mac", "src/clean.mac"
        ]);

        assert.strictEqual(
            result.stdout.length,
            3,
            "строка на файл плюс итог: " + result.out
        );
        assert.ok(
            result.stdout.slice(0, 2).every(line =>
                /^\S.* — E:\d+ W:\d+ I:\d+ H:\d+$/u.test(line)),
            "краткий режим: строка на файл: " + result.out
        );
        assert.ok(
            result.stdout[0].startsWith("src/clean.mac") &&
            result.stdout[1].startsWith("src/payment.mac"),
            "файлы упорядочены по пути: " + result.out
        );
        assert.ok(
            !result.out.includes("self-assignment"),
            "отдельные сообщения в кратком режиме не выводятся"
        );
    } finally {
        await fs.promises.rm(project, { recursive: true, force: true });
    }
});

/* ───────────────────────────────── JSONL ───────────────────────────────── */

test("JSONL разбирается построчно и стабилен", async () => {
    const project = await createProject(BASIC);

    try {
        const first = run([
            "check", "--context", project, "--format", "jsonl",
            "src/payment.mac", "src/clean.mac"
        ]);
        const second = run([
            "check", "--context", project, "--format", "jsonl",
            "src/payment.mac", "src/clean.mac"
        ]);

        assert.strictEqual(
            second.out,
            first.out,
            "повторный запуск обязан дать тот же вывод"
        );

        const records = first.stdout.map(line => JSON.parse(line));

        assert.strictEqual(records[0].record, "run");
        assert.strictEqual(
            records[records.length - 1].record,
            "summary"
        );

        for (const record of records) {
            assert.strictEqual(record.schemaVersion, 1);
            assert.ok(record.record, "у записи обязан быть вид");
        }

        const files = records.filter(record => record.record === "file");

        assert.deepStrictEqual(
            files.map(record => record.file),
            ["src/clean.mac", "src/payment.mac"],
            "файлы упорядочены по пути, и чистый тоже присутствует"
        );

        for (const record of records.filter(item =>
            item.record === "diagnostic")) {
            assert.ok(record.file && record.code && record.message);
            assert.ok(
                typeof record.start.line === "number" &&
                typeof record.start.column === "number",
                "позиции обязаны быть числами"
            );
            assert.ok(
                !record.file.includes("\\") && !record.file.includes(":"),
                "путь обязан быть относительным и через прямую черту: " +
                    record.file
            );
        }

        const summary = records[records.length - 1];

        assert.strictEqual(summary.files, 2);
        assert.strictEqual(
            summary.errors + summary.warnings + summary.information +
                summary.hints,
            records.filter(item => item.record === "diagnostic").length,
            "счётчики итога обязаны сойтись с числом записей"
        );
    } finally {
        await fs.promises.rm(project, { recursive: true, force: true });
    }
});

test("кириллица и кавычки в сообщении не ломают строку", async () => {
    const project = await createProject({
        "src/quotes.mac": [
            "Macro Проверка()",
            "  Var значение = 1;",
            "  значение = значение;",
            "  return значение;",
            "End;",
            ""
        ].join("\n")
    });

    try {
        const result = run([
            "check", "--context", project, "--format", "jsonl",
            "src/quotes.mac"
        ]);

        for (const line of result.stdout) {
            const record = JSON.parse(line);

            assert.ok(record.record, "каждая строка разбирается отдельно");
        }

        const diagnostics = result.stdout
            .map(line => JSON.parse(line))
            .filter(record => record.record === "diagnostic");

        assert.ok(
            diagnostics.length > 0,
            "образец обязан давать сообщения: " + result.out
        );
        assert.ok(
            diagnostics.every(record => !record.message.includes("\n")),
            "сообщение не имеет права занимать несколько строк"
        );
    } finally {
        await fs.promises.rm(project, { recursive: true, force: true });
    }
});

/* ────────────────────────── независимость от Git ───────────────────────── */

test("в исходниках командной строки нет обращений к Git", () => {
    const directory = path.join(__dirname, "..", "server", "src", "cli");

    for (const name of fs.readdirSync(directory)) {
        /*
         * Комментарии снимаются: слово «Git» в пояснении — это как раз то, что
         * там должно быть написано, а искать надо вызовы.
         */
        const source = fs.readFileSync(path.join(directory, name), "utf8")
            .replace(/\/\*[\s\S]*?\*\//gu, " ")
            .replace(/\/\/[^\n]*/gu, " ");

        for (const forbidden of ["git", "child_process", "execSync", "spawn"]) {
            assert.ok(
                !new RegExp("\\b" + forbidden + "\\b", "iu").test(source),
                name + ": в командной строке не имеет права быть «" +
                    forbidden + "»"
            );
        }
    }
});

test("каталог без .git анализируется как обычный", async () => {
    const project = await createProject(BASIC);

    try {
        assert.ok(
            !fs.existsSync(path.join(project, ".git")),
            "в стенде не должно быть репозитория"
        );

        const result = run([
            "check", "--context", project, "src/payment.mac"
        ]);

        assert.strictEqual(result.code, RSL_CHECK_EXIT.ok);
        assert.ok(
            !/commit|branch|diff/iu.test(result.out),
            "в ответе не имеет права быть сведений о репозитории"
        );
    } finally {
        await fs.promises.rm(project, { recursive: true, force: true });
    }
});

(async () => {
    for (const item of tests) {
        try {
            await item.action();
            passed++;
            console.log("[OK] " + item.name);
        } catch (error) {
            failed++;
            console.error("[FAIL] " + item.name);
            console.error(error);
        }
    }

    console.log(
        failed === 0
            ? "\nПройдено: " + passed
            : "\nПройдено: " + passed + ", провалено: " + failed
    );

    if (failed > 0) {
        process.exitCode = 1;
    }
})();

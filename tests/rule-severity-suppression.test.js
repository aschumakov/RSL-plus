"use strict";

/**
 * Уровень правил и подавление комментариями.
 *
 * Настройка выключает правило во всём проекте, а нужно бывает иначе: одно
 * поднять, другое приглушить, третье погасить в одном месте, где так и
 * задумано. И то и другое обязано работать одинаково в редакторе и в
 * командной строке — иначе проверка перед отправкой изменений покажет не то,
 * что видел автор.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

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

const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const {
    RslDiagnosticEngine
} = require("../server/out/diagnostics/diagnosticEngine");
const {
    normalizeRslRuleSeverity
} = require("../server/out/diagnostics/ruleSeverity");
const { runRslCli } = require("../server/out/cli/main");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const URI = "file:///d:/rules/main.mac";

/** Диагностики файла через редакторный путь. */
function inEditor(source, settings) {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([URI]);

    const module = index.updateOpenModule(URI, source, 1);

    return new RslDiagnosticEngine().buildLocal(module, index, settings);
}

function codesOf(diagnostics) {
    return diagnostics.map(item => String(item.code)).sort();
}

function severityOf(diagnostics, code) {
    return diagnostics.find(item => item.code === code)?.severity;
}

const NOISY = [
    "Macro Run()",
    "  Var value = 1;",
    "  value = value;",
    "  return value;",
    "End;",
    ""
].join("\n");

/* ───────────────────────────── уровни правил ───────────────────────────── */

test("уровень правила меняется настройкой", () => {
    const base = inEditor(NOISY);

    assert.strictEqual(
        severityOf(base, "self-assignment"),
        2,
        "по умолчанию это предупреждение"
    );

    assert.strictEqual(
        severityOf(inEditor(NOISY, { rules: { "self-assignment": "error" } }),
            "self-assignment"),
        1,
        "error"
    );
    assert.strictEqual(
        severityOf(
            inEditor(NOISY, { rules: { "self-assignment": "information" } }),
            "self-assignment"
        ),
        3,
        "information"
    );
    assert.strictEqual(
        severityOf(inEditor(NOISY, { rules: { "self-assignment": "hint" } }),
            "self-assignment"),
        4,
        "hint"
    );
});

test("значение none убирает сообщение и из счётчиков", () => {
    const found = inEditor(NOISY, { rules: { "self-assignment": "none" } });

    assert.ok(
        !codesOf(found).includes("self-assignment"),
        "выключенное правило не публикуется: " + codesOf(found).join(", ")
    );
});

test("прежние галочки продолжают работать", () => {
    const off = inEditor(NOISY, { selfAssignment: false });

    assert.ok(
        !codesOf(off).includes("self-assignment"),
        "булева настройка по-прежнему выключает проверку"
    );
});

test("неизвестный код и уровень называются, а не применяются", () => {
    const problems = [];
    const rules = normalizeRslRuleSeverity(
        {
            "self-assignment": "error",
            "нет-такого": "warning",
            "unused-expression": "очень-важно"
        },
        message => problems.push(message)
    );

    assert.deepStrictEqual(
        rules,
        { "self-assignment": "error" },
        "применяется только понятное: " + JSON.stringify(rules)
    );
    assert.strictEqual(problems.length, 2, problems.join("; "));
    assert.ok(
        problems.some(item => item.includes("нет-такого")),
        "неизвестный код обязан быть назван"
    );
    assert.ok(
        problems.some(item => item.includes("очень-важно")),
        "неизвестный уровень обязан быть назван"
    );
});

/* ────────────────────────────── подавление ─────────────────────────────── */

test("rsl-disable-next-line гасит только следующую строку", () => {
    const source = [
        "Macro Run()",
        "  Var value = 1;",
        "  // rsl-disable-next-line self-assignment",
        "  value = value;",
        "  value = value;",
        "  return value;",
        "End;",
        ""
    ].join("\n");
    const found = inEditor(source)
        .filter(item => item.code === "self-assignment");

    assert.strictEqual(
        found.length,
        1,
        "погашена одна строка из двух: " + found.length
    );
    assert.strictEqual(
        found[0].range.start.line,
        4,
        "погашена именно следующая за директивой"
    );
});

test("несколько кодов в одной директиве и любые пробелы", () => {
    const source = [
        "Macro Run()",
        "  Var value = 1;",
        "  // rsl-disable-next-line  SELF-ASSIGNMENT ,  unused-expression",
        "  value = value;",
        "  return value;",
        "End;",
        ""
    ].join("\n");

    assert.ok(
        !codesOf(inEditor(source)).includes("self-assignment"),
        "регистр и пробелы вокруг запятых значения не имеют"
    );
});

test("rsl-disable и rsl-enable ограничивают участок", () => {
    const source = [
        "Macro Run()",
        "  Var value = 1;",
        "  // rsl-disable self-assignment",
        "  value = value;",
        "  value = value;",
        "  // rsl-enable self-assignment",
        "  value = value;",
        "  return value;",
        "End;",
        ""
    ].join("\n");
    const found = inEditor(source)
        .filter(item => item.code === "self-assignment");

    assert.strictEqual(
        found.length,
        1,
        "за пределами участка сообщение остаётся: " + found.length
    );
    assert.strictEqual(found[0].range.start.line, 6);
});

test("rsl-disable-file гасит весь файл", () => {
    const source = [
        "// rsl-disable-file self-assignment",
        "Macro Run()",
        "  Var value = 1;",
        "  value = value;",
        "  value = value;",
        "  return value;",
        "End;",
        ""
    ].join("\n");

    assert.ok(
        !codesOf(inEditor(source)).includes("self-assignment"),
        "директива файла гасит все вхождения"
    );
});

test("неизвестный код в директиве даёт подсказку", () => {
    const source = [
        "Macro Run()",
        "  // rsl-disable-next-line нет-такого-правила",
        "  Var value = 1;",
        "  return value;",
        "End;",
        ""
    ].join("\n");
    const notice = inEditor(source)
        .find(item => item.code === "unknown-suppression-code");

    assert.ok(notice, "о неизвестном коде обязана быть подсказка");
    assert.strictEqual(notice.severity, 3, "это подсказка, а не ошибка");
});

test("директива в строке директивой не является", () => {
    const source = [
        "Macro Run()",
        "  Var value = 1;",
        "  Var text = \"// rsl-disable-next-line self-assignment\";",
        "  value = value;",
        "  return text;",
        "End;",
        ""
    ].join("\n");

    assert.ok(
        codesOf(inEditor(source)).includes("self-assignment"),
        "текст внутри строки не имеет права гасить проверки"
    );
});

test("синтаксическую ошибку подавить нельзя", () => {
    const source = [
        "// rsl-disable-file missing-end",
        "Macro Run()",
        "  Var value = 1;",
        ""
    ].join("\n");

    assert.ok(
        codesOf(inEditor(source)).includes("missing-end"),
        "ошибку, мешающую построить модель, гасить нельзя: " +
            codesOf(inEditor(source)).join(", ")
    );
});

/* ───────────────────── одинаково в редакторе и в CLI ───────────────────── */

test("CLI и редактор применяют уровни и подавление одинаково", async () => {
    const directory = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "rsl-rules-")
    );

    try {
        const source = [
            "Macro Run()",
            "  Var value = 1;",
            "  // rsl-disable-next-line self-assignment",
            "  value = value;",
            "  value = value;",
            "  return value;",
            "End;",
            ""
        ].join("\n");

        await fs.promises.writeFile(
            path.join(directory, "main.mac"),
            source,
            "utf8"
        );
        await fs.promises.writeFile(
            path.join(directory, "rsl-plus.json"),
            JSON.stringify({
                diagnostics: { rules: { "self-assignment": "error" } }
            }),
            "utf8"
        );

        const stdout = [];

        runRslCli(
            ["check", "--context", directory, "--format", "jsonl", "main.mac"],
            process.cwd(),
            { stdout: line => stdout.push(line), stderr: () => undefined }
        );

        const fromCli = stdout
            .map(line => JSON.parse(line))
            .filter(record => record.record === "diagnostic")
            .map(record => record.code + "@" + record.start.line + ":" +
                record.severity);
        const fromEditor = inEditor(source, {
            rules: { "self-assignment": "error" }
        }).map(item => String(item.code) + "@" + item.range.start.line + ":" +
            ["error", "warning", "information", "hint"][item.severity - 1]);

        assert.deepStrictEqual(
            fromCli.sort(),
            fromEditor.sort(),
            "код, позиция и уровень обязаны совпасть"
        );
        assert.ok(
            fromCli.some(item => item.startsWith("self-assignment@4:error")),
            "уровень из настроек применён: " + fromCli.join(", ")
        );
        assert.ok(
            !fromCli.some(item => item.startsWith("self-assignment@3")),
            "подавленная строка не публикуется: " + fromCli.join(", ")
        );
    } finally {
        await fs.promises.rm(directory, { recursive: true, force: true });
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

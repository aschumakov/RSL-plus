"use strict";

/**
 * Поставка командной строки.
 *
 * Проверяется не «запускается ли CLI из рабочего дерева» — это делает
 * cli-check.test.js, — а «запустится ли он из того, что попадёт в пакет».
 * Разница оказалась настоящей: `bin/rsl-plus.js` требовал
 * `../server/out/cli/main`, а .vscodeignore оставляет в пакете из server/out
 * только entry-файлы. В рабочем дереве всё работало, из опубликованного
 * артефакта — нет.
 *
 * Поэтому bundle копируется ОДИН, в чужой каталог, и запускается там же:
 * если у него остались внешние зависимости, запуск это покажет.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const ROOT = path.join(__dirname, "..");
const BUNDLE = path.join(ROOT, "bin", "rsl-plus-cli.js");

/** Файлы, которые .vscodeignore оставляет в пакете. */
function packagedPatterns() {
    return fs.readFileSync(path.join(ROOT, ".vscodeignore"), "utf8")
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith("#"));
}

test("тонкий файл в bin не тянет исключённое из пакета", () => {
    const launcher = fs.readFileSync(
        path.join(ROOT, "bin", "rsl-plus.js"),
        "utf8"
    );
    const patterns = packagedPatterns();

    assert.ok(
        patterns.includes("server/out/**"),
        "проверка рассчитана на то, что server/out исключён целиком"
    );
    assert.ok(
        launcher.includes("rsl-plus-cli.js"),
        "запуск обязан предпочитать собранный рядом bundle"
    );
});

test("bundle командной строки собирается", async () => {
    const { buildRslBundle } = require("../build/bundle");
    const built = await buildRslBundle("cli");

    assert.strictEqual(built.file, "bin/rsl-plus-cli.js");
    assert.ok(built.bytes > 100000, "bundle обязан нести в себе анализ");
    assert.ok(fs.existsSync(BUNDLE), "файл обязан появиться на диске");
});

test("bundle работает в чужом каталоге сам по себе", async () => {
    if (!fs.existsSync(BUNDLE)) {
        await require("../build/bundle").buildRslBundle("cli");
    }

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rsl-package-"));

    try {
        /* Только bundle: ни node_modules, ни server/out рядом нет. */
        const copy = path.join(directory, "rsl-plus-cli.js");

        fs.copyFileSync(BUNDLE, copy);

        const project = path.join(directory, "project");
        const nested = path.join(project, "src");

        fs.mkdirSync(nested, { recursive: true });
        fs.writeFileSync(
            path.join(project, "common.mac"),
            "Macro Shared(value)\n  return value;\nEnd;\n",
            "utf8"
        );
        fs.writeFileSync(
            path.join(project, "middle.mac"),
            "Import common;\nMacro Middle()\n  return Shared(1);\nEnd;\n",
            "utf8"
        );
        fs.writeFileSync(
            path.join(nested, "entry.mac"),
            "Import middle;\nMacro Entry()\n  return Middle();\nEnd;\n",
            "utf8"
        );

        const launcher = path.join(directory, "run.js");

        fs.writeFileSync(
            launcher,
            "require(\"./rsl-plus-cli.js\").runRslCliProcess();\n",
            "utf8"
        );

        const output = execFileSync(
            process.execPath,
            [
                launcher, "check",
                "--context", project,
                "--summary",
                "src/entry.mac"
            ],
            { cwd: directory, encoding: "utf8", stdio: "pipe" }
        );

        assert.ok(
            output.includes("Итого: файлов 1"),
            "bundle обязан отработать сам по себе: " + output
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("прямая и транзитивная зависимость грузятся из пакета", async () => {
    if (!fs.existsSync(BUNDLE)) {
        await require("../build/bundle").buildRslBundle("cli");
    }

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rsl-package-"));

    try {
        fs.writeFileSync(
            path.join(directory, "deep.mac"),
            "Macro Deep()\n  return 1;\nEnd;\n",
            "utf8"
        );
        fs.writeFileSync(
            path.join(directory, "middle.mac"),
            "Import deep;\nMacro Middle()\n  return Deep();\nEnd;\n",
            "utf8"
        );
        fs.writeFileSync(
            path.join(directory, "entry.mac"),
            "Import middle;\nMacro Entry()\n  return Middle();\nEnd;\n",
            "utf8"
        );

        /*
         * Запуск из другого каталога — именно то, на чём ломался разбор URI:
         * зависимость искалась относительно текущего каталога, а не корня.
         */
        /* Раскладка как в пакете: тонкий файл и bundle рядом, больше ничего. */
        const binDirectory = path.join(directory, "bin");

        fs.mkdirSync(binDirectory, { recursive: true });
        fs.copyFileSync(BUNDLE, path.join(binDirectory, "rsl-plus-cli.js"));
        fs.copyFileSync(
            path.join(ROOT, "bin", "rsl-plus.js"),
            path.join(binDirectory, "rsl-plus.js")
        );

        /* Отчёт о зависимостях идёт в stderr: он про работу, а не про находки. */
        const spawned = require("child_process").spawnSync(
            process.execPath,
            [
                path.join(binDirectory, "rsl-plus.js"), "check",
                "--context", directory,
                "--summary",
                path.join(directory, "entry.mac")
            ],
            { cwd: os.tmpdir(), encoding: "utf8" }
        );
        const result = spawned.stdout + spawned.stderr;

        assert.strictEqual(spawned.status, 0, "команда обязана отработать");
        /* Три: сам проверяемый файл, прямая зависимость и транзитивная. */
        assert.ok(
            /Загружено зависимостей: 3/u.test(result),
            "обе зависимости обязаны загрузиться: " + result
        );
        assert.ok(
            !/неполный контекст: 1/u.test(result),
            "контекст обязан быть полным: " + result
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
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

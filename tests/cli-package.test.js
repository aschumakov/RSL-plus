"use strict";

/**
 * Поставка командной строки — по настоящему пакету.
 *
 * Проверяется не «запускается ли CLI из рабочего дерева» — это делает
 * cli-check.test.js, — а «запустится ли он из того, что уйдёт пользователю».
 * Разница дважды оказывалась настоящей, и оба раза рабочее дерево работало:
 *
 *   bin/rsl-plus.js требовал ../server/out/cli/main, а .vscodeignore оставляет
 *   в VSIX из server/out только entry-файлы;
 *
 *   у npm не было .npmignore, поэтому исключения он брал из .gitignore — а тот
 *   скрывает собранное. В tarball попадали 95 проверок и 149 исходников и ни
 *   одного собранного файла; распакованный пакет падал на Cannot find module.
 *
 * Поэтому здесь собирается настоящий tarball, распаковывается и запускается
 * package/bin/rsl-plus.js. Проверка списком файлов рядом: она работает даже
 * там, где нет tar.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { execFileSync, spawnSync } = require("child_process");

/*
 * npm на Windows — это npm.cmd, а .cmd без оболочки не запускается: spawnSync
 * отдаёт EINVAL. Поэтому вызовы npm идут через оболочку.
 */
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NPM_OPTIONS = { shell: process.platform === "win32" };

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const ROOT = path.join(__dirname, "..");

/** Каталог для временных файлов проверки. */
function scratch(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTree(directory) {
    fs.rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 25
    });
}

/**
 * Распаковать tarball средствами Node.
 *
 * Не внешним tar: GNU tar на Windows принимает `C:\...` за адрес удалённой
 * машины и отвечает «Cannot connect to C:». Формат простой — заголовок в 512
 * байт, за ним содержимое, выровненное по 512, — и разобрать его надёжнее, чем
 * угадывать, какой tar стоит на машине.
 */
function extractTarball(tarball, target) {
    const raw = zlib.gunzipSync(fs.readFileSync(tarball));
    const BLOCK = 512;

    for (let at = 0; at + BLOCK <= raw.length;) {
        const header = raw.subarray(at, at + BLOCK);

        if (header[0] === 0) {
            /* Два нулевых блока — конец архива. */
            break;
        }

        const name = header.subarray(0, 100).toString("utf8")
            .replace(/\0.*$/u, "");
        const size = parseInt(
            header.subarray(124, 136).toString("utf8")
                .replace(/\0.*$/u, "").trim(),
            8
        ) || 0;
        const type = String.fromCharCode(header[156]);
        const from = at + BLOCK;

        at = from + Math.ceil(size / BLOCK) * BLOCK;

        if (type !== "0" && type !== "\0") {
            /* Каталоги и прочие записи создаются вместе с файлами. */
            continue;
        }

        const file = path.join(target, name);

        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, raw.subarray(from, from + size));
    }
}

/**
 * Состав пакета по мнению самого npm.
 *
 * Сборка запускается заранее, а скрипты у самого npm выключены. Иначе
 * получается ловушка: `--ignore-scripts` не даёт prepack собрать bundle, но
 * состав уже проверяется — и на чистом checkout, где bundle ещё нет, проверка
 * падает, а на дереве после первого `npm pack` проходит.
 */
async function packedFiles() {
    await require("../build/bundle").buildRslBundle("cli");

    const raw = execFileSync(
        NPM,
        ["pack", "--dry-run", "--json", "--ignore-scripts"],
        {
            ...NPM_OPTIONS,
            cwd: ROOT,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
        }
    );
    const info = Object.values(JSON.parse(raw))[0];

    return info.files.map(item => item.path);
}

test("в пакет попадают и запускающий файл, и bundle", async () => {
    const names = await packedFiles();

    for (const required of ["bin/rsl-plus.js", "bin/rsl-plus-cli.js"]) {
        assert.ok(
            names.includes(required),
            required + " обязан быть в пакете; в нём: " + names.join(", ")
        );
    }

    /*
     * И ничего лишнего: исходники и проверки в пакете означали бы, что
     * список files снова не действует.
     */
    assert.deepStrictEqual(
        names.filter(name =>
            name.startsWith("tests/") || name.startsWith("server/src/")),
        []
    );
});

test("распакованный пакет запускается и находит зависимости", () => {
    const directory = scratch("rsl-package-");

    try {
        /* Настоящий tarball: prepack собирает bundle сам. */
        const packed = execFileSync(
            NPM,
            ["pack", "--pack-destination", directory],
            {
                ...NPM_OPTIONS,
                cwd: ROOT,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"]
            }
        ).trim().split(/\r?\n/u).pop();
        const tarball = path.join(directory, packed);

        assert.ok(fs.existsSync(tarball), "tarball обязан быть собран");

        const unpacked = path.join(directory, "unpacked");

        fs.mkdirSync(unpacked, { recursive: true });

        extractTarball(tarball, unpacked);

        const launcher = path.join(unpacked, "package", "bin", "rsl-plus.js");

        assert.ok(
            fs.existsSync(launcher),
            "package/bin/rsl-plus.js обязан существовать"
        );
        assert.ok(
            fs.existsSync(
                path.join(unpacked, "package", "bin", "rsl-plus-cli.js")
            ),
            "и bundle рядом с ним"
        );

        /* Проект с прямой и транзитивной зависимостью. */
        const project = path.join(directory, "project");

        fs.mkdirSync(project, { recursive: true });
        fs.writeFileSync(
            path.join(project, "deep.mac"),
            "Macro Deep()\n  return 1;\nEnd;\n",
            "utf8"
        );
        fs.writeFileSync(
            path.join(project, "middle.mac"),
            "Import deep;\nMacro Middle()\n  return Deep();\nEnd;\n",
            "utf8"
        );
        fs.writeFileSync(
            path.join(project, "entry.mac"),
            "Import middle;\nMacro Entry()\n  return Middle();\nEnd;\n",
            "utf8"
        );

        /* Запуск из чужого каталога: так ломался разбор URI на Linux. */
        const run = spawnSync(
            process.execPath,
            [
                launcher, "check",
                "--context", project,
                "--summary",
                path.join(project, "entry.mac")
            ],
            { cwd: os.tmpdir(), encoding: "utf8" }
        );
        const output = run.stdout + run.stderr;

        assert.strictEqual(
            run.status,
            0,
            "команда обязана отработать: " + output
        );
        assert.ok(
            /Итого: файлов 1/u.test(output),
            "итог обязан быть напечатан: " + output
        );
        /* Три: сам проверяемый файл, прямая зависимость и транзитивная. */
        assert.ok(
            /Загружено зависимостей: 3/u.test(output),
            "обе зависимости обязаны загрузиться: " + output
        );
        assert.ok(
            !/неполный контекст: 1/u.test(output),
            "контекст обязан быть полным: " + output
        );
    } finally {
        removeTree(directory);
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

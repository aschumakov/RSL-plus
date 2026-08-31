"use strict";

/**
 * Физический NUL в исходниках.
 *
 * Байт 0x00 в тексте программы — это всегда описка: имелась в виду escape-
 * последовательность из двух символов. Git считает такой файл двоичным и
 * перестаёт показывать по нему diff, а рецензент перестаёт видеть правки.
 *
 * Проверка заведена потому, что это случилось трижды: в разное время NUL
 * появлялся в разных файлах, и каждый раз его замечали не сразу. Дешевле
 * запретить весь класс, чем ловить по одному.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

let passed = 0;
let failed = 0;

function test(name, action) {
    try {
        action();
        passed++;
        console.log("[OK] " + name);
    } catch (error) {
        failed++;
        console.error("[FAIL] " + name);
        console.error(error);
    }
}

const ROOTS = ["server/src", "client/src", "tests", "build", "bin"];
const TEXT_FILES = /\.(ts|js|cjs|mjs|json|md)$/u;

/** Все текстовые исходники проекта. */
function sourceFiles() {
    const root = path.join(__dirname, "..");
    const result = [];

    const walk = directory => {
        let entries;

        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch (_error) {
            return;
        }

        for (const entry of entries) {
            const full = path.join(directory, entry.name);

            if (entry.isDirectory()) {
                if (entry.name !== "node_modules" && entry.name !== "out") {
                    walk(full);
                }

                continue;
            }

            if (TEXT_FILES.test(entry.name)) {
                result.push(full);
            }
        }
    };

    ROOTS.forEach(item => walk(path.join(root, item)));

    return result;
}

test("в исходниках нет физического NUL", () => {
    const files = sourceFiles();

    assert.ok(files.length > 100, "проверка обязана что-то просмотреть");

    const found = [];

    for (const file of files) {
        const at = fs.readFileSync(file).indexOf(0);

        if (at >= 0) {
            found.push(path.relative(path.join(__dirname, ".."), file) +
                " (смещение " + at + ")");
        }
    }

    assert.deepStrictEqual(
        found,
        [],
        "вместо байта 0x00 в тексте программы пишется escape из двух символов"
    );
});

if (failed > 0) {
    console.error("\nПройдено: " + passed + "\nОшибок: " + failed);
    process.exitCode = 1;
} else {
    console.log("\nПройдено: " + passed + "\nОшибок: " + failed);
}

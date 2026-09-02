"use strict";

/**
 * Одна идентичность файла и одна идентичность ссылки на модуль.
 *
 * В RSL написание ссылки не значимо: `Import lib`, `Import lib.mac` и
 * `Import "sub\lib"` про один и тот же модуль. Разрешение имён это знало
 * всегда, а сравнение НАБОРА Import — нет: там стоял простой toLowerCase. Из-за
 * этого дописать в директиве расширение значило снять и поставить рёбра
 * Import-графа, пересчитать закрепление и сбросить Import-контекст всем
 * зависимым файлам — при том, что зависимость осталась той же.
 *
 * Отдельно проверяется идентичность файла. Она платформенная: на
 * регистронезависимой файловой системе два написания URI, различающиеся
 * регистром буквы диска, — один файл, и тот, кто сравнивает строки, считает их
 * разными. Индекс ссылок ключевался именно строкой.
 */

const assert = require("assert");

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

const {
    moduleBaseNameOfUri,
    moduleIdOf,
    moduleIdOfUri,
    sameUri,
    uriKey
} = require("../server/out/core/identity/uriKey");
const { ReferenceIndex } = require("../server/out/analysis/referenceIndex");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

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

const LIB = "file:///d:/identity/lib.mac";
const USER = "file:///d:/identity/user.mac";

/** Индекс с загруженной библиотекой и одним зависимым файлом. */
function board(importLine) {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([LIB, USER]);
    index.updateExternalModule(LIB, "Macro Alpha()\nEnd;\n", 1);
    index.updateOpenModule(USER, importLine + "\n\nAlpha();\n", 1);

    return index;
}

test("написание расширения не меняет набор Import", () => {
    const index = board("Import lib;");
    const before = {
        graph: index.interfaceCounters.importGraphUpdates,
        pinned: index.pinnedRebuilds,
        revision: index.getSemanticRevision(USER)
    };

    /* Тот же текст, но ссылка написана с расширением. */
    index.updateOpenModule(USER, "Import lib.mac;\n\nAlpha();\n", 2);

    assert.strictEqual(
        index.interfaceCounters.importGraphUpdates,
        before.graph,
        "рёбра Import-графа те же: зависимость не изменилась"
    );
    assert.strictEqual(
        index.pinnedRebuilds,
        before.pinned,
        "и закрепление пересчитывать незачем"
    );
    assert.notStrictEqual(
        before.revision,
        undefined,
        "ревизия окружения читается"
    );
});

test("ключ написанных Import не зависит от написания", () => {
    const plain = board("Import lib;");
    const dotted = board("Import lib.mac;");

    assert.strictEqual(
        plain.getDeclaredImportsKey(USER),
        dotted.getDeclaredImportsKey(USER),
        "`lib` и `lib.mac` — одна зависимость"
    );
});

test("обратный слеш в пути не меняет набор Import", () => {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([USER]);
    index.updateOpenModule(USER, "Import \"sub\\lib.mac\";\n", 1);

    const before = index.interfaceCounters.importGraphUpdates;

    index.updateOpenModule(USER, "Import \"sub/lib.mac\";\n", 2);

    assert.strictEqual(
        index.interfaceCounters.importGraphUpdates,
        before,
        "разделитель пути в RSL не значим"
    );
});

test("добавленная зависимость набор всё-таки меняет", () => {
    /* Обратная проверка: нормализация не должна склеивать разные наборы. */
    const index = board("Import lib;");
    const before = index.interfaceCounters.importGraphUpdates;

    index.updateOpenModule(USER, "Import lib;\nImport other;\n", 2);

    assert.ok(
        index.interfaceCounters.importGraphUpdates > before,
        "новая ссылка обязана обновить граф"
    );
});

test("идентичность ссылки: регистр и расширение", () => {
    assert.strictEqual(moduleIdOf("LIB"), moduleIdOf("lib.mac"));
    assert.strictEqual(moduleIdOf("./lib"), moduleIdOf("lib.mac"));
    assert.strictEqual(moduleIdOf("sub\\lib"), moduleIdOf("sub/lib.mac"));
    assert.notStrictEqual(
        moduleIdOf("sub/lib"),
        moduleIdOf("lib"),
        "путь в ссылке написан затем, чтобы различать одноимённые модули"
    );
});

test("ссылка, которой попадают в файл", () => {
    assert.strictEqual(moduleIdOfUri(LIB), "lib.mac");
    assert.strictEqual(moduleBaseNameOfUri(LIB), "lib");
});

test("регистр буквы диска не создаёт второй файл", () => {
    /*
     * Проверка платформенная по смыслу: на win32 это один файл, на
     * регистрозависимой системе — два, и склеивать их нельзя.
     */
    const upper = "file:///D:/identity/lib.mac";
    const expected = process.platform === "win32" ||
        process.platform === "darwin";

    assert.strictEqual(
        uriKey(upper) === uriKey(LIB),
        expected,
        "идентичность файла обязана следовать файловой системе"
    );
    assert.strictEqual(sameUri(upper, LIB), expected);
});

test("индекс ссылок не держит два входа на один файл", () => {
    const index = new ReferenceIndex();
    const hashes = new Uint32Array([1, 2, 3]);

    index.acceptScannedFacts(LIB, "aaa", hashes, []);
    assert.strictEqual(index.getStats().indexedFiles, 1);

    /* То же самое, но URI написан с большой буквой диска. */
    index.acceptScannedFacts("file:///D:/identity/lib.mac", "aaa", hashes, []);

    const expected = process.platform === "win32" ||
        process.platform === "darwin"
        ? 1
        : 2;

    assert.strictEqual(
        index.getStats().indexedFiles,
        expected,
        "по строке это были две записи об одном файле"
    );
});

test("сброс записи находит её при другом написании URI", () => {
    const index = new ReferenceIndex();

    index.acceptScannedFacts(LIB, "aaa", new Uint32Array([1]), []);
    index.invalidate("file:///D:/identity/lib.mac");

    const expected = process.platform === "win32" ||
        process.platform === "darwin"
        ? 0
        : 1;

    assert.strictEqual(
        index.getStats().indexedFiles,
        expected,
        "правка файла обязана снимать его запись независимо от написания"
    );
});

test("запись хранит написание URI, а не ключ сравнения", () => {
    const index = new ReferenceIndex();

    index.acceptScannedFacts(LIB, "aaa", new Uint32Array([1]), []);

    /*
     * Проверяется через набор кандидатов: наружу обязан выходить URI, по
     * которому файл можно открыть, а не нормализованный путь.
     */
    return index.getCandidateUris(LIB, [LIB, USER]).then(uris => {
        for (const uri of uris) {
            assert.ok(
                uri.startsWith("file:///"),
                "наружу выходит URI, а не ключ: " + uri
            );
        }
    });
});

console.log(
    failed === 0
        ? "\nПройдено: " + passed
        : "\nПройдено: " + passed + ", провалено: " + failed
);

if (failed > 0) {
    process.exitCode = 1;
}

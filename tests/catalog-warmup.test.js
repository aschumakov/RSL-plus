"use strict";

/**
 * Достройка каталога проекта.
 *
 * Каталог заполнялся по мере индексации, и в режиме activeImports ответы
 * Ctrl+T, Go to Implementation и переименования файла зависели от того, какие
 * файлы пользователь успел задеть. Здесь проверяется обратное: ответ один и тот
 * же независимо от того, что загружено.
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
    fileReferencesIn,
    RslCatalogWarmupService
} = require("../server/out/indexing/catalogWarmupService");
const {
    createRslVirtualClock
} = require("../server/out/core/clock");
const {
    buildRslFileRenameEdit
} = require("../server/out/features/fileRenameProvider");

let passed = 0;
let failed = 0;
const asyncTests = [];

function test(name, action) {
    try {
        action();
        passed++;
        console.log(`[OK] ${name}`);
    } catch (error) {
        failed++;
        console.error(`[FAIL] ${name}`);
        console.error(error);
    }
}

function testAsync(name, action) {
    asyncTests.push({ name, action });
}

const LIB = "file:///project/lib.mac";
const CALLER = "file:///project/caller.mac";
const OTHER = "file:///project/other.mac";

const FILES = new Map([
    [LIB, [
        "Macro LibraryHelper(document)",
        "  Var result = 1;",
        "  return result;",
        "End;",
        "Class Base",
        "  Var field;",
        "End;",
        ""
    ].join("\n")],
    [CALLER, [
        "Macro Run()",
        "  ExecMacroFile(\"lib.mac\");",
        "End;",
        ""
    ].join("\n")],
    [OTHER, [
        "Class(Base) Derived",
        "  Macro Work()",
        "  End;",
        "End;",
        ""
    ].join("\n")]
]);

function warmup(options) {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([...FILES.keys()]);

    const service = new RslCatalogWarmupService({
        index,
        readFile: uri => FILES.get(uri),
        ...(options || {})
    });

    return { index, service };
}

test("каталог знает имена файлов, которые никогда не загружались", () => {
    const { index, service } = warmup();

    assert.strictEqual(
        index.catalog.find("LibraryHelper", 5).length,
        0,
        "до достройки каталог пуст"
    );

    service.add([...FILES.keys()]);

    const progress = service.runToCompletion();

    assert.strictEqual(progress.done, 3, "прочитаны все файлы");
    assert.strictEqual(progress.skipped, 0);
    assert.deepStrictEqual(
        index.catalog.find("LibraryHelper", 5).map(item => item.uri),
        [LIB],
        "объявление из незагруженного файла попало в каталог"
    );
    assert.deepStrictEqual(
        index.catalog.implementationsOf("Base").map(item => item.name),
        ["Derived"],
        "наследник найден без загрузки модуля"
    );
    assert.strictEqual(
        index.getModule(LIB),
        undefined,
        "достройка не загружает модель в хранилище"
    );
});

test("уже известный каталогу файл второй раз не читается", () => {
    const read = [];
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([...FILES.keys()]);

    const service = new RslCatalogWarmupService({
        index,
        readFile: uri => {
            read.push(uri);

            return FILES.get(uri);
        }
    });

    service.add([LIB]);
    service.runToCompletion();
    service.add([LIB, CALLER]);
    service.runToCompletion();

    assert.deepStrictEqual(
        read,
        [LIB, CALLER],
        "второй раз тот же файл не читается: " + JSON.stringify(read)
    );
});

test("нечитаемый файл не останавливает обход", () => {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([...FILES.keys()]);

    const service = new RslCatalogWarmupService({
        index,
        readFile: uri => {
            if (uri === CALLER) {
                throw new Error("нет доступа");
            }

            return FILES.get(uri);
        }
    });

    service.add([...FILES.keys()]);

    const progress = service.runToCompletion();

    assert.strictEqual(progress.done, 2);
    assert.strictEqual(progress.skipped, 1, "нечитаемый файл пропущен");
    assert.ok(index.catalog.has(LIB), "остальные записаны");
});

test("слишком большой файл пропускается", () => {
    const index = new WorkspaceIndex();
    const huge = "file:///project/huge.mac";

    index.registerWorkspaceFiles([huge]);

    const service = new RslCatalogWarmupService({
        index,
        maxFileBytes: 1024,
        readFile: () => "Macro Big()\nEnd;\n" + "// ".repeat(4096)
    });

    service.add([huge]);

    assert.strictEqual(service.runToCompletion().skipped, 1);
    assert.ok(!index.catalog.has(huge));
});

/* ─── Строковые ссылки на файлы ──────────────────────────────────────────── */

test("строковые ссылки на файлы берутся из текста", () => {
    assert.deepStrictEqual(
        [...fileReferencesIn(
            "ExecMacroFile(\"lib.mac\"); Run('sub/Other.RSM');"
        )].sort(),
        ["lib.mac", "other.rsm"],
        "путь отбрасывается, регистр приводится"
    );
    assert.deepStrictEqual(
        [...fileReferencesIn("Var text = \"обычная строка\";")],
        [],
        "обычная строка ссылкой не считается"
    );
});

test("переименование правит файл, который никогда не открывался", () => {
    /*
     * Файлы настоящие: переименование читает текст с диска, и подменять чтение
     * значило бы проверить не тот путь, которым это работает у пользователя.
     */
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rsl-catalog-"));
    const uriOf = name => "file:///" +
        path.join(directory, name).split(path.sep).join("/");
    const libUri = uriOf("lib.mac");
    const callerUri = uriOf("caller.mac");

    fs.writeFileSync(path.join(directory, "lib.mac"), FILES.get(LIB), "utf8");
    fs.writeFileSync(
        path.join(directory, "caller.mac"),
        FILES.get(CALLER),
        "utf8"
    );

    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([libUri, callerUri]);

    const service = new RslCatalogWarmupService({
        index,
        readFile: uri => fs.readFileSync(
            path.join(directory, uri.slice(uri.lastIndexOf("/") + 1)),
            "utf8"
        )
    });

    service.add([libUri, callerUri]);
    service.runToCompletion();

    const environment = {
        index,
        getDocument: () => undefined,
        log: () => undefined
    };
    const edits = buildRslFileRenameEdit(environment, [{
        oldUri: libUri,
        newUri: uriOf("library.mac")
    }]);

    assert.ok(edits, "правки найдены");
    assert.deepStrictEqual(
        Object.keys(edits.changes),
        [callerUri],
        "правка в файле со строковой ссылкой: " +
            JSON.stringify(Object.keys(edits.changes))
    );
    assert.strictEqual(
        edits.changes[callerUri][0].newText.toLowerCase().includes("library"),
        true,
        "имя заменено"
    );

    fs.rmSync(directory, { recursive: true, force: true });
});

test("удалённый файл уходит из ссылок", () => {
    const { index, service } = warmup();

    service.add([...FILES.keys()]);
    service.runToCompletion();

    assert.deepStrictEqual(
        index.catalog.modulesMentioningFile("lib.mac"),
        [CALLER]
    );

    index.catalog.remove(CALLER);

    assert.deepStrictEqual(
        index.catalog.modulesMentioningFile("lib.mac"),
        [],
        "запись ушла вместе с файлом"
    );
});

test("обновление модели файла не теряет его строковые ссылки", () => {
    const { index, service } = warmup();

    service.add([...FILES.keys()]);
    service.runToCompletion();

    /* Файл открыли и правят: модель обновляется, текст не перечитывается. */
    index.updateOpenModule(CALLER, FILES.get(CALLER), 1);

    assert.deepStrictEqual(
        index.catalog.modulesMentioningFile("lib.mac"),
        [CALLER],
        "ссылки живут своей записью и обновлением модели не сбрасываются"
    );
});

/* ─── Порционность ───────────────────────────────────────────────────────── */

testAsync("обход идёт порциями и уступает дорогу", async () => {
    const clock = createRslVirtualClock(0);
    const { index, service } = warmup({
        clock,
        chunkFiles: 1,
        pauseMs: 10
    });

    service.add([...FILES.keys()]);

    assert.strictEqual(
        service.progress.done,
        0,
        "до первой паузы работа не начата"
    );

    await clock.advance(10);
    assert.strictEqual(service.progress.done, 1, "порция — один файл");

    service.suspend();
    await clock.advance(100);
    assert.strictEqual(
        service.progress.done,
        1,
        "приостановленный обход не работает"
    );

    service.resume();
    await clock.advance(10);
    await clock.advance(10);

    assert.strictEqual(service.progress.done, 3, "обход дошёл до конца");
    assert.ok(service.progress.complete);
    assert.ok(index.catalog.has(OTHER));
});

(async () => {
    for (const item of asyncTests) {
        try {
            await item.action();
            passed++;
            console.log(`[OK] ${item.name}`);
        } catch (error) {
            failed++;
            console.error(`[FAIL] ${item.name}`);
            console.error(error);
        }
    }

    console.log(
        failed === 0
            ? `\nПройдено: ${passed}`
            : `\nПройдено: ${passed}, провалено: ${failed}`
    );

    if (failed > 0) {
        process.exitCode = 1;
    }
})();

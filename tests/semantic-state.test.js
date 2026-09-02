"use strict";

/**
 * Одна модель актуальности семантических ответов.
 *
 * У любого семантического ответа есть НАБОР состояний, от которых он зависит.
 * Раньше каждый потребитель складывал свой ключ из того подмножества, которое
 * считал нужным, и подмножества расходились: у локальной фазы Problems в ключ
 * входил каталог платформы, у межфайловой — нет, и загрузка прикладного модуля
 * не отменяла её результат, хотя её вывод «имя неизвестно» от него и зависит.
 *
 * Проверяется три утверждения:
 *
 *   ответ не устаревает от того, от чего не зависит;
 *   ответ устаревает от того, от чего зависит;
 *   потребители одного вопроса объявляют одно и то же.
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
    RslSemanticState,
    mergeRslSemanticDependencies,
    sameRslHotStamp
} = require("../server/out/analysis/semanticState");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { RslScopeResolver } = require("../server/out/scopeResolver");

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

const URI = "file:///d:/state/main.mac";

/** Источник состояний под управлением теста. */
function stand() {
    const values = {
        text: 1,
        imports: "i",
        closure: "c",
        catalog: 1,
        workspace: 1,
        platform: 1,
        semantic: 1
    };
    const state = new RslSemanticState({
        textVersion: () => values.text,
        importsKey: () => values.imports,
        closureKey: () => values.closure,
        catalogRevision: () => values.catalog,
        workspaceRevision: () => values.workspace,
        platformRevision: () => values.platform,
        semanticRevision: () => values.semantic
    });

    return { values, state };
}

test("каждое состояние учитывается по отдельности", () => {
    const fields = [
        "text",
        "imports",
        "closure",
        "catalog",
        "workspace",
        "platform",
        "semantic"
    ];

    for (const field of fields) {
        const board = stand();
        const stamp = board.state.capture(URI, { [field]: true });

        for (const other of fields) {
            const kept = board.values[other];

            board.values[other] = "изменено";

            assert.strictEqual(
                board.state.isStale(stamp),
                other === field,
                "слепок по " + field + " не должен зависеть от " + other
            );

            board.values[other] = kept;
        }
    }
});

test("настройки передаются при слепке, а не берутся у источника", () => {
    const board = stand();
    const stamp = board.state.capture(
        URI,
        { settings: true },
        { settings: "a" }
    );

    assert.ok(board.state.isStale(stamp, { settings: "b" }));
    assert.ok(!board.state.isStale(stamp, { settings: "a" }));
});

test("незапрошенное состояние не спрашивается вовсе", () => {
    /*
     * Часть состояний строит строки по замыканию Import. Считать их для
     * потребителя, которому довольно одного числа, значило бы платить за то,
     * чего он не спрашивал.
     */
    const asked = [];
    const state = new RslSemanticState({
        textVersion: () => (asked.push("text"), 1),
        importsKey: () => (asked.push("imports"), "i"),
        closureKey: () => (asked.push("closure"), "c"),
        catalogRevision: () => (asked.push("catalog"), 1),
        workspaceRevision: () => (asked.push("workspace"), 1),
        platformRevision: () => (asked.push("platform"), 1),
        semanticRevision: () => (asked.push("semantic"), 1)
    });

    state.capture(URI, { semantic: true, platform: true });

    assert.deepStrictEqual(asked.sort(), ["platform", "semantic"]);
});

test("разные наборы зависимостей не дают один ключ", () => {
    const board = stand();

    assert.notStrictEqual(
        board.state.capture(URI, { text: true }).key,
        board.state.capture(URI, { catalog: true }).key,
        "иначе слепки разных проверок могли бы совпасть"
    );
});

test("запомненный ответ и его сброс", () => {
    const board = stand();
    let computed = 0;
    const ask = () => board.state.remember(
        URI,
        "проба",
        { closure: true },
        () => ++computed
    );

    assert.strictEqual(ask(), 1);
    assert.strictEqual(ask(), 1);
    assert.strictEqual(board.state.counters.hits, 1);

    board.values.catalog = 2;
    assert.strictEqual(ask(), 1, "каталог в зависимостях не объявлен");

    board.values.closure = "d";
    assert.strictEqual(ask(), 2, "а замыкание объявлено");
    assert.strictEqual(board.state.counters.resets, 1);
});

test("ответы разных вопросов не мешают друг другу", () => {
    const board = stand();
    const ask = (slot, depends, value) => board.state.remember(
        URI,
        slot,
        depends,
        () => value
    );

    assert.strictEqual(ask("первый", { text: true }, "a"), "a");
    assert.strictEqual(ask("второй", { closure: true }, "b"), "b");

    board.values.text = 2;

    assert.strictEqual(
        ask("первый", { text: true }, "c"),
        "c",
        "у зависящего от текста ответ пересчитан"
    );
    assert.strictEqual(
        ask("второй", { closure: true }, "d"),
        "b",
        "а у прочего остался прежним"
    );
});

test("закрытый документ забывается", () => {
    const board = stand();

    board.state.remember(URI, "проба", { text: true }, () => "a");
    board.state.forget(URI);

    assert.strictEqual(
        board.state.remember(URI, "проба", { text: true }, () => "b"),
        "b"
    );
});

test("объединение наборов", () => {
    const merged = mergeRslSemanticDependencies([
        { text: true },
        { closure: true, settings: true }
    ]);

    assert.deepStrictEqual(merged, {
        text: true,
        imports: undefined,
        closure: true,
        catalog: undefined,
        workspace: undefined,
        platform: undefined,
        semantic: undefined,
        settings: true
    });
});

test("горячий набор сравнивается двумя числами", () => {
    const board = stand();
    const stamp = board.state.hotStamp(URI);

    assert.ok(sameRslHotStamp(stamp, board.state.hotStamp(URI)));

    board.values.semantic = 2;
    assert.ok(!sameRslHotStamp(stamp, board.state.hotStamp(URI)));

    board.values.semantic = 1;
    board.values.platform = 2;
    assert.ok(
        !sameRslHotStamp(stamp, board.state.hotStamp(URI)),
        "каталог платформы приносит имена так же, как импортированный файл"
    );
    assert.ok(!sameRslHotStamp(undefined, stamp));
});

test("модель у resolver одна на всех потребителей", () => {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([URI]);
    index.updateOpenModule(URI, "Macro Run()\nEnd;\n", 1);

    const resolver = new RslScopeResolver(index);
    const stamp = resolver.captureSemanticStamp(URI, { text: true });

    assert.ok(!resolver.isSemanticStampStale(stamp));

    index.updateOpenModule(URI, "Macro Run()\n  Var x = 1;\nEnd;\n", 2);

    assert.ok(
        resolver.isSemanticStampStale(stamp),
        "правка текста обязана устареть слепок, зависящий от текста"
    );
    assert.strictEqual(
        resolver.semanticState,
        resolver.semanticState,
        "и модель одна, а не по одной на потребителя"
    );
});

test("состав файлов проекта — отдельное состояние", () => {
    /*
     * От него зависит, разрешится ли имя вообще и не стало ли оно
     * неоднозначным. Меняется он при обходе проекта, а не при чтении модуля,
     * поэтому и учитывается отдельно от каталога символов.
     */
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([URI]);
    index.updateOpenModule(URI, "Macro Run()\nEnd;\n", 1);

    const before = index.workspaceFilesRevision;

    index.updateExternalModule(
        "file:///d:/state/other.mac",
        "Macro Other()\nEnd;\n",
        1
    );

    assert.strictEqual(
        index.workspaceFilesRevision,
        before,
        "чтение модуля состав проекта не меняет"
    );

    index.registerWorkspaceFile("file:///d:/state/third.mac");

    assert.ok(
        index.workspaceFilesRevision > before,
        "а появление файла — меняет"
    );
});

console.log(
    failed === 0
        ? "\nПройдено: " + passed
        : "\nПройдено: " + passed + ", провалено: " + failed
);

if (failed > 0) {
    process.exitCode = 1;
}

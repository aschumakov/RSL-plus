"use strict";

/**
 * Иерархия вызовов опознаёт callable после сдвига его объявления.
 *
 * `CallHierarchyItem.data` живёт у клиента между запросами: prepare отдаёт
 * элемент, incoming и outgoing приходят потом — иногда через минуты, и за это
 * время файл правят. Пока в data лежали имя и границы объявления, правка выше
 * по файлу делала элемент неопознаваемым, и иерархия отвечала пустотой на
 * живой код.
 *
 * Проверяется то же утверждение, что и у ссылок: положение символа не является
 * его тождеством.
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

const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { ReferenceIndex } = require("../server/out/analysis/referenceIndex");
const {
    RslCallHierarchyProvider
} = require("../server/out/features/callHierarchyProvider");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const MAIN = "file:///d:/hierarchy/main.mac";

/** Filler выше, Alpha и Caller ниже: правка Filler сдвигает обоих. */
function source(fillerBody) {
    return [
        "Macro Filler()",
        ...fillerBody,
        "End;",
        "",
        "Macro Alpha()",
        "  return 1;",
        "End;",
        "",
        "Macro Caller()",
        "  Alpha();",
        "  Alpha();",
        "End;",
        ""
    ].join("\n");
}

function stand(text) {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN]);
    index.updateOpenModule(MAIN, text, 1);
    index.markOpen(MAIN);

    const referenceIndex = new ReferenceIndex({ log: () => undefined });

    referenceIndex.retainWorkspaceFiles([MAIN]);

    return {
        index,
        provider: new RslCallHierarchyProvider({
            index,
            resolver: new RslScopeResolver(index),
            referenceIndex
        })
    };
}

test("элемент опознаётся после сдвига объявления", async () => {
    const before = source([]);
    const board = stand(before);
    const items = board.provider.prepare(MAIN, before.indexOf("Macro Alpha") + 6);

    assert.strictEqual(items.length, 1, "prepare нашёл Alpha");
    assert.strictEqual(items[0].name, "Alpha");

    const item = items[0];

    /* Правка только тела Filler: Alpha и Caller съезжают на две строки. */
    const after = source(["  Var x = 1;", "  Var y = 2;"]);

    board.index.updateOpenModule(MAIN, after, 2);

    const incoming = await board.provider.incoming(item);

    assert.strictEqual(
        incoming.length,
        1,
        "вызывающий по-прежнему находится по СТАРОМУ элементу"
    );
    assert.strictEqual(incoming[0].from.name, "Caller");
    assert.strictEqual(
        incoming[0].fromRanges.length,
        2,
        "оба вызова на месте"
    );

    /* И места вызова — из ТЕКУЩЕЙ модели, а не из данных элемента. */
    assert.strictEqual(
        incoming[0].fromRanges[0].start.line,
        10,
        "строка вызова та, куда его сдвинули"
    );
});

test("исходящие вызовы считаются по актуальным границам тела", async () => {
    const before = source([]);
    const board = stand(before);
    const items = board.provider.prepare(
        MAIN,
        before.indexOf("Macro Caller") + 6
    );

    assert.strictEqual(items.length, 1);

    const item = items[0];
    const after = source(["  Var x = 1;", "  Var y = 2;"]);

    board.index.updateOpenModule(MAIN, after, 2);

    const outgoing = await board.provider.outgoing(item);

    assert.strictEqual(
        outgoing.length,
        1,
        "тело Caller найдено по актуальным границам"
    );
    assert.strictEqual(outgoing[0].to.name, "Alpha");
    assert.strictEqual(
        outgoing[0].fromRanges.length,
        2,
        "оба вызова внутри тела"
    );
});

test("удалённое объявление элемент не подменяет соседним", async () => {
    const before = source([]);
    const board = stand(before);
    const items = board.provider.prepare(MAIN, before.indexOf("Macro Alpha") + 6);
    const item = items[0];

    /* Alpha убран; Filler и Caller остались. */
    board.index.updateOpenModule(
        MAIN,
        "Macro Filler()\nEnd;\n\nMacro Caller()\nEnd;\n",
        2
    );

    const incoming = await board.provider.incoming(item);

    assert.deepStrictEqual(
        incoming,
        [],
        "объявления больше нет — выдумывать его нельзя"
    );
});

test("одноимённые из разных областей не смешиваются", async () => {
    /*
     * Устойчивый номер включает область и порядок среди одноимённых, поэтому
     * два разных Alpha остаются разными элементами.
     */
    const text = [
        "Class Holder",
        "  Macro Alpha()",
        "  End;",
        "End;",
        "",
        "Macro Alpha()",
        "  return 1;",
        "End;",
        ""
    ].join("\n");
    const board = stand(text);
    const outer = board.provider.prepare(
        MAIN,
        text.lastIndexOf("Macro Alpha") + 6
    );
    const inner = board.provider.prepare(
        MAIN,
        text.indexOf("  Macro Alpha") + 8
    );

    assert.strictEqual(outer.length, 1);
    assert.strictEqual(inner.length, 1);
    assert.notDeepStrictEqual(
        outer[0].data,
        inner[0].data,
        "разные объявления — разное тождество"
    );
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

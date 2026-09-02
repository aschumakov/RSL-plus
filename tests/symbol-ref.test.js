"use strict";

/**
 * Межфайловая идентичность объявления не зависит от экземпляра RslSymbol.
 *
 * `RslSymbol` — объект конкретной модели документа. Он неизменяем, и это его
 * достоинство, но у него есть свойства, к идентичности объявления не
 * относящиеся: положения в тексте. Правка ВЫШЕ по файлу двигает их все, модель
 * пересобирается, и объект становится другим, хотя объявление то же.
 *
 * Пока экземпляр служил ключом, кэш соседнего документа, запомнивший символ из
 * библиотеки, после правки её тела отдавал прежний объект с прежними
 * положениями: карта диапазонов по нему не отвечала вовсе, а там, где диапазон
 * брали прямо у символа, переход уходил на строку, где объявления уже нет.
 *
 * Здесь проверяется, что положение спрашивается у ТЕКУЩЕЙ модели по паре
 * «файл и устойчивый номер объявления».
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
    findRslSymbolById,
    rslSymbolRef,
    sameRslSymbolRef
} = require("../server/out/symbols/symbolRef");
const { sameUri } = require("../server/out/core/identity/uriKey");
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

const LIB = "file:///d:/ref/lib.mac";

/** Библиотека: объявление Alpha и место под тело выше него. */
function library(bodyLines) {
    return [
        "Macro Filler()",
        ...bodyLines,
        "End;",
        "",
        "Macro Alpha(a: String)",
        "    Return a;",
        "End;",
        ""
    ].join("\n");
}

/** Объявление Alpha в текущей модели. */
function alphaOf(index) {
    const module = index.getModule(LIB);

    return module.symbolTree.children.find(
        item => item.name.toLowerCase() === "alpha"
    );
}

test("номер объявления переживает правку тела выше него", () => {
    const index = new WorkspaceIndex();

    index.updateExternalModule(LIB, library([]), 1);

    const before = alphaOf(index);

    index.updateExternalModule(
        LIB,
        library(["    Var x = 1;", "    Var y = 2;"]),
        2
    );

    const after = alphaOf(index);

    assert.notStrictEqual(before, after, "объект модели другой");
    assert.strictEqual(
        before.id,
        after.id,
        "а номер объявления тот же: он не собран из положения"
    );
    assert.notStrictEqual(
        before.range.start,
        after.range.start,
        "положение при этом действительно съехало"
    );
});

test("диапазон по устаревшему объекту — актуальный", () => {
    const index = new WorkspaceIndex();

    index.updateExternalModule(LIB, library([]), 1);

    const remembered = alphaOf(index);
    const rangeBefore = index.getDefinitionRange(LIB, remembered);

    assert.ok(rangeBefore, "до правки диапазон известен");

    index.updateExternalModule(
        LIB,
        library(["    Var x = 1;", "    Var y = 2;"]),
        2
    );

    /* Тот же запомненный объект — вопрос задаётся им, как это делает кэш. */
    const rangeAfter = index.getDefinitionRange(LIB, remembered);
    const live = index.getDefinitionRange(LIB, alphaOf(index));

    assert.ok(
        rangeAfter,
        "по устаревшему объекту в карте не было ответа вовсе"
    );
    assert.deepStrictEqual(
        rangeAfter,
        live,
        "ответ обязан совпасть с ответом по актуальному объекту"
    );
    assert.notStrictEqual(
        rangeAfter.start.line,
        rangeBefore.start.line,
        "и он не прежний: объявление сдвинулось на две строки"
    );
});

test("актуальный объект по устаревшему", () => {
    const index = new WorkspaceIndex();

    index.updateExternalModule(LIB, library([]), 1);

    const remembered = alphaOf(index);

    index.updateExternalModule(LIB, library(["    Var x = 1;"]), 2);

    const live = index.liveSymbol(LIB, remembered);

    assert.strictEqual(live, alphaOf(index));
    assert.strictEqual(
        live.range.start,
        alphaOf(index).range.start
    );
});

test("объект по идентичности", () => {
    const index = new WorkspaceIndex();

    index.updateExternalModule(LIB, library([]), 1);

    const ref = rslSymbolRef(LIB, alphaOf(index));

    index.updateExternalModule(LIB, library(["    Var x = 1;"]), 2);

    assert.strictEqual(
        index.resolveSymbolRef(ref),
        alphaOf(index),
        "пара «файл и номер» находит объявление в новой модели"
    );
});

test("без модели отдаётся то, что было", () => {
    const index = new WorkspaceIndex();

    index.updateExternalModule(LIB, library([]), 1);

    const remembered = alphaOf(index);

    index.removeModule(LIB);

    assert.strictEqual(
        index.liveSymbol(LIB, remembered),
        remembered,
        "ответ по устаревшим сведениям лучше отсутствия ответа"
    );
    assert.strictEqual(index.resolveSymbolRef(rslSymbolRef(LIB, remembered)), undefined);
});

test("удалённое объявление не подменяется соседним", () => {
    const index = new WorkspaceIndex();

    index.updateExternalModule(LIB, library([]), 1);

    const remembered = alphaOf(index);

    /* Alpha убран, Filler остался. */
    index.updateExternalModule(LIB, "Macro Filler()\nEnd;\n", 2);

    assert.strictEqual(
        index.resolveSymbolRef(rslSymbolRef(LIB, remembered)),
        undefined,
        "объявления больше нет — и выдумывать его нельзя"
    );
});

test("поиск по номеру спускается по вложенным", () => {
    const index = new WorkspaceIndex();

    index.updateExternalModule(
        LIB,
        [
            "Class Holder()",
            "    Var count: Integer;",
            "End;",
            ""
        ].join("\n"),
        1
    );

    const root = index.getModule(LIB).symbolTree;
    const holder = root.children[0];
    const member = holder.children[0];

    assert.ok(member, "член класса разобран");
    assert.strictEqual(findRslSymbolById(root, member.id), member);
    assert.strictEqual(
        findRslSymbolById(root, (member.id + "/нет")),
        undefined
    );
});

test("одинаковость идентичности учитывает файловую систему", () => {
    const index = new WorkspaceIndex();

    index.updateExternalModule(LIB, library([]), 1);

    const left = rslSymbolRef(LIB, alphaOf(index));
    const right = rslSymbolRef("file:///D:/ref/lib.mac", alphaOf(index));
    const expected = process.platform === "win32" ||
        process.platform === "darwin";

    assert.strictEqual(sameRslSymbolRef(left, right, sameUri), expected);
    assert.strictEqual(sameRslSymbolRef(left, left, sameUri), true);
    assert.strictEqual(sameRslSymbolRef(left, undefined, sameUri), false);
});

console.log(
    failed === 0
        ? "\nПройдено: " + passed
        : "\nПройдено: " + passed + ", провалено: " + failed
);

if (failed > 0) {
    process.exitCode = 1;
}

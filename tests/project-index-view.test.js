"use strict";

/**
 * Один вход к сведениям уровня проекта.
 *
 * Сведения о проекте лежат в нескольких хранилищах, и объединять их приходилось
 * потребителям — каждому по-своему. Дерево зависимостей спрашивало каталог,
 * переход к определению — загруженные модели, Auto Import — только индекс
 * загруженных символов, Ctrl+T — только каталог. Из-за этого один и тот же
 * вопрос получал разные ответы в зависимости от того, кто спрашивает и что
 * успела прочитать фоновая индексация.
 *
 * Главная проверяемая величина — та, ради которой вход и заведён: ответ не
 * зависит от того, держится ли подробная модель модуля в памяти. Подробные
 * модели вытесняются по пределу, каталог — нет, и предложение подключить
 * объявление ИСЧЕЗАЛО вместе с вытесненной моделью, хотя объявление из проекта
 * никуда не делось.
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
    RslProjectIndexView
} = require("../server/out/indexing/projectIndexView");
const {
    buildKnownAutoImportCompletions
} = require("../server/out/features/autoImportProvider");
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

const MAIN = "file:///d:/view/main.mac";
const LIB = "file:///d:/view/lib.mac";
const DEEP = "file:///d:/view/deep.mac";
const OTHER = "file:///d:/view/other.mac";

/** Проект: main -> lib -> deep, плюс не подключённый other. */
function project(options = {}) {
    const index = new WorkspaceIndex(options);

    index.registerWorkspaceFiles([MAIN, LIB, DEEP, OTHER]);
    index.updateExternalModule(DEEP, "Macro DeepHelper()\nEnd;\n", 1);
    index.updateExternalModule(
        LIB,
        "Import deep;\n\nMacro LibHelper()\nEnd;\n",
        1
    );
    index.updateExternalModule(OTHER, "Macro OtherHelper()\nEnd;\n", 1);
    index.updateOpenModule(
        MAIN,
        "Import lib;\n\nMacro Run()\n    Oth\nEnd;\n",
        1
    );

    return { index, view: new RslProjectIndexView(index) };
}

test("замыкание Import не обрывается на незагруженном модуле", () => {
    const board = project();

    assert.deepStrictEqual(
        [...board.view.importClosureUris(MAIN)].sort(),
        [MAIN, DEEP, LIB].sort(),
        "deep подключён через lib"
    );

    /* Модель lib вытеснена: её Import помнит каталог. */
    board.index.removeModule(LIB);

    assert.deepStrictEqual(
        [...board.view.importClosureUris(MAIN)].sort(),
        [MAIN, DEEP, LIB].sort(),
        "обход не обрывается там, где кончилась память"
    );
});

test("объявление находится и после вытеснения модели", () => {
    const board = project();
    const before = board.view.findSymbol("OtherHelper");

    assert.strictEqual(before.length, 1);
    assert.strictEqual(before[0].ref.uri, OTHER);
    assert.strictEqual(before[0].source, "model");

    board.index.removeModule(OTHER);

    const after = board.view.findSymbol("OtherHelper");

    assert.strictEqual(
        after.length,
        1,
        "запись каталога переживает вытеснение подробной модели"
    );
    assert.strictEqual(after[0].ref.uri, OTHER);
    assert.strictEqual(
        after[0].source,
        "catalog",
        "и честно говорит, откуда сведения"
    );
    assert.strictEqual(
        after[0].symbol,
        undefined,
        "объекта символа нет — модель не в памяти"
    );
    assert.deepStrictEqual(
        after[0].ref,
        before[0].ref,
        "идентичность объявления при этом та же"
    );
});

test("экспортёры имени не зависят от вытеснения", () => {
    const board = project();

    assert.deepStrictEqual(board.view.findExporters("OtherHelper"), [OTHER]);

    board.index.removeModule(OTHER);

    assert.deepStrictEqual(
        board.view.findExporters("OtherHelper"),
        [OTHER],
        "иначе адресная загрузка не знала бы, какой файл читать"
    );
});

test("Auto Import предлагает символ вытесненного модуля", () => {
    /*
     * Тот самый случай. Прежде отвечал только индекс загруженных символов, и
     * предложение исчезало вместе с моделью.
     */
    const board = project();
    const module = board.index.getModule(MAIN);
    const labels = found => found.items.map(item => item.label);

    assert.deepStrictEqual(
        labels(buildKnownAutoImportCompletions(module, board.index, "Oth", 10)),
        ["OtherHelper"]
    );

    board.index.removeModule(OTHER);

    assert.deepStrictEqual(
        labels(buildKnownAutoImportCompletions(module, board.index, "Oth", 10)),
        ["OtherHelper"],
        "объявление из проекта не исчезло — значит и предложение не вправе"
    );
});

test("подключённый модуль не предлагается подключить заново", () => {
    const board = project();
    const module = board.index.getModule(MAIN);

    /* Модель lib вытеснена, но Import на неё в файле написан. */
    board.index.removeModule(LIB);

    const labels = buildKnownAutoImportCompletions(
        module,
        board.index,
        "Lib",
        10
    ).items.map(item => item.label);

    assert.deepStrictEqual(
        labels,
        [],
        "иначе вытеснение модели превращало бы подключённый модуль в кандидата"
    );
});

test("транзитивно подключённый — тоже не кандидат", () => {
    const board = project();
    const module = board.index.getModule(MAIN);

    board.index.removeModule(LIB);
    board.index.removeModule(DEEP);

    const labels = buildKnownAutoImportCompletions(
        module,
        board.index,
        "Deep",
        10
    ).items.map(item => item.label);

    assert.deepStrictEqual(
        labels,
        [],
        "deep виден через lib, и Import ему не нужен"
    );
});

test("приватное объявление не предлагается", () => {
    const index = new WorkspaceIndex();
    const hidden = "file:///d:/view/hidden.mac";

    index.registerWorkspaceFiles([MAIN, hidden]);
    index.updateExternalModule(
        hidden,
        "Private Macro Secret()\nEnd;\n",
        1
    );

    const module = index.updateOpenModule(MAIN, "Macro Run()\nEnd;\n", 1);
    const labels = buildKnownAutoImportCompletions(
        module,
        index,
        "Sec",
        10
    ).items.map(item => item.label);

    assert.deepStrictEqual(labels, []);
});

test("зависимые различают одноимённые модули", () => {
    const index = new WorkspaceIndex();
    const one = "file:///d:/view/a/cards.mac";
    const two = "file:///d:/view/b/cards.mac";
    const user = "file:///d:/view/user.mac";

    index.registerWorkspaceFiles([one, two, user]);
    index.updateExternalModule(one, "Macro CardsOne()\nEnd;\n", 1);
    index.updateExternalModule(two, "Macro CardsTwo()\nEnd;\n", 1);
    index.updateExternalModule(
        user,
        "Import \"a/cards.mac\";\nMacro Run()\nEnd;\n",
        1
    );

    const view = new RslProjectIndexView(index);

    assert.deepStrictEqual(
        view.dependentsOf(one),
        [{ uri: user, ambiguous: false }],
        "путь в Import написан затем, чтобы различать одноимённые"
    );
    assert.deepStrictEqual(
        view.dependentsOf(two),
        [],
        "второй одноимённый к этой ссылке отношения не имеет"
    );
});

test("неоднозначная ссылка помечается, а не прячется", () => {
    const index = new WorkspaceIndex();
    const one = "file:///d:/view/a/cards.mac";
    const two = "file:///d:/view/b/cards.mac";
    const user = "file:///d:/view/user.mac";

    index.registerWorkspaceFiles([one, two, user]);
    index.updateExternalModule(one, "Macro CardsOne()\nEnd;\n", 1);
    index.updateExternalModule(two, "Macro CardsTwo()\nEnd;\n", 1);
    index.updateExternalModule(user, "Import cards;\nMacro Run()\nEnd;\n", 1);

    const view = new RslProjectIndexView(index);

    assert.deepStrictEqual(view.dependentsOf(one), [
        { uri: user, ambiguous: true }
    ]);
    assert.deepStrictEqual(view.dependentsOf(two), [
        { uri: user, ambiguous: true }
    ]);
});

test("Ctrl+T приводит в актуальную строку", () => {
    /*
     * Запись каталога помнит положение на момент чтения файла. У открытого
     * документа оно съезжает от каждой правки, и до следующего чтения ответ
     * приводил в строку, где объявления уже нет.
     */
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN]);
    index.updateOpenModule(MAIN, "Macro Target()\nEnd;\n", 1);

    const view = new RslProjectIndexView(index);
    const before = view.workspaceSymbols("Target", 10);

    assert.strictEqual(before.length, 1);

    index.updateOpenModule(
        MAIN,
        "Macro Filler()\nEnd;\n\nMacro Target()\nEnd;\n",
        2
    );

    const live = index.getDefinitionRangeByRef(before[0].ref);

    assert.ok(live, "объявление то же, а строка другая");
    assert.strictEqual(
        live.start.line,
        3,
        "актуальная строка берётся у текущей модели"
    );
});

test("написанные Import известны и без подробной модели", () => {
    const board = project();

    assert.deepStrictEqual(board.view.importsOf(LIB), ["deep"]);

    board.index.removeModule(LIB);

    assert.deepStrictEqual(
        board.view.importsOf(LIB),
        ["deep"],
        "состав Import каталог помнит про все прочитанные файлы"
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

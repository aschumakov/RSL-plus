"use strict";

/**
 * Дерево зависимостей проекта.
 *
 * Import-граф у сервера был, а пользователю его видно не было: почему имя
 * доступно, чего не хватает и от чего зависит файл, приходилось выяснять
 * чтением кода.
 *
 * Проверяется то, ради чего дерево и заведено: недостающее и неоднозначное
 * видно наравне с найденным, цикл не уводит обход в бесконечность, а уровень
 * считается по одному — дерево проекта целиком не строится.
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
    buildRslDependencyLevel,
    findRslDependencyPath
} = require("../server/out/features/dependencyTree");
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

const MAIN = "file:///d:/tree/payment.mac";
const COMMON = "file:///d:/tree/common.mac";
const UTILS = "file:///d:/tree/utils.mac";
const CARDS_ONE = "file:///d:/tree/a/cards.mac";
const CARDS_TWO = "file:///d:/tree/b/cards.mac";

/** Проект: payment -> common -> utils, плюс неоднозначное и недостающее. */
function project() {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN, COMMON, UTILS, CARDS_ONE, CARDS_TWO]);
    index.updateExternalModule(UTILS, "Macro Util()\nEnd;\n", 1);
    index.updateExternalModule(COMMON, "Import utils;\nMacro Common()\nEnd;\n", 1);
    index.updateExternalModule(CARDS_ONE, "Macro CardsOne()\nEnd;\n", 1);
    index.updateExternalModule(CARDS_TWO, "Macro CardsTwo()\nEnd;\n", 1);
    index.updateOpenModule(
        MAIN,
        "Import common, cards, missing, SomeInter;\nMacro Run()\nEnd;\n",
        1
    );

    return index;
}

const PLATFORM = new Set(["someinter"]);

function level(index, uri, options = {}) {
    return buildRslDependencyLevel(
        {
            index,
            knowsPlatformModule: name => PLATFORM.has(name.toLowerCase())
        },
        { uri, ...options }
    );
}

test("уровень показывает все виды зависимостей", () => {
    const nodes = level(project(), MAIN);
    const byName = new Map(nodes.map(node => [node.name, node.state]));

    assert.strictEqual(byName.get("common"), "resolved");
    assert.strictEqual(byName.get("cards"), "ambiguous", "два файла с этим именем");
    assert.strictEqual(byName.get("missing"), "missing");
    assert.strictEqual(byName.get("SomeInter"), "platform");
});

test("раскрывается только то, у чего есть дети", () => {
    const nodes = level(project(), MAIN);
    const common = nodes.find(node => node.name === "common");

    assert.strictEqual(common.expandable, true, "common подключает utils");

    const deeper = level(project(), common.uri);

    assert.deepStrictEqual(
        deeper.map(node => node.name),
        ["utils"]
    );
    assert.ok(
        !deeper[0].expandable,
        "у utils своих Import нет: раскрывать нечего"
    );
});

test("уровень считается по одному, а не всё дерево", () => {
    /*
     * Обход всего проекта здесь недопустим: на 6166 файлах это тысячи узлов,
     * из которых пользователь раскроет пять. Признак — utils в ответе на
     * запрос про payment не появляется.
     */
    const nodes = level(project(), MAIN);

    assert.ok(
        !nodes.some(node => node.name === "utils"),
        "транзитивная зависимость на первом уровне не показывается"
    );
});

test("цикл не уводит обход в бесконечность", () => {
    const index = project();

    index.updateExternalModule(UTILS, "Import payment;\nMacro Util()\nEnd;\n", 2);

    const nodes = buildRslDependencyLevel(
        { index },
        { uri: UTILS, ancestors: [MAIN, COMMON] }
    );
    const back = nodes.find(node => node.name === "payment");

    assert.ok(back, "обратная ссылка показана");
    assert.strictEqual(back.cycle, true, "и помечена циклом");
    assert.ok(!back.expandable, "раскрывать её нельзя");
});

test("обратные зависимости показывают, кто ссылается", () => {
    const nodes = level(project(), COMMON, { direction: "dependents" });

    assert.deepStrictEqual(
        nodes.map(node => node.uri),
        [MAIN]
    );
});

test("путь зависимости — кратчайший", () => {
    const index = project();

    assert.deepStrictEqual(
        findRslDependencyPath(index, MAIN, UTILS),
        [MAIN, COMMON, UTILS],
        "через common: другого пути нет"
    );
});

test("пути нет — пустой ответ", () => {
    assert.deepStrictEqual(
        findRslDependencyPath(project(), UTILS, MAIN),
        [],
        "utils про payment ничего не знает"
    );
});

test("незагруженный модуль отличается от недостающего", () => {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN, COMMON]);
    index.updateOpenModule(MAIN, "Import common;\nMacro Run()\nEnd;\n", 1);

    const nodes = level(index, MAIN);

    assert.strictEqual(
        nodes[0].state,
        "unloaded",
        "файл в проекте есть, но ещё не прочитан — это не отсутствие"
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

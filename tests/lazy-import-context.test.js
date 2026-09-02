"use strict";

/**
 * Import-контекст: видимые модули отдельно, поиск имени отдельно.
 *
 * Контекст собирал карту ВСЕХ публичных имён всего транзитивного замыкания —
 * чтобы резолвер взял из неё одно имя. На настоящем проекте это 0,5-1,1 мс на
 * каждую сборку, то есть на каждую правку открытого файла.
 *
 * Теперь имя ищет общий индекс символов, а замыкание решает видимость.
 * Проверяется именно то, что могло разойтись: состав, порядок при одинаковых
 * именах и видимость приватных.
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

const MAIN = "file:///d:/lazy/main.mac";
const NEAR = "file:///d:/lazy/near.mac";
const FAR = "file:///d:/lazy/far.mac";
const OUTSIDE = "file:///d:/lazy/outside.mac";

/** main -> near -> far; outside не подключён ни к чему. */
function project() {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN, NEAR, FAR, OUTSIDE]);
    index.updateExternalModule(
        FAR,
        "Macro Shared()\n  return 3;\nEnd;\nMacro OnlyFar()\nEnd;\n",
        1
    );
    index.updateExternalModule(
        NEAR,
        "Import far;\nMacro Shared()\n  return 2;\nEnd;\n" +
        "Private Macro Hidden()\nEnd;\n",
        1
    );
    index.updateExternalModule(
        OUTSIDE,
        "Macro Shared()\n  return 9;\nEnd;\nMacro OnlyOutside()\nEnd;\n",
        1
    );
    index.updateOpenModule(MAIN, "Import near;\nMacro Run()\nEnd;\n", 1);

    return index;
}

test("имя из прямого Import находится", () => {
    const index = project();

    assert.deepStrictEqual(
        index.findImportedSymbols(MAIN, "Shared").map(item => item.uri),
        [NEAR, FAR],
        "оба модуля замыкания объявляют это имя"
    );
});

test("порядок — обхода замыкания, ближний первым", () => {
    const index = project();
    const found = index.findImportedSymbols(MAIN, "Shared");

    assert.strictEqual(
        found[0].uri,
        NEAR,
        "прямой Import обязан быть первым: по нему разрешают имя"
    );
});

test("транзитивное имя находится", () => {
    const index = project();

    assert.deepStrictEqual(
        index.findImportedSymbols(MAIN, "OnlyFar").map(item => item.uri),
        [FAR]
    );
});

test("неподключённый модуль не виден", () => {
    const index = project();

    assert.deepStrictEqual(
        index.findImportedSymbols(MAIN, "OnlyOutside"),
        [],
        "outside никем не импортирован"
    );
});

test("приватное имя подключённого модуля не видно", () => {
    const index = project();

    assert.deepStrictEqual(
        index.findImportedSymbols(MAIN, "Hidden"),
        [],
        "Private снаружи не виден"
    );
});

test("собственное имя документа импортированным не считается", () => {
    const index = project();

    assert.deepStrictEqual(
        index.findImportedSymbols(MAIN, "Run"),
        [],
        "замыкание — это подключённые модули, а не сам документ"
    );
});

test("несуществующее имя даёт пустой ответ", () => {
    const index = project();

    assert.deepStrictEqual(index.findImportedSymbols(MAIN, "НетТакого"), []);
});

test("выключенные Import ничего не показывают", () => {
    const index = project();

    index.setImportsEnabled(false);

    assert.deepStrictEqual(index.findImportedSymbols(MAIN, "Shared"), []);
});

test("новый Import сразу виден", () => {
    const index = project();

    assert.deepStrictEqual(index.findImportedSymbols(MAIN, "OnlyOutside"), []);

    index.updateOpenModule(MAIN, "Import near, outside;\nMacro Run()\nEnd;\n", 2);

    assert.deepStrictEqual(
        index.findImportedSymbols(MAIN, "OnlyOutside").map(item => item.uri),
        [OUTSIDE]
    );
});

test("правка тела модуля замыкания не меняет ответ", () => {
    const index = project();
    const before = index.findImportedSymbols(MAIN, "Shared")
        .map(item => item.uri + "#" + item.symbolId);

    index.updateExternalModule(
        NEAR,
        "Import far;\nMacro Shared()\n  Var x = 1;\n  return x;\nEnd;\n" +
        "Private Macro Hidden()\nEnd;\n",
        2
    );

    assert.deepStrictEqual(
        index.findImportedSymbols(MAIN, "Shared")
            .map(item => item.uri + "#" + item.symbolId),
        before
    );
});

test("список для Completion по-прежнему полный", () => {
    /*
     * Полное перечисление нужно ровно одному потребителю, и он его получает
     * из тех же видимых модулей.
     */
    const index = project();
    const names = index.getImportedCompletionItems(MAIN)
        .map(item => item.label)
        .sort();

    assert.deepStrictEqual(
        names,
        ["OnlyFar", "Shared"],
        "приватное не попадает, одноимённое не дублируется"
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

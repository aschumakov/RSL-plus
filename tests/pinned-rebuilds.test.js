"use strict";

/**
 * Закрепление пересчитывается по изменению Import, а не по любой правке.
 *
 * Транзитивное замыкание Import открытых документов — обход графа вширь по
 * всему проекту. Раньше он запускался на КАЖДУЮ замену открытого модуля, то
 * есть на каждое нажатие клавиши: `a = 1` -> `a = 2` перестраивало замыкание
 * целиком, хотя подключённые модули те же самые.
 *
 * Проверяется и то, ради чего пересчёт вообще нужен: после изменения Import
 * состав закрепления обязан стать правильным.
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

const MAIN = "file:///d:/project/main.mac";
const A = "file:///d:/project/a.mac";
const B = "file:///d:/project/b.mac";
const DEEP = "file:///d:/project/deep.mac";

/** Проект: main открыт и подключает a, a подключает deep. */
function project() {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN, A, B, DEEP]);
    index.updateExternalModule(A, "Import deep;\nMacro Alpha()\nEnd;\n", 1);
    index.updateExternalModule(B, "Macro Beta()\nEnd;\n", 1);
    index.updateExternalModule(DEEP, "Macro Deep()\nEnd;\n", 1);
    index.updateOpenModule(MAIN, "Import a;\nMacro Run()\nEnd;\n", 1);

    return index;
}

test("обычная правка с тем же Import не пересчитывает замыкание", () => {
    const index = project();
    const before = index.pinnedRebuilds;

    index.updateOpenModule(MAIN, "Import a;\nMacro Run()\n  x = 1;\nEnd;\n", 2);
    index.updateOpenModule(MAIN, "Import a;\nMacro Run()\n  x = 2;\nEnd;\n", 3);
    index.updateOpenModule(MAIN, "Import a;\nMacro Run()\n  x = 12;\nEnd;\n", 4);

    assert.strictEqual(
        index.pinnedRebuilds - before,
        0,
        "набор Import не менялся: пересчитывать нечего"
    );
});

test("порядок и написание Import значения не имеют", () => {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN, A, B]);
    index.updateExternalModule(A, "Macro Alpha()\nEnd;\n", 1);
    index.updateExternalModule(B, "Macro Beta()\nEnd;\n", 1);
    index.updateOpenModule(MAIN, "Import a, b;\nMacro Run()\nEnd;\n", 1);

    const before = index.pinnedRebuilds;

    index.updateOpenModule(MAIN, "Import B, A;\nMacro Run()\nEnd;\n", 2);

    assert.strictEqual(
        index.pinnedRebuilds - before,
        0,
        "переставленные и иначе написанные имена — тот же набор"
    );
});

test("добавленный Import пересчитывает замыкание", () => {
    const index = project();
    const before = index.pinnedRebuilds;

    index.updateOpenModule(MAIN, "Import a, b;\nMacro Run()\nEnd;\n", 2);

    assert.strictEqual(
        index.pinnedRebuilds - before,
        1,
        "набор Import изменился"
    );
    assert.strictEqual(
        index.pinnedModuleCount,
        4,
        "закреплены main, a, deep и добавленный b"
    );
});

test("убранный Import пересчитывает замыкание", () => {
    const index = project();

    index.updateOpenModule(MAIN, "Import a, b;\nMacro Run()\nEnd;\n", 2);

    const before = index.pinnedRebuilds;

    index.updateOpenModule(MAIN, "Import a;\nMacro Run()\nEnd;\n", 3);

    assert.strictEqual(index.pinnedRebuilds - before, 1);
    assert.strictEqual(
        index.pinnedModuleCount,
        3,
        "b больше не удерживается"
    );
});

test("открытие и закрытие документа пересчитывают замыкание", () => {
    const index = project();

    /* Тот же текст, но модуль был внешним: закрепление обязано появиться. */
    let before = index.pinnedRebuilds;

    index.updateOpenModule(B, "Macro Beta()\nEnd;\n", 2);

    assert.strictEqual(
        index.pinnedRebuilds - before,
        1,
        "внешний модуль стал открытым"
    );

    before = index.pinnedRebuilds;
    index.markClosed(B);

    assert.strictEqual(
        index.pinnedRebuilds - before,
        1,
        "закрытый документ больше никого не удерживает"
    );
});

test("правка Import у закреплённой зависимости пересчитывает замыкание", () => {
    const index = project();
    const before = index.pinnedRebuilds;

    /* a закреплён как зависимость main; теперь он подключает ещё и b. */
    index.updateExternalModule(A, "Import deep, b;\nMacro Alpha()\nEnd;\n", 2);

    assert.strictEqual(index.pinnedRebuilds - before, 1);
    assert.strictEqual(
        index.pinnedModuleCount,
        4,
        "b попал в замыкание через a"
    );
});

test("правка закреплённой зависимости без Import ничего не пересчитывает", () => {
    const index = project();
    const before = index.pinnedRebuilds;

    index.updateExternalModule(
        A,
        "Import deep;\nMacro Alpha()\n  y = 1;\nEnd;\n",
        2
    );

    assert.strictEqual(index.pinnedRebuilds - before, 0);
});

test("правка постороннего модуля ничего не пересчитывает", () => {
    const index = project();
    const before = index.pinnedRebuilds;

    /* Фоновая индексация проекта: тысячи таких загрузок подряд. */
    for (let number = 0; number < 50; number++) {
        const uri = "file:///d:/project/back" + number + ".mac";

        index.registerWorkspaceFile(uri);
        index.updateExternalModule(uri, "Macro Back()\nEnd;\n", 1);
    }

    assert.strictEqual(
        index.pinnedRebuilds - before,
        0,
        "посторонние модули замыкания не касаются"
    );
});

test("появление недостающего модуля пересчитывает замыкание", () => {
    const index = new WorkspaceIndex();
    const late = "file:///d:/project/late.mac";

    index.registerWorkspaceFiles([MAIN, late]);
    index.updateOpenModule(MAIN, "Import late;\nMacro Run()\nEnd;\n", 1);

    const before = index.pinnedRebuilds;

    /* Модуль был написан в Import, но ещё не загружен. */
    index.updateExternalModule(late, "Macro Late()\nEnd;\n", 1);

    assert.strictEqual(index.pinnedRebuilds - before, 1);
    assert.strictEqual(
        index.pinnedModuleCount,
        2,
        "догруженный модуль обязан закрепиться"
    );
});

test("переключение Import пересчитывает замыкание", () => {
    const index = project();
    let before = index.pinnedRebuilds;

    index.setImportsEnabled(false);

    assert.strictEqual(index.pinnedRebuilds - before, 1);
    assert.strictEqual(
        index.pinnedModuleCount,
        0,
        "с выключенным Import удерживать нечего"
    );

    before = index.pinnedRebuilds;
    index.setImportsEnabled(true);

    assert.strictEqual(index.pinnedRebuilds - before, 1);
    assert.strictEqual(index.pinnedModuleCount, 3);
});

test("удаление закреплённого модуля не ломает состав замыкания", () => {
    const index = project();

    index.removeModule(A);

    /*
     * a пропал, но main его по-прежнему пишет в Import. Закрепление обязано
     * ждать его обратно, а не считать deep своей зависимостью.
     */
    index.updateExternalModule(A, "Import deep;\nMacro Alpha()\nEnd;\n", 2);

    assert.strictEqual(
        index.pinnedModuleCount,
        3,
        "вернувшийся модуль снова приводит за собой deep"
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

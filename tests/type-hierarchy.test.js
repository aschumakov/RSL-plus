"use strict";

/**
 * Переход к реализации и иерархия типов.
 *
 * Обе функции отвечают по постоянному каталогу проекта: связь «класс —
 * базовый класс» записана для каждого файла, включая те, чья подробная модель
 * вытеснена. Нового обхода проекта на запрос не делается.
 */

const assert = require("assert");

const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const {
    findRslImplementations,
    prepareRslTypeHierarchy,
    rslSubtypes,
    rslSupertypes
} = require("../server/out/features/typeHierarchyProvider");
const { classNameAt } = require("../server/out/features/classNameAt");

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

const BASE = "file:///d:/hierarchy/base.mac";
const MIDDLE = "file:///d:/hierarchy/middle.mac";
const LEAF = "file:///d:/hierarchy/leaf.mac";
const OTHER = "file:///d:/hierarchy/other.mac";

function project() {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([BASE, MIDDLE, LEAF, OTHER]);
    index.updateExternalModule(BASE, "Class Base\n  Var Field;\nEnd;\n", 1);
    index.updateExternalModule(
        MIDDLE,
        "Import base;\nClass(Base) Middle\n  Var Own;\nEnd;\n",
        1
    );
    index.updateExternalModule(
        LEAF,
        "Import middle;\nClass(Middle) Leaf\n  Var Deep;\nEnd;\n",
        1
    );
    index.updateExternalModule(OTHER, "Class Unrelated\nEnd;\n", 1);

    return index;
}

test("переход к реализации находит наследников", () => {
    const index = project();

    assert.deepStrictEqual(
        findRslImplementations(index, "Base").map(item => item.uri),
        [MIDDLE]
    );
    assert.deepStrictEqual(
        findRslImplementations(index, "Middle").map(item => item.uri),
        [LEAF]
    );
    assert.deepStrictEqual(findRslImplementations(index, "Unrelated"), []);
});

test("иерархия типов ходит вверх и вниз", () => {
    const index = project();
    const [middle] = prepareRslTypeHierarchy(index, "Middle");

    assert.ok(middle, "класс обязан находиться в каталоге");
    assert.strictEqual(middle.detail, "наследник Base");

    assert.deepStrictEqual(
        rslSupertypes(index, middle).map(item => item.name),
        ["Base"]
    );
    assert.deepStrictEqual(
        rslSubtypes(index, middle).map(item => item.name),
        ["Leaf"]
    );
});

test("ответ не зависит от порядка загрузки файлов", () => {
    const forward = project();
    const backward = new WorkspaceIndex();
    backward.registerWorkspaceFiles([OTHER, LEAF, MIDDLE, BASE]);
    backward.updateExternalModule(OTHER, "Class Unrelated\nEnd;\n", 1);
    backward.updateExternalModule(
        LEAF,
        "Import middle;\nClass(Middle) Leaf\n  Var Deep;\nEnd;\n",
        1
    );
    backward.updateExternalModule(
        MIDDLE,
        "Import base;\nClass(Base) Middle\n  Var Own;\nEnd;\n",
        1
    );
    backward.updateExternalModule(BASE, "Class Base\n  Var Field;\nEnd;\n", 1);

    assert.deepStrictEqual(
        findRslImplementations(backward, "Base").map(item => item.uri),
        findRslImplementations(forward, "Base").map(item => item.uri)
    );
});

test("имя класса под курсором берётся из каталога", () => {
    const index = project();
    const open = "file:///d:/hierarchy/main.mac";
    const source = [
        "Import base;",
        "Macro Test()",
        "  Var holder: Base;",
        "  return holder;",
        "End;",
        ""
    ].join("\n");
    index.registerWorkspaceFile(open);
    index.updateOpenModule(open, source, 1);

    assert.strictEqual(
        classNameAt(index, open, source.indexOf("Base;")),
        "Base"
    );
    assert.strictEqual(
        classNameAt(index, open, source.indexOf("holder")),
        "",
        "переменная классом не является"
    );
});

if (failed > 0) {
    console.error(`\nПройдено: ${passed}\nОшибок: ${failed}`);
    process.exitCode = 1;
} else {
    console.log(`\nПройдено: ${passed}\nОшибок: ${failed}`);
}

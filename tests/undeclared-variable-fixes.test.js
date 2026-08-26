"use strict";

/**
 * Исправления для «переменная не объявлена в текущей области».
 *
 * Проверка находит копипаст `parm = ...` рядом с объявленным `param`; Quick Fix
 * доводит дело до конца — заменяет имя или объявляет переменную. Подбор идёт
 * только по запросу Code Action, поэтому на набор текста он не влияет.
 */

const assert = require("assert");

const { buildRslCodeActions } = require("../server/out/codeActions");
const { buildRslDiagnostics } = require("../server/out/diagnostics");
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

const MAIN = "file:///d:/fixes/main.mac";

/** Диагностики файла и предложенные для них исправления. */
function actionsFor(lines) {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([MAIN]);
    const module = index.updateOpenModule(MAIN, lines.join("\n"), 1);
    const diagnostics = buildRslDiagnostics(module, index)
        .filter(item => item.code === "undeclared-variable");

    return {
        module,
        diagnostics,
        actions: buildRslCodeActions(module, {
            textDocument: { uri: MAIN },
            range: diagnostics[0]?.range || {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 }
            },
            context: { diagnostics }
        })
    };
}

function titles(actions) {
    return actions.map(item => item.title);
}

function editsOf(action) {
    return action.edit.changes[MAIN];
}

test("похожее имя предлагается заменой", () => {
    const found = actionsFor([
        "Macro Test(param)",
        "  Var value;",
        "  parm = value;",
        "End;"
    ]);

    assert.strictEqual(found.diagnostics.length, 1, "нужна одна находка");
    assert.ok(
        titles(found.actions).includes("Заменить на «param»"),
        "ожидалась замена на параметр: " + titles(found.actions).join(", ")
    );

    const replacement = found.actions.find(
        item => item.title === "Заменить на «param»"
    );

    assert.strictEqual(replacement.isPreferred, true);
    assert.deepStrictEqual(
        editsOf(replacement).map(edit => edit.newText),
        ["param"]
    );
});

test("объявление переменной предлагается в начало тела", () => {
    const found = actionsFor([
        "Macro Test(param)",
        "  Var value;",
        "  completelyOther = value;",
        "End;"
    ]);
    const declaration = found.actions.find(
        item => item.title.startsWith("Объявить переменную")
    );

    assert.ok(declaration, "ожидалось объявление: " + titles(found.actions));

    const [edit] = editsOf(declaration);

    assert.strictEqual(edit.newText, "  Var completelyOther;\n");
    assert.strictEqual(
        edit.range.start.line,
        1,
        "объявление вставляется первой строкой тела процедуры"
    );
});

test("два одинаково близких имени замену не предлагают", () => {
    const found = actionsFor([
        "Macro Test()",
        "  Var parma, parmb;",
        "  parmc = 1;",
        "End;"
    ]);

    assert.deepStrictEqual(
        titles(found.actions).filter(title => title.startsWith("Заменить")),
        [],
        "выбирать между parma и parmb не на чем"
    );
    assert.ok(
        titles(found.actions).some(title => title.startsWith("Объявить")),
        "объявить переменную всё равно можно"
    );
});

test("процедура с похожим именем заменой не предлагается", () => {
    const found = actionsFor([
        "Macro Handler()",
        "  return 1;",
        "End;",
        "Macro Test()",
        "  Var value;",
        "  Handlar = value;",
        "End;"
    ]);

    assert.deepStrictEqual(
        titles(found.actions).filter(title => title.startsWith("Заменить")),
        [],
        "процедура не может быть целью присваивания"
    );
});

test("далёкое имя заменой не считается", () => {
    const found = actionsFor([
        "Macro Test()",
        "  Var counter;",
        "  xyz = 1;",
        "End;"
    ]);

    assert.deepStrictEqual(
        titles(found.actions).filter(title => title.startsWith("Заменить")),
        []
    );
});

if (failed > 0) {
    console.error(`\nПройдено: ${passed}\nОшибок: ${failed}`);
    process.exitCode = 1;
} else {
    console.log(`\nПройдено: ${passed}\nОшибок: ${failed}`);
}

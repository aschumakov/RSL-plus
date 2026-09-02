"use strict";

/**
 * Поиск использований и иерархия вызовов видят строковые вызовы.
 *
 * В RSL процедуру запросто вызывают строкой: `ExecMacro("Handler")`,
 * `ExecMacroFile("lib.mac", "Handler")`, `R2M(obj, "Method")`, имя обработчика
 * в известной позиции. Обход идентификаторов их не видит — там строка, а не
 * имя, — и «кто это вызывает» показывало неполную картину.
 *
 * Разбор общий с переходом: см. callSiteFacts.
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

const { findRslReferences } = require("../server/out/analysis/references");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const LIB = "file:///d:/dynamic/lib.mac";
const USER = "file:///d:/dynamic/user.mac";

const LIB_SOURCE = [
    "Macro Handler(value)",
    "  return value;",
    "End;",
    "",
    "Class THolder",
    "  Macro Load(id)",
    "    return id;",
    "  End;",
    "End;",
    ""
].join("\n");

/** Проект: user подключает lib и зовёт Handler разными способами. */
function project(userSource) {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([LIB, USER]);
    /*
     * Оба документа открыты: у внешней сводки нет потока токенов, а быстрый
     * путь поиска обходит именно открытые модели.
     */
    index.updateOpenModule(LIB, LIB_SOURCE, 1);
    index.updateOpenModule(USER, userSource, 1);
    index.catalog.record(index.getModule(LIB));
    index.catalog.record(index.getModule(USER));

    return index;
}

/**
 * Использования Handler из lib среди ОТКРЫТЫХ документов.
 *
 * Берётся быстрый путь поиска: он не требует ни постоянных хранилищ, ни
 * обхода диска, а проверяется здесь именно разбор мест вызова.
 */
async function referencesToHandler(userSource) {
    const index = project(userSource);
    const resolver = new RslScopeResolver(index);
    const lib = index.getModule(LIB);
    const target = lib.symbolTree.children
        .find(symbol => symbol.name === "Handler");


    const found = findRslReferences(
        index,
        resolver,
        LIB,
        target.selectionRange.start,
        false
    );

    return found
        .filter(item => item.uri === USER)
        .map(item => item.range.start.line);
}

test("обычный вызов по-прежнему находится", async () => {
    const lines = await referencesToHandler(
        "Import lib;\nMacro Run()\n  return Handler(1);\nEnd;\n"
    );

    assert.deepStrictEqual(lines, [2]);
});

test("ExecMacro со строкой находится", async () => {
    const lines = await referencesToHandler(
        'Import lib;\nMacro Run()\n  return ExecMacro("Handler", 1);\nEnd;\n'
    );

    assert.deepStrictEqual(
        lines,
        [2],
        "вызов строкой — такое же использование"
    );
});

test("ExecMacroFile с именем файла находится", async () => {
    const lines = await referencesToHandler(
        'Macro Run()\n  return ExecMacroFile("lib.mac", "Handler");\nEnd;\n'
    );

    assert.deepStrictEqual(
        lines,
        [1],
        "файл назван прямо, Import для этого не нужен"
    );
});

test("обработчик в известной позиции находится", async () => {
    const lines = await referencesToHandler(
        'Import lib;\nMacro Run()\n  RunDialog(form, "Handler");\nEnd;\n'
    );

    assert.deepStrictEqual(lines, [2]);
});

test("обычная строка использованием не считается", async () => {
    const lines = await referencesToHandler(
        'Import lib;\nMacro Run()\n  MsgBox("Handler");\nEnd;\n'
    );

    assert.deepStrictEqual(
        lines,
        [],
        "текст сообщения — не вызов"
    );
});

test("собранное на ходу имя не угадывается", async () => {
    const lines = await referencesToHandler(
        'Import lib;\nMacro Run()\n  ExecMacro(prefix + "Handler");\nEnd;\n'
    );

    assert.deepStrictEqual(lines, []);
});

test("имя из чужого модуля не притягивается", async () => {
    /*
     * Тот же текст вызова, но Import нет и файл не назван: имя ниоткуда не
     * разрешается, и показывать его использованием нельзя.
     */
    const lines = await referencesToHandler(
        'Macro Run()\n  return ExecMacro("Handler", 1);\nEnd;\n'
    );

    assert.deepStrictEqual(lines, []);
});

test("несколько форм в одном файле", async () => {
    const lines = await referencesToHandler([
        "Import lib;",
        "Macro Run()",
        "  Handler(1);",
        '  ExecMacro("Handler", 2);',
        '  ExecMacroFile("lib.mac", "Handler");',
        "End;",
        ""
    ].join("\n"));

    assert.deepStrictEqual(lines, [2, 3, 4]);
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

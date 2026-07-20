"use strict";

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

const { CBase } = require("../server/out/common");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { buildRslDiagnostics } = require("../server/out/diagnostics");

let passed = 0;
let failed = 0;

function test(name, action) {
    try {
        action();
        passed++;
        console.log(`[OK] ${name}`);
    } catch (error) {
        failed++;
        console.error(`[FAIL] ${name}`);
        console.error(error);
    }
}

function createModule(index, uri, source) {
    const tree = new CBase(source, 0);
    return index.updateModule(uri, source, tree, 1, true);
}

function diagnosticsFor(source, setup) {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles(["file:///main.mac"]);

    if (setup) {
        setup(index);
    }

    const module = createModule(index, "file:///main.mac", source);
    return buildRslDiagnostics(module, index);
}

function codes(items) {
    return items.map(item => item.code);
}

test("Неиспользуемая локальная переменная попадает в Problems", () => {
    const source = [
        "Macro Test(usedParam, unusedParam)",
        "    Var usedValue, unusedValue;",
        "    usedValue = usedParam;",
        "End;"
    ].join("\n");
    const diagnostics = diagnosticsFor(source);
    const unused = diagnostics.filter(item => item.code === "unused-declaration");

    assert.deepStrictEqual(
        unused.map(item => item.message).sort(),
        [
            "Параметр unusedParam объявлен, но не используется",
            "Переменная unusedValue объявлена, но не используется"
        ]
    );
});

test("Публичная глобальная переменная не считается неиспользуемой", () => {
    const diagnostics = diagnosticsFor("Var PublicValue;");
    assert.ok(!codes(diagnostics).includes("unused-declaration"));
});

test("Private-глобальная переменная проверяется", () => {
    const diagnostics = diagnosticsFor("Private Var HiddenValue;");
    assert.ok(codes(diagnostics).includes("unused-declaration"));
});

test("Неиспользуемый Import определяется по публичным символам", () => {
    const source = "Import lib\\common;\nMacro Test()\nEnd;";
    const diagnostics = diagnosticsFor(source, index => {
        index.registerWorkspaceFiles([
            "file:///main.mac",
            "file:///lib/common.mac"
        ]);
        createModule(
            index,
            "file:///lib/common.mac",
            "Macro Shared()\nEnd;\nVar GlobalValue;"
        );
    });

    assert.ok(codes(diagnostics).includes("unused-import"));
});

test("Использованный символ снимает предупреждение Import", () => {
    const source = [
        "Import lib\\common;",
        "Macro Test()",
        "    Shared();",
        "End;"
    ].join("\n");
    const diagnostics = diagnosticsFor(source, index => {
        index.registerWorkspaceFiles([
            "file:///main.mac",
            "file:///lib/common.mac"
        ]);
        createModule(index, "file:///lib/common.mac", "Macro Shared()\nEnd;");
    });

    assert.ok(!codes(diagnostics).includes("unused-import"));
});

test("ExecMacro со строковым именем считается использованием Import", () => {
    const source = [
        "Import lib\\common;",
        "Macro Test()",
        "    ExecMacro(\"Shared\");",
        "End;"
    ].join("\n");
    const diagnostics = diagnosticsFor(source, index => {
        index.registerWorkspaceFiles([
            "file:///main.mac",
            "file:///lib/common.mac"
        ]);
        createModule(index, "file:///lib/common.mac", "Macro Shared()\nEnd;");
    });

    assert.ok(!codes(diagnostics).includes("unused-import"));
});


test("Локальная переменная не маскирует неиспользуемый Import", () => {
    const source = [
        "Import lib\\common;",
        "Macro Test()",
        "    Var value;",
        "    value = 1;",
        "End;"
    ].join("\n");
    const diagnostics = diagnosticsFor(source, index => {
        index.registerWorkspaceFiles([
            "file:///main.mac",
            "file:///lib/common.mac"
        ]);
        createModule(index, "file:///lib/common.mac", "Var value;");
    });

    assert.ok(codes(diagnostics).includes("unused-import"));
});

test("Использование символа транзитивного Import учитывается", () => {
    const source = [
        "Import lib\\common;",
        "Macro Test()",
        "    Shared();",
        "End;"
    ].join("\n");
    const diagnostics = diagnosticsFor(source, index => {
        index.registerWorkspaceFiles([
            "file:///main.mac",
            "file:///lib/common.mac",
            "file:///lib/utils.mac"
        ]);
        createModule(index, "file:///lib/utils.mac", "Macro Shared()\nEnd;");
        createModule(index, "file:///lib/common.mac", "Import lib\\utils;");
    });

    assert.ok(!codes(diagnostics).includes("unused-import"));
});

test("Лишняя и незакрытая круглая скобка определяются", () => {
    const missing = diagnosticsFor([
        "Macro Test()",
        "    Call((1);",
        "End;"
    ].join("\n"));
    const extra = diagnosticsFor([
        "Macro Test()",
        "    Other());",
        "End;"
    ].join("\n"));

    assert.ok(codes(missing).includes("missing-closing-bracket"));
    assert.ok(codes(extra).includes("extra-closing-bracket"));
});

test("Лишний END и недостающий END определяются", () => {
    const extra = diagnosticsFor("End;");
    const missing = diagnosticsFor("Macro Test()\nIf ready\nDoWork();");

    assert.ok(codes(extra).includes("extra-end"));
    assert.strictEqual(
        missing.filter(item => item.code === "missing-end").length,
        2
    );
});

test("END и скобки внутри SQL-блока игнорируются", () => {
    const diagnostics = diagnosticsFor([
        "Macro Test()",
        "[",
        "begin",
        "  if x = '(' then",
        "    null;",
        "  end if;",
        "end;",
        "];",
        "End;"
    ].join("\n"));

    assert.ok(!codes(diagnostics).includes("extra-end"));
    assert.ok(!codes(diagnostics).includes("missing-end"));
    assert.ok(!codes(diagnostics).includes("missing-closing-bracket"));
});

test("Незакрытые строка, комментарий и SQL-блок диагностируются", () => {
    assert.ok(codes(diagnosticsFor('Macro Test()\nvalue = "abc')).includes("unclosed-string"));
    assert.ok(codes(diagnosticsFor("/* comment")).includes("unclosed-comment"));
    assert.ok(codes(diagnosticsFor("[ select 1")).includes("unclosed-square-block"));
});

test("Повторное объявление и повторный Import диагностируются", () => {
    const source = [
        "Import common, common;",
        "Macro Test()",
        "    Var value, value;",
        "End;"
    ].join("\n");
    const diagnostics = diagnosticsFor(source);

    assert.ok(codes(diagnostics).includes("duplicate-import"));
    assert.ok(codes(diagnostics).includes("duplicate-declaration"));
});

console.log("");
console.log(`Пройдено: ${passed}`);
console.log(`Ошибок: ${failed}`);

if (failed > 0) {
    process.exitCode = 1;
}

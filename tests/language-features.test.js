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
const { buildRslCodeActions } = require("../server/out/codeActions");
const { buildRslDiagnostics } = require("../server/out/diagnostics");
const {
    findRslReferences
} = require("../server/out/analysis/references");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { buildRslSemanticTokens } = require("../server/out/semanticTokens");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

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

function createModule(index, uri, source, open = true) {
    return index.updateModule(
        uri,
        source,
        new CBase(source, 0),
        1,
        open
    );
}

function paramsFor(module, diagnostic) {
    return {
        textDocument: { uri: module.uri },
        range: diagnostic.range,
        context: { diagnostics: [diagnostic] }
    };
}

test("Quick Fix удаляет DEBUGBREAK", () => {
    const index = new WorkspaceIndex();
    const source = "Macro Test()\n DebugBreak;\nEnd;";
    const module = createModule(index, "file:///main.mac", source);
    const diagnostic = buildRslDiagnostics(module, index)
        .find(item => item.code === "debugbreak");
    assert.ok(diagnostic);

    const actions = buildRslCodeActions(
        module,
        paramsFor(module, diagnostic)
    );
    assert.strictEqual(actions.length, 1);
    const edit = actions[0].edit.changes[module.uri][0];
    assert.strictEqual(edit.newText, "");
    assert.strictEqual(edit.range.start.line, 1);
    assert.strictEqual(edit.range.end.line, 2);
});

test("Quick Fix удаляет один элемент из Import", () => {
    const index = new WorkspaceIndex();
    createModule(index, "file:///common.mac", "Macro Shared()\nEnd;", false);
    const source = "Import common, other;\nMacro Test()\nEnd;";
    const module = createModule(index, "file:///main.mac", source);
    const diagnostic = buildRslDiagnostics(module, index)
        .find(item => item.code === "unused-import");
    assert.ok(diagnostic);

    const actions = buildRslCodeActions(
        module,
        paramsFor(module, diagnostic)
    );
    assert.strictEqual(actions.length, 1);
    const edit = actions[0].edit.changes[module.uri][0];
    assert.strictEqual(edit.newText, "");
    assert.strictEqual(edit.range.start.line, 0);
});

test("Find All References находит объявление и вызов", () => {
    const index = new WorkspaceIndex();
    const library = "Macro Shared(value)\nEnd;";
    const main = "Import library;\nMacro Test()\n Shared(1);\nEnd;";
    /* Синхронный helper работает по открытым моделям; workspace-поиск — async. */
    createModule(index, "file:///library.mac", library, true);
    createModule(index, "file:///main.mac", main);
    const resolver = new RslScopeResolver(index);
    const references = findRslReferences(
        index,
        resolver,
        "file:///main.mac",
        main.indexOf("Shared"),
        true
    );

    assert.strictEqual(references.length, 2);
    assert.ok(references.some(item => item.uri === "file:///library.mac"));
    assert.ok(references.some(item => item.uri === "file:///main.mac"));
});

test("Find All References умеет исключать объявление", () => {
    const index = new WorkspaceIndex();
    const source = "Macro Shared()\nEnd;\nMacro Test()\n Shared();\nEnd;";
    createModule(index, "file:///main.mac", source);
    const resolver = new RslScopeResolver(index);
    const references = findRslReferences(
        index,
        resolver,
        "file:///main.mac",
        source.lastIndexOf("Shared"),
        false
    );
    assert.strictEqual(references.length, 1);
    assert.strictEqual(references[0].range.start.line, 3);
});

test("Semantic Tokens помечают объявление Macro", () => {
    const index = new WorkspaceIndex();
    const source = "Macro Shared(value)\n Var result;\n result = value;\nEnd;";
    const module = createModule(index, "file:///main.mac", source);
    const tokens = buildRslSemanticTokens(module, index).data;

    assert.ok(tokens.length >= 5);
    assert.strictEqual(tokens[3], 2);
    assert.strictEqual(tokens[4] & 1, 1);
});

test("Semantic Tokens помечают параметр отдельно от переменной", () => {
    const index = new WorkspaceIndex();
    const source = "Macro Shared(value)\n value = 1;\nEnd;";
    const module = createModule(index, "file:///main.mac", source);
    const tokens = buildRslSemanticTokens(module, index).data;
    const tokenTypes = [];

    for (let offset = 0; offset < tokens.length; offset += 5) {
        tokenTypes.push(tokens[offset + 3]);
    }

    assert.ok(tokenTypes.includes(4));
});

console.log("");
console.log(`Пройдено: ${passed}`);
console.log(`Ошибок: ${failed}`);

if (failed > 0) {
    process.exitCode = 1;
}

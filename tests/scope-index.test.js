"use strict";

const assert = require("assert");
const path = require("path");

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
const { RslScopeResolver } = require("../server/out/scopeResolver");

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

function offsetInside(source, value, occurrence = 0) {
    let offset = -1;
    let from = 0;

    for (let index = 0; index <= occurrence; index++) {
        offset = source.indexOf(value, from);
        assert.notStrictEqual(offset, -1);
        from = offset + value.length;
    }

    return offset + Math.floor(value.length / 2);
}

function createModule(index, uri, source) {
    const tree = new CBase(source, 0);
    index.updateModule(uri, source, tree, 1, true);
    return tree;
}

test("Локальная переменная другого Macro не видна", () => {
    const source = [
        "Macro First()",
        "    Var result;",
        "    result = 1;",
        "End;",
        "Macro Second()",
        "    result = 2;",
        "End;"
    ].join("\n");
    const index = new WorkspaceIndex();
    const tree = createModule(index, "file:///main.mac", source);
    const resolver = new RslScopeResolver(index);
    const resolved = resolver.resolveAt(
        "file:///main.mac",
        tree,
        offsetInside(source, "result", 2)
    );

    assert.strictEqual(resolved, undefined);
});

test("Ближайшая локальная переменная имеет приоритет", () => {
    const source = [
        "Var result;",
        "Macro Test()",
        "    Var result;",
        "    result = 2;",
        "End;"
    ].join("\n");
    const index = new WorkspaceIndex();
    const tree = createModule(index, "file:///main.mac", source);
    const resolver = new RslScopeResolver(index);
    const resolved = resolver.resolveAt(
        "file:///main.mac",
        tree,
        offsetInside(source, "result", 2)
    );

    assert.ok(resolved);
    assert.strictEqual(resolved.object.Range.start, source.indexOf("result", 5));
});

test("Метод разрешается по типу объекта слева от точки", () => {
    const source = [
        "Class Service",
        "    Macro Run()",
        "        return true;",
        "    End;",
        "End;",
        "Macro Test()",
        "    Var service: Service;",
        "    service.Run();",
        "End;"
    ].join("\n");
    const index = new WorkspaceIndex();
    const tree = createModule(index, "file:///main.mac", source);
    const resolver = new RslScopeResolver(index);
    const resolved = resolver.resolveAt(
        "file:///main.mac",
        tree,
        offsetInside(source, "Run", 1)
    );

    assert.ok(resolved);
    assert.strictEqual(resolved.object.Name, "Run");
});

test("Completion после частично введённого метода остаётся объектным", () => {
    const source = [
        "Class Service",
        "    Macro Run()",
        "    End;",
        "End;",
        "Macro Test()",
        "    Var service: Service;",
        "    service.Ru",
        "End;"
    ].join("\n");
    const index = new WorkspaceIndex();
    const tree = createModule(index, "file:///main.mac", source);
    const resolver = new RslScopeResolver(index);
    const completions = resolver.getCompletions(
        "file:///main.mac",
        tree,
        source.indexOf("service.Ru") + "service.Ru".length
    );

    assert.ok(completions.some(item => item.label === "Run"));
});

test("Private-метод доступен через this внутри своего класса", () => {
    const source = [
        "Class Service",
        "    Private Macro Hidden()",
        "    End;",
        "    Macro Test()",
        "        this.Hidden();",
        "    End;",
        "End;"
    ].join("\n");
    const index = new WorkspaceIndex();
    const tree = createModule(index, "file:///main.mac", source);
    const resolver = new RslScopeResolver(index);
    const resolved = resolver.resolveAt(
        "file:///main.mac",
        tree,
        offsetInside(source, "Hidden", 1)
    );

    assert.ok(resolved);
    assert.strictEqual(resolved.object.Name, "Hidden");
});

test("Поиск идёт только по графу Import", () => {
    const index = new WorkspaceIndex();
    createModule(
        index,
        "file:///lib/common.mac",
        "Macro Shared()\nEnd;"
    );
    createModule(
        index,
        "file:///lib/unrelated.mac",
        "Macro Hidden()\nEnd;"
    );
    const mainSource = [
        "Import lib\\common;",
        "Macro Test()",
        "    Shared();",
        "    Hidden();",
        "End;"
    ].join("\n");
    const mainTree = createModule(
        index,
        "file:///main.mac",
        mainSource
    );
    const resolver = new RslScopeResolver(index);

    const shared = resolver.resolveAt(
        "file:///main.mac",
        mainTree,
        offsetInside(mainSource, "Shared")
    );
    const hidden = resolver.resolveAt(
        "file:///main.mac",
        mainTree,
        offsetInside(mainSource, "Hidden")
    );

    assert.ok(shared);
    assert.strictEqual(shared.uri, "file:///lib/common.mac");
    assert.strictEqual(hidden, undefined);
});

test("Ленивый индекс находит файл проекта по относительному пути", () => {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([
        "file:///project/lib/common.mac",
        "file:///project/other/common.mac",
        "file:///project/main.mac"
    ]);

    assert.strictEqual(
        index.findWorkspaceFileUri("lib\\common"),
        "file:///project/lib/common.mac"
    );
});

test("Reverse import graph возвращает зависимые модули", () => {
    const index = new WorkspaceIndex();
    createModule(
        index,
        "file:///main.mac",
        "Import lib\\common;"
    );
    createModule(
        index,
        "file:///lib/common.mac",
        "Macro Shared()\nEnd;"
    );

    assert.deepStrictEqual(
        index.getDependents("file:///lib/common.mac"),
        ["file:///main.mac"]
    );
});

console.log("");
console.log(`Пройдено: ${passed}`);
console.log(`Ошибок: ${failed}`);

if (failed > 0) {
    process.exitCode = 1;
}

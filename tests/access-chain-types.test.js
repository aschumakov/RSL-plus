"use strict";

/**
 * Типизация цепочек обращений.
 *
 * Прежде тип определялся только у простого получателя-идентификатора. Всё,
 * что сложнее — вызов, обращение к полю поля, вызов метода результата, — не
 * типизировалось вовсе: подсказка после точки молчала, состав класса никто не
 * спрашивал, а проверка «такого члена нет» тем более.
 *
 * Разбор идёт от точки назад и только вокруг позиции: полной проверки типов
 * файла здесь нет и не нужно. Тип каждого звена даёт состав предыдущего — тот
 * же самый состав, который видят подсказка, переход и Hover.
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
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { getDefaults } = require("../server/out/defaults");
const {
    PlatformModuleCatalog
} = require("../server/out/builtins/platformModuleCatalog");
const { RslTypeEngine } = require("../server/out/analysis/typeEngine");
const {
    readRslAccessChain,
    findRslChainDot
} = require("../server/out/analysis/accessChain");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const URI = "file:///d:/chain/main.mac";

const SOURCE = [
    "Import rsd;",
    "Class TChild",
    "  Var Value: TStream;",
    "End;",
    "Class THolder",
    "  Var Child: TChild;",
    "End;",
    "Macro GetRecordset(): RsdRecordset",
    "End;",
    "Macro GetObject(): THolder",
    "End;",
    "Macro T()",
    "  Var command: RsdCommand;",
    "  Var obj: THolder;",
    "  GetRecordset().MoveNext;",
    "  command.Execute().MoveNext;",
    "  obj.Child.Value;",
    "  GetObject().Child.Value;",
    "End;",
    ""
].join("\n");

let stand;

async function engineStand() {
    if (!stand) {
        const catalog = new PlatformModuleCatalog({ log: () => undefined });

        await catalog.ensureModules(["rsd"]);

        const index = new WorkspaceIndex();

        index.registerWorkspaceFiles([URI]);

        const module = index.updateOpenModule(URI, SOURCE, 1);
        const resolver = new RslScopeResolver(index, getDefaults(), catalog);

        stand = {
            index,
            module,
            resolver,
            engine: new RslTypeEngine(index, resolver)
        };
    }

    return stand;
}

/** Тип получателя в конце написанной цепочки. */
async function receiverAt(chain) {
    const { engine } = await engineStand();
    const at = SOURCE.indexOf(chain) + chain.length;

    return engine.resolveReceiverType(URI, at);
}

test("вызов процедуры типизируется по результату", async () => {
    const type = await receiverAt("GetRecordset().MoveNext");

    assert.strictEqual(type.kind, "class");
    assert.strictEqual(type.name, "RsdRecordset");
    assert.strictEqual(type.source, "platform");
});

test("вызов метода результата типизируется", async () => {
    const type = await receiverAt("command.Execute().MoveNext");

    assert.strictEqual(type.name, "RsdRecordset");
});

test("поле поля типизируется", async () => {
    const type = await receiverAt("obj.Child.Value");

    assert.strictEqual(type.name, "TChild");
    assert.strictEqual(type.source, "workspace");
});

test("поле результата вызова типизируется", async () => {
    const type = await receiverAt("GetObject().Child.Value");

    assert.strictEqual(type.name, "TChild");
});

test("состав цепочки — тот же общий набор", async () => {
    /*
     * Главный инвариант: состав, полученный по цепочке, ничем не отличается
     * от состава, полученного по имени. Иначе подсказка после `x.` и после
     * `f().` показывала бы разное.
     */
    const { engine } = await engineStand();
    const at = SOURCE.indexOf("command.Execute().MoveNext") +
        "command.Execute().MoveNext".length;
    const type = engine.resolveReceiverType(URI, at);
    const viaChain = engine.resolveClass(URI, type, at);
    const viaName = engine.getMemberSet(URI, "RsdRecordset", at);

    assert.strictEqual(viaChain.completeness, viaName.completeness);
    assert.strictEqual(viaChain.source, viaName.source);
    assert.strictEqual(viaChain.levels.length, viaName.levels.length);
});

test("звенья цепочки читаются от точки назад", async () => {
    const { module } = await engineStand();
    const tokens = module.syntax.tokens;
    const written = "GetObject().Child.Value";
    const at = SOURCE.indexOf(written) + written.length;
    const dot = findRslChainDot(tokens, at);

    assert.ok(dot >= 0, "точка обязана найтись");

    const chain = readRslAccessChain(tokens, dot);

    assert.deepStrictEqual(
        chain.map(item => item.name + (item.call ? "()" : "")),
        ["GetObject()", "Child"],
        "получателем служит всё, что слева от последней точки"
    );
});

test("не цепочка — не цепочка", async () => {
    const { module } = await engineStand();
    const tokens = module.syntax.tokens;
    const at = SOURCE.indexOf("Var command") + 4;

    assert.strictEqual(
        findRslChainDot(tokens, at),
        -1,
        "в обычной позиции обращения к члену нет"
    );
});

test("неизвестное звено обрывает цепочку, а не выдумывает тип", async () => {
    const { engine } = await engineStand();
    const index = new WorkspaceIndex();
    const uri = "file:///d:/chain/other.mac";

    index.registerWorkspaceFiles([uri]);

    const source = "Macro T()\n  Var v;\n  v.НетТакого.Дальше;\nEnd;\n";

    index.updateOpenModule(uri, source, 1);

    const resolver = new RslScopeResolver(index, getDefaults());
    const other = new RslTypeEngine(index, resolver);
    const at = source.indexOf("v.НетТакого.Дальше") +
        "v.НетТакого.Дальше".length;
    const type = other.resolveReceiverType(uri, at);

    assert.ok(
        type.kind === "unknown" || type.kind === "variant",
        "у необъявленного получателя тип не выдумывается: " + type.kind
    );

    void engine;
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

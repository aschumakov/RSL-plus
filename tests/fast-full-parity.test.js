"use strict";

/**
 * Быстрый и полный пути обязаны видеть одну картину.
 *
 * Подсказка отвечает дважды: из компактного индекса версии, пока полная
 * модель считается, и из модели, когда она готова. Пользователь этой разницы
 * знать не должен, и одно различие между ними недопустимо категорически:
 *
 *     недопустимо   fast -> MakeArray, заготовки, глобальные процедуры
 *                   full -> MoveNext
 *
 * То есть после точки один путь показывает общие имена, а другой члены. Это
 * не «менее точный ответ», а неверный: таких имён в этой позиции не бывает.
 *
 * Допустимо другое:
 *
 *     допустимо     fast -> MoveNext...        full -> MoveNext...
 *     допустимо     fast -> пусто (member-only) full -> MoveNext...
 *
 * Второе — честное «пока не знаю»: ответ помечается приблизительным и
 * спрашивается заново, когда модель готова.
 *
 * И вторая половина: если оба пути разрешили символ, это обязан быть один и
 * тот же символ. Разные ответы на один вопрос хуже отсутствия ответа.
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
const {
    buildRslFastMemberCompletions
} = require("../server/out/features/fastCompletionProvider");
const {
    getFastCompletionIndex
} = require("../server/out/features/fastCompletionIndex");
const {
    collectRslClassMembers
} = require("../server/out/features/fastClassChain");
const { RslTypeEngine } = require("../server/out/analysis/typeEngine");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const URI = "file:///d:/parity/main.mac";

/**
 * Имена, которых после точки не бывает ни при каком незнании.
 *
 * Встроенная процедура, заготовка и глобальное имя — то самое, что
 * показывалось вместо членов.
 */
const GLOBALS = ["MakeArray", "MsgBox", "StrLen", "Macro", "If"];

let catalog;

async function platform() {
    if (!catalog) {
        catalog = new PlatformModuleCatalog({ log: () => undefined });
        await catalog.ensureModules(["rsd"]);
    }

    return catalog;
}

/** Оба ответа на одну позицию: быстрый и полный. */
async function bothPaths(source, marker) {
    const known = await platform();
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([URI]);

    const module = index.updateOpenModule(URI, source, 1);
    const resolver = new RslScopeResolver(index, getDefaults(), known);
    const offset = source.indexOf(marker) + marker.length;
    const snapshot = {
        uri: URI,
        version: 1,
        text: source,
        lex: module.lex
    };
    const fastIndex = getFastCompletionIndex(snapshot);
    const fast = buildRslFastMemberCompletions(
        snapshot,
        offset,
        className => collectRslClassMembers(className, {
            resolver,
            uri: URI,
            imports: module.imports,
            fastIndex,
            offset
        }),
        fastIndex
    );
    const full = resolver.getCompletions(URI, module.symbolTree, offset);

    return {
        index,
        module,
        resolver,
        offset,
        fast,
        fastLabels: fast.kind === "resolved-members"
            ? fast.items.map(item => String(item.label))
            : [],
        fullLabels: full.map(item => String(item.label))
    };
}

function hasGlobals(labels) {
    return GLOBALS.filter(name =>
        labels.some(label => label.toLowerCase() === name.toLowerCase()));
}

test("после точки ни один путь не показывает общих имён", async () => {
    /*
     * Перебираются все состояния незнания разом: известный класс, класс без
     * типа, необъявленное имя. Общих имён не должно быть ни в одном.
     */
    const cases = [
        ["известный класс", [
            "Import rsd;",
            "Macro T()",
            "  Var rs: RsdRecordset;",
            "  rs.m"
        ].join("\n"), "  rs.m"],
        ["неизвестный класс", [
            "Macro T()",
            "  Var q: НетТакогоКласса;",
            "  q.m"
        ].join("\n"), "  q.m"],
        ["необъявленное имя", [
            "Macro T()",
            "  unknownThing.m"
        ].join("\n"), "  unknownThing.m"],
        ["нетипизированный параметр", [
            "Macro T(param)",
            "  param.m"
        ].join("\n"), "  param.m"]
    ];

    for (const [label, source, marker] of cases) {
        const answer = await bothPaths(source, marker);

        assert.deepStrictEqual(
            hasGlobals(answer.fastLabels),
            [],
            label + ": быстрый путь показал общие имена: " +
                answer.fastLabels.slice(0, 8).join(", ")
        );
        assert.deepStrictEqual(
            hasGlobals(answer.fullLabels),
            [],
            label + ": полный путь показал общие имена: " +
                answer.fullLabels.slice(0, 8).join(", ")
        );
    }
});

test("известный класс: оба пути дают его члены", async () => {
    const answer = await bothPaths(
        [
            "Import rsd;",
            "Macro T()",
            "  Var rs: RsdRecordset;",
            "  rs.m"
        ].join("\n"),
        "  rs.m"
    );

    assert.strictEqual(
        answer.fast.kind,
        "resolved-members",
        "быстрый путь обязан узнать класс"
    );
    assert.ok(
        answer.fastLabels.some(label => /^movenext$/iu.test(label)),
        "быстрый: " + answer.fastLabels.slice(0, 8).join(", ")
    );
    assert.ok(
        answer.fullLabels.some(label => /^movenext$/iu.test(label)),
        "полный: " + answer.fullLabels.slice(0, 8).join(", ")
    );
});

test("неизвестный тип: пустой member-only, а не общий список", async () => {
    const answer = await bothPaths(
        [
            "Macro T()",
            "  Var q: НетТакогоКласса;",
            "  q.m"
        ].join("\n"),
        "  q.m"
    );

    assert.strictEqual(
        answer.fast.kind,
        "unresolved-member-access",
        "быстрый путь обязан честно сказать «пока не знаю»"
    );
    assert.deepStrictEqual(
        answer.fullLabels,
        [],
        "полный путь тоже ничего не предлагает"
    );
});

test("состав у обоих путей один и тот же", async () => {
    /*
     * Не просто «оба непусты»: состав обязан совпасть по именам. Разные
     * наборы означали бы, что у путей разные представления о классе.
     */
    const answer = await bothPaths(
        [
            "Import rsd;",
            "Macro T()",
            "  Var rs: RsdRecordset;",
            "  rs."
        ].join("\n"),
        "  rs."
    );
    const fast = [...answer.fastLabels].map(item => item.toLowerCase()).sort();
    const full = [...answer.fullLabels].map(item => item.toLowerCase()).sort();

    assert.deepStrictEqual(
        fast,
        full,
        "составы разошлись: только у быстрого " +
            fast.filter(item => !full.includes(item)).join(", ") +
            "; только у полного " +
            full.filter(item => !fast.includes(item)).join(", ")
    );
});

test("тождество символа: оба пути указывают на один член", async () => {
    /*
     * Вторая половина совпадения: если символ разрешили оба, это обязан быть
     * один и тот же член одного и того же класса.
     */
    const source = [
        "Import rsd;",
        "Macro T()",
        "  Var rs: RsdRecordset;",
        "  rs.MoveNext();",
        "End;",
        ""
    ].join("\n");
    const answer = await bothPaths(source, "  rs.MoveNext");
    const engine = new RslTypeEngine(answer.index, answer.resolver);
    const at = source.indexOf("rs.MoveNext");
    const viaResolver = answer.resolver.resolveMemberReference(
        URI,
        answer.module.symbolTree,
        at,
        "MoveNext"
    );
    const viaEngine = engine.resolveMember(URI, at, "MoveNext");

    assert.ok(viaResolver, "resolver обязан разрешить член");
    assert.ok(viaEngine, "TypeEngine обязан разрешить тот же член");
    assert.strictEqual(
        viaEngine.symbol.name.toLowerCase(),
        viaResolver.symbol.name.toLowerCase()
    );
    assert.strictEqual(viaEngine.uri, viaResolver.uri);

    /* И тип получателя у движка тот же класс, что нашла подсказка. */
    const type = engine.resolveReceiverType(URI, source.indexOf("rs.Move") + 3);

    assert.strictEqual(type.name, "RsdRecordset");
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

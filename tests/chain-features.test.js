"use strict";

/**
 * Цепочки обращений в настоящих features.
 *
 * Типизировать цепочку слой типов умел, а сами features по-прежнему искали
 * идентификатор непосредственно перед точкой. Следствий было два, и оба
 * плохие.
 *
 * Первое: `GetRecordset().` и `cmd.Execute().` не считались обращением к
 * члену вовсе — и после точки показывался ОБЩИЙ список имён. Это прямое
 * нарушение правила «globals после точки — никогда», и нарушали его оба пути.
 *
 * Второе: `cmd.Execute().MoooveNext()` не проверялся: получателя не нашли,
 * значит и состав не спросили.
 *
 * Здесь закреплено и то, и другое — на реальных вызовах, а не на помощниках.
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
    getRslMemberSet,
    rslMemberSetCompletions
} = require("../server/out/analysis/memberSet");
const {
    readRslAccessChain,
    findRslChainDot
} = require("../server/out/analysis/accessChain");
const {
    collectUnknownVariables
} = require("../server/out/diagnostics/unknownVariableDiagnostics");
const {
    buildRslFastMemberCompletions
} = require("../server/out/features/fastCompletionProvider");
const {
    getFastCompletionIndex
} = require("../server/out/features/fastCompletionIndex");
const {
    collectRslClassMembers
} = require("../server/out/features/fastClassChain");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const URI = "file:///d:/chainfeat/main.mac";

/** Имена, которых после точки не бывает ни при каком незнании. */
const GLOBALS = ["MakeArray", "MsgBox", "StrLen"];

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
    "Macro T()",
    "  Var cmd: RsdCommand;",
    "  Var obj: THolder;",
    "  GetRecordset().",
    "  cmd.Execute().",
    "  obj.Child.",
    "End;",
    ""
].join("\n");

let stand;

async function board() {
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
            engine: new RslTypeEngine(index, resolver),
            snapshot: {
                uri: URI,
                version: 1,
                text: SOURCE,
                lex: module.lex
            }
        };
    }

    return stand;
}

/** Что покажут оба пути в позиции сразу за написанной цепочкой. */
async function afterChain(marker) {
    const { module, resolver, engine, snapshot } = await board();
    const offset = SOURCE.indexOf(marker) + marker.length;
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
    const resolverItems = resolver
        .getCompletions(URI, module.symbolTree, offset)
        .map(item => String(item.label));
    const type = engine.resolveReceiverType(URI, offset);
    const options = engine.memberOptions(URI, offset);
    const set = type.kind === "class"
        ? getRslMemberSet(type.name, options)
        : undefined;

    return {
        fast,
        resolverItems,
        type,
        chained: set && set.resolved
            ? rslMemberSetCompletions(set, options).map(item =>
                String(item.label))
            : []
    };
}

const CHAINS = [
    ["GetRecordset().", "RsdRecordset"],
    ["cmd.Execute().", "RsdRecordset"],
    ["obj.Child.", "TChild"]
];

test("после цепочки ни один путь не показывает общих имён", async () => {
    /*
     * Главное нарушение, которое здесь и закрывается: перед точкой стояла
     * закрывающая скобка, получателя «не нашли» — и вызывающий добирал общий
     * список. То есть `GetRecordset().` предлагал MakeArray.
     */
    for (const [marker] of CHAINS) {
        const answer = await afterChain(marker);
        const fastLabels = answer.fast.kind === "resolved-members"
            ? answer.fast.items.map(item => String(item.label))
            : [];

        for (const name of GLOBALS) {
            assert.ok(
                !fastLabels.some(label =>
                    label.toLowerCase() === name.toLowerCase()),
                marker + ": быстрый путь показал «" + name + "»"
            );
            assert.ok(
                !answer.resolverItems.some(label =>
                    label.toLowerCase() === name.toLowerCase()),
                marker + ": резолвер показал «" + name + "»"
            );
        }
    }
});

test("тип получателя цепочки определяется", async () => {
    for (const [marker, expected] of CHAINS) {
        const answer = await afterChain(marker);

        assert.strictEqual(
            answer.type.name,
            expected,
            marker + ": ожидался " + expected + ", получен «" +
                (answer.type.name || answer.type.kind) + "»"
        );
        assert.ok(
            answer.chained.length > 0,
            marker + ": состав обязан быть непустым"
        );
    }
});

test("состав по цепочке — тот же общий набор", async () => {
    const answer = await afterChain("cmd.Execute().");
    const { engine } = await board();
    const offset = SOURCE.indexOf("cmd.Execute().") +
        "cmd.Execute().".length;
    const byName = rslMemberSetCompletions(
        getRslMemberSet("RsdRecordset", engine.memberOptions(URI, offset)),
        engine.memberOptions(URI, offset)
    ).map(item => String(item.label));

    assert.deepStrictEqual(
        [...answer.chained].sort(),
        [...byName].sort(),
        "состав по цепочке и по имени класса обязан совпадать"
    );
});

test("цепочка не переходит через перевод строки", async () => {
    /*
     * Незаконченное `obj.` в конце строки — обычное состояние при наборе, и
     * предыдущая строка к этому обращению отношения не имеет. Без правила
     * цепочка склеивалась и приводила к чужому классу: `obj.Child.` после",
     * строки `cmd.Execute().` давала звенья cmd, Execute(), obj, Child.
     */
    const { module } = await board();
    const offset = SOURCE.indexOf("obj.Child.") + "obj.Child.".length;
    const dot = findRslChainDot(module.syntax.tokens, offset);

    assert.ok(dot >= 0);
    assert.deepStrictEqual(
        readRslAccessChain(module.syntax.tokens, dot)
            .map(item => item.name),
        ["obj", "Child"],
        "звенья обязаны быть только из своей строки"
    );
});

test("описка в члене по цепочке находится", async () => {
    const catalog = new PlatformModuleCatalog({ log: () => undefined });

    await catalog.ensureModules(["rsd"]);

    const cases = [
        [
            "цепочка через метод",
            [
                "Import rsd;",
                "Macro T()",
                "  Var cmd: RsdCommand;",
                "  cmd.Execute().MoooveNext();",
                "End;",
                ""
            ].join("\n"),
            ["MoooveNext"]
        ],
        [
            "цепочка через процедуру",
            [
                "Import rsd;",
                "Macro Get(): RsdRecordset",
                "End;",
                "Macro T()",
                "  Get().MoooveNext();",
                "End;",
                ""
            ].join("\n"),
            ["MoooveNext"]
        ],
        [
            "верный член по цепочке",
            [
                "Import rsd;",
                "Macro T()",
                "  Var cmd: RsdCommand;",
                "  cmd.Execute().MoveNext();",
                "End;",
                ""
            ].join("\n"),
            []
        ]
    ];

    for (const [label, source, expected] of cases) {
        const uri = "file:///d:/chainfeat/" + label.replace(/\s/gu, "-") +
            ".mac";
        const index = new WorkspaceIndex();

        index.registerWorkspaceFiles([uri]);

        const module = index.updateOpenModule(uri, source, 1);
        const resolver = new RslScopeResolver(index, getDefaults(), catalog);
        const found = collectUnknownVariables(module, resolver, {
            mode: "safe",
            checkMembers: true
        })
            .filter(item => item.kind === "member")
            .map(item => item.name);

        assert.deepStrictEqual(found, expected, label);
    }
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

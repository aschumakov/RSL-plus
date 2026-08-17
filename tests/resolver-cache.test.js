"use strict";

/**
 * Кэш разрешения имён не должен зависеть от порядка запросов.
 *
 * Кэш хранит найденный символ вместе с интервалом смещений, на котором ответ
 * остаётся верным. Если этот интервал взят шире, чем нужно, первый же запрос
 * «отравляет» кэш: ответ, верный для своей строки, начинает выдаваться и там,
 * где виден уже другой символ. Проявляется это только при определённом порядке
 * обращений — то есть на живом редакторе, где порядок задаёт пользователь.
 *
 * Эталон здесь — свежий resolver на каждый запрос: кэшу нечем влиять. Против
 * него сверяются прямой, обратный и перемешанный порядок на одном resolver.
 */

const assert = require("assert");

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

/** Ответ в виде строки: сравнивать нужно и файл, и место объявления. */
function describe(resolved) {
    if (!resolved) {
        return "нет";
    }

    return `${resolved.uri}#${resolved.symbol.range.start}` +
        `..${resolved.symbol.range.end}:${resolved.symbol.name}`;
}

/** Порядок обращений, устойчивый между запусками: свой генератор. */
function shuffled(length) {
    const positions = [];

    for (let index = 0; index < length; index++) {
        positions.push(index);
    }

    let seed = 7;

    for (let index = positions.length - 1; index > 0; index--) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const swap = seed % (index + 1);
        const value = positions[index];
        positions[index] = positions[swap];
        positions[swap] = value;
    }

    return positions;
}

function checkOrderIndependence(source) {
    const uri = "file:///d:/resolver-order.mac";
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([uri]);
    const module = index.updateOpenModule(uri, source, 1);
    const targets = module.lex.tokens
        .filter(token => token.kind === "identifier")
        .map(token => ({ name: token.value, offset: token.start }));

    assert.ok(targets.length > 0, "В образце обязаны быть идентификаторы");

    const expected = targets.map(target => describe(
        new RslScopeResolver(index).resolveName(
            uri,
            module.symbolTree,
            target.name,
            target.offset
        )
    ));

    const orders = {
        прямой: targets.map((_, position) => position),
        обратный: targets.map((_, position) => position).reverse(),
        перемешанный: shuffled(targets.length)
    };

    for (const [orderName, order] of Object.entries(orders)) {
        /* Один resolver на весь порядок: именно так работает сервер. */
        const shared = new RslScopeResolver(index);

        for (const position of order) {
            const target = targets[position];
            const actual = describe(shared.resolveName(
                uri,
                module.symbolTree,
                target.name,
                target.offset
            ));

            assert.strictEqual(
                actual,
                expected[position],
                `Порядок «${orderName}» изменил ответ для ${target.name}` +
                    `@${target.offset}`
            );
        }
    }
}

/*
 * Случаи подобраны так, чтобы одно и то же имя в разных местах файла разрешалось
 * по-разному: только на таких именах порядок запросов и может что-то изменить.
 */
const CASES = {
    "объявление ниже обращения в том же Macro": [
        "Var x = 1;",
        "Macro T()",
        "  msgbox(x);",
        "  Var x = 2;",
        "  msgbox(x);",
        "End;"
    ].join("\n"),
    "два объявления одного имени подряд": [
        "Macro T()",
        "  msgbox(y);",
        "  Var y = 1;",
        "  msgbox(y);",
        "  Var y = 2;",
        "  msgbox(y);",
        "End;"
    ].join("\n"),
    "модульная переменная объявлена между двумя Macro": [
        "Macro T()",
        "  msgbox(z);",
        "End;",
        "Var z = 1;",
        "Macro U()",
        "  msgbox(z);",
        "End;"
    ].join("\n"),
    "поле класса и модульная переменная одного имени": [
        "Var v = 0;",
        "Class C",
        "  Var v: String;",
        "  Macro M()",
        "    msgbox(v);",
        "  End;",
        "End;",
        "Macro T()",
        "  msgbox(v);",
        "End;"
    ].join("\n"),
    "параметр перекрывает модульную переменную": [
        "Var p = 1;",
        "Macro T(p)",
        "  msgbox(p);",
        "End;",
        "Macro U()",
        "  msgbox(p);",
        "End;"
    ].join("\n")
};

for (const [name, source] of Object.entries(CASES)) {
    test(`порядок запросов не влияет: ${name}`, () => {
        checkOrderIndependence(source);
    });
}

test("правка файла обнуляет кэш разрешения", () => {
    const uri = "file:///d:/resolver-revision.mac";
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([uri]);
    const resolver = new RslScopeResolver(index);
    const before = "Macro T()\n  Var q: TFile;\n  msgbox(q);\nEnd;";
    const first = index.updateOpenModule(uri, before, 1);
    const offset = before.lastIndexOf("q");

    assert.strictEqual(
        resolver.resolveName(uri, first.symbolTree, "q", offset)?.symbol
            .typeName,
        "TFile"
    );

    /* Тип поменялся — прежний ответ обязан быть выброшен, а не переиспользован. */
    const after = "Macro T()\n  Var q: TStringList;\n  msgbox(q);\nEnd;";
    const second = index.updateOpenModule(uri, after, 2);

    assert.strictEqual(
        resolver.resolveName(
            uri,
            second.symbolTree,
            "q",
            after.lastIndexOf("q")
        )?.symbol.typeName,
        "TStringList"
    );
});

console.log(`\nПройдено: ${passed}, провалено: ${failed}`);

if (failed > 0) {
    process.exitCode = 1;
}

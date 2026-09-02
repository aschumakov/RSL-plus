"use strict";

/**
 * Единый разбор мест вызова.
 *
 * В RSL вызов сплошь и рядом записан строкой: имя процедуры первым аргументом
 * ExecMacro, имя метода вторым аргументом R2M, обработчик в известной позиции.
 * Для пользователя это такой же вызов, как `Foo()`.
 *
 * Каждая функция понимала их по-своему: иерархия вызовов считала вызовом
 * «идентификатор и открывающая скобка» и строковых форм не видела вовсе.
 * Здесь проверяется общий разбор — состав, диапазоны и отказ угадывать.
 */

const assert = require("assert");

const { lexRsl } = require("../server/out/lexer");
const {
    collectRslCallSites
} = require("../server/out/analysis/callSiteFacts");

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

/** Места вызова по тексту, в удобном для сравнения виде. */
function sites(source) {
    return collectRslCallSites(lexRsl(source).tokens).map(site => ({
        kind: site.kind,
        name: site.targetName,
        text: source.slice(site.start, site.end),
        module: site.moduleName
    }));
}

test("обычный вызов", () => {
    assert.deepStrictEqual(
        sites("Macro Run()\n  Foo(1);\nEnd;\n"),
        [{ kind: "call", name: "Foo", text: "Foo", module: undefined }]
    );
});

test("вызов метода", () => {
    const found = sites("Macro Run()\n  object.Method(1);\nEnd;\n");

    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].kind, "method");
    assert.strictEqual(found[0].name, "Method");
});

test("ExecMacro со строкой", () => {
    assert.deepStrictEqual(
        sites('Macro Run()\n  ExecMacro("Handler", 1);\nEnd;\n'),
        [{
            kind: "execMacro",
            name: "Handler",
            text: "Handler",
            module: undefined
        }],
        "диапазон обязан указывать на имя без кавычек"
    );
});

test("ExecMacro2 берёт имя первым аргументом", () => {
    /*
     * Это не «модуль, потом имя»: второй аргумент ExecMacro2 — уже параметр
     * вызываемой процедуры. В настоящем коде проекта так и написано:
     * ExecMacro2("getCodeByISO", 398).
     */
    assert.deepStrictEqual(
        sites('Macro Run()\n  ExecMacro2("Handler", 398);\nEnd;\n'),
        [{
            kind: "execMacro2",
            name: "Handler",
            text: "Handler",
            module: undefined
        }]
    );
});

test("ExecMacroFile называет файл", () => {
    assert.deepStrictEqual(
        sites('Macro Run()\n  ExecMacroFile("lib.mac", "Handler");\nEnd;\n'),
        [{
            kind: "execMacroFile",
            name: "Handler",
            text: "Handler",
            module: "lib.mac"
        }]
    );
});

test("R2M называет метод и получателя", () => {
    const found = collectRslCallSites(
        lexRsl('Macro Run()\n  Var ref = R2M(holder, "Load");\nEnd;\n').tokens
    );

    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].kind, "r2m");
    assert.strictEqual(found[0].targetName, "Load");
    assert.ok(
        found[0].receiverOffset !== undefined,
        "получатель обязан быть указан"
    );
});

test("обработчик в известной позиции", () => {
    const found = sites('Macro Run()\n  RunDialog(form, "OnEvent");\nEnd;\n');

    assert.deepStrictEqual(
        found.filter(site => site.kind === "callback"),
        [{ kind: "callback", name: "OnEvent", text: "OnEvent", module: undefined }]
    );
});

test("ссылка на процедуру обработчиком", () => {
    const found = sites("Macro Run()\n  Sort(Compare, list);\nEnd;\n");

    assert.deepStrictEqual(
        found.filter(site => site.kind === "callback").map(site => site.name),
        ["Compare"],
        "имя без скобок обычным вызовом не увидеть"
    );
});

test("собранное на ходу имя не угадывается", () => {
    assert.deepStrictEqual(
        sites('Macro Run()\n  ExecMacro(prefix + "Handler");\nEnd;\n')
            .filter(site => site.kind === "execMacro"),
        [],
        "значение такого аргумента известно только во время выполнения"
    );
});

test("обычная строка вызовом не считается", () => {
    assert.deepStrictEqual(
        sites('Macro Run()\n  MsgBox("Handler");\nEnd;\n')
            .filter(site => site.kind !== "call"),
        [],
        "MsgBox — не обработчик"
    );
});

test("вложенные скобки не разделяют аргументы", () => {
    assert.deepStrictEqual(
        sites('Macro Run()\n  ExecMacroFile(Choose(a, b), "Handler");\nEnd;\n')
            .filter(site => site.kind === "execMacroFile"),
        [{
            kind: "execMacroFile",
            name: "Handler",
            text: "Handler",
            module: undefined
        }],
        "имя во втором аргументе, а файл вычисляется и не угадывается"
    );
});

test("несколько вызовов в одной строке", () => {
    assert.deepStrictEqual(
        sites('Macro Run()\n  Foo(ExecMacro("Handler"));\nEnd;\n')
            .map(site => site.name)
            .sort(),
        ["Foo", "Handler"]
    );
});

test("незакрытая скобка не уводит разбор", () => {
    const found = sites('Macro Run()\n  ExecMacro("Handler"\n  Var x = 1;\nEnd;\n');

    assert.ok(
        found.every(site => site.name !== "Var"),
        "разбор обязан остановиться на конце предложения"
    );
});

console.log(
    failed === 0
        ? "\nПройдено: " + passed
        : "\nПройдено: " + passed + ", провалено: " + failed
);

if (failed > 0) {
    process.exitCode = 1;
}

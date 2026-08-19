"use strict";

/**
 * Дешёвые проверки выражения: точка без имени, оператор без операнда,
 * присваивание не туда.
 *
 * Проверки идут по тем же токенам, которые разбор оператора и так собрал,
 * поэтому они обязаны работать и при выключенном дереве выражений — именно так
 * разбирается открытый документ.
 *
 * Вторая половина проверок — о том, чего трогать нельзя. Список законных
 * записей взят не из головы: каждая из них встречается в рабочем репозитории
 * макросов, а `cmd.value("t_ref") = AddRef` — 43945 раз.
 */

const assert = require("assert");

const { parseRslSyntax } = require("../server/out/syntaxParser");
const { buildRslDiagnostics } = require("../server/out/diagnostics");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

const CODES = new Set([
    "missing-member-name",
    "missing-operand",
    "invalid-assignment-target"
]);

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

/** Замечания выражения; дерево выражений выключено, как в открытом документе. */
function checks(body, options) {
    const source = "Macro Test()\n  " + body + "\nEnd;";

    return parseRslSyntax(source, undefined, {
        buildExpressionTree: options?.buildExpressionTree === true
    })
        .diagnostics
        .filter(item => CODES.has(item.code))
        .map(item => item.code);
}

test("точка без имени", () => {
    assert.deepStrictEqual(checks("obj..field = 1;"), ["missing-member-name"]);
    assert.deepStrictEqual(checks("Call(obj.);"), ["missing-member-name"]);
    assert.deepStrictEqual(
        checks("Call(obj., value);"),
        ["missing-member-name"]
    );
});

test("оператор без операнда", () => {
    assert.deepStrictEqual(checks("value = * rate;"), ["missing-operand"]);
    assert.deepStrictEqual(checks("x = a + / b;"), ["missing-operand"]);
});

test("присваивание не туда", () => {
    assert.deepStrictEqual(
        checks("1 = value;"),
        ["invalid-assignment-target"]
    );
    assert.deepStrictEqual(
        checks("(a + b) = value;"),
        ["invalid-assignment-target"]
    );
});

test("проверки работают и с построенным деревом выражений", () => {
    assert.deepStrictEqual(
        checks("obj..field = 1;", { buildExpressionTree: true }),
        ["missing-member-name"]
    );
});

test("законные записи RSL остаются чистыми", () => {
    const legal = [
        /* Свойство по умолчанию и параметризованное свойство. */
        "dlg.(\"KNP\") = \"\";",
        "this.(id) = value;",
        "cmd.value(\"t_ref\") = AddRef;",
        "arr[1] = 2;",
        "obj.field = 3;",
        /* Унарные операторы. */
        "x = -y;",
        "x = not y;",
        "p = @proc;",
        "x = ~mask;",
        /* Звёздочка формата, а не умножение. */
        "x = String(Value:*:*, 0, Point);",
        "x = string(Value:o:12:*:0);",
        /* Сравнение в условии. */
        "If (a = b)\n    x = 1;\n  End;"
    ];

    for (const body of legal) {
        assert.deepStrictEqual(
            checks(body),
            [],
            "ложная тревога на законной записи: " + body
        );
    }
});

test("точка в конце набранного текста ошибкой не считается", () => {
    /* Так выглядит момент вызова подсказки членов: имя ещё не набрано. */
    assert.deepStrictEqual(checks("obj."), []);
    assert.deepStrictEqual(checks("value = obj."), []);
});

test("пустой аргумент намеренно не проверяется", () => {
    /*
     * `var a, , b` встречается в рабочих файлах репозитория, и правило RSL на
     * этот счёт не подтверждено. Пока не подтверждено — не проверяется.
     */
    assert.deepStrictEqual(checks("var a, , b;"), []);
    assert.deepStrictEqual(checks("Call(a, , b);"), []);
});

test("замечания доходят до Problems", () => {
    const source = [
        "Macro Test()",
        "  Var obj, value;",
        "  obj..field = 1;",
        "End;"
    ].join("\n");
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles(["file:///main.mac"]);
    const found = buildRslDiagnostics(
        index.updateOpenModule("file:///main.mac", source, 1),
        index,
        {}
    ).filter(item => CODES.has(String(item.code)));

    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].severity, 1);
    assert.strictEqual(found[0].range.start.line, 2);
});

console.log("\nПройдено: " + passed + ", провалено: " + failed);

if (failed > 0) {
    process.exitCode = 1;
}

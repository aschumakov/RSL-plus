"use strict";

const assert = require("assert");
const path = require("path");

const formatterPath = path.join(
    __dirname,
    "..",
    "server",
    "out",
    "format.js"
);

const { FormatCode } = require(formatterPath);

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

test("Простой блок If форматируется", () => {
    const source = [
        "If a==b",
        'Message("ok");',
        "End"
    ].join("\n");

    const expected = [
        "If a == b",
        '    Message("ok");',
        "End"
    ].join("\n");

    assert.strictEqual(FormatCode(source, 4), expected);
});

test("Else находится на уровне If", () => {
    const source = [
        "If a",
        'Message("1");',
        "Else",
        'Message("2");',
        "End"
    ].join("\n");

    const expected = [
        "If a",
        '    Message("1");',
        "Else",
        '    Message("2");',
        "End"
    ].join("\n");

    assert.strictEqual(FormatCode(source, 4), expected);
});

test("Вложенный While форматируется", () => {
    const source = [
        "If enabled",
        "While active",
        "DoWork();",
        "End",
        "End"
    ].join("\n");

    const expected = [
        "If enabled",
        "    While active",
        "        DoWork();",
        "    End",
        "End"
    ].join("\n");

    assert.strictEqual(FormatCode(source, 4), expected);
});

test("Незакрытый If не вызывает исключение", () => {
    const source = [
        "If enabled",
        "DoWork();"
    ].join("\n");

    assert.doesNotThrow(() => {
        FormatCode(source, 4);
    });
});

test("Повторное форматирование не меняет результат", () => {
    const source = [
        "If a==b",
        'Message("ok");',
        "End"
    ].join("\n");

    const first = FormatCode(source, 4);
    const second = FormatCode(first, 4);

    assert.strictEqual(second, first);
});

test("Многострочный вызов выравнивается по скобкам", () => {
    const source = [
        "private macro CheckType(typegua)",
        'var sql = execSqlSelect(" select count(*)              "+',
        '"   from dtype_crd_dbt ty      "+',
        '"  where ty.t_crd_kind = :1    "+',
        '"    and ty.t_credittypeid = :2",',
        'MakeArray (SqlParam (":1", 21),',
        'SqlParam (":2", typegua)));',
        "return getResultBySql(sql);",
        "end;"
    ].join("\n");

    const expected = [
        "private macro CheckType(typegua)",
        '    var sql = execSqlSelect(" select count(*)              "+',
        '                            "   from dtype_crd_dbt ty      "+',
        '                            "  where ty.t_crd_kind = :1    "+',
        '                            "    and ty.t_credittypeid = :2",',
        '                            MakeArray (SqlParam (":1", 21),',
        '                                       SqlParam (":2", typegua)));',
        "    return getResultBySql(sql);",
        "end;"
    ].join("\n");

    assert.strictEqual(FormatCode(source, 4), expected);
});

console.log("");
console.log(`Пройдено: ${passed}`);
console.log(`Ошибок: ${failed}`);

if (failed > 0) {
    process.exitCode = 1;
}
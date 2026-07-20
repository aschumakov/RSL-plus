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

test(
    "Объявления и строковые конкатенации сохраняют выравнивание",
    () => {
        const source = [
            "private macro Make_Acc_All(objType, objID, curcode, fncash, acc_cat, isresident, isip, legal, sector)",
            "private var q,",
            "rs,",
            "rs1,",
            "Account,",
            "ODB,",
            "creditID,",
            "duration,",
            "SysType,",
            "PayType,",
            "cmd;",
            "cmd = RsdCommand();",
            "",
            'q = " SELECT t.t_account              "+',
            '"   FROM RSUSER.DLOANS_ACC_DBT t  "+',
            '"  WHERE t.t_typeaccred_ref  = :1 "+',
            '"    AND t.t_curcode         = :2 "+',
            '"    AND t.t_isnotresident   = :3 "+',
            '"    AND t.t_fncash          = :4 "+',
            '"    AND t.t_isip            = :5 "+',
            '"    AND t.t_legalform       = :6 "+',
            '"    AND t.t_crd_kind        = decode("+objType+", 6,1,"+objType+")"+ // RSDEV-7122',
            '"";',
            "end;"
        ].join("\n");

        const expected = [
            "private macro Make_Acc_All(objType, objID, curcode, fncash, acc_cat, isresident, isip, legal, sector)",
            "    private var q,",
            "                rs,",
            "                rs1,",
            "                Account,",
            "                ODB,",
            "                creditID,",
            "                duration,",
            "                SysType,",
            "                PayType,",
            "                cmd;",
            "    cmd = RsdCommand();",
            "",
            '    q = " SELECT t.t_account              "+',
            '        "   FROM RSUSER.DLOANS_ACC_DBT t  "+',
            '        "  WHERE t.t_typeaccred_ref  = :1 "+',
            '        "    AND t.t_curcode         = :2 "+',
            '        "    AND t.t_isnotresident   = :3 "+',
            '        "    AND t.t_fncash          = :4 "+',
            '        "    AND t.t_isip            = :5 "+',
            '        "    AND t.t_legalform       = :6 "+',
            '        "    AND t.t_crd_kind        = decode("+objType+", 6,1,"+objType+")"+ // RSDEV-7122',
            '        "";',
            "end;"
        ].join("\n");

        const formatted = FormatCode(source, 4);

        assert.strictEqual(formatted, expected);
        assert.strictEqual(
            FormatCode(formatted, 4),
            expected
        );
    }
);

test("OnError находится на уровне Macro", () => {
    const source = [
        "MACRO Get_Request()",
        'BegAction(500, "Ожидание ответа на запрос...", false);',
        "WinHttp.Send(xml);",
        "EndAction(100);",
        "return true;",
        "OnError",
        "EndAction(100);",
        "return false;",
        "END;"
    ].join("\n");

    const expected = [
        "MACRO Get_Request()",
        '    BegAction(500, "Ожидание ответа на запрос...", false);',
        "    WinHttp.Send(xml);",
        "    EndAction(100);",
        "    return true;",
        "OnError",
        "    EndAction(100);",
        "    return false;",
        "END;"
    ].join("\n");

    const formatted = FormatCode(source, 4);

    assert.strictEqual(formatted, expected);
    assert.strictEqual(
        FormatCode(formatted, 4),
        expected
    );
});

console.log("");
console.log(`Пройдено: ${passed}`);
console.log(`Ошибок: ${failed}`);

if (failed > 0) {
    process.exitCode = 1;
}
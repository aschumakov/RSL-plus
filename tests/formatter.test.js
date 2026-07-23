"use strict";

const assert = require("assert");
const path = require("path");
const { FormatCode } = require(path.join(
    __dirname,
    "..",
    "server",
    "out",
    "format.js"
));

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

test("Простой If форматируется", () => {
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

test("Else и OnError находятся на уровне владельца", () => {
    const source = [
        "Macro Test()",
        "If enabled",
        "DoFirst();",
        "Else",
        "DoSecond();",
        "End;",
        "OnError",
        "HandleError();",
        "End;"
    ].join("\n");

    const expected = [
        "Macro Test()",
        "    If enabled",
        "        DoFirst();",
        "    Else",
        "        DoSecond();",
        "    End;",
        "OnError",
        "    HandleError();",
        "End;"
    ].join("\n");

    assert.strictEqual(FormatCode(source, 4), expected);
});

test("Верхнеуровневый OnError задаёт отступ до конца файла", () => {
    const source = [
        "if(debugmode)",
        "exit(0);",
        "end;",
        "exit(1);",
        "onerror(x)",
        "if(rsldefcon.IsInTrans)",
        "rsldefcon.RollbackTrans;",
        "end;",
        'ExecSql("insert into log_table values(:err)",',
        'MakeArray(SQLParam("err",x.message)),false);',
        "exit(0);"
    ].join("\n");

    const expected = [
        "if(debugmode)",
        "    exit(0);",
        "end;",
        "exit(1);",
        "onerror(x)",
        "    if(rsldefcon.IsInTrans)",
        "        rsldefcon.RollbackTrans;",
        "    end;",
        '    ExecSql("insert into log_table values(:err)",',
        '            MakeArray(SQLParam("err",x.message)),false);',
        "    exit(0);"
    ].join("\n");

    assert.strictEqual(FormatCode(source, 4), expected);
});

test("Последовательные присваивания выравниваются по знаку равно", () => {
    const source = [
        "If hasMessage",
        "Message.id        = AMessage(i).id;",
        "Message.type      = AMessage(i).type;",
        "Message.createdAt = AMessage(i).createdAt;",
        "Message.content   = AMessage(i).content;",
        "Message.InmessLogId = a.logid;",
        "Message.ParentId  = a.parentid;",
        "End;"
    ].join("\n");

    const expected = [
        "If hasMessage",
        "    Message.id          = AMessage(i).id;",
        "    Message.type        = AMessage(i).type;",
        "    Message.createdAt   = AMessage(i).createdAt;",
        "    Message.content     = AMessage(i).content;",
        "    Message.InmessLogId = a.logid;",
        "    Message.ParentId    = a.parentid;",
        "End;"
    ].join("\n");

    const formatted = FormatCode(source, 4);
    assert.strictEqual(formatted, expected);
    assert.strictEqual(FormatCode(formatted, 4), expected);
});

test("Выравнивание не объединяет разные блоки присваиваний", () => {
    const source = [
        "shortName = first;",
        "longName = second;",
        "",
        "If left==right",
        "nested = third;",
        "muchLongerNested = fourth;",
        "End;",
        "after = fifth;"
    ].join("\n");

    const expected = [
        "shortName = first;",
        "longName  = second;",
        "",
        "If left == right",
        "    nested           = third;",
        "    muchLongerNested = fourth;",
        "End;",
        "after = fifth;"
    ].join("\n");

    assert.strictEqual(FormatCode(source, 4), expected);
});

test("Многострочный вызов выравнивается по скобке", () => {
    const source = [
        "Macro Test()",
        "result = Call(first,",
        "second,",
        "Nested(third,",
        "fourth));",
        "End;"
    ].join("\n");

    const expected = [
        "Macro Test()",
        "    result = Call(first,",
        "                  second,",
        "                  Nested(third,",
        "                         fourth));",
        "End;"
    ].join("\n");

    assert.strictEqual(FormatCode(source, 4), expected);
});

test("Объявление и конкатенация сохраняют continuation", () => {
    const source = [
        "Macro Test()",
        "private var first,",
        "second,",
        "third;",
        'sql = "select "+',
        '"from dual";',
        "End;"
    ].join("\n");

    const expected = [
        "Macro Test()",
        "    private var first,",
        "                second,",
        "                third;",
        '    sql = "select "+',
        '          "from dual";',
        "End;"
    ].join("\n");

    assert.strictEqual(FormatCode(source, 4), expected);
});

test("Строки обоих видов и SQL-блок не изменяются", () => {
    const source = [
        "If a==b",
        "value = 'a==b';",
        'other = "x!=y";',
        "[",
        "begin",
        " if x=1 then",
        "   null;",
        " end if;",
        "end;",
        "]",
        "End;"
    ].join("\n");

    const formatted = FormatCode(source, 4);

    assert.ok(formatted.includes("'a==b'"));
    assert.ok(formatted.includes('"x!=y"'));
    assert.ok(formatted.includes([
        "[",
        "begin",
        " if x=1 then",
        "   null;",
        " end if;",
        "end;",
        "]"
    ].join("\n")));
});

test("BOM, CRLF и финальный перевод строки сохраняются", () => {
    const source = "\uFEFFIf a==b\r\nDoWork();\r\nEnd;\r\n";
    const formatted = FormatCode(source, 4);

    assert.ok(formatted.startsWith("\uFEFF"));
    assert.ok(formatted.includes("\r\n"));
    assert.ok(formatted.endsWith("\r\n"));
    assert.strictEqual(formatted.replace(/\r\n/g, "").includes("\n"), false);
});

test("Форматирование идемпотентно", () => {
    const source = [
        "Macro Test()",
        "If a==b",
        "DoWork();",
        "End;",
        "End;"
    ].join("\n");
    const once = FormatCode(source, 4);
    assert.strictEqual(FormatCode(once, 4), once);
});

console.log("");
console.log(`Пройдено: ${passed}`);
console.log(`Ошибок: ${failed}`);

if (failed > 0) {
    process.exitCode = 1;
}

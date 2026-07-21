"use strict";

const assert = require("assert");
const path = require("path");
const {
    lexRsl,
    tokenAtOffset
} = require(path.join(
    __dirname,
    "..",
    "server",
    "out",
    "lexer.js"
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

test("CRLF является одним newline token", () => {
    const result = lexRsl("a\r\nb");
    const newline = result.tokens.find(token => token.kind === "newline");

    assert.ok(newline);
    assert.strictEqual(newline.raw, "\r\n");
    assert.strictEqual(newline.start, 1);
    assert.strictEqual(newline.end, 3);
    assert.strictEqual(result.tokens[result.tokens.length - 1].raw, "b");
});

test("Строки с одинарными и двойными кавычками непрозрачны", () => {
    const source = `'if end' + "class macro"`;
    const strings = lexRsl(source).tokens.filter(token =>
        token.kind === "string"
    );

    assert.deepStrictEqual(strings.map(token => token.raw), [
        "'if end'",
        '"class macro"'
    ]);
});

test("Квадратный SQL-блок возвращается одним token", () => {
    const source = [
        "[",
        "begin",
        "  if x then",
        "    value := ']';",
        "  end if;",
        "end;",
        "]",
        "Macro Real()",
        "End;"
    ].join("\n");
    const tokens = lexRsl(source).tokens;
    const square = tokens.find(token => token.kind === "square");

    assert.ok(square);
    assert.strictEqual(square.line, 0);
    assert.strictEqual(square.endLine, 6);
    assert.ok(tokens.some(token => token.raw === "Macro"));
});

test("Комментарии не выпускают ложные ключевые слова", () => {
    const source = [
        "// Macro Fake()",
        "/* Class Fake End */",
        "Macro Real()",
        "End;"
    ].join("\n");
    const identifiers = lexRsl(source).tokens
        .filter(token => token.kind === "identifier")
        .map(token => token.value);

    assert.deepStrictEqual(identifiers, ["Macro", "Real", "End"]);
});

test("tokenAtOffset на начале имени возвращает само имя", () => {
    const source = "  SomeName();";
    const result = lexRsl(source);
    const token = tokenAtOffset(result.tokens, source.indexOf("SomeName"), true);

    assert.ok(token);
    assert.strictEqual(token.raw, "SomeName");
});

test("tokenAtOffset работает на правой границе имени", () => {
    const source = "SomeName();";
    const result = lexRsl(source);
    const token = tokenAtOffset(result.tokens, "SomeName".length, true);

    assert.ok(token);
    assert.strictEqual(token.raw, "SomeName");
});

test("Индекс массива разбирается как RSL-код, а не SQL-блок", () => {
    const source = "accounts [i].number + BlockSum[BlockSum.Size]";
    const tokens = lexRsl(source).tokens;
    const identifiers = tokens
        .filter(token => token.kind === "identifier")
        .map(token => token.value);

    assert.deepStrictEqual(identifiers, [
        "accounts",
        "i",
        "number",
        "BlockSum",
        "BlockSum",
        "Size"
    ]);
    assert.strictEqual(
        tokens.filter(token => token.kind === "square").length,
        0
    );
    assert.strictEqual(
        tokens.filter(token => token.kind === "symbol" && token.raw === "[").length,
        2
    );
});

test("SQL-блок после завершённой инструкции остаётся защищённым", () => {
    const source = "lStartCapture();\n[\nselect '[^[[:digit:]]]*' from dual\n]";
    const square = lexRsl(source).tokens.find(token => token.kind === "square");

    assert.ok(square);
    assert.ok(square.raw.includes("[^[[:digit:]]]*"));
});

console.log("");
console.log(`Пройдено: ${passed}`);
console.log(`Ошибок: ${failed}`);

if (failed > 0) {
    process.exitCode = 1;
}

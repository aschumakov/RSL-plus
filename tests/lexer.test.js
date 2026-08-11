"use strict";

const assert = require("assert");
const path = require("path");
const {
    lexRsl,
    tokenAtOffset,
    findUnrecognizedEscapes
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


test("Вложенный блочный комментарий остаётся единым token", () => {
    const source = [
        "/* outer /* inner */",
        "if (FakeCall()) return 1; end;",
        "*/",
        "Macro Real()",
        "End;"
    ].join("\n");
    const result = lexRsl(source);
    const comments = result.tokens.filter(token => token.kind === "comment");
    const identifiers = result.tokens
        .filter(token => token.kind === "identifier")
        .map(token => token.value);

    assert.strictEqual(comments.length, 1);
    assert.ok(comments[0].raw.includes("FakeCall()"));
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

test("SPNAME с фигурными скобками является единым идентификатором", () => {
    const source = "Var {oper}, {34-23-O};";
    const identifiers = lexRsl(source).tokens
        .filter(token => token.kind === "identifier")
        .map(token => token.value);

    assert.deepStrictEqual(identifiers, [
        "Var",
        "{oper}",
        "{34-23-O}"
    ]);
});

test("Денежная и шестнадцатеричная константа лексируются одним токеном", () => {
    const money = lexRsl("$146").tokens.find(token => token.kind === "number");
    assert.ok(money);
    assert.strictEqual(money.raw, "$146");

    const moneyFraction = lexRsl("$1.46").tokens
        .find(token => token.kind === "number");
    assert.ok(moneyFraction);
    assert.strictEqual(moneyFraction.raw, "$1.46");

    const hex = lexRsl("#F2").tokens.find(token => token.kind === "number");
    assert.ok(hex);
    assert.strictEqual(hex.raw, "#F2");

    const bare = lexRsl("$").tokens.find(token => token.kind === "number");
    assert.ok(bare);
    assert.strictEqual(bare.raw, "$");

    const negative = lexRsl("-$12.34").tokens
        .filter(token => token.kind === "symbol" || token.kind === "number");
    assert.deepStrictEqual(
        negative.map(token => token.raw),
        ["-", "$12.34"]
    );
});

test("Нераспознанная escape-последовательность обнаруживается", () => {
    assert.deepStrictEqual(findUnrecognizedEscapes('"\\P"'), [1]);
    assert.deepStrictEqual(findUnrecognizedEscapes('"\\n"'), []);
    assert.deepStrictEqual(findUnrecognizedEscapes('"\\""'), []);
    assert.deepStrictEqual(findUnrecognizedEscapes("\"\\'\""), []);
    assert.deepStrictEqual(findUnrecognizedEscapes('"\\x41"'), []);
    assert.deepStrictEqual(findUnrecognizedEscapes('"\\xZZ"'), [1]);
    assert.deepStrictEqual(findUnrecognizedEscapes('"no escapes"'), []);
});

/* --- точечный relex больших файлов ---------------------------------- */

const {
    tryIncrementalRelex
} = require("../server/out/services/incrementalLex");

function bigLexSource(approxKb) {
    const chunks = [];
    let size = 0;
    let index = 0;
    while (size < approxKb * 1024) {
        const chunk = [
            `Macro Handler${index}(obj, cmd, id)`,
            `  Var value${index} = ${index};`,
            `  Println("text ${index}");`,
            `  return value${index};`,
            "End;",
            ""
        ].join("\n");
        chunks.push(chunk);
        size += chunk.length;
        index++;
    }
    return chunks.join("\n");
}

/*
 * Точечный relex обязан быть либо правильным, либо отсутствующим.
 *
 * Проверка сравнивает его результат с полным лексированием на множестве
 * правок в разных местах файла: любое расхождение означает, что дальше
 * поедет весь анализ — токены лежат в основе AST, Structure и подсветки.
 * Отказ (undefined) допустим всегда, неверный результат — никогда.
 */
test("точечный relex совпадает с полным лексированием или отказывает", () => {
    const source = bigLexSource(120);
    const lex = lexRsl(source);
    let applied = 0;

    const positions = [];
    for (let fraction = 0.55; fraction < 1; fraction += 0.05) {
        const anchor = Math.floor(source.length * fraction);
        const found = source.indexOf("value", anchor);
        if (found > 0) positions.push(found);
    }
    assert.ok(positions.length > 0, "Не нашлось позиций для правок");

    for (const position of positions) {
        const variants = [
            source.slice(0, position + 3) + "X" + source.slice(position + 3),
            source.slice(0, position + 3) + source.slice(position + 4),
            source.slice(0, position + 5) + "9" + source.slice(position + 5),
            source.slice(0, position) + "renamed" + source.slice(position + 5)
        ];

        for (const next of variants) {
            const incremental = tryIncrementalRelex(source, lex, next);
            if (!incremental) continue;
            applied++;
            assert.deepStrictEqual(
                incremental.tokens,
                lexRsl(next).tokens,
                "Точечный relex дал другой token stream, чем полный проход"
            );
            assert.deepStrictEqual(
                incremental.lineStarts,
                lexRsl(next).lineStarts,
                "Точечный relex сбил границы строк"
            );
        }
    }

    assert.ok(
        applied > 0,
        "Ни одна правка не пошла точечным путём — проверка ничего не проверила"
    );
});

/*
 * Точечный relex не должен применяться там, где он дороже полного прохода.
 *
 * Его стоимость определяется числом токенов ПОСЛЕ правки: им пересчитываются
 * позиции. Замеры: правка в начале файла 550КБ обходится в 46 мс против 40 мс
 * полного лексирования, то есть путь становится вредным. Отсечка по доле
 * потока — единственное, что удерживает его от этого.
 */
test("точечный relex отказывается от правки в начале большого файла", () => {
    const source = bigLexSource(120);
    const lex = lexRsl(source);

    const nearStart = source.indexOf("value");
    const atStart = source.slice(0, nearStart + 3) + "X" +
        source.slice(nearStart + 3);
    assert.strictEqual(
        tryIncrementalRelex(source, lex, atStart),
        undefined,
        "Правка в начале файла пересчитала бы позиции почти всему потоку"
    );

    const nearEnd = source.lastIndexOf("value");
    const atEnd = source.slice(0, nearEnd + 3) + "X" +
        source.slice(nearEnd + 3);
    const incremental = tryIncrementalRelex(source, lex, atEnd);
    assert.ok(
        incremental,
        "Правка в конце файла обязана идти точечным путём: там сдвигать почти нечего"
    );
    assert.deepStrictEqual(incremental.tokens, lexRsl(atEnd).tokens);
});

console.log("");
console.log(`Пройдено: ${passed}`);
console.log(`Ошибок: ${failed}`);

if (failed > 0) {
    process.exitCode = 1;
}

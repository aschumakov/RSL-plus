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

/** Подпись token stream: всё, что обязано совпасть с полным лексированием. */
function tokenSignature(tokens) {
    const parts = [];
    for (const token of tokens) {
        parts.push(
            token.kind, token.start, token.end,
            token.line, token.character,
            token.endLine, token.endCharacter
        );
    }
    return parts.join("|");
}

function firstDifferenceIndex(left, right) {
    const max = Math.min(left.length, right.length);
    for (let index = 0; index < max; index++) {
        if (tokenSignature([left[index]]) !== tokenSignature([right[index]])) {
            return index;
        }
    }
    return max;
}

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
 * Пересчёт строки обязан совпадать с полным лексированием на любой правке.
 *
 * Проверка перебирает правки псевдослучайно, но детерминированно: окно
 * пересчёта — строка, поэтому важны не отдельные заранее выбранные позиции, а
 * то, что ни одна правка внутри строки не даёт расхождения. Перебираются в том
 * числе правки, меняющие разбиение строки на токены (пробел, точка с запятой,
 * кавычка, скобка) и открывающие многострочные конструкции — на последних путь
 * обязан отказываться.
 *
 * Отсутствие такой проверки означало бы, что расхождение находит пользователь:
 * токены лежат в основе AST, Structure, Problems и подсветки.
 */
test("пересчёт строки совпадает с полным лексированием на случайных правках", () => {
    /* Источник с комментариями и квадратными блоками: их relex обязан обходить. */
    const chunks = [];
    for (let index = 0; index < 450; index++) {
        chunks.push(
            `Macro Handler${index}(obj, cmd, id)`,
            `  Var value${index} = ${index}, other${index} = "text ${index}";`,
            index % 7 === 0 ? `  /* блочный${index}` : `  // строчный ${index}`,
            index % 7 === 0 ? `     продолжение */` : `  if (cmd == "run")`,
            index % 7 === 0 ? "  x = 1;" : `    Println(other${index});`,
            index % 11 === 0 ? "  q = [select * from tbl];" : "  End;",
            `  return value${index};`,
            "End;",
            ""
        );
    }
    const source = chunks.join("\n");
    assert.ok(source.length > 50_000, "Нужен файл выше порога relex");

    const lex = lexRsl(source);
    /* Детерминированный ГПСЧ: падение теста обязано воспроизводиться. */
    let seed = 20260811;
    const random = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
    };

    const inserts = [
        "X", " ", ";", "\"", "(", ")", "/*", "*/", "//", "[", "]",
        "renamed", "\t", "'", "0x1F", "\\", ",", "=="
    ];
    let applied = 0;
    let refused = 0;

    for (let attempt = 0; attempt < 400; attempt++) {
        /* Правки только во второй половине файла: в начале действует отсечка. */
        const at = Math.floor(
            source.length * 0.5 + random() * source.length * 0.49
        );
        const insert = inserts[Math.floor(random() * inserts.length)];
        const removeCount = Math.floor(random() * 4);
        const next = source.slice(0, at) + insert +
            source.slice(at + removeCount);

        const incremental = tryIncrementalRelex(source, lex, next);

        if (!incremental) {
            refused++;
            continue;
        }

        applied++;
        const full = lexRsl(next);
        const where = `вставка ${JSON.stringify(insert)} в позицию ${at}, ` +
            `удалено ${removeCount} символов`;

        /*
         * Сравнение идёт по подписи, а не deepStrictEqual по массивам: в файле
         * этого размера около 28 тысяч токенов, и глубокое сравнение на каждой
         * из сотен правок исчерпывало память. При расхождении первый несовпавший
         * токен всё равно печатается целиком.
         */
        if (tokenSignature(incremental.tokens) !== tokenSignature(full.tokens)) {
            const index = firstDifferenceIndex(
                incremental.tokens,
                full.tokens
            );
            assert.deepStrictEqual(
                incremental.tokens[index],
                full.tokens[index],
                `Расхождение token stream на токене ${index}: ${where}`
            );
            assert.fail(`Расхождение длины token stream: ${where}`);
        }

        assert.deepStrictEqual(
            incremental.lineStarts,
            full.lineStarts,
            `Расхождение границ строк: ${where}`
        );
        assert.strictEqual(incremental.hasBom, full.hasBom);
        assert.strictEqual(incremental.hasFinalEol, full.hasFinalEol);
    }

    assert.ok(
        applied > 60,
        `Пересчёт строки применился всего ${applied} раз из 400 — ` +
            "проверка почти ничего не проверила"
    );
    assert.ok(
        refused > 0,
        "Ни одна правка не была отклонена — проверьте, что comment, square " +
            "и переводы строк по-прежнему уходят на полный lexRsl"
    );
    console.log(
        `[METRIC] пересчёт строки: применён ${applied}, отклонён ${refused}`
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

/*
 * Enter — самая частая правка после набора символа, и до сих пор она уходила на
 * полное лексирование: любая правка с переводом строки отвергалась, потому что
 * у всего остатка потока меняются не только смещения, но и номера строк.
 *
 * Здесь проверяется не выигрыш, а совпадение: номера строк, колонки и
 * lineStarts обязаны сойтись с полным лексированием до последнего поля.
 * Расхождение в них означало бы сдвинутые Problems и подсветку.
 */
test("серия Enter пересчитывается точечно и совпадает с полным lex", () => {
    for (const size of [100, 300, 500]) {
        let source = bigLexSource(size);
        assert.ok(
            source.length > 100_000,
            `нужен файл больше 100 КБ, получено ${source.length}`
        );

        let applied = 0;

        /* Начало, середина и конец: в начале путь обязан отказываться. */
        for (const fraction of [0.05, 0.4, 0.7, 0.95]) {
            const lex = lexRsl(source);
            const lines = source.split("\n");
            const offset = lines
                .slice(0, Math.floor(lines.length * fraction))
                .join("\n").length;

            /* Enter, затем ещё один — серия, а не одиночная правка. */
            for (let press = 0; press < 3; press++) {
                const next = `${source.slice(0, offset)}\n${source.slice(offset)}`;
                const incremental = tryIncrementalRelex(
                    source,
                    lexRsl(source),
                    next
                );

                if (incremental) {
                    applied++;
                    const full = lexRsl(next);
                    assert.deepStrictEqual(
                        incremental.tokens,
                        full.tokens,
                        `${size} КБ, доля ${fraction}: token stream разошёлся`
                    );
                    assert.deepStrictEqual(
                        incremental.lineStarts,
                        full.lineStarts,
                        `${size} КБ, доля ${fraction}: lineStarts разошлись`
                    );
                    assert.strictEqual(
                        incremental.hasFinalEol,
                        full.hasFinalEol
                    );
                }

                source = next;
            }

            void lex;
        }

        assert.ok(
            applied > 0,
            `${size} КБ: ни один Enter не пошёл точечным путём`
        );
    }
});

test("удаление перевода строки тоже пересчитывается точечно", () => {
    /* Backspace в начале строки склеивает её с предыдущей. */
    const source = bigLexSource(200);
    const lex = lexRsl(source);
    const lines = source.split("\n");
    const offset = lines
        .slice(0, Math.floor(lines.length * 0.8))
        .join("\n").length;

    assert.strictEqual(source.charAt(offset), "\n", "ожидался перевод строки");
    const next = source.slice(0, offset) + source.slice(offset + 1);
    const incremental = tryIncrementalRelex(source, lex, next);

    assert.ok(incremental, "склейка строк обязана идти точечным путём");
    const full = lexRsl(next);
    assert.deepStrictEqual(incremental.tokens, full.tokens);
    assert.deepStrictEqual(incremental.lineStarts, full.lineStarts);
});

console.log("");
console.log(`Пройдено: ${passed}`);
console.log(`Ошибок: ${failed}`);

if (failed > 0) {
    process.exitCode = 1;
}

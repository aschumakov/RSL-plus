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

/*
 * Точечный relex не должен применяться там, где он дороже полного прохода.
 *
 * Его стоимость определяется числом токенов ПОСЛЕ правки: им пересчитываются
 * позиции. Замеры: правка в начале файла 550КБ обходится в 46 мс против 40 мс
 * полного лексирования, то есть путь становится вредным. Отсечка по доле
 * потока — единственное, что удерживает его от этого.
 */
test("точечный relex ограничен долей сдвигаемого потока", () => {
    /*
     * Порог опущен с 0.5 до 0.85: копирование токена стало в пять раз дешевле,
     * и середина файла теперь идёт точечным путём. Но при сдвиге почти всего
     * потока выигрыш вырождается — на 1,1 МБ 95 мс против 98 мс полного
     * лексирования, а на машине медленнее уже минус. Отсечка обязана остаться.
     */
    const source = bigLexSource(120);
    const lex = lexRsl(source);

    /* Самое начало файла сдвигает почти весь поток — путь обязан отказаться. */
    const start = source.indexOf("value");
    let decision;
    assert.strictEqual(
        tryIncrementalRelex(
            source,
            lex,
            `${source.slice(0, start + 3)}X${source.slice(start + 3)}`,
            value => {
                decision = value;
            }
        ),
        undefined,
        "при сдвиге почти всего потока выигрыша нет"
    );
    assert.strictEqual(decision.reason, "editTooEarly");

    /* Середина и конец — идут точечно и совпадают с полным лексированием. */
    const lines = source.split("\n");
    const places = [
        ["середина", lines.slice(0, Math.floor(lines.length * 0.5)).join("\n").length],
        ["конец", source.lastIndexOf("value")]
    ];

    for (const [where, offset] of places) {
        const next = `${source.slice(0, offset)}\n${source.slice(offset)}`;
        const incremental = tryIncrementalRelex(source, lex, next);

        assert.ok(incremental, `правка в ${where} файла обязана идти точечно`);
        const full = lexRsl(next);
        assert.deepStrictEqual(
            incremental.tokens,
            full.tokens,
            `${where}: token stream разошёлся с полным лексированием`
        );
        assert.deepStrictEqual(incremental.lineStarts, full.lineStarts);
    }
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

test("причина выбора пути lex попадает в решение", () => {
    /*
     * По одной длительности lex не видно, почему правка пошла полным путём.
     * Причины разные и лечатся по-разному, поэтому каждая называется отдельно.
     */
    const source = bigLexSource(200);
    const lex = lexRsl(source);
    const reasonOf = next => {
        let decision;
        tryIncrementalRelex(source, lex, next, value => {
            decision = value;
        });
        return decision;
    };

    const lines = source.split("\n");
    const late = lines.slice(0, Math.floor(lines.length * 0.9)).join("\n").length;
    const applied = reasonOf(`${source.slice(0, late)}\n${source.slice(late)}`);
    assert.strictEqual(applied.reason, "incremental");
    /*
     * Смещение может отличаться от места вставки на один символ: общий префикс
     * захватывает и вставленный перевод строки, если следующий символ такой же.
     */
    assert.ok(
        applied.editStart >= late && applied.editStart <= late + 1,
        `позиция правки обязана быть в решении, получено ${applied.editStart}`
    );
    assert.ok(applied.editLine > 0, "номер строки правки тоже");
    assert.strictEqual(applied.lineDelta, 1, "Enter добавляет одну строку");

    /* Правка в начале файла сдвигает почти весь поток — выигрыша нет. */
    const early = source.indexOf("value");
    const atStart = reasonOf(`${source.slice(0, early)}X${source.slice(early)}`);
    assert.strictEqual(atStart.reason, "editTooEarly");
    assert.ok(
        atStart.shiftedFraction > 0.85,
        "причина обязана называть измеренную долю, а не только сам отказ"
    );

    assert.strictEqual(
        reasonOf(`${source.slice(0, late)}/*${source.slice(late)}`).reason,
        "multilineConstruct",
        "открытый комментарий обязан называться своей причиной"
    );

    /* Маленький файл точечного пути не имеет вовсе. */
    const small = "Macro T()\nEnd;\n";
    let smallDecision;
    tryIncrementalRelex(small, lexRsl(small), `${small}\n`, value => {
        smallDecision = value;
    });
    assert.strictEqual(smallDecision.reason, "smallFile");
});

console.log("");
console.log(`Пройдено: ${passed}`);
console.log(`Ошибок: ${failed}`);

if (failed > 0) {
    process.exitCode = 1;
}

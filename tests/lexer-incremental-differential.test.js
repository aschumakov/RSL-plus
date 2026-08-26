"use strict";

/**
 * Точечный пересчёт lex против полного — дифференциальные проверки.
 *
 * Случайные правки, серия Enter и сверка сигнатур токенов ловили настоящие
 * расхождения, поэтому проверки сохранены целиком. Стоят они пятнадцати
 * секунд, и место им в полном наборе, а не в быстром.
 */

const assert = require("assert");
const path = require("path");
const {
    lexRsl
} = require(path.join(
    __dirname,
    "..",
    "server",
    "out",
    "lexer"
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

if (failed > 0) {
    console.error(`\nПройдено: ${passed}\nОшибок: ${failed}`);
    process.exitCode = 1;
} else {
    console.log(`\nПройдено: ${passed}\nОшибок: ${failed}`);
}

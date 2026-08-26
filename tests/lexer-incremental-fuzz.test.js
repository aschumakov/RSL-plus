"use strict";

/**
 * Точечный пересчёт lex против полного — случайные правки.
 *
 * Четыреста случайных правок против полного лексирования: самая долгая
 * проверка набора (девять секунд) и самая полезная — именно она находила
 * расхождения точечного пути. Отдельный файл нужен, чтобы она шла
 * параллельно с остальными, а не держала всю группу.
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

if (failed > 0) {
    console.error(`\nПройдено: ${passed}\nОшибок: ${failed}`);
    process.exitCode = 1;
} else {
    console.log(`\nПройдено: ${passed}\nОшибок: ${failed}`);
}

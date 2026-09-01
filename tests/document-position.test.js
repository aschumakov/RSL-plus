"use strict";

/**
 * Один контракт перевода координат и поиска токена.
 *
 * Обе операции жили копиями примерно в десяти файлах, и копии разошлись по
 * существу. Смещение в позицию: одни искали строку бинарным поиском, другие
 * проходили список начал строк подряд. Позиция в смещение: одни прижимали
 * символ к концу строки, другие — к концу документа, и негодная позиция по
 * второму правилу уезжала на следующие строки, то есть ответ выдавался не про
 * то место, куда показывает пользователь.
 *
 * Здесь закреплено правило, а не реализация: оно из спецификации LSP — символ
 * за концом строки считается равным длине строки, и перевод строки в неё не
 * входит.
 */

const assert = require("assert");

const serverModulePath = require.resolve("../server/out/server");

require.cache[serverModulePath] = {
    id: serverModulePath,
    filename: serverModulePath,
    loaded: true,
    exports: {
        getTree: () => [],
        GetFileByNameRequest: () => undefined
    }
};

const {
    offsetAtPosition,
    positionAtOffset,
    rangeAtOffsets
} = require("../server/out/core/documentPosition");
const {
    lexRsl,
    lowerBoundTokenIndex,
    tokenAtOffset,
    tokenIndexAtOffset
} = require("../server/out/lexer");

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

/** Начала строк так же, как их считает лексер. */
function startsOf(source) {
    return lexRsl(source).lineStarts;
}

test("смещение и позиция обратимы на всех границах строк", () => {
    const source = "Macro Run()\r\n  Var value = 1;\r\nEnd;\r\n";
    const starts = startsOf(source);

    for (let offset = 0; offset <= source.length; offset++) {
        const position = positionAtOffset(starts, offset);
        const back = offsetAtPosition(starts, source, position);
        const inTerminator = source.charCodeAt(offset) === 10 ||
            source.charCodeAt(offset) === 13;

        if (inTerminator && position.character > 0) {
            /* Внутри "\r\n" позиции нет: она прижимается к концу текста строки. */
            assert.ok(
                back <= offset,
                "смещение " + offset + ": " + back + " обязано не расти"
            );

            continue;
        }

        assert.strictEqual(
            back,
            offset,
            "смещение " + offset + " обязано вернуться самим собой"
        );
    }
});

test("символ за концом строки прижимается к её концу, а не уезжает дальше", () => {
    const source = "abc\ndefgh\nij\n";
    const starts = startsOf(source);
    /* Строка 0 — "abc": её текст кончается на смещении 3. */
    const far = offsetAtPosition(starts, source, { line: 0, character: 999 });

    assert.strictEqual(
        far,
        3,
        "позиция обязана остаться на своей строке"
    );
    assert.strictEqual(
        source.slice(far, far + 1),
        "\n",
        "и указывать ровно на перевод строки"
    );

    /* Раньше вторая половина реализаций прижимала к концу документа. */
    assert.notStrictEqual(
        far,
        source.length,
        "к концу документа прижимать нельзя"
    );
});

test("перевод строки не входит в длину строки", () => {
    for (const [eol, name] of [["\r\n", "CRLF"], ["\n", "LF"]]) {
        const source = "abc" + eol + "de" + eol;
        const starts = startsOf(source);
        const end = offsetAtPosition(starts, source, {
            line: 0,
            character: 100
        });

        assert.strictEqual(
            source.slice(0, end),
            "abc",
            name + ": конец строки — это конец её текста"
        );
    }
});

test("негодные строка и символ приводятся, а не отвергаются", () => {
    const source = "abc\ndef\n";
    const starts = startsOf(source);

    assert.strictEqual(
        offsetAtPosition(starts, source, { line: -5, character: -5 }),
        0,
        "отрицательные значения дают начало документа"
    );

    const beyond = offsetAtPosition(starts, source, {
        line: 999,
        character: 0
    });

    assert.strictEqual(
        beyond,
        starts[starts.length - 1],
        "строка за концом документа даёт начало последней строки"
    );
});

test("последняя строка без перевода строки", () => {
    const source = "abc\ndef";
    const starts = startsOf(source);

    assert.strictEqual(
        offsetAtPosition(starts, source, { line: 1, character: 100 }),
        source.length,
        "конец текста и есть конец последней строки"
    );
});

test("пустой документ", () => {
    const starts = startsOf("");

    assert.deepStrictEqual(
        positionAtOffset(starts, 0),
        { line: 0, character: 0 }
    );
    assert.strictEqual(
        offsetAtPosition(starts, "", { line: 3, character: 7 }),
        0,
        "в пустом документе любая позиция — начало"
    );
});

test("диапазон не зависит от порядка концов", () => {
    const source = "abc\ndef\n";
    const starts = startsOf(source);

    assert.deepStrictEqual(
        rangeAtOffsets(starts, 6, 1),
        rangeAtOffsets(starts, 1, 6),
        "перевёрнутый диапазон обязан быть нормализован"
    );
    assert.deepStrictEqual(
        rangeAtOffsets(starts, 1, 6),
        {
            start: { line: 0, character: 1 },
            end: { line: 1, character: 2 }
        }
    );
});

test("поиск токена по номеру и по значению отвечают одинаково", () => {
    const source = "Macro Run()\n  Var value = 1;\n  value = value + 1;\nEnd;\n";
    const tokens = lexRsl(source).tokens;

    for (let offset = 0; offset <= source.length; offset++) {
        const byValue = tokenAtOffset(tokens, offset);
        const at = tokenIndexAtOffset(tokens, offset);

        assert.strictEqual(
            at < 0 ? undefined : tokens[at],
            byValue,
            "смещение " + offset + ": номер и токен обязаны совпадать"
        );
    }
});

test("бинарный поиск токена совпадает с перебором", () => {
    const source = "Macro Run()\n  Var value = 1;\nEnd;\n";
    const tokens = lexRsl(source).tokens;

    for (let offset = 0; offset <= source.length; offset++) {
        const linear = tokens.find(token =>
            token.start <= offset && offset <= token.end);
        const binary = tokenAtOffset(tokens, offset);

        if (linear === binary) {
            continue;
        }

        /*
         * Расхождение допустимо только на стыке двух токенов: там перебор
         * всегда берёт левый, а общий поиск предпочитает имя, число или
         * строку — то, на что пользователь и показывает курсором.
         */
        assert.ok(
            binary && linear &&
            (binary.start === offset || binary.end === offset),
            "смещение " + offset + ": расхождение вне стыка токенов"
        );
    }
});

test("нижняя граница участка", () => {
    const source = "Macro Run()\n  Var value = 1;\nEnd;\n";
    const tokens = lexRsl(source).tokens;

    for (const start of [0, 5, 12, 20, source.length]) {
        const at = lowerBoundTokenIndex(tokens, start);

        assert.strictEqual(
            at,
            tokens.findIndex(token => token.start >= start) < 0
                ? tokens.length
                : tokens.findIndex(token => token.start >= start),
            "граница " + start + " обязана совпасть с перебором"
        );
    }
});

console.log(
    failed === 0
        ? "\nПройдено: " + passed
        : "\nПройдено: " + passed + ", провалено: " + failed
);

if (failed > 0) {
    process.exitCode = 1;
}

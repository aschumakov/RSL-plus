"use strict";

/**
 * Дефекты, найденные при проверке версии перед рассылкой.
 *
 * Каждая проверка соответствует одному из них: квадратичный рост лексера на
 * вложенных скобках, падение на оборванном UTF-16, автодополнение через перевод
 * строки и цена проверок выражения на очень большом файле.
 *
 * Время сравнивается не с жёстким пределом в миллисекундах, а с ростом на
 * файлах разного размера: абсолютные числа на занятом компьютере разъезжаются, а
 * характер роста — нет.
 */

const assert = require("assert");

const {
    TextDocument
} = require("../server/node_modules/vscode-languageserver-textdocument");
const { lexRsl } = require("../server/out/lexer");
const { parseRslSyntax } = require("../server/out/syntaxParser");
const { decodeRslSource } = require("../server/out/core/textDecoding");
const {
    createFastDocumentSnapshot
} = require("../server/out/services/fastDocumentSnapshot");
const {
    buildRslFastMemberCompletions
} = require("../server/out/features/fastCompletionProvider");

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

/**
 * Лучшее время из нескольких прогонов.
 *
 * Не медиана: сборка мусора и посторонняя нагрузка только добавляют время, и
 * медиана двух разных размеров разъезжается на разы. Минимум отвечает на вопрос
 * «сколько это стоит по существу» и от прогона к прогону держится.
 */
function milliseconds(action, runs = 7) {
    let best = Number.POSITIVE_INFINITY;

    for (let run = 0; run < runs; run++) {
        const started = process.hrtime.bigint();
        action();
        best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
    }

    return best;
}

/** Текст из вложенных вызовов, за которыми идёт индекс: `f(f(a))[i];`. */
function nestedCalls(sizeKb) {
    const line = "x = " + "f(".repeat(40) + "a" + ")".repeat(40) + "[i];\n";
    let source = "";

    while (source.length < sizeKb * 1024) {
        source += line;
    }

    return source;
}

test("лексер на вложенных скобках растёт линейно", () => {
    /*
     * Здесь был квадратичный рост: для каждой пары `)[` шёл поиск назад до
     * парной скобки, и 20 КБ такого текста лексировались 107 мс вместо 4.
     */
    const withIndex = nestedCalls(60);
    /* Тот же текст и тот же размер, но без пары `)[`, которая и тормозила. */
    const withoutIndex = withIndex.split("[i]").join("+ 1");

    for (let run = 0; run < 3; run++) {
        lexRsl(withIndex);
        lexRsl(withoutIndex);
    }

    const indexed = milliseconds(() => lexRsl(withIndex));
    const plain = milliseconds(() => lexRsl(withoutIndex));
    const ratio = indexed / Math.max(plain, 0.001);

    /*
     * Сравниваются два текста одного размера: так из замера уходит и разница в
     * объёме памяти, и разница в числе токенов. Обход назад делал текст с
     * `)[` в разы дороже — здесь разница должна быть в пределах шума.
     */
    assert.ok(
        ratio < 2,
        "текст с `)[` дороже такого же без него в " + ratio.toFixed(1) +
            " раза: " + plain.toFixed(1) + " мс -> " + indexed.toFixed(1) + " мс"
    );
});

test("оборванный UTF-16 не срывает чтение файла", () => {
    const cases = [
        ["LE целый", [0xFF, 0xFE, 0x41, 0x00, 0x42, 0x00], "AB"],
        ["LE без последнего байта", [0xFF, 0xFE, 0x41, 0x00, 0x42], "A"],
        ["BE целый", [0xFE, 0xFF, 0x00, 0x41, 0x00, 0x42], "AB"],
        ["BE без последнего байта", [0xFE, 0xFF, 0x00, 0x41, 0x00], "A"],
        ["только BOM LE", [0xFF, 0xFE], ""],
        ["только BOM BE", [0xFE, 0xFF], ""]
    ];

    for (const [name, bytes, expected] of cases) {
        const decoded = decodeRslSource(Buffer.from(bytes));
        assert.strictEqual(decoded.encoding, "utf16", name);
        assert.strictEqual(decoded.text, expected, name);
    }

    /* Один байт BOM не образует: файл читается как обычный. */
    assert.notStrictEqual(
        decodeRslSource(Buffer.from([0xFF])).encoding,
        "utf16"
    );
    assert.strictEqual(decodeRslSource(Buffer.from([])).text, "");
});

test("подсказка членов не переходит через перевод строки", () => {
    const members = () => [{ label: "setText" }, { label: "getText" }];
    const ask = source => {
        const document = TextDocument.create("file:///m.mac", "rsl", 1, source);
        return buildRslFastMemberCompletions(
            createFastDocumentSnapshot(document),
            source.length,
            members
        );
    };
    const head = "Macro T()\n  Var Field7: TRsbLabel;\n  Field7.";

    /* Курсор сразу за точкой — обращение к члену. */
    assert.strictEqual(ask(head).length, 2);
    assert.strictEqual(ask(head + " ").length, 2);
    assert.strictEqual(ask(head + "set").length, 1);
    /* После перевода строки точка относится к прошлой строке. */
    assert.strictEqual(ask(head + "\n"), undefined);
    assert.strictEqual(ask(head + "\n  "), undefined);
    assert.strictEqual(ask(head + "\r\n"), undefined);
});

test("проверки выражения не меняют характер роста разбора", () => {
    /*
     * Проверки выражения идут по токенам оператора и добавляют постоянную долю
     * к разбору. Предел закреплён именно как рост: на файле вдвое большего
     * размера время не должно вырастать больше чем в три раза.
     */
    const line = "value = a + b * (c - d) / e;\n";
    const small = line.repeat(4000);
    const large = line.repeat(8000);
    const parse = source => parseRslSyntax(source, undefined, {
        buildExpressionTree: false
    });
    parse(small);
    parse(large);

    const smallTime = milliseconds(() => parse(small), 3);
    const largeTime = milliseconds(() => parse(large), 3);
    const ratio = largeTime / Math.max(smallTime, 0.001);

    assert.ok(
        ratio < 3,
        "рост в " + ratio.toFixed(1) + " раза при двукратном размере: " +
            smallTime.toFixed(1) + " мс -> " + largeTime.toFixed(1) + " мс"
    );
});

console.log("\nПройдено: " + passed + ", провалено: " + failed);

if (failed > 0) {
    process.exitCode = 1;
}

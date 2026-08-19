"use strict";

/**
 * Кодировка исходников с диска.
 *
 * Макросы RS-Bank лежат либо в UTF-8, либо в CP866. Сервер читал их всегда как
 * UTF-8, и на реальном репозитории это 4286 файлов из 5816: каждая
 * кириллическая буква превращалась в символ замены, `Macro НоваяОперация`
 * становился `Macro ????????????`, и символ переставал быть идентификатором.
 * Переход, автодополнение и вывод типов через Import для таких имён не работали.
 */

const assert = require("assert");

const {
    decodeRslSource,
    decodeRslSourceText
} = require("../server/out/core/textDecoding");
const {
    extractCompactDeclarations
} = require("../server/out/analysis/declarationExtractor");

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

/** Кодирование в CP866: обратное преобразование к тому, что делает декодер. */
function encodeCp866(text) {
    const bytes = [];

    for (const character of text) {
        const code = character.codePointAt(0);

        if (code < 0x80) {
            bytes.push(code);
        } else if (code >= 0x0410 && code <= 0x042F) {
            bytes.push(0x80 + (code - 0x0410));
        } else if (code >= 0x0430 && code <= 0x043F) {
            bytes.push(0xA0 + (code - 0x0430));
        } else if (code >= 0x0440 && code <= 0x044F) {
            bytes.push(0xE0 + (code - 0x0440));
        } else if (code === 0x0401) {
            bytes.push(0xF0);
        } else if (code === 0x0451) {
            bytes.push(0xF1);
        } else if (code === 0x2116) {
            bytes.push(0xFC);
        } else {
            throw new Error(`нет байта CP866 для ${character}`);
        }
    }

    return Buffer.from(bytes);
}

test("CP866 распознаётся и декодируется", () => {
    const source = [
        "Macro НоваяОперация(документ)",
        "  Var сумма = 0;",
        "  // комментарий № 1 с ёлкой",
        "End;"
    ].join("\n");
    const decoded = decodeRslSource(encodeCp866(source));

    assert.strictEqual(decoded.encoding, "cp866");
    assert.strictEqual(decoded.text, source, "текст обязан совпасть посимвольно");
});

test("таблица CP866 верна на всех 256 байтах", () => {
    /*
     * Кириллица в CP866 идёт подряд тремя кусками, и на них соблазнительно
     * обойтись формулой. Между ними лежат 48 символов псевдографики с
     * произвольным порядком: первая версия считала их арифметикой и давала
     * другие символы, а проверка смотрела только на кириллицу и молчала.
     *
     * Эталон — таблица Unicode.org, выписанная здесь независимо от кода.
     */
    const reference = [];

    for (let index = 0; index < 32; index++) {
        reference.push(0x0410 + index);
    }
    for (let index = 0; index < 16; index++) {
        reference.push(0x0430 + index);
    }
    reference.push(
        0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556,
        0x2555, 0x2563, 0x2551, 0x2557, 0x255D, 0x255C, 0x255B, 0x2510,
        0x2514, 0x2534, 0x252C, 0x251C, 0x2500, 0x253C, 0x255E, 0x255F,
        0x255A, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256C, 0x2567,
        0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256B,
        0x256A, 0x2518, 0x250C, 0x2588, 0x2584, 0x258C, 0x2590, 0x2580
    );
    for (let index = 0; index < 16; index++) {
        reference.push(0x0440 + index);
    }
    reference.push(
        0x0401, 0x0451, 0x0404, 0x0454, 0x0407, 0x0457, 0x040E, 0x045E,
        0x00B0, 0x2219, 0x00B7, 0x221A, 0x2116, 0x00A4, 0x25A0, 0x00A0
    );

    assert.strictEqual(reference.length, 128, "эталон обязан покрыть 0x80..0xFF");

    const wrong = [];

    for (let byte = 0; byte <= 0xFF; byte++) {
        const decoded = decodeRslSourceText(Buffer.from([byte]));
        const expected = byte < 0x80 ? byte : reference[byte - 0x80];

        if (decoded.charCodeAt(0) !== expected) {
            wrong.push(
                `0x${byte.toString(16)}: U+${decoded.charCodeAt(0).toString(16)}` +
                ` вместо U+${expected.toString(16)}`
            );
        }
    }

    assert.deepStrictEqual(wrong, [], "таблица CP866 обязана совпасть целиком");
});

test("кодировка определяется по BOM: есть BOM — UTF-8, нет — CP866", () => {
    const source = "Macro НоваяОперация()\nEnd;";

    /*
     * Файл без BOM читается как CP866 — так принято в репозитории банка.
     * Прежде такой файл сначала проверялся на корректный UTF-8, и файл,
     * случайно оказавшийся корректным UTF-8, читался не по соглашению.
     */
    const plain = decodeRslSource(Buffer.from(source, "utf8"));

    assert.strictEqual(plain.encoding, "cp866");

    const withBom = decodeRslSource(
        Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(source, "utf8")])
    );
    assert.strictEqual(withBom.encoding, "utf8");
    assert.strictEqual(
        withBom.text,
        source,
        "BOM обязан быть снят, иначе он станет первым символом текста"
    );
});

test("длина в символах сохраняется: на ней держатся все смещения", () => {
    const source = "Var сумма = 1;";
    const bytes = encodeCp866(source);

    assert.ok(
        bytes.length === source.length,
        "в CP866 один символ — один байт, и смещения обязаны совпадать"
    );
    assert.strictEqual(decodeRslSourceText(bytes).length, source.length);
});

test("кириллическое имя остаётся идентификатором", () => {
    /*
     * Ради этого всё и делается: до исправления имя приходило в виде символов
     * замены, извлекатель объявлений не мог его прочитать, и символ пропадал
     * из индекса.
     */
    const source = [
        "Macro НоваяОперация(документ)",
        "End;",
        "Class ДокументПлатежа",
        "  Macro Сохранить()",
        "  End;",
        "End;"
    ].join("\n");
    const text = decodeRslSourceText(encodeCp866(source));
    const declarations = extractCompactDeclarations(text, {
        includePrivate: true
    }).declarations;

    assert.deepStrictEqual(
        declarations.map(item => item.name),
        ["НоваяОперация", "ДокументПлатежа"]
    );
    assert.deepStrictEqual(
        declarations[1].children.map(item => item.name),
        ["Сохранить"]
    );

    /* А как выглядел бы прежний путь — на том же файле. */
    const asUtf8 = encodeCp866(source).toString("utf8");
    assert.ok(
        asUtf8.includes("�"),
        "прежнее чтение обязано было портить текст — иначе исправлять нечего"
    );
    assert.ok(
        !extractCompactDeclarations(asUtf8, { includePrivate: true })
            .declarations
            .some(item => item.name === "НоваяОперация"),
        "и терять объявление"
    );
});

test("пустой файл и чистый ASCII не ломаются", () => {
    assert.strictEqual(decodeRslSourceText(Buffer.alloc(0)), "");
    assert.strictEqual(decodeRslSource(Buffer.alloc(0)).encoding, "cp866");

    /* На чистом ASCII CP866 и UTF-8 совпадают байт в байт. */
    const ascii = "Macro Test()\r\n  Var x = 1;\r\nEnd;\r\n";
    const decoded = decodeRslSource(Buffer.from(ascii, "ascii"));
    assert.strictEqual(decoded.encoding, "cp866");
    assert.strictEqual(decoded.text, ascii);
});

/*
 * ─── Идентичность URI ───────────────────────────────────────────────────────
 *
 * Её спрашивают на каждый разрешённый символ, а считается она разбором URL с
 * нормализацией пути. В профиле семантической подсветки это была одна из самых
 * дорогих строк, и ответ теперь запоминается. Запоминание обязано не менять
 * ответ — это и проверяется.
 */

test("идентичность URI не зависит от того, спрашивали ли её раньше", () => {
    const {
        getUriIdentity,
        normalizeUriPath
    } = require("../server/out/indexing/moduleNames");

    const cases = [
        "file:///d%3A/repo/Macro.mac",
        "file:///d:/repo/macro.mac",
        "file:///D:/Repo/MACRO.MAC",
        "untitled:Untitled-1",
        "rsl:builtin",
        "",
        "file:",
        "не-URI вовсе"
    ];

    for (const uri of cases) {
        const first = getUriIdentity(uri);
        const second = getUriIdentity(uri);

        assert.strictEqual(
            second,
            first,
            `${uri}: повторный ответ обязан совпасть с первым`
        );
        assert.strictEqual(typeof first, "string");
        assert.ok(first.length > 0 || uri.length === 0);
    }

    /* Не-файловый URI возвращается как есть: нормализовать его нечем. */
    assert.strictEqual(getUriIdentity("rsl:builtin"), "rsl:builtin");
    assert.strictEqual(getUriIdentity("untitled:X"), "untitled:X");

    /* На Windows регистр пути не различает файлы. */
    if (process.platform === "win32") {
        assert.strictEqual(
            getUriIdentity("file:///d:/repo/macro.mac"),
            getUriIdentity("file:///D:/Repo/MACRO.MAC"),
            "регистр пути не должен делать из одного файла два"
        );
    }

    /* И тот же ответ у нормализации пути. */
    assert.strictEqual(
        normalizeUriPath("rsl:builtin"),
        "rsl:builtin"
    );
});

if (failed > 0) {
    console.error(`\nПройдено: ${passed}\nОшибок: ${failed}`);
    process.exitCode = 1;
} else {
    console.log(`\nПройдено: ${passed}\nОшибок: ${failed}`);
}

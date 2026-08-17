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

test("UTF-8 остаётся UTF-8, в том числе с BOM", () => {
    const source = "Macro НоваяОперация()\nEnd;";
    const plain = decodeRslSource(Buffer.from(source, "utf8"));

    assert.strictEqual(plain.encoding, "utf8");
    assert.strictEqual(plain.text, source);

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
    assert.strictEqual(decodeRslSource(Buffer.alloc(0)).encoding, "utf8");

    const ascii = "Macro Test()\r\n  Var x = 1;\r\nEnd;\r\n";
    const decoded = decodeRslSource(Buffer.from(ascii, "ascii"));
    assert.strictEqual(decoded.encoding, "utf8");
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

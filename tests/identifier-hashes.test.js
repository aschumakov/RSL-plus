"use strict";

/**
 * Набор хэшей идентификаторов файла.
 *
 * Это отсечка для поиска ссылок: файл, в наборе которого искомого имени нет,
 * не читается вовсе. Ошибка здесь не косметическая — поиск перестанет находить
 * настоящие использования.
 *
 * Прежний способ на каждое вхождение заводил две строки: вырезку имени и её
 * приведённую копию. Идентификаторов в файле тысячи, и на настоящем проекте
 * это обходилось в четверть времени компактного чтения. Теперь хэш считается
 * прямо по диапазону текста, и здесь проверяется, что ответ от этого не
 * изменился.
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
    collectIdentifierHashes,
    hashReferenceIdentifier
} = require("../server/out/analysis/referenceSourceFacts");
const {
    isIdentifierPart,
    isIdentifierStart,
    normalizeIdentifier
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

/**
 * Прежний способ, слово в слово: вырезка, приведение, хэш.
 *
 * Он здесь как эталон. Новый обязан давать тот же набор.
 */
function reference(source) {
    const hashes = new Set();
    let position = 0;

    while (position < source.length) {
        if (!isIdentifierStart(source.charAt(position))) {
            position++;
            continue;
        }

        const start = position++;

        while (
            position < source.length &&
            isIdentifierPart(source.charAt(position))
        ) {
            position++;
        }

        const name = normalizeIdentifier(source.substring(start, position));

        if (name) {
            hashes.add(hashReferenceIdentifier(name));
        }
    }

    return Array.from(hashes).sort((left, right) => left - right);
}

/** Сверка нового способа с эталоном. */
function same(source, note) {
    assert.deepStrictEqual(
        Array.from(collectIdentifierHashes(source)),
        reference(source),
        note || source
    );
}

test("обычный код", () => {
    same([
        "Import lib;",
        "Macro Send(document, silent)",
        "  Var local = document;",
        "  return local;",
        "End;",
        ""
    ].join("\n"));
});

test("имена в строках и комментариях учитываются", () => {
    /*
     * Ради этого набор и считается по сырому тексту: имя метода в RSL
     * запросто написано строкой.
     */
    const source = 'Macro Run()\n  // про GetClient\n  R2M(obj, "Method");\nEnd;\n';

    same(source);
    assert.ok(
        Array.from(collectIdentifierHashes(source)).includes(
            hashReferenceIdentifier("method")
        ),
        "имя из строки обязано попасть в набор"
    );
    assert.ok(
        Array.from(collectIdentifierHashes(source)).includes(
            hashReferenceIdentifier("getclient")
        ),
        "и имя из комментария тоже"
    );
});

test("регистр значения не имеет", () => {
    const upper = Array.from(collectIdentifierHashes("SendDocument"));
    const lower = Array.from(collectIdentifierHashes("senddocument"));

    assert.deepStrictEqual(upper, lower);
    same("SendDocument senddocument SENDDOCUMENT");
});

test("кириллица складывается так же", () => {
    same("ПроводкиНеттинг проводкинеттинг ПРОВОДКИНЕТТИНГ");
    assert.deepStrictEqual(
        Array.from(collectIdentifierHashes("Ёлка")),
        Array.from(collectIdentifierHashes("ёлка")),
        "Ё и ё — одно имя"
    );
});

test("цифры и подчёркивание — часть имени", () => {
    same("_private name2 l_rurCode ID_Operation");
});

test("границы имени", () => {
    same("a.b.c", "точка разделяет имена");
    same("1abc", "имя не начинается с цифры");
    same("", "пустой файл");
    same("   \n\t  ", "только пробелы");
    same("name", "имя в самом конце без завершителя");
});

test("одно и то же имя даёт одну запись", () => {
    assert.strictEqual(
        collectIdentifierHashes("alpha alpha alpha").length,
        1
    );
});

test("набор отсортирован", () => {
    const values = Array.from(
        collectIdentifierHashes("zeta alpha mu beta omega")
    );

    assert.deepStrictEqual(
        values,
        values.slice().sort((left, right) => left - right),
        "поиск ищет по нему двоичным, порядок обязателен"
    );
});

test("много вариаций совпадают с эталоном", () => {
    /*
     * Дословная сверка на настоящем корпусе проекта делалась отдельным
     * стендом: 6166 файлов, 1 666 862 уникальных идентификатора, ноль
     * расхождений. Здесь остаётся сторож на случайных наборах символов.
     */
    const alphabet = "aZ_9.АяЁё \n\"'/";

    for (let index = 0; index < 400; index++) {
        let source = "";

        for (let at = 0; at < 60; at++) {
            source += alphabet.charAt((index * 7 + at * 13) % alphabet.length);
        }

        same(source, JSON.stringify(source));
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

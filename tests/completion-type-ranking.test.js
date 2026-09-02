"use strict";

/**
 * Ожидаемый тип поднимает подходящих кандидатов.
 *
 * Это ВЕС, а не фильтр. Тип выводится не всегда и не обязан быть верным во всех
 * случаях; отбрасывать по нему кандидатов значило бы прятать нужное имя из-за
 * неточного вывода. Поэтому проверяется и то, что подходящий стал выше, и то,
 * что остальные никуда не делись.
 */

const assert = require("assert");

const {
    rankCompletionItemsForPrefix
} = require("../server/out/features/completionRanking");

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

/** Кандидат с известным типом. */
function candidate(label, type) {
    return {
        label,
        kind: 6,
        data: { symbolId: label, rslType: type }
    };
}

/** Имена в порядке показа. */
function order(items, prefix, options) {
    return rankCompletionItemsForPrefix(items, prefix, options)
        .slice()
        .sort((left, right) =>
            String(left.sortText).localeCompare(String(right.sortText)))
        .map(item => item.label);
}

const ITEMS = [
    candidate("docAlpha", "tbfile"),
    candidate("docBravo", "string"),
    candidate("docCharlie", "tbfile"),
    candidate("docDelta", "")
];

test("без ожидаемого типа порядок прежний", () => {
    assert.deepStrictEqual(
        order(ITEMS, "doc"),
        ["docAlpha", "docBravo", "docCharlie", "docDelta"]
    );
});

test("подходящие по типу поднимаются выше", () => {
    assert.deepStrictEqual(
        order(ITEMS, "doc", { expectedType: "TBFile" }),
        ["docAlpha", "docCharlie", "docBravo", "docDelta"],
        "сначала оба TBFile, потом остальные в прежнем порядке"
    );
});

test("никто не пропадает", () => {
    assert.strictEqual(
        order(ITEMS, "doc", { expectedType: "TBFile" }).length,
        ITEMS.length,
        "тип — вес, а не фильтр"
    );
});

test("регистр типа значения не имеет", () => {
    assert.deepStrictEqual(
        order(ITEMS, "doc", { expectedType: "tbFILE" }),
        order(ITEMS, "doc", { expectedType: "TBFile" })
    );
});

test("совпадение имени важнее типа", () => {
    /*
     * Точное начало имени обязано побеждать: тип лишь упорядочивает равных.
     */
    const items = [
        candidate("send", "string"),
        candidate("documentSend", "tbfile")
    ];

    assert.deepStrictEqual(
        order(items, "send", { expectedType: "TBFile" }),
        ["send", "documentSend"]
    );
});

test("неизвестный тип кандидата не мешает", () => {
    const items = [
        candidate("alpha", undefined),
        candidate("beta", "tbfile")
    ];

    assert.deepStrictEqual(
        order(items, "", { expectedType: "TBFile" }),
        ["beta", "alpha"]
    );
});

console.log(
    failed === 0
        ? "\nПройдено: " + passed
        : "\nПройдено: " + passed + ", провалено: " + failed
);

if (failed > 0) {
    process.exitCode = 1;
}

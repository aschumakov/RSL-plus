"use strict";

/*
 * Устойчивость Completion: разрешение описаний, порядок и один список на
 * версию текста.
 *
 * Проверяется то, что раньше зависело от случайностей: сколько элементов успело
 * поместиться в общий кэш, в каком порядке фоновая индексация прочитала файлы и
 * успела ли к моменту запроса появиться полная модель.
 */

const assert = require("assert");

const {
    CompletionTransport
} = require("../server/out/features/completionTransport");
const {
    rankCompletionItemsForPrefix
} = require("../server/out/features/completionRanking");
const {
    createCompletionRegistry,
    completeAfter,
    resolveItem,
    orderedLabels,
    DEFAULT_SETTINGS
} = require("./completion-harness");

let passed = 0;
let failed = 0;
const planned = [];

/* Тесты объявляются подряд, а выполняются по очереди: часть из них async. */
function test(name, action) {
    planned.push({ name, action });
}

/* --- Разрешение описаний --- */

test("длинный список разрешается целиком, включая первый элемент", () => {
    const transport = new CompletionTransport();
    const items = Array.from({ length: 2001 }, (_, at) => ({
        label: "Item" + at,
        kind: 3,
        detail: "модуль" + at,
        documentation: "описание " + at
    }));

    const list = transport.prepare(items, { sessionId: "session-1" });

    assert.strictEqual(list.items.length, 2001);
    assert.strictEqual(
        list.items[0].documentation,
        undefined,
        "тяжёлые поля уходят в resolve"
    );

    const first = transport.resolve(list.items[0]);
    const last = transport.resolve(list.items[2000]);

    assert.strictEqual(
        first.documentation,
        "описание 0",
        "первый элемент обязан разрешаться и в списке из двух тысяч"
    );
    assert.strictEqual(last.documentation, "описание 2000");
});

test("одинаковые с виду элементы разрешаются каждый в своё описание", () => {
    const transport = new CompletionTransport();
    const items = [
        {
            label: "Shared",
            kind: 3,
            detail: "common.mac",
            documentation: "из каталога one",
            data: { uri: "file:///one/common.mac", symbolId: "s1" }
        },
        {
            label: "Shared",
            kind: 3,
            detail: "common.mac",
            documentation: "из каталога two",
            data: { uri: "file:///two/common.mac", symbolId: "s1" }
        }
    ];

    const list = transport.prepare(items, { sessionId: "session-2" });

    assert.strictEqual(
        transport.resolve(list.items[0]).documentation,
        "из каталога one"
    );
    assert.strictEqual(
        transport.resolve(list.items[1]).documentation,
        "из каталога two"
    );
});

test("совпадающие во всём элементы не затирают друг друга", () => {
    const transport = new CompletionTransport();
    const list = transport.prepare(
        [
            { label: "Same", kind: 3, detail: "d", documentation: "первое" },
            { label: "Same", kind: 3, detail: "d", documentation: "второе" }
        ],
        { sessionId: "session-3" }
    );

    assert.strictEqual(transport.resolve(list.items[0]).documentation, "первое");
    assert.strictEqual(transport.resolve(list.items[1]).documentation, "второе");
});

test("память разрешения ограничена, а текущий список удерживается целиком", () => {
    const transport = new CompletionTransport({ maxItems: 300 });
    const build = (session, count) => transport.prepare(
        Array.from({ length: count }, (_, at) => ({
            label: session + "-" + at,
            kind: 3,
            detail: "d",
            documentation: "описание " + at
        })),
        { sessionId: session }
    );

    const first = build("s1", 200);
    build("s2", 200);
    const third = build("s3", 200);

    assert.ok(
        transport.retainedItems <= 400,
        "давние списки вытеснены: " + transport.retainedItems
    );
    assert.strictEqual(
        transport.resolve(third.items[0]).documentation,
        "описание 0",
        "текущий список разрешается полностью"
    );
    assert.strictEqual(
        transport.resolve(first.items[0]).documentation,
        undefined,
        "самый давний список уже не удерживается"
    );
});

/* --- Порядок --- */

test("одноимённые из разных файлов идут в одном порядке", () => {
    const make = uri => ({
        label: "Shared",
        kind: 3,
        detail: "common.mac",
        data: { uri, symbolId: "shared" }
    });
    const one = make("file:///project/one/common.mac");
    const two = make("file:///project/two/common.mac");

    const straight = rankCompletionItemsForPrefix([one, two], "Sha")
        .map(item => String(item.sortText));
    const reversed = rankCompletionItemsForPrefix([two, one], "Sha")
        .map(item => String(item.sortText));

    assert.notStrictEqual(
        straight[0],
        straight[1],
        "ключи сортировки обязаны различаться"
    );
    assert.deepStrictEqual(
        straight.slice().sort(),
        reversed.slice().sort(),
        "порядок не зависит от порядка сборки кандидатов"
    );
});

/* --- Один список на версию текста --- */

const MAIN = "file:///d:/stability/main.mac";
const SOURCE = [
    "Import lib;",
    "Macro Test()",
    "  Var counter = 1;",
    "  counter",
    "End;"
].join("\n");

const WORKSPACE = [
    { uri: "file:///d:/stability/lib.mac", text: "Macro Helper()\nEnd;\n" },
    {
        uri: "file:///d:/stability/other.mac",
        text: "Macro Another()\nEnd;\n"
    }
];

test("готовность модели не меняет уже открытый список", async () => {
    const stand = createCompletionRegistry({
        uri: MAIN,
        source: SOURCE,
        modelReady: false,
        workspace: WORKSPACE
    });
    const fast = await completeAfter(stand, "  counter");

    /* Модель этой версии готова: источник сменился, текст — нет. */
    stand.index.updateOpenModule(MAIN, SOURCE, 2);
    const afterModel = await completeAfter(stand, "  counter");

    assert.deepStrictEqual(
        orderedLabels(afterModel),
        orderedLabels(fast),
        "повторный запрос по тому же тексту обязан дать тот же список"
    );
});

test("имя модуля в Import предлагается и до готовности модели", async () => {
    const source = "Import \nMacro Test()\n  Var a = 1;\nEnd;\n";
    const stand = createCompletionRegistry({
        uri: MAIN,
        source,
        modelReady: false,
        workspace: WORKSPACE
    });
    const list = await completeAfter(stand, "Import ");
    const labels = list.items.map(item => String(item.label));

    assert.ok(
        labels.some(label => /lib/i.test(label)),
        "в Import обязаны предлагаться модули проекта: " + labels.join(", ")
    );
    assert.ok(
        !labels.includes("Test"),
        "имена области видимости в Import не предлагаются"
    );
});

test("разрешение описания работает через обработчик", async () => {
    const stand = createCompletionRegistry({
        uri: MAIN,
        source: SOURCE,
        modelReady: true,
        workspace: WORKSPACE,
        settings: {
            ...DEFAULT_SETTINGS,
            autoImport: { enabled: true }
        }
    });
    const list = await completeAfter(stand, "  counter");
    const withDetail = list.items.find(item =>
        item.data && item.data.rslCompletionKey
    );

    if (!withDetail) {
        return;
    }

    const resolved = resolveItem(stand, withDetail);
    assert.ok(
        resolved.detail !== undefined || resolved.documentation !== undefined,
        "выбранный элемент обязан получить подпись или описание"
    );
});

(async () => {
    for (const item of planned) {
        try {
            await item.action();
            passed++;
            console.log("[OK] " + item.name);
        } catch (error) {
            failed++;
            console.error("[FAIL] " + item.name);
            console.error(error);
        }
    }

    console.log("\nПройдено: " + passed + ", провалено: " + failed);

    if (failed > 0) {
        process.exitCode = 1;
    }
})();

"use strict";

/**
 * Отчёт о памяти: кто именно её занял.
 *
 * Общая цифра heap не отвечает ни на вопрос «кто занял», ни на вопрос «почему
 * выросло». Постоянных структур в сервере много — сводки модулей, каталог
 * проекта, индекс идентификаторов, записи о ссылках, кэш диагностик, кэш
 * подсветки, — и каждая молча добавляет к сумме.
 *
 * Отчёт — тоже код, и он тоже обязан быть проверен: иначе числа, по которым
 * принимаются решения, окажутся сочинёнными.
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
    collectRslServerStatus,
    formatRslServerStatus
} = require("../server/out/features/serverStatus");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

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

/** Источники с известными числами: проверяется перенос, а не сбор. */
function sources(overrides = {}) {
    return {
        openModels: () => 3,
        externalModules: () => ({ count: 4000, bytes: 1024 * 1024, limit: 4000 }),
        catalog: () => ({ modules: 6165, symbols: 97220, bytes: 2048 }),
        referenceIndex: () => ({
            files: 6165,
            identifiers: 1666207,
            persisted: 6000
        }),
        referenceShards: () => ({ files: 12, names: 30, buckets: 2 }),
        catalogStore: () => ({
            files: 6165,
            pendingDeclarations: 0,
            loaded: true
        }),
        importContexts: () => 8,
        diagnosticCache: () => ({ entries: 5, bytes: 4096 }),
        semanticTokens: () => 7,
        pinnedModules: () => 11,
        changeLogSteps: () => 42,
        evictions: () => ({ byCount: 120, byBytes: 34, blockedByPinned: 2 }),
        ...overrides
    };
}

function entryOf(status, name) {
    const found = status.entries.find(item => item.name === name);

    assert.ok(found, "в отчёте обязана быть строка «" + name + "»");

    return found;
}

test("отчёт переносит числа без искажений", () => {
    const status = collectRslServerStatus(sources());

    assert.strictEqual(entryOf(status, "Открытые модели документов").count, 3);
    assert.strictEqual(
        entryOf(status, "Сводки внешних модулей").count,
        4000
    );
    assert.strictEqual(
        entryOf(status, "Сводки внешних модулей").limit,
        4000
    );
    assert.strictEqual(entryOf(status, "Каталог проекта").count, 97220);
    assert.strictEqual(
        entryOf(status, "Каталог проекта: модули").count,
        6165
    );
    assert.strictEqual(entryOf(status, "Записи о ссылках").count, 12);
    assert.strictEqual(entryOf(status, "Кэш диагностик").bytes, 4096);
    assert.strictEqual(
        entryOf(status, "Кэш семантической подсветки").count,
        7
    );
    assert.strictEqual(
        entryOf(status, "Закреплённые зависимости").count,
        11
    );
    assert.strictEqual(entryOf(status, "Журнал правок").count, 42);
    assert.deepStrictEqual(status.evictions, {
        byCount: 120,
        byBytes: 34,
        blockedByPinned: 2
    });
});

test("отчёт называет каждую структуру и причины вытеснения", () => {
    const report = formatRslServerStatus(collectRslServerStatus(sources()));

    for (const expected of [
        "Открытые модели документов",
        "Сводки внешних модулей",
        "Каталог проекта",
        "Сохранённый состав проекта",
        "Индекс идентификаторов",
        "Записи о ссылках",
        "Import-контексты",
        "Кэш диагностик",
        "Кэш семантической подсветки",
        "Закреплённые зависимости",
        "Журнал правок",
        "Вытеснение сводок"
    ]) {
        assert.ok(
            report.includes(expected),
            "в отчёте обязана быть строка «" + expected + "»: " + report
        );
    }

    assert.ok(
        /Куча \d+[.,]\d+ МБ/u.test(report),
        "отчёт обязан называть занятую кучу: " + report
    );
});

test("отчёт говорит, был ли собран мусор", () => {
    const report = formatRslServerStatus(collectRslServerStatus(sources()));
    const collected = typeof global.gc === "function";

    assert.strictEqual(
        report.includes("без сборки мусора"),
        !collected,
        "оговорка о точности замера обязана соответствовать запуску"
    );
});

test("индекс считает причины вытеснения", () => {
    const index = new WorkspaceIndex({ maxExternalModules: 3 });
    const uris = [];

    for (let number = 0; number < 20; number++) {
        uris.push("file:///d:/status/mod" + number + ".mac");
    }

    index.registerWorkspaceFiles(uris);

    assert.deepStrictEqual(
        index.evictionStats,
        { byCount: 0, byBytes: 0, blockedByPinned: 0 },
        "до загрузки вытеснять нечего"
    );

    for (const uri of uris) {
        index.updateExternalModule(uri, "Macro Any()\nEnd;\n", 1);
    }

    assert.ok(
        index.evictionStats.byCount > 0,
        "предел по числу обязан быть назван причиной: " +
            JSON.stringify(index.evictionStats)
    );
    assert.strictEqual(
        index.externalModuleLimit,
        3,
        "предел обязан попадать в отчёт"
    );
});

test("остановленное закреплением вытеснение видно в отчёте", () => {
    const index = new WorkspaceIndex({ maxExternalModules: 2 });
    const main = "file:///d:/status/main.mac";
    const first = "file:///d:/status/a.mac";
    const second = "file:///d:/status/b.mac";
    const third = "file:///d:/status/c.mac";

    index.registerWorkspaceFiles([main, first, second, third]);
    index.updateOpenModule(main, "Import a, b, c;\nMacro Run()\nEnd;\n", 1);
    index.updateExternalModule(first, "Macro FromA()\nEnd;\n", 1);
    index.updateExternalModule(second, "Macro FromB()\nEnd;\n", 1);
    index.updateExternalModule(third, "Macro FromC()\nEnd;\n", 1);

    assert.ok(
        index.evictionStats.blockedByPinned > 0,
        "остановка по закреплению обязана быть видна: " +
            JSON.stringify(index.evictionStats)
    );
    assert.strictEqual(
        index.pinnedModuleCount,
        4,
        "закреплены документ и три его зависимости"
    );
});

if (failed > 0) {
    console.error("\nПройдено: " + passed + "\nОшибок: " + failed);
    process.exitCode = 1;
} else {
    console.log("\nПройдено: " + passed + "\nОшибок: " + failed);
}

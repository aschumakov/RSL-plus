"use strict";

/*
 * Инкрементальные диагностики против полного расчёта.
 *
 * Кэш по единицам документа имеет право экономить работу и не имеет права
 * менять ответ. Поэтому каждая правка проверяется так: тот же текст считается
 * второй раз с чистым кэшем — и два результата должны совпасть до последнего
 * символа сообщения и позиции.
 *
 * Отдельно проверяется то, чего не видно в обычном прогоне: прерванный расчёт
 * не должен попадать в кэш, а смена настроек — оставлять в нём находки,
 * посчитанные по прежним правилам.
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

const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const {
    buildLocalRslDiagnostics,
    buildLocalRslDiagnosticsChunked
} = require("../server/out/diagnostics");
const {
    RslUnitDiagnosticsCache
} = require("../server/out/diagnostics/unitDiagnosticsCache");

let passed = 0;
let failed = 0;

function test(name, action) {
    try {
        const result = action();

        if (result && typeof result.then === "function") {
            throw new Error("асинхронный тест должен запускаться через runAsync");
        }

        passed++;
        console.log(`[OK] ${name}`);
    } catch (error) {
        failed++;
        console.error(`[FAIL] ${name}`);
        console.error(error);
    }
}

const asyncTests = [];

function testAsync(name, action) {
    asyncTests.push({ name, action });
}

const EDITED = "file:///edited.mac";

function openModule(index, uri, source, version) {
    return index.updateOpenModule(uri, source, version);
}

/** Диагностики документа в его текущей версии. */
function diagnose(index, uri, source, version, cache, settings) {
    const module = openModule(index, uri, source, version);

    return buildLocalRslDiagnostics(
        module,
        index,
        settings,
        undefined,
        undefined,
        cache
    );
}

/** Сравнимый вид: без порядка и без ссылок на объекты. */
function normalize(diagnostics) {
    return diagnostics
        .map(item => JSON.stringify({
            code: item.code,
            severity: item.severity,
            message: item.message,
            range: item.range,
            data: item.data === undefined ? null : item.data,
            related: (item.relatedInformation || []).map(entry => ({
                message: entry.message,
                range: entry.location.range
            }))
        }))
        .sort();
}

/**
 * Полный расчёт того же текста.
 *
 * Считается с чистым кэшем: переиспользовать нечего, и ответ получается таким,
 * каким был бы при первом открытии файла.
 */
function fullDiagnostics(source, settings) {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([EDITED]);

    return diagnose(
        index,
        EDITED,
        source,
        1,
        new RslUnitDiagnosticsCache(),
        settings
    );
}

/**
 * Прогоняет цепочку правок и сверяет каждую версию с полным расчётом.
 *
 * Правки идут одна за другой в одном документе — именно так работает редактор,
 * и именно так накапливается ошибка кэша: неверно перенесённая запись живёт до
 * закрытия файла.
 */
function checkEdits(name, versions) {
    test(name, () => {
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([EDITED]);
        const cache = new RslUnitDiagnosticsCache();

        versions.forEach((source, step) => {
            const incremental = normalize(
                diagnose(index, EDITED, source, step + 1, cache)
            );
            const full = normalize(fullDiagnostics(source));

            assert.deepStrictEqual(
                incremental,
                full,
                `шаг ${step + 1}: инкрементальный ответ расходится с полным`
            );
        });
    });
}

const BASE = [
    "Import lib;",
    "",
    "Macro First()",
    "  Var a: BtFileRef;",
    "  return a;",
    "End;",
    "",
    "Macro Second()",
    "  Var text = \"строка\";",
    "  return text;",
    "End;",
    "",
    "Macro Third()",
    "  DebugBreak;",
    "  return 1;",
    "End;",
    ""
].join("\n");

/** Тот же текст с заменой одной строки. */
function replaced(line, text) {
    const lines = BASE.split("\n");
    lines[line] = text;

    return lines.join("\n");
}

checkEdits("повторный расчёт без правок даёт тот же ответ", [BASE, BASE]);

checkEdits("находка появляется в теле Macro", [
    BASE,
    replaced(8, "  Var text = \"незакрытая;")
]);

checkEdits("находка исчезает из тела Macro", [
    replaced(8, "  Var text = \"незакрытая;"),
    BASE
]);

checkEdits("устаревшее объявление убрано правкой", [
    BASE,
    replaced(3, "  Var a: Tbfile;"),
    BASE
]);

checkEdits("отладочный BREAK убран и возвращён", [
    BASE,
    replaced(13, "  Var b = 1;"),
    BASE,
    replaced(13, "  DebugBreak;")
]);

checkEdits("правка выше по файлу сдвигает остальные единицы", [
    BASE,
    BASE.replace("Import lib;", "Import lib;\nImport other;\nImport third;"),
    BASE.replace("Import lib;", "")
]);

checkEdits("Macro добавлена и удалена", [
    BASE,
    BASE + "\nMacro Fourth()\n  Var c: StrucRef;\nEnd;\n",
    BASE
]);

checkEdits("Macro переименована", [
    BASE,
    BASE.replace("Macro Second()", "Macro Renamed()"),
    BASE
]);

checkEdits("правка на верхнем уровне", [
    BASE,
    BASE.replace("Import lib;", "Import lib;\nVar модуль: DbfFileRef;"),
    BASE
]);

checkEdits("класс: правка в методе и правка в самом классе", [
    [
        "Class Storage;",
        "  Var поле: ArrayRef;",
        "  Macro Save()",
        "    Var a: TxtFileRef;",
        "  End;",
        "  Macro Load()",
        "    return 1;",
        "  End;",
        "End;",
        ""
    ].join("\n"),
    [
        "Class Storage;",
        "  Var поле: ArrayRef;",
        "  Macro Save()",
        "    Var a: Tbfile;",
        "  End;",
        "  Macro Load()",
        "    return 1;",
        "  End;",
        "End;",
        ""
    ].join("\n"),
    [
        "Class Storage;",
        "  Var поле: Integer;",
        "  Macro Save()",
        "    Var a: Tbfile;",
        "  End;",
        "  Macro Load()",
        "    DebugBreak;",
        "  End;",
        "End;",
        ""
    ].join("\n")
]);

checkEdits("незавершённый текст в процессе набора", [
    BASE,
    replaced(4, "  return a"),
    replaced(4, "  return a."),
    replaced(4, "  return a.Name"),
    BASE
]);

test("правка не переносит находку из пересчитанной единицы", () => {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([EDITED]);
    const cache = new RslUnitDiagnosticsCache();

    diagnose(index, EDITED, BASE, 1, cache);
    const fixed = diagnose(
        index,
        EDITED,
        replaced(3, "  Var a: Tbfile;"),
        2,
        cache
    );

    assert.strictEqual(
        fixed.filter(item => item.code === "deprecated-declaration").length,
        0,
        "исправленное объявление больше не отмечено"
    );
});

/* --- Настройки --- */

function debugBreaks(diagnostics) {
    return diagnostics.filter(item => item.code === "debugbreak").length;
}

test("выключенная проверка не остаётся в кэше", () => {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([EDITED]);
    const cache = new RslUnitDiagnosticsCache();

    const on = diagnose(index, EDITED, BASE, 1, cache, { debugBreak: true });
    assert.strictEqual(debugBreaks(on), 1, "с включённой проверкой находка есть");

    const off = diagnose(index, EDITED, BASE, 2, cache, { debugBreak: false });
    assert.strictEqual(
        debugBreaks(off),
        0,
        "после выключения предупреждение исчезает"
    );

    const again = diagnose(index, EDITED, BASE, 3, cache, { debugBreak: true });
    assert.strictEqual(
        debugBreaks(again),
        1,
        "после обратного включения предупреждение возвращается"
    );
});

test("смена structure и deprecatedDeclarations пересчитывает единицы", () => {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([EDITED]);
    const cache = new RslUnitDiagnosticsCache();
    const deprecated = list => list.filter(item =>
        item.code === "deprecated-declaration"
    ).length;

    const on = diagnose(index, EDITED, BASE, 1, cache, {
        deprecatedDeclarations: true
    });
    assert.ok(deprecated(on) > 0);

    const off = diagnose(index, EDITED, BASE, 2, cache, {
        deprecatedDeclarations: false
    });
    assert.strictEqual(deprecated(off), 0);

    const structureOff = diagnose(index, EDITED, BASE, 3, cache, {
        structure: false
    });
    const structureOn = diagnose(index, EDITED, BASE, 4, cache, {
        structure: true
    });
    assert.deepStrictEqual(
        normalize(structureOn),
        normalize(fullDiagnostics(BASE, { structure: true })),
        "включение structure даёт полный ответ"
    );
    assert.ok(structureOff.length <= structureOn.length);
});

/* --- Отмена и лимит --- */

/** Порция без бюджета: этапы идут подряд, паузы не мешают счёту отмен. */
function freeSlice() {
    return {
        shouldYield: () => false,
        yieldNow: async () => undefined,
        yieldIfNeeded: async () => undefined,
        yieldCount: 0
    };
}

/** Порция, отдающая управление на каждом шаге: отмена попадает внутрь этапа. */
function eagerSlice() {
    let yields = 0;

    return {
        shouldYield: () => true,
        yieldNow: async () => {
            yields++;
            await new Promise(resolve => setImmediate(resolve));
        },
        yieldIfNeeded: async function () {
            await this.yieldNow();
        },
        get yieldCount() {
            return yields;
        }
    };
}

testAsync("отменённый расчёт не запоминается", async () => {
    for (const [label, slice, cancelAfter] of [
        ["до этапа", freeSlice(), 0],
        ["внутри этапа", eagerSlice(), 2],
        ["ближе к концу", freeSlice(), 6]
    ]) {
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([EDITED]);
        const cache = new RslUnitDiagnosticsCache();
        const module = openModule(index, EDITED, BASE, 1);
        let calls = 0;

        await buildLocalRslDiagnosticsChunked(
            module,
            index,
            undefined,
            () => ++calls > cancelAfter,
            slice,
            undefined,
            undefined,
            cache
        );

        assert.strictEqual(
            cache.size,
            0,
            `${label}: прерванный расчёт ничего не запомнил`
        );

        /* Следующий полный расчёт обязан найти всё. */
        const full = diagnose(index, EDITED, BASE, 1, cache);
        assert.strictEqual(
            debugBreaks(full),
            1,
            `${label}: после отмены находка не потерялась`
        );
    }
});

testAsync("расчёт, упёршийся в лимит, не запоминается", async () => {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([EDITED]);
    const cache = new RslUnitDiagnosticsCache();
    /*
     * Находки здесь даёт не кэшируемая проверка — недостижимый код.
     * Именно они упираются в лимит и останавливают расчёт, не дав кэшируемым
     * проверкам дойти до конца файла.
     */
    const noisy = [
        "Macro Test()",
        "  DebugBreak;",
        "End;",
        ...Array.from({ length: 40 }, (_, at) => [
            `Macro Dead${at}()`,
            "  return 1;",
            `  Var dead${at} = 1;`,
            "End;"
        ].join("\n")),
        ""
    ].join("\n");
    const module = openModule(index, EDITED, noisy, 1);

    await buildLocalRslDiagnosticsChunked(
        module,
        index,
        { maxProblems: 3 },
        () => false,
        freeSlice(),
        undefined,
        undefined,
        cache
    );

    assert.strictEqual(cache.size, 0, "неполный результат не запомнен");

    const full = diagnose(index, EDITED, noisy, 1, cache);
    assert.strictEqual(debugBreaks(full), 1, "полный расчёт находит всё");
});

testAsync("полный расчёт запоминается", async () => {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([EDITED]);
    const cache = new RslUnitDiagnosticsCache();
    const module = openModule(index, EDITED, BASE, 1);

    await buildLocalRslDiagnosticsChunked(
        module,
        index,
        undefined,
        () => false,
        freeSlice(),
        undefined,
        undefined,
        cache
    );

    assert.strictEqual(cache.size, 1, "результат запомнен");
    assert.ok(cache.bytes > 0);
});

/* --- Память --- */

test("закрытый файл уходит из кэша", () => {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([EDITED]);
    const cache = new RslUnitDiagnosticsCache();

    diagnose(index, EDITED, BASE, 1, cache);
    assert.strictEqual(cache.size, 1);
    assert.ok(cache.bytes > 0);

    cache.forget(EDITED);
    assert.strictEqual(cache.size, 0, "запись удалена");
    assert.strictEqual(cache.bytes, 0, "память освобождена");
});

test("кэш ограничен по памяти, а не только по числу файлов", () => {
    const cache = new RslUnitDiagnosticsCache({
        maxEntries: 50,
        maxBytes: 200 * 1024
    });
    const big = BASE + "Macro Padding()\n  Var s = \"" +
        "x".repeat(60 * 1024) + "\";\nEnd;\n";

    for (let file = 0; file < 6; file++) {
        const uri = `file:///big-${file}.mac`;
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([uri]);
        diagnose(index, uri, big, 1, cache);
    }

    assert.ok(
        cache.bytes <= 200 * 1024,
        "граница по памяти соблюдена: " + cache.bytes
    );
    assert.ok(cache.size < 6, "старые записи вытеснены: " + cache.size);
});

(async () => {
    for (const item of asyncTests) {
        try {
            await item.action();
            passed++;
            console.log(`[OK] ${item.name}`);
        } catch (error) {
            failed++;
            console.error(`[FAIL] ${item.name}`);
            console.error(error);
        }
    }

    console.log(`\nПройдено: ${passed}, провалено: ${failed}`);

    if (failed > 0) {
        process.exit(1);
    }
})();

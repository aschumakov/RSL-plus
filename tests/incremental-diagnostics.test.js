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
const fs = require("fs");

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
const { RslScopeResolver } = require("../server/out/scopeResolver");

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

testAsync("предел публикации не отменяет запись в кэш", async () => {
    /*
     * Прежде расчёт обрывался на пределе Problems, и это отменяло запись:
     * неполный результат запоминать нельзя. Из-за этого файл, набравший
     * предел, пересчитывался целиком на каждую правку — и обрыв обходился
     * дороже полного расчёта: на printdog.mac 92 мс против 71.
     *
     * Теперь предел ограничивает вывод, а не анализ: расчёт доходит до конца,
     * запись сохраняется, а лишние сообщения просто не публикуются. Обрыв
     * остался у отмены и у страховочного предела расчёта — их путь тот же, и
     * он проверен выше.
     */
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([EDITED]);
    const cache = new RslUnitDiagnosticsCache();
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
    const published = await buildLocalRslDiagnosticsChunked(
        module,
        index,
        { maxProblems: 3 },
        () => false,
        freeSlice(),
        undefined,
        undefined,
        cache
    );

    assert.strictEqual(
        published.length,
        3,
        "публикуется ровно предел: " + published.length
    );
    assert.ok(
        cache.size >= 1,
        "полный расчёт обязан попасть в кэш, а не пропасть из-за предела"
    );

    /* И ничего не потеряно: полный ответ по тому же кэшу находит всё. */
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

    /*
     * Записей на файл столько, сколько лент: проверки, зависящие только от
     * текста, и проверки, читающие импорты, устаревают от разных событий.
     */
    assert.ok(cache.size >= 1, "результат запомнен: " + cache.size);
    assert.ok(cache.bytes > 0);
});

/* --- Память --- */

/* ─────────────────── Ленты кэша: text и imports ────────────────────────── */

/*
 * Лента imports устаревает от окружения файла, а не от каждой правки.
 *
 * Прежде её отпечаток содержал полный ключ Import-замыкания, а тот включает
 * версию самого открытого документа. Любая правка меняла версию, и лента не
 * давала ни одного попадания на всём проекте макросов: проверки, читающие
 * импорты, считались заново на каждое нажатие клавиши.
 *
 * Здесь проверяется граница: что ленту обязано обнулять, а что нет.
 */

const LANE_MAIN = "file:///d:/lane/main.mac";
const LANE_DIRECT = "file:///d:/lane/direct.mac";
const LANE_DEEP = "file:///d:/lane/deep.mac";

/** Файл, в котором есть присваивание: проверка импортов на нём работает. */
function laneSource(body, imports = "Import direct;") {
    return [
        imports,
        "Var moduleWide;",
        "Macro Handle(value)",
        "  Var local;",
        "  local = value;",
        body,
        "  return local;",
        "End;",
        ""
    ].join("\n");
}

/**
 * Стенд одного открытого файла: кэш, resolver и наблюдение за лентами.
 *
 * Ревизия каталога прикладных модулей подставная: настоящий каталог читает
 * файлы с диска, а тесту нужно только её изменение.
 */
function laneStand() {
    const index = new WorkspaceIndex();
    const platform = {
        revision: 0,
        /* Пустой каталог: тесту нужно только изменение ревизии. */
        findSymbol: () => undefined,
        findClass: () => undefined,
        findBaseClass: () => undefined,
        findResultType: () => undefined,
        knowsModule: () => false,
        indexState: () => "loaded",
        completionItems: () => [],
        classCompletionItems: () => []
    };

    index.registerWorkspaceFiles([LANE_MAIN, LANE_DIRECT, LANE_DEEP]);
    index.updateExternalModule(LANE_DEEP, "Macro DeepHelper()\nEnd;\n", 1);
    index.updateExternalModule(
        LANE_DIRECT,
        "Import deep;\nMacro DirectHelper()\nEnd;\n",
        1
    );

    const cache = new RslUnitDiagnosticsCache();
    const resolver = new RslScopeResolver(index, undefined, platform);
    let version = 0;

    return {
        index,
        platform,
        cache,
        /** Пересчитать файл и вернуть, попала ли лента imports. */
        run(source) {
            const before = cache.laneStats("imports");

            version++;

            const module = index.updateOpenModule(LANE_MAIN, source, version);

            buildLocalRslDiagnostics(
                module,
                index,
                undefined,
                undefined,
                resolver,
                cache
            );

            const after = cache.laneStats("imports");

            if (
                after.hits + after.misses ===
                before.hits + before.misses
            ) {
                throw new Error(
                    "лента imports не участвовала в расчёте: проверка, " +
                    "читающая импорты, не запустилась"
                );
            }

            return after.hits > before.hits;
        },
        /** Заменить содержимое зависимости. */
        change(uri, source, moduleVersion) {
            index.updateExternalModule(uri, source, moduleVersion);
        }
    };
}

test("правка тела процедуры оставляет ленту imports тёплой", () => {
    const stand = laneStand();

    stand.run(laneSource("  local = local + 1;"));

    assert.strictEqual(
        stand.run(laneSource("  local = local + 2;")),
        true,
        "первая правка тела обязана попасть в ленту imports"
    );
    assert.strictEqual(
        stand.run(laneSource("  local = local + 3;")),
        true,
        "вторая правка подряд — тоже"
    );
});

test("новая локальная Var не обнуляет ленту imports", () => {
    const stand = laneStand();

    stand.run(laneSource("  local = local + 1;"));

    assert.strictEqual(
        stand.run(laneSource("  Var another;\n  another = local;")),
        true,
        "объявление внутри процедуры окружения файла не меняет"
    );
});

test("правка Import обнуляет ленту imports", () => {
    for (const [name, imports] of [
        ["добавление", "Import direct;\nImport deep;"],
        ["удаление", ""],
        ["замена", "Import deep;"],
        ["ненайденный модуль", "Import direct;\nImport notyet;"]
    ]) {
        const stand = laneStand();

        stand.run(laneSource("  local = local + 1;"));

        assert.strictEqual(
            stand.run(laneSource("  local = local + 1;", imports)),
            false,
            name + " Import обязано обнулить ленту imports"
        );
    }
});

test("изменение зависимости обнуляет ленту imports", () => {
    const direct = laneStand();

    direct.run(laneSource("  local = local + 1;"));
    direct.change(
        LANE_DIRECT,
        "Import deep;\nMacro DirectHelper()\nEnd;\nMacro Added()\nEnd;\n",
        2
    );

    assert.strictEqual(
        direct.run(laneSource("  local = local + 1;")),
        false,
        "изменение прямой зависимости обязано обнулить ленту"
    );

    const deep = laneStand();

    deep.run(laneSource("  local = local + 1;"));
    deep.change(
        LANE_DEEP,
        "Macro DeepHelper()\nEnd;\nMacro DeepAdded()\nEnd;\n",
        2
    );

    assert.strictEqual(
        deep.run(laneSource("  local = local + 1;")),
        false,
        "изменение транзитивной зависимости обязано обнулить ленту"
    );
});

test("появление недоступного модуля обнуляет ленту imports", () => {
    const stand = laneStand();
    const source = laneSource("  local = local + 1;", "Import later;");

    stand.run(source);

    /* Модуль появился в проекте: имена из него теперь обязаны разрешаться. */
    stand.index.registerWorkspaceFiles([
        LANE_MAIN,
        LANE_DIRECT,
        LANE_DEEP,
        "file:///d:/lane/later.mac"
    ]);
    stand.index.updateExternalModule(
        "file:///d:/lane/later.mac",
        "Macro LaterHelper()\nEnd;\n",
        1
    );

    assert.strictEqual(
        stand.run(source),
        false,
        "прежде ненайденный модуль появился — лента обязана обнулиться"
    );
});

test("изменение каталога прикладных модулей обнуляет ленту imports", () => {
    const stand = laneStand();

    stand.run(laneSource("  local = local + 1;"));
    stand.platform.revision++;

    assert.strictEqual(
        stand.run(laneSource("  local = local + 1;")),
        false,
        "каталог дочитан — имена могли разрешиться, лента обязана обнулиться"
    );
});

test("новое имя уровня модуля обнуляет ленту imports", () => {
    const stand = laneStand();

    stand.run(laneSource("  local = local + 1;"));

    const withName = laneSource("  local = local + 1;")
        .replace("Var moduleWide;", "Var moduleWide;\nVar moduleWideToo;");

    assert.strictEqual(
        stand.run(withName),
        false,
        "новая переменная уровня модуля обязана обнулить ленту"
    );
});

test("полный ключ окружения остаётся у прочих потребителей", () => {
    /*
     * Кэш semantic tokens сверяется по полному ключу: там версия документа как
     * раз нужна — подсветку пересчитывать при каждой правке и надо. Ключ без
     * документа существует отдельно и от правки не меняется.
     */
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([LANE_MAIN]);

    const resolver = new RslScopeResolver(index);
    const source = laneSource("  local = local + 1;", "");

    index.updateOpenModule(LANE_MAIN, source, 1);

    const fullBefore = resolver.getImportContextKey(LANE_MAIN);
    const importedBefore = resolver.getImportedContextKey(LANE_MAIN);

    index.updateOpenModule(LANE_MAIN, source + "\n", 2);

    assert.notStrictEqual(
        resolver.getImportContextKey(LANE_MAIN),
        fullBefore,
        "полный ключ обязан меняться от версии документа"
    );
    assert.strictEqual(
        resolver.getImportedContextKey(LANE_MAIN),
        importedBefore,
        "ключ окружения от версии документа зависеть не имеет права"
    );

    /*
     * Подсветка объявляет свои зависимости, а не складывает ключ по месту:
     * текст документа в них входит, потому что пересчитывать раскраску при
     * каждой правке и надо.
     */
    const registry = fs.readFileSync(
        "server/src/features/semanticTokensFeatureRegistry.ts",
        "utf8"
    );
    const declared = registry.slice(
        registry.indexOf("const SEMANTIC_TOKENS_DEPENDS"),
        registry.indexOf("} as const;", registry.indexOf(
            "const SEMANTIC_TOKENS_DEPENDS"
        ))
    );

    assert.ok(
        declared.includes("text: true"),
        "подсветка обязана зависеть от текста документа"
    );
    assert.ok(
        declared.includes("closure: true"),
        "и от интерфейсов замыкания: внешний символ красится иначе"
    );
});

test("закрытый файл уходит из кэша", () => {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([EDITED]);
    const cache = new RslUnitDiagnosticsCache();

    diagnose(index, EDITED, BASE, 1, cache);
    assert.ok(cache.size >= 1, "результат запомнен: " + cache.size);
    assert.ok(cache.bytes > 0);

    /* Забыть файл — значит забыть все его ленты, а не только первую. */
    cache.forget(EDITED);
    assert.strictEqual(cache.size, 0, "записи удалены");
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

test("счёт объёма не расходится с содержимым при вытеснении", () => {
    /*
     * Кэш вытесняет и по числу записей, и по объёму. Раньше вытеснение по
     * числу шло внутри LRU молча, и счётчик объёма оставался завышенным:
     * кэш считал себя переполненным и выбрасывал полезные записи.
     */
    const cache = new RslUnitDiagnosticsCache({
        maxEntries: 2,
        maxBytes: 8 * 1024 * 1024
    });

    for (let file = 0; file < 4; file++) {
        const uri = `file:///counted-${file}.mac`;
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([uri]);
        diagnose(index, uri, BASE, 1, cache);
    }

    assert.strictEqual(cache.size, 2, "записей не больше предела");

    /*
     * Объём двух записей: у всех файлов текст один и тот же, а размер записи
     * от ленты не зависит — он считается по тексту и числу находок.
     */
    const single = new RslUnitDiagnosticsCache();
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles(["file:///single.mac"]);
    diagnose(index, "file:///single.mac", BASE, 1, single);

    const expected = (single.bytes / single.size) * 2;

    assert.strictEqual(
        cache.bytes,
        expected,
        "учтён объём ровно оставшихся записей: " + cache.bytes +
            " против " + expected
    );
});

test("замена записи не удваивает учтённый объём", () => {
    const cache = new RslUnitDiagnosticsCache({ maxEntries: 1 });
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([EDITED]);

    diagnose(index, EDITED, BASE, 1, cache);
    const first = cache.bytes;
    diagnose(index, EDITED, BASE + "Macro Extra()\nEnd;\n", 2, cache);

    assert.strictEqual(cache.size, 1);
    assert.ok(
        cache.bytes > 0 && cache.bytes < first * 2,
        "учтена одна запись, а не обе: " + cache.bytes + " против " + first
    );
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

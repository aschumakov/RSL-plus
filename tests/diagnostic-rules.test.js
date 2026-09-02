"use strict";

/*
 * Реестр проверок против фактического плана.
 *
 * Реестр описывает, что за проверка, когда её результат устаревает и что нужно
 * посчитать до неё. Это описание работает: из него считаются множество
 * кэшируемых проверок и отпечаток настроек кэша. Значит оно обязано совпадать с
 * таблицей этапов — иначе реестр станет документацией, которая врёт, а вместе с
 * ней соврёт и кэш.
 *
 * Отдельно проверяется само разделение лент: дочитанный Import обязан
 * пересчитывать проверки, которые читают импорты, и не трогать те, что зависят
 * только от текста.
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
    buildLocalRslDiagnosticsChunked,
    buildWorkspaceRslDiagnosticsChunked,
    normalizeDiagnosticSettings
} = require("../server/out/diagnostics");
const {
    RslUnitDiagnosticsCache
} = require("../server/out/diagnostics/unitDiagnosticsCache");
const {
    RSL_DIAGNOSTIC_RULES,
    rslDiagnosticRule,
    rslDiagnosticRules,
    rslRequiredStageIds,
    rslUnitCacheFingerprint,
    rslUnitCacheLaneRules
} = require("../server/out/diagnostics/ruleRegistry");
const {
    mergeRslSemanticDependencies,
    RslSemanticState
} = require("../server/out/analysis/semanticState");

let passed = 0;
let failed = 0;
const asyncTests = [];

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

function testAsync(name, action) {
    asyncTests.push({ name, action });
}

/* Все проверки включены: иначе часть этапов не попадёт в план. */
const ALL_ON = {
    enabled: true,
    structure: true,
    useBeforeDeclaration: true,
    unusedVariables: true,
    deprecatedDeclarations: true,
    debugBreak: true,
    unusedImports: true,
    redundantImports: true,
    ambiguousReferences: true,
    unknownMembers: true,
    unknownVariables: "strict",
    unknownSpecialVariables: "warn",
    /* Единственная проверка, выключенная по умолчанию: здесь включены все. */
    shadowedDeclaration: true,
    dialect: "coreRsl"
};

const SOURCE = [
    "Import common;",
    "Var moduleLevel = 1;",
    "Macro Probe(argument)",
    "  Var local = 0;",
    "  local = argument;",
    "  undeclaredHere = 1;",
    "  return local;",
    "End;",
    "Class(Base) Child",
    "  Var field;",
    "  Macro Method()",
    "    field = 1;",
    "  End;",
    "End;",
    ""
].join("\n");

function openIndex(uri, source, extra) {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([uri, ...(extra || [])]);

    return { index, module: index.updateOpenModule(uri, source, 1) };
}

/** Имена этапов, которые план действительно запустил. */
async function stageNames(phase, uri, source) {
    const { index, module } = openIndex(uri, source);
    const names = [];
    const observer = name => {
        if (!names.includes(name)) {
            names.push(name);
        }
    };

    if (phase === "local") {
        await buildLocalRslDiagnosticsChunked(
            module,
            index,
            ALL_ON,
            undefined,
            undefined,
            observer
        );
    } else {
        await buildWorkspaceRslDiagnosticsChunked(
            module,
            index,
            ALL_ON,
            undefined,
            undefined,
            undefined,
            observer
        );
    }

    return names;
}

/* ─── Реестр и план ──────────────────────────────────────────────────────── */

test("описание проверки не повторяется дважды в одной фазе", () => {
    const seen = new Set();

    for (const rule of RSL_DIAGNOSTIC_RULES) {
        const key = `${rule.phase}:${rule.id}`;

        assert.ok(!seen.has(key), `описание повторяется: ${key}`);
        seen.add(key);
    }
});

test("подготовка объявлена раньше того, кто её требует", () => {
    for (const rule of RSL_DIAGNOSTIC_RULES) {
        const order = rslDiagnosticRules(rule.phase).map(item => item.id);
        const position = order.indexOf(rule.id);

        for (const required of rule.requires) {
            const requiredPosition = order.indexOf(required);

            assert.notStrictEqual(
                requiredPosition,
                -1,
                `${rule.phase}:${rule.id} требует неизвестный этап ${required}`
            );
            assert.ok(
                requiredPosition < position,
                `${rule.phase}:${rule.id} требует ${required}, ` +
                    "объявленный позже"
            );
        }
    }
});

test("замыкание подготовки собирает всё, что нужно проверке", () => {
    const closure = rslRequiredStageIds("local", ["useBeforeDeclaration"]);

    assert.ok(closure.has("identifierIndex"), "нужен индекс идентификаторов");
    assert.ok(closure.has("declarationFacts"), "нужны факты об объявлениях");
    assert.ok(
        !closure.has("resolverWarmup"),
        "чужая подготовка в замыкание не попадает"
    );
});

testAsync("реестр совпадает с планом локальной фазы", async () => {
    const names = await stageNames("local", "file:///rules-local.mac", SOURCE);
    const declared = rslDiagnosticRules("local").map(rule => rule.id);

    assert.deepStrictEqual(
        [...names].sort(),
        [...declared].sort(),
        "план и реестр разошлись"
    );
    assert.deepStrictEqual(
        names,
        declared,
        "порядок в реестре обязан совпадать с порядком в плане"
    );
});

testAsync("реестр совпадает с планом межфайловой фазы", async () => {
    const names = await stageNames(
        "workspace",
        "file:///rules-workspace.mac",
        SOURCE
    );
    const declared = rslDiagnosticRules("workspace").map(rule => rule.id);

    assert.deepStrictEqual(
        [...names].sort(),
        [...declared].sort(),
        "план и реестр разошлись"
    );
    assert.deepStrictEqual(
        names,
        declared,
        "порядок в реестре обязан совпадать с порядком в плане"
    );
});

/* ─── Снимок вычисления ──────────────────────────────────────────────────── */

test("ключ складывается только из того, от чего зависит проверка", () => {
    /* Источник состояний под управлением теста. */
    const values = {
        text: 1,
        imports: "i",
        closure: "a",
        catalog: 1,
        workspace: 1,
        platform: 1,
        semantic: 1
    };
    const state = new RslSemanticState({
        textVersion: () => values.text,
        importsKey: () => values.imports,
        closureKey: () => values.closure,
        catalogRevision: () => values.catalog,
        workspaceRevision: () => values.workspace,
        platformRevision: () => values.platform,
        semanticRevision: () => values.semantic
    });
    const uri = "file:///d:/rules/main.mac";
    const textOnly = state.capture(
        uri,
        { text: true, settings: true },
        { settings: "s" }
    );
    const withClosure = state.capture(
        uri,
        { text: true, closure: true, settings: true },
        { settings: "s" }
    );

    values.closure = "b";

    assert.ok(
        !state.isStale(textOnly, { settings: "s" }),
        "проверка, не читающая импорты, от их правки не устаревает"
    );
    assert.ok(
        state.isStale(withClosure, { settings: "s" }),
        "проверка, читающая импорты, устаревает"
    );
    assert.notStrictEqual(
        state.capture(uri, { text: true }).key,
        state.capture(uri, { settings: true }).key,
        "разные зависимости не дают одинаковый ключ"
    );
});

test("запомненный ответ переживает изменение того, от чего не зависит", () => {
    /*
     * Ради этого модель и заведена: потребитель объявляет зависимости и
     * получает запоминание вместе с правильным сбросом, а не свою карту,
     * свой ключ и свой invalidate().
     */
    const values = { closure: "a", catalog: 1 };
    const state = new RslSemanticState({
        textVersion: () => 1,
        importsKey: () => "i",
        closureKey: () => values.closure,
        catalogRevision: () => values.catalog,
        workspaceRevision: () => 1,
        platformRevision: () => 1,
        semanticRevision: () => 1
    });
    const uri = "file:///d:/rules/main.mac";
    let computed = 0;
    const ask = () => state.remember(
        uri,
        "проба",
        { closure: true },
        () => ++computed
    );

    assert.strictEqual(ask(), 1);
    assert.strictEqual(ask(), 1, "второй раз считать незачем");

    values.catalog = 2;
    assert.strictEqual(
        ask(),
        1,
        "каталог в зависимостях не объявлен — ответ остаётся"
    );

    values.closure = "b";
    assert.strictEqual(ask(), 2, "а замыкание объявлено");
    assert.strictEqual(state.counters.resets, 1);
});

test("зависимости фазы складываются из зависимостей её проверок", () => {
    const local = mergeRslSemanticDependencies(
        rslDiagnosticRules("local").map(rule => rule.depends)
    );
    const workspace = mergeRslSemanticDependencies(
        rslDiagnosticRules("workspace").map(rule => rule.depends)
    );

    assert.ok(
        local.text && local.imports && local.closure && local.settings
    );
    assert.ok(
        !local.workspace,
        "состав файлов проекта локальной фазе не нужен"
    );
    assert.ok(
        workspace.workspace,
        "а межфайловой нужен: от него зависит, найдётся ли файл по имени"
    );
    assert.ok(
        !local.catalog,
        "локальная фаза не отвечает про весь проект и от каталога не зависит"
    );
    assert.ok(
        workspace.catalog,
        "межфайловая фаза отвечает про проект: состав модулей важен"
    );
});

/* ─── Ленты кэша ─────────────────────────────────────────────────────────── */

test("лента текста и лента импортов отпечатываются по-разному", () => {
    const options = normalizeDiagnosticSettings(ALL_ON);
    const text = rslUnitCacheFingerprint("text", options);
    const imports = rslUnitCacheFingerprint("imports", options);

    assert.notStrictEqual(text, imports, "ленты обязаны различаться");
    assert.notStrictEqual(
        text,
        rslUnitCacheFingerprint(
            "text",
            normalizeDiagnosticSettings({ ...ALL_ON, debugBreak: false })
        ),
        "снятая галочка проверки этой ленты меняет отпечаток"
    );
    assert.strictEqual(
        imports,
        rslUnitCacheFingerprint(
            "imports",
            normalizeDiagnosticSettings({ ...ALL_ON, debugBreak: false })
        ),
        "чужая галочка отпечаток этой ленты не меняет"
    );
    assert.deepStrictEqual(
        rslUnitCacheLaneRules("imports").map(rule => rule.id),
        ["undeclaredAssignments"],
        "в ленте импортов ровно та проверка, которая читает импорты"
    );
    assert.ok(
        rslUnitCacheLaneRules("text").every(
            rule => !rule.depends.imports && !rule.depends.closure
        ),
        "в ленте текста нет проверок, читающих импорты"
    );
    assert.strictEqual(
        rslDiagnosticRule("local", "undeclaredAssignments").cache,
        "unit",
        "проверка присваиваний кэшируется по единицам"
    );
});

test("дочитанный Import не пересчитывает ленту текста", () => {
    const main = "file:///lane-main.mac";
    const lib = "file:///lane-lib.mac";
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([main, lib]);

    const source = [
        "Import lane-lib;",
        "Macro Probe()",
        "  Var known = 1;",
        "  shared = known;",
        "  DEBUGBREAK;",
        "End;",
        ""
    ].join("\n");
    const cache = new RslUnitDiagnosticsCache();
    const settings = { unknownVariables: "safe", debugBreak: true };

    const first = buildLocalRslDiagnostics(
        index.updateOpenModule(main, source, 1),
        index,
        settings,
        undefined,
        undefined,
        cache
    );

    assert.ok(
        first.some(item => item.code === "debugbreak"),
        "отладочный DEBUGBREAK найден"
    );

    const before = {
        text: cache.laneStats("text"),
        imports: cache.laneStats("imports")
    };

    /* Импортированный модуль дочитан: граф модулей изменился, текст — нет. */
    index.updateExternalModule(lib, "Var shared;\n", 1);

    const second = buildLocalRslDiagnostics(
        index.updateOpenModule(main, source, 2),
        index,
        settings,
        undefined,
        undefined,
        cache
    );
    const after = {
        text: cache.laneStats("text"),
        imports: cache.laneStats("imports")
    };

    assert.strictEqual(
        after.text.hits - before.text.hits,
        1,
        "лента текста переиспользована"
    );
    assert.strictEqual(
        after.imports.misses - before.imports.misses,
        1,
        "лента импортов пересчитана заново"
    );
    assert.ok(
        second.some(item => item.code === "debugbreak"),
        "находка ленты текста сохранилась"
    );
    assert.ok(
        !second.some(item => item.code === "undeclared-variable"),
        "объявление в импортированном модуле убрало находку: " +
            JSON.stringify(second.map(item => item.code))
    );
});

test("объявление на уровне модуля пересчитывает ленту импортов целиком", () => {
    /*
     * Проверка присваиваний кэшируется по единицам, но её ответ зависит и от
     * имён вне своей единицы: `shared = 1` в одном Macro перестаёт быть
     * находкой, стоит объявить `Var shared` на уровне модуля. Без этого
     * пересчёта находка осталась бы в нетронутых процедурах.
     */
    const uri = "file:///lane-module-level.mac";
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([uri]);

    const body = [
        "Macro First()",
        "  Var known = 1;",
        "  shared = known;",
        "End;",
        "Macro Second()",
        "  Var other = 2;",
        "  shared = other;",
        "End;",
        ""
    ].join("\n");
    const cache = new RslUnitDiagnosticsCache();
    const settings = { unknownVariables: "safe" };
    const diagnose = (source, version) => buildLocalRslDiagnostics(
        index.updateOpenModule(uri, source, version),
        index,
        settings,
        undefined,
        undefined,
        cache
    );

    const before = diagnose(body, 1);

    assert.strictEqual(
        before.filter(item => item.code === "undeclared-variable").length,
        2,
        "необъявленная переменная найдена в обеих процедурах"
    );

    const after = diagnose("Var shared;\n" + body, 2);

    assert.strictEqual(
        after.filter(item => item.code === "undeclared-variable").length,
        0,
        "объявление на уровне модуля убрало находки во всех единицах: " +
            JSON.stringify(after.map(item => item.code))
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

    console.log(
        failed === 0
            ? `\nПройдено: ${passed}`
            : `\nПройдено: ${passed}, провалено: ${failed}`
    );

    if (failed > 0) {
        process.exitCode = 1;
    }
})();

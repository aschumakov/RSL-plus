"use strict";

/**
 * Возврат на уже посчитанную вкладку не пересчитывает Problems заново.
 *
 * Межфайловая фаза складывала ключ из зависимостей ВСЕХ своих проверок сразу, а
 * это объединение: у `unknownVariables` и `ambiguousReferences` в нём каталог
 * проекта, у остальных нет. Каталог меняется на каждую запись модуля — то есть
 * всё время, пока идёт фоновая индексация, — и вместе с ним отменялись
 * `unusedImports`, `redundantImports`, `selfImport` и `specialVariables`,
 * которым каталог не нужен вовсе.
 *
 * Заметно это при переключении вкладок: файл не менялся, а Problems считаются
 * целиком. Здесь проверяется, что пересчитывается только то, чьи зависимости
 * действительно изменились, и что причина промаха названа.
 */

const assert = require("assert");

const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { getDefaults } = require("../server/out/defaults");
const {
    RslDiagnosticEngine
} = require("../server/out/diagnostics/diagnosticEngine");
const {
    DiagnosticsCoordinator
} = require("../server/out/diagnostics/diagnosticsCoordinator");
const {
    rslWorkspaceLanes
} = require("../server/out/diagnostics/ruleRegistry");
const {
    RslSettingsService
} = require("../server/out/services/settingsService");
const { createRslVirtualClock } = require("../server/out/core/clock");
const {
    PlatformModuleCatalog
} = require("../server/out/builtins/platformModuleCatalog");
const {
    TextDocument
} = require("../server/node_modules/vscode-languageserver-textdocument");

let passed = 0;
let failed = 0;
const planned = [];

function test(name, action) {
    planned.push({ name, action });
}

const FIRST = "file:///d:/lanes/first.mac";
const SECOND = "file:///d:/lanes/second.mac";
const LIB = "file:///d:/lanes/lib.mac";
const OTHER = "file:///d:/lanes/other.mac";

const LIB_SOURCE = "Macro Helper(value)\n  return value;\nEnd;\n";
const FIRST_SOURCE = [
    "Import lib;",
    "",
    "Macro Run()",
    "  return Helper(1);",
    "End;",
    ""
].join("\n");
const SECOND_SOURCE = [
    "Import lib;",
    "",
    "Macro Other()",
    "  return Helper(2);",
    "End;",
    ""
].join("\n");

const SETTINGS = {
    language: { dialect: "rsBank" },
    imports: { enabled: true },
    autoImport: { enabled: true },
    analysis: { workspaceIndexing: "activeImports" },
    semanticHighlighting: { maxFileSizeKb: 512 },
    inlayHints: { variableTypes: true },
    diagnostics: {}
};

/** Две открытые вкладки и общая библиотека. */
function createStand() {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([FIRST, SECOND, LIB]);
    index.updateExternalModule(LIB, LIB_SOURCE, 1);

    const documents = new Map([
        [FIRST, TextDocument.create(FIRST, "rsl", 1, FIRST_SOURCE)],
        [SECOND, TextDocument.create(SECOND, "rsl", 1, SECOND_SOURCE)]
    ]);

    index.updateOpenModule(FIRST, FIRST_SOURCE, 1);
    index.updateOpenModule(SECOND, SECOND_SOURCE, 1);
    index.markOpen(FIRST);
    index.markOpen(SECOND);

    const clock = createRslVirtualClock(1000);
    const coordinator = new DiagnosticsCoordinator(
        { sendDiagnostics: () => undefined },
        {
            get: uri => documents.get(uri),
            all: () => [...documents.values()]
        },
        index,
        new RslSettingsService(SETTINGS),
        new RslDiagnosticEngine(),
        {
            clock,
            isParseBusy: () => false,
            waitForIdle: async () => undefined,
            log: () => undefined,
            onImports: () => undefined,
            resolver: new RslScopeResolver(index, getDefaults())
        }
    );

    return {
        index,
        clock,
        coordinator,
        /** Правка: новая версия и документа, и модели — как у сервера. */
        change(uri, text) {
            const version = documents.get(uri).version + 1;

            documents.set(uri, TextDocument.create(uri, "rsl", version, text));
            index.updateOpenModule(uri, text, version);
        }
    };
}

async function settle(stand, milliseconds = 4000) {
    await stand.clock.advance(milliseconds);
}

/** Разница счётчиков кэша между двумя моментами. */
function since(before, after) {
    const byReason = {};

    for (const [name, count] of Object.entries(after.byReason)) {
        const was = before.byReason[name] || 0;

        if (count > was) {
            byReason[name] = count - was;
        }
    }

    return {
        hits: after.hits - before.hits,
        misses: after.misses - before.misses,
        byReason
    };
}

/*
 * Второй стенд: у каждой ленты своя находка.
 *
 * Иначе не увидеть, что именно показано. `unused-import` считает лента без
 * каталога, `platform-module-not-imported` — лента с каталогом; когда
 * каталог меняется, на экране обязана остаться первая и пропасть вторая.
 */
const SHOWN_FIRST = "file:///d:/lanes/shown-first.mac";
const SHOWN_SECOND = "file:///d:/lanes/shown-second.mac";

const SHOWN_FIRST_SOURCE = [
    "Import lib;",
    "",
    "Macro Run()",
    "  Var ok = RSBParty;",
    "  return ok;",
    "End;",
    ""
].join("\n");
const SHOWN_SECOND_SOURCE =
    "Macro Other()\n  return 2;\nEnd;\n";

/** Каталог платформы читается один раз на весь файл проверок. */
let platformCatalog;

async function platform() {
    if (!platformCatalog) {
        platformCatalog = new PlatformModuleCatalog({
            log: () => undefined
        });
        await platformCatalog.ensureModules(["PTInter"]);
    }

    return platformCatalog;
}

async function createShowStand() {
    const catalog = await platform();
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([SHOWN_FIRST, SHOWN_SECOND, LIB]);
    index.updateExternalModule(LIB, LIB_SOURCE, 1);

    const documents = new Map([
        [
            SHOWN_FIRST,
            TextDocument.create(SHOWN_FIRST, "rsl", 1, SHOWN_FIRST_SOURCE)
        ],
        [
            SHOWN_SECOND,
            TextDocument.create(
                SHOWN_SECOND, "rsl", 1, SHOWN_SECOND_SOURCE
            )
        ]
    ]);

    index.updateOpenModule(SHOWN_FIRST, SHOWN_FIRST_SOURCE, 1);
    index.updateOpenModule(SHOWN_SECOND, SHOWN_SECOND_SOURCE, 1);
    index.markOpen(SHOWN_FIRST);
    index.markOpen(SHOWN_SECOND);

    const clock = createRslVirtualClock(1000);
    const settings = new RslSettingsService({
        ...SETTINGS,
        diagnostics: { unknownVariables: "warning" }
    });
    const coordinator = new DiagnosticsCoordinator(
        { sendDiagnostics: () => undefined },
        {
            get: uri => documents.get(uri),
            all: () => [...documents.values()]
        },
        index,
        settings,
        new RslDiagnosticEngine(),
        {
            clock,
            isParseBusy: () => false,
            waitForIdle: async () => undefined,
            log: () => undefined,
            onImports: () => undefined,
            resolver: new RslScopeResolver(index, getDefaults(), catalog)
        }
    );

    return {
        index,
        clock,
        coordinator,
        /** Коды того, что показали бы прямо сейчас. */
        shown(uri) {
            return (coordinator.getCached(uri) || [])
                .map(item => item.code)
                .sort();
        },
        change(uri, text) {
            const version = documents.get(uri).version + 1;

            documents.set(uri, TextDocument.create(uri, "rsl", version, text));
            index.updateOpenModule(uri, text, version);
        }
    };
}

test("запись в каталог не уносит с экрана находки другой ленты",
    async () => {
    /*
     * Прежде показывалось всё из общей записи с объединённым ключом, а в
     * него входит каталог: одна запись фоновой индексации — и Problems
     * пустели целиком, включая находки, к каталогу отношения не имеющие.
     */
    const stand = await createShowStand();

    stand.coordinator.setActiveDocument(SHOWN_FIRST);
    stand.coordinator.scheduleLocal(SHOWN_FIRST, 0);
    stand.coordinator.scheduleWorkspace(SHOWN_FIRST, 0);
    await stand.clock.advance(4000);

    assert.deepStrictEqual(
        stand.shown(SHOWN_FIRST),
        ["platform-module-not-imported", "unused-import"],
        "обе ленты посчитаны: " + stand.shown(SHOWN_FIRST).join(", ")
    );

    /* Фоновая индексация прочитала посторонний файл. */
    stand.index.registerWorkspaceFile(OTHER);
    stand.index.updateExternalModule(OTHER, "Macro Alone()\nEnd;\n", 1);

    const after = stand.shown(SHOWN_FIRST);

    assert.ok(
        after.includes("unused-import"),
        "находка актуальной ленты обязана остаться: " + after.join(", ")
    );
    assert.ok(
        !after.includes("platform-module-not-imported"),
        "а устаревшая — не показываться: " + after.join(", ")
    );
});

test("правка файла убирает с экрана обе ленты", async () => {
    /*
     * Обратная сторона: разделение не должно оставлять на экране находки,
     * посчитанные по прежнему тексту. Текст входит в ключ каждой ленты.
     */
    const stand = await createShowStand();

    stand.coordinator.setActiveDocument(SHOWN_FIRST);
    stand.coordinator.scheduleLocal(SHOWN_FIRST, 0);
    stand.coordinator.scheduleWorkspace(SHOWN_FIRST, 0);
    await stand.clock.advance(4000);

    assert.ok(stand.shown(SHOWN_FIRST).length > 0, "есть что показывать");

    stand.change(
        SHOWN_FIRST,
        SHOWN_FIRST_SOURCE + "\nMacro Added()\nEnd;\n"
    );

    const after = stand.shown(SHOWN_FIRST);

    assert.deepStrictEqual(
        after.filter(code =>
            code === "unused-import" ||
            code === "platform-module-not-imported"),
        [],
        "по прежнему тексту показывать нельзя ничего: " + after.join(", ")
    );
});

test("возврат на неизменённую вкладку не ждёт задержку", async () => {
    /*
     * Задержка в 300 мс склеивает расчёты при быстром перелистывании
     * вкладок. Когда файл не менялся, склеивать нечего: ждать значит
     * позже показать то же самое.
     */
    const stand = await createShowStand();

    stand.coordinator.setActiveDocument(SHOWN_FIRST);
    stand.coordinator.scheduleLocal(SHOWN_FIRST, 0);
    stand.coordinator.scheduleWorkspace(SHOWN_FIRST, 0);
    await stand.clock.advance(4000);

    stand.coordinator.setActiveDocument(SHOWN_SECOND);
    stand.coordinator.scheduleLocal(SHOWN_SECOND, 0);
    stand.coordinator.scheduleWorkspace(SHOWN_SECOND, 0);
    await stand.clock.advance(4000);

    /* Каталог изменился, пока смотрели вторую вкладку. */
    stand.index.registerWorkspaceFile(OTHER);
    stand.index.updateExternalModule(OTHER, "Macro Alone()\nEnd;\n", 1);

    stand.coordinator.setActiveDocument(SHOWN_FIRST);
    await stand.clock.advance(100);

    const after = stand.shown(SHOWN_FIRST);

    assert.ok(
        after.includes("platform-module-not-imported"),
        "устаревшая лента обязана быть пересчитана без ожидания 300 мс: " +
            after.join(", ")
    );
});

test("ленты межфайловой фазы разделены по зависимостям", () => {
    const lanes = rslWorkspaceLanes();

    assert.ok(lanes.length >= 2, "лент должно быть больше одной");

    const withCatalog = lanes.filter(lane => lane.depends.catalog);
    const withoutCatalog = lanes.filter(lane => !lane.depends.catalog);

    assert.strictEqual(
        withCatalog.length,
        1,
        "каталог нужен ровно одной ленте"
    );
    assert.ok(
        withoutCatalog.length >= 1,
        "и есть проверки, которым он не нужен"
    );
    assert.ok(
        withoutCatalog[0].rules.includes("unusedImports"),
        "unusedImports каталога не читает"
    );
    assert.ok(
        withCatalog[0].rules.includes("unknownVariables"),
        "а unknownVariables читает"
    );
    assert.ok(
        withoutCatalog[0].rules.includes("importReferences"),
        "подготовка попадает в ленту, которая её требует"
    );
});

test("возврат на неизменённую вкладку не считает ничего заново", async () => {
    const stand = createStand();

    stand.coordinator.setActiveDocument(FIRST);
    stand.coordinator.scheduleLocal(FIRST, 0);
    stand.coordinator.scheduleWorkspace(FIRST, 0);
    await settle(stand);

    stand.coordinator.setActiveDocument(SECOND);
    stand.coordinator.scheduleLocal(SECOND, 0);
    stand.coordinator.scheduleWorkspace(SECOND, 0);
    await settle(stand);

    /* Возврат: оба файла не менялись, проект тоже. */
    const before = stand.coordinator.diagnosticsCacheCounters;

    stand.coordinator.setActiveDocument(FIRST);
    stand.coordinator.scheduleWorkspace(FIRST, 0);
    await settle(stand);

    const delta = since(before, stand.coordinator.diagnosticsCacheCounters);

    assert.strictEqual(
        delta.misses,
        0,
        "пересчитано лент: " + delta.misses +
            ", причины " + JSON.stringify(delta.byReason)
    );
});

test("запись в каталог отменяет только ленту каталога", async () => {
    /*
     * Ровно то, ради чего сделано разделение: фоновая индексация читает
     * посторонний модуль, каталог меняется — и проверки, которым он не нужен,
     * остаются посчитанными.
     */
    const stand = createStand();

    stand.coordinator.setActiveDocument(FIRST);
    stand.coordinator.scheduleLocal(FIRST, 0);
    stand.coordinator.scheduleWorkspace(FIRST, 0);
    await settle(stand);

    const before = stand.coordinator.diagnosticsCacheCounters;

    /* Фоновая индексация прочитала посторонний файл. */
    stand.index.registerWorkspaceFile(OTHER);
    stand.index.updateExternalModule(OTHER, "Macro Alone()\nEnd;\n", 1);

    stand.coordinator.scheduleWorkspace(FIRST, 0);
    await settle(stand);

    const delta = since(before, stand.coordinator.diagnosticsCacheCounters);

    assert.strictEqual(
        delta.misses,
        1,
        "пересчитана одна лента, а не все: " + JSON.stringify(delta.byReason)
    );
    assert.ok(
        delta.hits >= 1,
        "и хотя бы одна взята из памяти"
    );
    assert.ok(
        delta.byReason.catalog || delta.byReason.workspace,
        "причина названа: " + JSON.stringify(delta.byReason)
    );
});

test("правка документа отменяет обе ленты", async () => {
    /* Обратная проверка: разделение не должно прятать настоящее изменение. */
    const stand = createStand();

    stand.coordinator.setActiveDocument(FIRST);
    stand.coordinator.scheduleLocal(FIRST, 0);
    stand.coordinator.scheduleWorkspace(FIRST, 0);
    await settle(stand);

    const before = stand.coordinator.diagnosticsCacheCounters;

    stand.change(FIRST, FIRST_SOURCE + "\nMacro Added()\nEnd;\n");
    stand.coordinator.scheduleWorkspace(FIRST, 0);
    await settle(stand);

    const delta = since(before, stand.coordinator.diagnosticsCacheCounters);

    assert.ok(
        delta.misses >= 1,
        "правка обязана пересчитать хотя бы одну ленту"
    );
});

test("состав Problems тот же, что и без разделения", async () => {
    /*
     * Разделение — это про то, КОГДА считать, а не про то, что получится.
     * Ответ обязан совпасть с посчитанным одним куском.
     */
    const stand = createStand();
    const index = stand.index;
    const module = index.getModule(FIRST);
    const engine = new RslDiagnosticEngine();
    const resolver = new RslScopeResolver(index, getDefaults());
    const whole = await engine.buildWorkspaceAsync(
        module,
        index,
        SETTINGS.diagnostics,
        () => false,
        resolver
    );
    const lanes = rslWorkspaceLanes();
    const planned = new Set(lanes.flatMap(lane => lane.rules));
    const byLanes = [];

    for (const lane of lanes) {
        const members = new Set(lane.rules);

        byLanes.push(...await engine.buildWorkspaceAsync(
            module,
            index,
            SETTINGS.diagnostics,
            () => false,
            resolver,
            undefined,
            ruleId => ruleId === "core-workspace"
                ? true
                : planned.has(ruleId)
                    ? members.has(ruleId)
                    : lane.id === lanes[lanes.length - 1].id
        ));
    }

    const signature = items => items
        .map(item => item.code + ":" + item.range.start.line +
            ":" + item.range.start.character)
        .sort()
        .join("|");

    assert.strictEqual(signature(byLanes), signature(whole));
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

    console.log(
        failed === 0
            ? "\nПройдено: " + passed
            : "\nПройдено: " + passed + ", провалено: " + failed
    );

    if (failed > 0) {
        process.exitCode = 1;
    }
})();

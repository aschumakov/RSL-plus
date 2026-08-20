"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
    PerformanceLogger
} = require("../server/out/performanceLogger");
const {
    DiagnosticsCoordinator
} = require("../server/out/diagnostics/diagnosticsCoordinator");
const {
    RslLanguageFeatureRegistry
} = require("../server/out/features/languageFeatureRegistry");
const {
    CompletionTransport
} = require("../server/out/features/completionTransport");
const {
    createFastDocumentSnapshot,
    getFastDocumentSymbols,
    getFastFoldingRanges,
    getFastDocumentImports
} = require("../server/out/services/fastDocumentSnapshot");
const {
    DocumentAnalysisService
} = require("../server/out/services/documentAnalysisService");
const {
    RslSettingsService
} = require("../server/out/services/settingsService");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

const defaults = {
    imports: { enabled: true },
    autoImport: { enabled: true },
    analysis: { workspaceIndexing: "activeImports" },
    semanticHighlighting: { maxFileSizeKb: 512 },
    diagnostics: {
        enabled: true,
        structure: true,
        maxProblems: 200
    }
};

async function testAvailableSettingsDoNotWaitForVsCode() {
    const service = new RslSettingsService(defaults);
    service.updateFromConfiguration({
        rslPlus: {
            imports: { enabled: false },
            diagnostics: {
                maxProblems: 75
            }
        }
    });

    const available = service.getAvailable("file:///slow.mac");

    assert.strictEqual(available.imports.enabled, false);
    assert.strictEqual(available.diagnostics.maxProblems, 75);
    assert.strictEqual(available.diagnostics.enabled, true);

    service.updateFromConfiguration({
        rslPlus: {
            imports: { enabled: true },
            autoImport: { enabled: false },
            analysis: { workspaceIndexing: "workspaceIdle" },
            semanticHighlighting: { maxFileSizeKb: 256 }
        }
    });
    const migrated = service.getAvailable("file:///new-settings.mac");
    assert.strictEqual(migrated.imports.enabled, true);
    assert.strictEqual(migrated.autoImport.enabled, false);
    assert.strictEqual(migrated.analysis.workspaceIndexing, "workspaceIdle");
    assert.strictEqual(migrated.semanticHighlighting.maxFileSizeKb, 256);
    assert.strictEqual(
        typeof service.get,
        "undefined",
        "Сервис настроек не должен иметь асинхронный LSP-путь"
    );
}

async function testResourceSettingsAreIsolatedAndCached() {
    const service = new RslSettingsService(defaults);
    const changed = [];
    service.onDidResolve((uri, settings) => {
        changed.push({ uri, settings });
    });

    service.updateResource("file:///a.mac", {
        diagnostics: {
            maxProblems: 10
        }
    });
    service.updateResource("file:///b.mac", {
        diagnostics: {
            maxProblems: 20
        }
    });

    const a = service.getAvailable("file:///a.mac");
    const b = service.getAvailable("file:///b.mac");
    assert.strictEqual(a.diagnostics.maxProblems, 10);
    assert.strictEqual(b.diagnostics.maxProblems, 20);
    assert.strictEqual(a.diagnostics.enabled, true);
    assert.strictEqual(changed.length, 2);

    assert.strictEqual(service.updateResource("file:///a.mac", {
        diagnostics: {
            maxProblems: 10
        }
    }), false);
    assert.strictEqual(changed.length, 2, "Одинаковый snapshot не публикуется");

    service.clear("file:///a.mac");
    assert.strictEqual(
        service.getAvailable("file:///a.mac").diagnostics.maxProblems,
        200
    );
}

async function testPerformanceLogger() {
    const logger = new PerformanceLogger();

    assert.strictEqual(logger.enabled, false);
    assert.strictEqual(logger.start("disabled"), undefined);

    const directory = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "rsl-plus-performance-")
    );
    const logFile = path.join(directory, "profile.jsonl");

    try {
        logger.configure(logFile);
        assert.strictEqual(logger.enabled, true);

        const span = logger.start("test.operation", {
            uri: "file:///test.mac",
            chars: 42
        });
        logger.end(span, {
            tokens: 7
        });
        await logger.shutdown();

        const records = (await fs.promises.readFile(logFile, "utf8"))
            .trim()
            .split(/\r?\n/)
            .map(line => JSON.parse(line));
        const operation = records.find(item =>
            item.event === "test.operation"
        );

        assert.ok(operation);
        assert.strictEqual(operation.chars, 42);
        assert.strictEqual(operation.tokens, 7);
        assert.strictEqual(typeof operation.durationMs, "number");
        assert.strictEqual(typeof operation.heapUsedAfterBytes, "number");
        assert.strictEqual(typeof operation.rssAfterBytes, "number");
    } finally {
        await fs.promises.rm(directory, {
            recursive: true,
            force: true
        });
    }
}

async function testProblemsDoNotWaitForConfigurationRequest() {
    const uri = "file:///problems.mac";
    const document = { uri, version: 1, getText: () => "Macro Test()\nEnd;" };
    const module = {
        uri,
        version: 1,
        sourceLength: document.getText().length,
        imports: []
    };
    const publications = [];
    const coordinator = new DiagnosticsCoordinator(
        {
            sendDiagnostics(value) {
                publications.push(value);
            }
        },
        {
            get: requestedUri => requestedUri === uri ? document : undefined,
            all: () => [document]
        },
        {
            getModule: requestedUri => requestedUri === uri
                ? module
                : undefined,
            getCurrentModule: (requestedUri, version) =>
                requestedUri === uri && module.version === version
                    ? module
                    : undefined,
            getImportClosureKey: () => "",
            get size() {
                return 1;
            }
        },
        {
            getAvailable: () => ({
                ...defaults,
                diagnostics: {
                    enabled: true,
                    maxProblems: 200
                }
            }),
            get: () => {
                throw new Error(
                    "Diagnostics не должны ждать workspace/configuration"
                );
            }
        },
        {
            buildLocal: () => [{
                code: "test",
                message: "ready",
                severity: 2,
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 1 }
                }
            }],
            buildWorkspace: () => [],
            buildLocalAsync(...args) {
                return Promise.resolve(this.buildLocal(...args));
            },
            buildWorkspaceAsync(...args) {
                return Promise.resolve(this.buildWorkspace(...args));
            },
            /* Координатор сообщает движку о закрытии файла. */
            forget: () => undefined
        },
        {
            isParseBusy: () => false,
            log: message => {
                throw new Error(message);
            },
            onImports: () => undefined,
            localDebounceMs: 0,
            workspaceDebounceMs: 1000
        }
    );

    coordinator.setActiveDocument(uri);
    coordinator.scheduleLocal(uri, 0);
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.ok(publications.length > 0);
    assert.strictEqual(
        publications.at(-1).diagnostics[0].message,
        "ready"
    );
    coordinator.close(uri);
}

async function testOutlineUsesPreparedSnapshotAndReportsTiming() {
    const source = "Var GlobalValue;\nMacro Test()\nEnd;";
    const uri = "file:///outline.mac";
    const document = {
        uri,
        languageId: "rsl",
        version: 1,
        lineCount: 3,
        getText: () => source,
        positionAt(offset) {
            const before = source.slice(0, offset);
            const lines = before.split("\n");
            return {
                line: lines.length - 1,
                character: lines.at(-1).length
            };
        },
        offsetAt: () => 0
    };
    const snapshot = createFastDocumentSnapshot(document);
    assert.strictEqual(
        snapshot.symbols,
        undefined,
        "Outline должен оставаться ленивым до presentation-фазы"
    );
    assert.strictEqual(
        snapshot.foldingRanges,
        undefined,
        "Folding должен оставаться ленивым до первого запроса"
    );
    assert.ok(getFastFoldingRanges(snapshot).length > 0);
    getFastDocumentSymbols(document, snapshot);

    const classSource = [
        "Class TExecFunPIParm()",
        "  Var pi:TRecHandler;",
        "  Var stat:Integer;",
        "  Var err_mes:String;",
        "End;"
    ].join("\n");
    const classDocument = {
        ...document,
        uri: "file:///outline-class.mac",
        lineCount: 5,
        getText: () => classSource,
        positionAt(offset) {
            const before = classSource.slice(0, offset);
            const lines = before.split("\n");
            return {
                line: lines.length - 1,
                character: lines.at(-1).length
            };
        }
    };
    const classSymbols = getFastDocumentSymbols(
        classDocument,
        createFastDocumentSnapshot(classDocument)
    );
    assert.deepStrictEqual(
        classSymbols.map(item => item.name),
        ["TExecFunPIParm"]
    );
    assert.deepStrictEqual(
        classSymbols[0].children.map(item => item.name),
        ["pi", "stat", "err_mes"]
    );

    const handlers = {};
    const register = name => callback => {
        handlers[name] = callback;
    };
    const connection = {
        onCompletion: register("completion"),
        onCompletionResolve: register("completionResolve"),
        onSignatureHelp: register("signatureHelp"),
        onHover: register("hover"),
        onDocumentHighlight: register("documentHighlight"),
        onDefinition: register("definition"),
        onReferences: register("references"),
        onWorkspaceSymbol: register("workspaceSymbol"),
        onCodeAction: register("codeAction"),
        onSelectionRanges: register("selectionRanges"),
        onExecuteCommand: register("executeCommand"),
        onRequest: (method, callback) => {
            handlers[method] = callback;
        },
        onDocumentSymbol: register("documentSymbol"),
        onFoldingRanges: register("foldingRanges"),
        onDocumentFormatting: register("documentFormatting"),
        onDocumentRangeFormatting: register("documentRangeFormatting"),
        sendRequest: async () => undefined,
        languages: {
            callHierarchy: {
                onPrepare: register("callHierarchyPrepare"),
                onIncomingCalls: register("callHierarchyIncoming"),
                onOutgoingCalls: register("callHierarchyOutgoing")
            },
            semanticTokens: {
                on: register("semanticTokens"),
                onDelta: register("semanticTokensDelta"),
                onRange: register("semanticTokensRange")
            },
            inlayHint: {
                on: register("inlayHint"),
                refresh: () => undefined
            }
        }
    };
    const performanceEvents = [];
    const index = new WorkspaceIndex();
    const registry = new RslLanguageFeatureRegistry({
        connection,
        documents: {
            get: requestedUri =>
                requestedUri === uri ? document : undefined
        },
        index,
        resolver: new RslScopeResolver(index),
        definitionProvider: {},
        getFastDocumentSnapshot: () => snapshot,
        ensureDocumentParsed: async () => {
            throw new Error("Outline не должен запускать полный parser");
        },
        getSettings: () => defaults,
        log: () => undefined,
        performance: {
            enabled: true,
            start(event, fields) {
                return { event, fields };
            },
            end(span, fields) {
                performanceEvents.push({
                    event: span.event,
                    ...span.fields,
                    ...fields
                });
            }
        }
    });
    registry.register();

    const symbols = await handlers.documentSymbol({
        textDocument: { uri }
    });
    assert.deepStrictEqual(
        symbols.map(item => item.name),
        ["GlobalValue", "Test"]
    );
    assert.strictEqual(
        performanceEvents.at(-1).outcome,
        "preparedFastSnapshot"
    );
    assert.strictEqual(
        typeof performanceEvents.at(-1).outlineReadyAgeMs,
        "number"
    );

    await handlers.documentSymbol({ textDocument: { uri } });
    assert.strictEqual(
        performanceEvents.at(-1).outcome,
        "providerCache"
    );
}

async function testOutlineIsReadyBeforeDiagnostics() {
    const source = "Var GlobalValue;\nMacro Test()\nEnd;";
    const uri = "file:///event-order.mac";
    const document = {
        uri,
        languageId: "rsl",
        version: 1,
        lineCount: 3,
        getText: () => source,
        positionAt(offset) {
            const before = source.slice(0, offset);
            const lines = before.split("\n");
            return {
                line: lines.length - 1,
                character: lines.at(-1).length
            };
        },
        offsetAt: () => 0
    };
    const events = [];
    const performance = {
        enabled: true,
        start(event, fields) {
            events.push(`start:${event}`);
            return { event, fields };
        },
        end(span) {
            events.push(`end:${span.event}`);
        },
        mark() {}
    };
    const documents = {
        get: requestedUri => requestedUri === uri ? document : undefined,
        all: () => [document]
    };
    const index = new WorkspaceIndex();
    let analysis;
    const coordinator = new DiagnosticsCoordinator(
        { sendDiagnostics: () => undefined },
        documents,
        index,
        {
            getAvailable: () => defaults
        },
        {
            buildLocal: () => [],
            buildWorkspace: () => [],
            buildLocalAsync(...args) {
                return Promise.resolve(this.buildLocal(...args));
            },
            buildWorkspaceAsync(...args) {
                return Promise.resolve(this.buildWorkspace(...args));
            },
            /* Координатор сообщает движку о закрытии файла. */
            forget: () => undefined
        },
        {
            isParseBusy: requestedUri =>
                analysis?.isBusyFor(requestedUri) ?? false,
            waitForIdle: requestedUri =>
                analysis?.whenIdle(requestedUri) ?? Promise.resolve(),
            log: message => {
                throw new Error(message);
            },
            performance,
            onImports: () => undefined,
            localDebounceMs: 0,
            workspaceDebounceMs: 1000,
            interactiveRetryMs: 1
        }
    );
    analysis = new DocumentAnalysisService(
        documents,
        index,
        {
            getAvailable: () => defaults
        },
        {
            log: message => {
                throw new Error(message);
            },
            performance,
            invalidateProviderCaches: () => undefined,
            onParsed: () => {
                coordinator.setActiveDocument(uri);
            },
            onImports: () => undefined,
            initialParseDelayMs: 0,
            inactiveParseDelayMs: 0
        }
    );

    analysis.setActiveDocument(uri);
    assert.strictEqual(analysis.open(document), true);
    await waitFor(
        () => events.includes("end:diagnostics.local"),
        1000
    );

    const documentOpen = events.indexOf("start:document.open");
    const outlineReady = events.indexOf("end:analysis.outlineSnapshot");
    const diagnostics = events.indexOf("start:diagnostics.local");

    assert.ok(documentOpen >= 0, "document.open не зарегистрирован");
    assert.ok(outlineReady > documentOpen);
    assert.ok(
        diagnostics > outlineReady,
        `Нарушен порядок событий: ${events.join(" → ")}`
    );

    analysis.close(uri);
    coordinator.close(uri);
}

async function testInactiveRestoredTabIsLazy() {
    const source = "Macro Restored()\nEnd;";
    const uri = "file:///inactive-restored.mac";
    const document = {
        uri,
        languageId: "rsl",
        version: 1,
        getText: () => source,
        positionAt: () => ({ line: 0, character: 0 }),
        offsetAt: () => 0
    };
    const events = [];
    const documents = {
        get: requested => requested === uri ? document : undefined
    };
    const index = new WorkspaceIndex();
    const analysis = new DocumentAnalysisService(
        documents,
        index,
        { getAvailable: () => defaults },
        {
            log: message => { throw new Error(message); },
            performance: {
                enabled: true,
                start(event, fields) { return { event, fields }; },
                end(span) { events.push(span.event); },
                mark() {}
            },
            invalidateProviderCaches: () => undefined,
            onParsed: () => events.push("parsed"),
            onImports: () => undefined,
            initialParseDelayMs: 0
        }
    );

    analysis.open(document);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(!events.includes("analysis.fastSnapshot"));
    assert.ok(!events.includes("parsed"));

    analysis.setActiveDocument(uri);
    await waitFor(() => events.includes("parsed"), 1000);
    assert.ok(events.includes("analysis.fastSnapshot"));
    assert.ok(events.includes("analysis.outlineSnapshot"));
    analysis.close(uri);
}

/*
 * Две фазы анализа открытого файла должны быть именно фазами, а не одним
 * событием: Structure и объявления доступны из Fast Snapshot сразу, точная
 * локальная модель появляется позже, и одно не подменяет другое.
 *
 * Проверяется и стоимость: объявления одной версии сканируются один раз,
 * сколько бы потребителей их ни спросило (Outline, Structure, будущие
 * фазы) — иначе каждый потребитель платил бы полным проходом по токенам.
 */
async function testFastPhasePrecedesLocalModel() {
    const uri = "file:///two-phase.mac";
    const line = 'Var x1 = Something.Method(a, "text", 42) + b;\n';
    const source = [
        "Import library;",
        "Macro Visible(obj)",
        line.repeat(1200),
        "End;"
    ].join("\n");
    const lineStarts = [0];
    for (let position = 0; position < source.length; position++) {
        if (source[position] === "\n") lineStarts.push(position + 1);
    }
    const document = {
        uri,
        languageId: "rsl",
        version: 1,
        lineCount: lineStarts.length,
        getText: () => source,
        positionAt(offset) {
            const bounded = Math.max(0, Math.min(offset, source.length));
            let line = 0;
            while (
                line + 1 < lineStarts.length &&
                lineStarts[line + 1] <= bounded
            ) line++;
            return { line, character: bounded - lineStarts[line] };
        },
        offsetAt: () => 0
    };
    const documents = {
        get: requested => requested === uri ? document : undefined,
        all: () => [document]
    };
    const index = new WorkspaceIndex();
    const analysis = new DocumentAnalysisService(
        documents,
        index,
        { getAvailable: () => defaults },
        {
            log: () => undefined,
            invalidateProviderCaches: () => undefined,
            onParsed: () => undefined,
            onImports: () => undefined,
            initialParseDelayMs: 0,
            inactiveParseDelayMs: 0
        }
    );

    try {
        analysis.setActiveDocument(uri);
        assert.strictEqual(
            analysis.isFastReady(document),
            false,
            "До открытия документа не готова ни одна фаза"
        );

        analysis.open(document);

        assert.strictEqual(
            analysis.isFastReady(document),
            true,
            "Fast Snapshot обязан быть готов синхронно в open()"
        );
        assert.strictEqual(
            analysis.isLocalReady(document),
            false,
            "Полная модель не может быть готова до планового parse: иначе " +
                "Structure ждала бы полного разбора"
        );

        const snapshot = analysis.getFastSnapshot(document);
        const structure = getFastDocumentSymbols(document, snapshot);
        assert.ok(
            structure.some(item => item.name === "Visible"),
            "Structure должна содержать Macro текущего файла до полного parse"
        );
        assert.strictEqual(
            getFastDocumentSymbols(document, snapshot),
            structure,
            "Structure строится один раз на версию документа"
        );
        assert.deepStrictEqual(
            getFastDocumentImports(snapshot).map(value => value.toLowerCase()),
            ["library"],
            "Список Import должен быть доступен до полного parse"
        );

        /*
         * Дескрипторы объявлений намеренно не остаются в снимке: всё нужное
         * уже лежит в Structure, а вторая копия стоила около 7 МиБ на
         * открытый файл 1,1 МБ.
         */
        assert.strictEqual(
            snapshot.declarations,
            undefined,
            "Снимок не должен удерживать дескрипторы объявлений"
        );

        await waitFor(() => analysis.isLocalReady(document), 5000);
        assert.strictEqual(
            analysis.isFastReady(document),
            true,
            "Готовность полной модели не должна сбрасывать первую фазу"
        );
        assert.ok(
            index.getCurrentModule(uri, document.version)?.symbolTree
                .find("Visible"),
            "Полная модель обязана содержать тот же символ точнее"
        );
    } finally {
        analysis.close(uri);
    }
}

/*
 * Подсветка и навигация при постепенно загружающемся Import-графе.
 *
 * Открытый файл не меняется, пока индексируются его зависимости, поэтому по
 * одной версии документа отличить "внешний символ ещё неизвестен" от "уже
 * известен" нельзя. Проверяется, что:
 *   - токены не остаются закэшированными после загрузки внешнего модуля;
 *   - сервер просит клиента перезапросить их, объединяя всплеск загрузок;
 *   - Definition для неизвестного символа запускает приоритетную догрузку и
 *     отвечает уже по ней.
 */
async function testImportContextDrivesHighlightAndNavigation() {
    const uri = "file:///import-context.mac";
    const source = [
        "Import library;",
        "Macro Caller()",
        "  SharedHandler(1);",
        "End;"
    ].join("\n");
    const lineStarts = [0];
    for (let position = 0; position < source.length; position++) {
        if (source[position] === "\n") lineStarts.push(position + 1);
    }
    const document = {
        uri,
        languageId: "rsl",
        version: 1,
        lineCount: lineStarts.length,
        getText: () => source,
        positionAt(offset) {
            const bounded = Math.max(0, Math.min(offset, source.length));
            let line = 0;
            while (
                line + 1 < lineStarts.length &&
                lineStarts[line + 1] <= bounded
            ) line++;
            return { line, character: bounded - lineStarts[line] };
        },
        offsetAt(position) {
            const line = Math.max(
                0,
                Math.min(position.line, lineStarts.length - 1)
            );
            return Math.min(
                source.length,
                lineStarts[line] + Math.max(0, position.character)
            );
        }
    };

    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([uri, "file:///library.mac"]);
    index.updateOpenModule(uri, source, 1);

    const handlers = {};
    const register = name => callback => { handlers[name] = callback; };
    let refreshCount = 0;
    const connection = {
        onCompletion: register("completion"),
        onCompletionResolve: register("completionResolve"),
        onSignatureHelp: register("signatureHelp"),
        onHover: register("hover"),
        onDocumentHighlight: register("documentHighlight"),
        onDefinition: register("definition"),
        onReferences: register("references"),
        onWorkspaceSymbol: register("workspaceSymbol"),
        onCodeAction: register("codeAction"),
        onSelectionRanges: register("selectionRanges"),
        onExecuteCommand: register("executeCommand"),
        onRequest: (method, callback) => { handlers[method] = callback; },
        onDocumentSymbol: register("documentSymbol"),
        onFoldingRanges: register("foldingRanges"),
        onDocumentFormatting: register("documentFormatting"),
        onDocumentRangeFormatting: register("documentRangeFormatting"),
        sendRequest: async () => undefined,
        languages: {
            callHierarchy: {
                onPrepare: register("callHierarchyPrepare"),
                onIncomingCalls: register("callHierarchyIncoming"),
                onOutgoingCalls: register("callHierarchyOutgoing")
            },
            semanticTokens: {
                on: register("semanticTokens"),
                onDelta: register("semanticTokensDelta"),
                onRange: register("semanticTokensRange"),
                refresh: () => {
                    refreshCount++;
                    return Promise.resolve();
                }
            },
            inlayHint: {
                on: register("inlayHint"),
                refresh: () => undefined
            }
        }
    };

    const loadRequests = [];
    const registry = new RslLanguageFeatureRegistry({
        connection,
        documents: {
            get: requested => requested === uri ? document : undefined,
            all: () => [document]
        },
        index,
        resolver: new RslScopeResolver(index),
        /* Провайдер отвечает за Import-файлы, строковые ссылки и Location. */
        definitionProvider: {
            findImportDefinition: async () => null,
            findDynamicDefinition: async () => null,
            createObjectLocationByUri: (targetUri, symbol) => ({
                uri: targetUri,
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: symbol.name.length }
                }
            })
        },
        getFastDocumentSnapshot: () => createFastDocumentSnapshot(document),
        ensureDocumentParsed: async () => index.getModule(uri)?.symbolTree,
        /* Адресная догрузка Import, как её делает WorkspaceModuleLoader. */
        ensureImportedSymbol: async (fromUri, symbolName) => {
            loadRequests.push(symbolName);
            index.updateExternalModule(
                "file:///library.mac",
                "Macro SharedHandler(value)\nEnd;",
                1
            );
            return index.findImportedSymbols(fromUri, symbolName).length > 0;
        },
        getSettings: () => defaults,
        supportsRefresh: () => true,
        log: () => undefined
    });
    registry.register();

    try {
        const cancellation = { isCancellationRequested: false };
        const first = await handlers.semanticTokens(
            { textDocument: { uri } },
            cancellation
        );
        const firstResultId = first.resultId;
        assert.ok(first.data.length > 0, "Токены должны строиться");

        const cachedAgain = await handlers.semanticTokens(
            { textDocument: { uri } },
            cancellation
        );
        assert.strictEqual(
            cachedAgain.resultId,
            firstResultId,
            "Без изменений кэш обязан отдавать тот же result"
        );

        /* Ctrl+Click по неизвестному символу: догрузка Import по запросу. */
        const definition = await handlers.definition(
            {
                textDocument: { uri },
                position: document.positionAt(source.indexOf("SharedHandler"))
            },
            cancellation
        );

        assert.deepStrictEqual(
            loadRequests,
            ["SharedHandler"],
            "Неизвестный символ обязан запускать приоритетную догрузку Import"
        );
        assert.ok(
            definition,
            "После догрузки переход обязан отвечать, а не возвращать null"
        );
        assert.strictEqual(definition.uri, "file:///library.mac");

        /* Внешний модуль загружен — Import-замыкание открытого файла другое. */
        registry.notifyImportContextChanged([uri]);
        registry.notifyImportContextChanged([uri]);
        registry.notifyImportContextChanged([uri]);
        assert.strictEqual(
            refreshCount,
            0,
            "Просьба перезапросить токены обязана быть отложенной"
        );
        await new Promise(resolve => setTimeout(resolve, 400));
        assert.strictEqual(
            refreshCount,
            1,
            "Всплеск загрузок Import-графа обязан давать одну просьбу " +
                `перезапросить токены, получено ${refreshCount}`
        );

        const afterImport = await handlers.semanticTokens(
            { textDocument: { uri } },
            cancellation
        );
        assert.notStrictEqual(
            afterImport.resultId,
            firstResultId,
            "После загрузки внешнего модуля токены обязаны быть пересчитаны: " +
                "иначе известный внешний символ остался бы раскрашен как " +
                "неизвестный до следующей правки файла"
        );
    } finally {
        registry.dispose();
    }
}

function testCompletionPayloadIsBoundedAndResolvedLazily() {
    const transport = new CompletionTransport({
        searchLimit: 3,
        cacheEntries: 8
    });
    const source = Array.from({ length: 5 }, (ignored, index) => ({
        label: `Item${index}`,
        detail: `Detail${index}`,
        documentation: `Documentation${index}`,
        data: { source: "test" }
    }));

    /*
     * Обычный список отдаётся целиком и помечается полным: `isIncomplete`
     * означает «перезапроси на каждую букву», а не «результатов больше».
     */
    const whole = transport.prepare(source);
    assert.strictEqual(whole.items.length, 5);
    assert.strictEqual(whole.isIncomplete, false);

    /* Ограничение и неполнота — только у поиска по всему проекту. */
    const prepared = transport.prepare(source, {
        limit: transport.limitForSearch,
        incomplete: true
    });

    assert.strictEqual(prepared.items.length, 3);
    assert.strictEqual(prepared.isIncomplete, true);
    assert.strictEqual(prepared.items[0].detail, undefined);
    assert.strictEqual(prepared.items[0].documentation, undefined);
    const resolved = transport.resolve(prepared.items[0]);
    assert.strictEqual(resolved.detail, "Detail0");
    assert.strictEqual(resolved.documentation, "Documentation0");
    assert.strictEqual(resolved.data.source, "test");
}

/*
 * Регрессия по ревью: интерактивные обработчики ждут полный parse не дольше
 * INTERACTIVE_PARSE_BUDGET_MS и раньше после истечения бюджета отвечали по
 * модели ПРЕДЫДУЩЕЙ версии, подставляя в неё offset ТЕКУЩЕЙ. После вставки
 * текста перед символом такая смесь давала не устаревший, а неверный ответ.
 */
async function testInteractiveFallbackDoesNotMixVersions() {
    const uri = "file:///version-mix.mac";
    const firstVersion = [
        "Macro Test()",
        "  Var value;",
        "  value = 1;",
        "End;"
    ].join("\n");
    /* Вставка целой строки сдвигает все offset-ы ниже неё. */
    const secondVersion = firstVersion.replace(
        "Macro Test()",
        "Var Inserted;\nMacro Test()"
    );

    const createTestDocument = (source, version) => ({
        uri,
        languageId: "rsl",
        version,
        lineCount: source.split("\n").length,
        getText: () => source,
        positionAt(offset) {
            const lines = source.slice(0, offset).split("\n");
            return {
                line: lines.length - 1,
                character: lines.at(-1).length
            };
        },
        offsetAt(position) {
            const lines = source.split("\n");
            let offset = 0;
            for (let line = 0; line < position.line; line++) {
                offset += lines[line].length + 1;
            }
            return offset + position.character;
        }
    });

    const index = new WorkspaceIndex();
    index.updateOpenModule(uri, firstVersion, 1);

    let document = createTestDocument(secondVersion, 2);
    const handlers = {};
    const register = name => callback => {
        handlers[name] = callback;
    };
    const connection = {
        onCompletion: register("completion"),
        onCompletionResolve: register("completionResolve"),
        onSignatureHelp: register("signatureHelp"),
        onHover: register("hover"),
        onDocumentHighlight: register("documentHighlight"),
        onDefinition: register("definition"),
        onReferences: register("references"),
        onWorkspaceSymbol: register("workspaceSymbol"),
        onCodeAction: register("codeAction"),
        onSelectionRanges: register("selectionRanges"),
        onExecuteCommand: register("executeCommand"),
        onRequest: (method, callback) => {
            handlers[method] = callback;
        },
        onDocumentSymbol: register("documentSymbol"),
        onFoldingRanges: register("foldingRanges"),
        onDocumentFormatting: register("documentFormatting"),
        onDocumentRangeFormatting: register("documentRangeFormatting"),
        sendRequest: async () => undefined,
        languages: {
            callHierarchy: {
                onPrepare: register("callHierarchyPrepare"),
                onIncomingCalls: register("callHierarchyIncoming"),
                onOutgoingCalls: register("callHierarchyOutgoing")
            },
            semanticTokens: {
                on: register("semanticTokens"),
                onDelta: register("semanticTokensDelta"),
                onRange: register("semanticTokensRange")
            },
            inlayHint: {
                on: register("inlayHint"),
                refresh: () => undefined
            }
        }
    };
    const registry = new RslLanguageFeatureRegistry({
        connection,
        documents: {
            get: requested => requested === uri ? document : undefined,
            all: () => [document]
        },
        index,
        resolver: new RslScopeResolver(index),
        definitionProvider: {},
        getFastDocumentSnapshot: () =>
            createFastDocumentSnapshot(document),
        /* Полный parse версии 2 не успевает в бюджет ожидания. */
        ensureDocumentParsed: () => new Promise(() => undefined),
        getSettings: () => defaults,
        log: () => undefined
    });
    registry.register();

    const params = {
        textDocument: { uri },
        position: document.positionAt(
            secondVersion.indexOf("value = 1;")
        )
    };
    const cancellation = { isCancellationRequested: false };
    const [hover, completion, signatureHelp] = await Promise.all([
        handlers.hover(params, cancellation),
        handlers.completion(params, cancellation),
        handlers.signatureHelp(params, cancellation)
    ]);

    assert.strictEqual(
        hover,
        null,
        "Hover не должен отвечать по модели другой версии документа"
    );
    /*
     * Список отдаётся полным и до готовности модели.
     *
     * `isIncomplete` для редактора значит «перезапроси провайдер на каждую
     * следующую букву», а не «ответ приблизительный». Пометка ответа из
     * быстрого индекса неполным и приводила к пересчёту на каждый символ:
     * состав и порядок менялись под руками, а разбор конкурировал с вводом.
     */
    assert.strictEqual(
        completion.isIncomplete,
        false,
        "ответ до готовности модели не должен заставлять клиента " +
            "перезапрашивать список на каждую букву"
    );
    /*
     * Пустой список пользователь читает как «в файле ничего не объявлено».
     * Пока модели нет, состав берётся из быстрого снимка — приблизительный, но
     * не пустой.
     */
    assert.ok(
        completion.items.length > 0,
        "до готовности модели ответом обязан быть состав из быстрого снимка"
    );
    assert.strictEqual(signatureHelp, null);

    /* Та же позиция на модели своей версии отвечает содержательно. */
    index.updateOpenModule(uri, secondVersion, 2);
    document = createTestDocument(secondVersion, 2);
    const currentHover = await handlers.hover(params, cancellation);
    assert.ok(
        currentHover && currentHover.contents,
        "После готовности parse Hover обязан отвечать по своей версии"
    );
}

async function waitFor(predicate, timeoutMs) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started >= timeoutMs) {
            throw new Error("Истекло время ожидания тестового события");
        }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

(async () => {
    await testAvailableSettingsDoNotWaitForVsCode();
    console.log("[OK] анализ использует настройки без ожидания VS Code");

    await testResourceSettingsAreIsolatedAndCached();
    console.log("[OK] resource-настройки изолированы и кэшируются");

    await testPerformanceLogger();
    console.log("[OK] performance logger выключен без пути и пишет JSONL");

    await testProblemsDoNotWaitForConfigurationRequest();
    console.log("[OK] Problems публикуются без workspace/configuration");

    await testOutlineUsesPreparedSnapshotAndReportsTiming();
    console.log("[OK] Outline отвечает из подготовленного snapshot и логирует задержку");

    await testOutlineIsReadyBeforeDiagnostics();
    console.log("[OK] document.open и Outline завершаются раньше diagnostics");

    await testInactiveRestoredTabIsLazy();
    console.log("[OK] неактивная восстановленная вкладка анализируется лениво");

    testCompletionPayloadIsBoundedAndResolvedLazily();
    console.log("[OK] Completion ограничен и догружает detail через resolve");

    await testInteractiveFallbackDoesNotMixVersions();
    console.log("[OK] интерактивный fallback не смешивает версии документа");

    await testFastPhasePrecedesLocalModel();
    console.log("[OK] быстрая фаза опережает точную локальную модель");

    await testImportContextDrivesHighlightAndNavigation();
    console.log("[OK] подсветка и переход учитывают догруженный Import");
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

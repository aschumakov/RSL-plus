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
    createFastDocumentSnapshot,
    getFastDocumentSymbols
} = require("../server/out/services/fastDocumentSnapshot");
const {
    RslSettingsService
} = require("../server/out/services/settingsService");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

const defaults = {
    import: "ДА",
    diagnostics: {
        enabled: true,
        structure: true,
        maxProblems: 200
    }
};

async function testAvailableSettingsDoNotWaitForVsCode() {
    let resolveConfiguration;
    let requestCompleted = false;
    const requested = new Promise(resolve => {
        resolveConfiguration = resolve;
    });
    const connection = {
        workspace: {
            getConfiguration() {
                return requested;
            }
        }
    };
    const service = new RslSettingsService(connection, defaults);
    service.configure(true);
    service.updateFromConfiguration({
        RSLanguageServer: {
            import: "НЕТ",
            diagnostics: {
                maxProblems: 75
            }
        }
    });

    const changed = [];
    service.onDidResolve((uri, settings) => {
        changed.push({ uri, settings });
    });

    const pending = service.get("file:///slow.mac").then(settings => {
        requestCompleted = true;
        return settings;
    });
    const available = service.getAvailable("file:///slow.mac");

    assert.strictEqual(available.import, "НЕТ");
    assert.strictEqual(available.diagnostics.maxProblems, 75);
    assert.strictEqual(available.diagnostics.enabled, true);
    await Promise.resolve();
    assert.strictEqual(
        requestCompleted,
        false,
        "Доступный снимок не должен ждать workspace/configuration"
    );

    resolveConfiguration({
        import: "ДА",
        diagnostics: {
            maxProblems: 10
        }
    });
    const resolved = await pending;

    assert.strictEqual(resolved.import, "ДА");
    assert.strictEqual(service.getAvailable(
        "file:///slow.mac"
    ).diagnostics.maxProblems, 10);
    assert.strictEqual(changed.length, 1);
    assert.strictEqual(changed[0].uri, "file:///slow.mac");
}

async function testResourceSettingsAreIsolatedAndCached() {
    const calls = [];
    const connection = {
        workspace: {
            getConfiguration({ scopeUri }) {
                calls.push(scopeUri);
                return Promise.resolve({
                    import: "ДА",
                    diagnostics: {
                        maxProblems: scopeUri.endsWith("a.mac") ? 10 : 20
                    }
                });
            }
        }
    };
    const service = new RslSettingsService(connection, defaults);
    service.configure(true);

    const a = await service.get("file:///a.mac");
    const b = await service.get("file:///b.mac");
    assert.strictEqual(a.diagnostics.maxProblems, 10);
    assert.strictEqual(b.diagnostics.maxProblems, 20);
    assert.strictEqual(a.diagnostics.enabled, true);
    assert.strictEqual(calls.length, 2);

    await service.get("file:///a.mac");
    assert.strictEqual(
        calls.length,
        2,
        "Настройки документа должны кэшироваться отдельно"
    );

    service.clear("file:///a.mac");
    await service.get("file:///a.mac");
    assert.strictEqual(calls.length, 3);
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
            getImportClosureKey: () => "",
            get size() {
                return 1;
            }
        },
        {
            getAvailable: () => ({
                import: "ДА",
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
            buildWorkspace: () => []
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
    getFastDocumentSymbols(document, snapshot);

    const handlers = {};
    const register = name => callback => {
        handlers[name] = callback;
    };
    const connection = {
        onCompletion: register("completion"),
        onHover: register("hover"),
        onDocumentHighlight: register("documentHighlight"),
        onDefinition: register("definition"),
        onReferences: register("references"),
        onCodeAction: register("codeAction"),
        onSelectionRanges: register("selectionRanges"),
        onExecuteCommand: register("executeCommand"),
        onDocumentSymbol: register("documentSymbol"),
        onFoldingRanges: register("foldingRanges"),
        onDocumentFormatting: register("documentFormatting"),
        sendRequest: async () => undefined,
        languages: {
            semanticTokens: {
                on: register("semanticTokens"),
                onDelta: register("semanticTokensDelta"),
                onRange: register("semanticTokensRange")
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
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

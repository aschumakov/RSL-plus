import {
    CodeActionKind,
    FileChangeType,
    InitializeParams,
    ProposedFeatures,
    TextDocumentSyncKind,
    createConnection,
    TextDocuments
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";

import { CBase, configureSymbolTreeProvider } from "./common";
import { RslDiagnosticEngine } from "./diagnostics/diagnosticEngine";
import { DiagnosticsCoordinator } from "./diagnostics/diagnosticsCoordinator";
import { DocumentAnalysisService } from "./services/documentAnalysisService";
import { RslDefinitionProvider } from "./features/definitionProvider";
import { DEFAULT_DIAGNOSTIC_SETTINGS } from "./diagnostics";
import { RslLanguageFeatureRegistry } from "./features/languageFeatureRegistry";
import {
    GO_TO_BLOCK_END_COMMAND,
    GO_TO_BLOCK_START_COMMAND
} from "./features/blockNavigation";
import { RslScopeResolver } from "./scopeResolver";
import { IFAStruct, IRslSettings } from "./interfaces";
import { RSL_SEMANTIC_TOKENS_LEGEND } from "./semanticTokens";
import { RslSettingsService } from "./services/settingsService";
import { WorkspaceIndex } from "./workspaceIndex";
import { WorkspaceModuleLoader } from "./indexing/workspaceModuleLoader";
import { ReferenceIndex } from "./analysis/referenceIndex";
import {
    PerformanceLogger,
    type IPerformanceFields
} from "./performanceLogger";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments<TextDocument>(TextDocument);
const workspaceIndex = new WorkspaceIndex();
configureSymbolTreeProvider(() => workspaceIndex.getModules());
const scopeResolver = new RslScopeResolver(workspaceIndex);

const defaultSettings: IRslSettings = {
    import: "ДА",
    diagnostics: DEFAULT_DIAGNOSTIC_SETTINGS
};
const settingsService = new RslSettingsService(defaultSettings);
const diagnosticEngine = new RslDiagnosticEngine();
const referenceIndex = new ReferenceIndex({ log: logMessage });
const performanceLogger = new PerformanceLogger(message => logMessage(message));

let hasWorkspaceFolderCapability = false;
let workFolderOpened = false;
let clientReady = false;
let activeDocumentUri: string | undefined;
let lastReportedModuleCount = -1;
let moduleCountTimer: NodeJS.Timeout | undefined;

interface IActiveDocumentState {
    uri?: string | null;
    settings?: IRslSettings;
    clientAtMs?: number;
}

interface IClientPerformanceEvent extends IPerformanceFields {
    event?: string;
    clientAtMs?: number;
}

function logMessage(message: string): void {
    connection.console.log(
        `[${new Date().toISOString()}] PID=${process.pid} ${message}`
    );
}

function errorToString(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}\n${error.stack || ""}`;
    }

    return String(error);
}

logMessage(`Language server started. Node=${process.version}`);

process.on("unhandledRejection", reason => {
    logMessage(`UNHANDLED REJECTION\n${errorToString(reason)}`);
});

process.on("uncaughtException", error => {
    logMessage(`UNCAUGHT EXCEPTION\n${errorToString(error)}`);
});

process.on("exit", code => {
    logMessage(`Language server exited. Code=${code}`);
});

function sendClientNotification(method: string, params?: unknown): void {
    connection.sendNotification(method, params).then(
        undefined,
        error => logMessage(
            `Client notification failed: ${method}\n${errorToString(error)}`
        )
    );
}

function notifyClient(method: string, params?: unknown): void {
    if (clientReady) {
        sendClientNotification(method, params);
    }
}

function notifyModuleCount(force: boolean = false): void {
    const publish = (): void => {
        moduleCountTimer = undefined;
        const count = workspaceIndex.size;

        if (!force && count === lastReportedModuleCount) {
            return;
        }

        lastReportedModuleCount = count;
        notifyClient("updateStatusBar", count);
    };

    if (force) {
        if (moduleCountTimer) {
            clearTimeout(moduleCountTimer);
            moduleCountTimer = undefined;
        }
        publish();
        return;
    }

    if (!moduleCountTimer) {
        moduleCountTimer = setTimeout(publish, 250);
    }
}

let languageFeatures: RslLanguageFeatureRegistry;

function invalidateProviderCaches(uri: string): void {
    languageFeatures?.invalidate(uri);
}

let diagnosticsCoordinator: DiagnosticsCoordinator;

const moduleLoader = new WorkspaceModuleLoader(
    workspaceIndex,
    {
        log: logMessage,
        performance: performanceLogger,
        onModuleLoaded: module => {
            refreshOpenDependents(module.uri);
        },
        onModuleCountChanged: () => notifyModuleCount(),
        requestMissingImport: name => notifyClient("getFilebyName", name)
    },
    referenceIndex
);

const documentAnalysis = new DocumentAnalysisService(
    documents,
    workspaceIndex,
    settingsService,
    {
        log: logMessage,
        performance: performanceLogger,
        invalidateProviderCaches,
        onParsed: (module, wasKnown) => {
            diagnosticsCoordinator.scheduleLocal(module.uri);
            diagnosticsCoordinator.scheduleWorkspace(module.uri);
            notifyModuleCount();

            if (!wasKnown) {
                refreshOpenDependents(module.uri);
            }
        },
        onImports: (uri, imports) => {
            if (uri === activeDocumentUri) {
                moduleLoader.enqueueImports(imports, "foreground");
            }
        }
    }
);

diagnosticsCoordinator = new DiagnosticsCoordinator(
    connection,
    documents,
    workspaceIndex,
    settingsService,
    diagnosticEngine,
    {
        isParseBusy: uri => documentAnalysis.isBusyFor(uri),
        log: logMessage,
        performance: performanceLogger,
        onImports: (uri, imports) => {
            if (uri === activeDocumentUri) {
                moduleLoader.enqueueImports(imports, "foreground");
            }
        }
    }
);

/*
 * Resource-настройки приходят вместе с уведомлением об активном документе.
 * Пересчитываем Problems только при реальном изменении snapshot.
 */
settingsService.onDidResolve((uri, settings) => {
    const document = documents.get(uri);
    const module = workspaceIndex.getModule(uri);

    workspaceIndex.setImportsEnabled(settings.import === "ДА");

    if (
        !document ||
        !module ||
        module.version !== document.version
    ) {
        return;
    }

    if (uri === activeDocumentUri && settings.import === "ДА") {
        moduleLoader.enqueueImports(module.imports, "foreground");
    }

    diagnosticsCoordinator.scheduleLocal(uri, 0);
    diagnosticsCoordinator.scheduleWorkspace(uri, 0);
});

connection.onNotification("workspaceFiles", (uris: string[]) => {
    const items = Array.isArray(uris) ? uris : [];
    moduleLoader.registerWorkspaceFiles(items);
    definitionProvider.clearCaches();
});

connection.onNotification("clientReady", () => {
    clientReady = true;
    /* По умолчанию загружается только транзитивная цепочка Import открытых файлов. */
    notifyModuleCount(true);
});

connection.onNotification(
    "activeDocumentChanged",
    (value: IActiveDocumentState | string | null | undefined) => {
        let state: IActiveDocumentState;

        if (typeof value === "string") {
            state = { uri: value };
        } else if (value == null) {
            state = { uri: null };
        } else {
            state = value;
        }
        const uri = state.uri || undefined;
        activeDocumentUri = uri;

        if (uri && state.settings) {
            settingsService.updateResource(uri, state.settings);
        }

        const settings = uri
            ? settingsService.getAvailable(uri)
            : settingsService.getWorkspaceSnapshot();
        workspaceIndex.setImportsEnabled(settings.import === "ДА");
        moduleLoader.beginForegroundGeneration();
        documentAnalysis.setActiveDocument(uri);
        diagnosticsCoordinator.setActiveDocument(uri);

        const module = uri ? workspaceIndex.getModule(uri) : undefined;
        if (module && settings.import === "ДА") {
            moduleLoader.enqueueImports(module.imports, "foreground");
        }

        performanceLogger.mark("activeDocument.changed", {
            uri: uri ?? null,
            settingsSource: state.settings ? "clientSnapshot" : "cached",
            clientToServerMs: typeof state.clientAtMs === "number"
                ? Math.max(0, Date.now() - state.clientAtMs)
                : undefined
        });
    }
);

connection.onNotification(
    "clientPerformance",
    (value: IClientPerformanceEvent | undefined) => {
        if (!value || typeof value.event !== "string") {
            return;
        }

        const fields: IPerformanceFields = {};
        for (const [name, fieldValue] of Object.entries(value)) {
            if (
                name !== "event" &&
                name !== "clientAtMs" &&
                (
                    typeof fieldValue === "string" ||
                    typeof fieldValue === "number" ||
                    typeof fieldValue === "boolean" ||
                    fieldValue === null
                )
            ) {
                fields[name] = fieldValue;
            }
        }
        if (typeof value.clientAtMs === "number") {
            fields.clientToServerMs = Math.max(
                0,
                Date.now() - value.clientAtMs
            );
        }
        performanceLogger.mark(value.event, fields);
    }
);

export function GetFileByNameRequest(name: string): void {
    if (workFolderOpened && name) {
        moduleLoader.enqueueImport(name, "foreground");
    }
}

export function GetFileRequest(filePath: string): void {
    if (filePath) {
        notifyClient("getFile", filePath);
    }
}

export function getTree(): IFAStruct[] {
    return workspaceIndex.getModules();
}

function getCurDoc(uri: string): TextDocument | undefined {
    return documents.get(uri);
}

const definitionProvider = new RslDefinitionProvider({
    getOpenDocument: getCurDoc,
    ensureDocumentParsed,
    getLoadedModules: () => workspaceIndex.getModules(),
    getImportedModules: uri =>
        workspaceIndex.getImportedModules(uri).map(module => ({
            uri: module.uri,
            object: module.object
        })),
    findWorkspaceFileUri: name =>
        workspaceIndex.findWorkspaceFileUri(name),
    resolveWorkspaceFileUri: name =>
        workspaceIndex.resolveWorkspaceFile(name),
    ensureModuleByName: name => moduleLoader.ensureLoadedByName(name),
    getDefinitionRange: (uri, object) =>
        workspaceIndex.getDefinitionRange(uri, object),
    log: logMessage
});

languageFeatures = new RslLanguageFeatureRegistry({
    connection,
    documents,
    index: workspaceIndex,
    resolver: scopeResolver,
    definitionProvider,
    referenceIndex,
    getFastDocumentSnapshot: document =>
        documentAnalysis.getFastSnapshot(document),
    ensureDocumentParsed,
    ensureImportedSymbol: (uri, symbolName) =>
        moduleLoader.ensureImportedSymbol(uri, symbolName),
    log: logMessage,
    performance: performanceLogger
});
languageFeatures.register();

connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities;
    const initializationOptions = params.initializationOptions as
        {
            referenceIndexCachePath?: string;
            performanceLogFile?: string;
            initialSettings?: IRslSettings;
        } | undefined;
    referenceIndex.configurePersistence(
        initializationOptions?.referenceIndexCachePath
    );
    performanceLogger.configure(
        initializationOptions?.performanceLogFile
    );
    definitionProvider.configureWorkspace(params);
    workFolderOpened = !!(
        (params.workspaceFolders && params.workspaceFolders.length > 0) ||
        params.rootUri ||
        params.rootPath
    );
    hasWorkspaceFolderCapability = !!(
        capabilities.workspace &&
        capabilities.workspace.workspaceFolders
    );
    settingsService.updateFromConfiguration({
        RSLanguageServer: initializationOptions?.initialSettings
    });

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: {
                resolveProvider: false,
                triggerCharacters: ["."]
            },
            hoverProvider: true,
            documentHighlightProvider: true,
            selectionRangeProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            executeCommandProvider: {
                commands: [
                    GO_TO_BLOCK_START_COMMAND,
                    GO_TO_BLOCK_END_COMMAND
                ]
            },
            codeActionProvider: {
                codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.Refactor]
            },
            semanticTokensProvider: {
                legend: RSL_SEMANTIC_TOKENS_LEGEND,
                full: { delta: true },
                range: true
            },
            documentSymbolProvider: true,
            documentFormattingProvider: true,
            foldingRangeProvider: true
        }
    };
});

connection.onInitialized(() => {
    if (!workFolderOpened) {
        sendClientNotification("noRootFolder");
    }

    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(() => {
            definitionProvider.clearCaches();
        });
    }

    connection.onRequest("getMacros", () =>
        workspaceIndex.getWorkspaceFileUris()
    );
});

documents.onDidOpen(event => {
    workspaceIndex.markOpen(event.document.uri);
    documentAnalysis.open(event.document);
});

documents.onDidClose(event => {
    const uri = event.document.uri;
    settingsService.clear(uri);
    documentAnalysis.close(uri);
    diagnosticsCoordinator.close(uri);
    languageFeatures?.forget(uri);
    workspaceIndex.markClosed(uri);
});

documents.onDidChangeContent(change => {
    diagnosticsCoordinator.cancel(change.document.uri);
    documentAnalysis.changed(change.document);
});

async function ensureDocumentParsed(
    document: TextDocument
): Promise<CBase | undefined> {
    /* Интерактивный LSP-запрос не должен отменять уже запланированные Problems. */
    return documentAnalysis.ensureParsed(document);
}

connection.onDidChangeWatchedFiles(change => {
    for (const fileChange of change.changes) {
        handleWatchedFileChange(
            fileChange.uri,
            fileChange.type
        ).catch(error => {
            logMessage(
                `Watched file processing failed: ${fileChange.uri}\n` +
                errorToString(error)
            );
        });
    }
});

async function handleWatchedFileChange(
    uri: string,
    type: FileChangeType
): Promise<void> {
    referenceIndex.invalidate(uri);
    definitionProvider.invalidateUri(uri);
    const dependents = workspaceIndex.getDependents(uri);

    if (type === FileChangeType.Deleted) {
        moduleLoader.remove(uri);
        documentAnalysis.invalidate(uri);
        dependents.forEach(dependentUri =>
            diagnosticsCoordinator.scheduleWorkspace(dependentUri, 650)
        );
        return;
    }

    workspaceIndex.registerWorkspaceFile(uri);
    const openDocument = documents.get(uri);

    if (openDocument) {
        documentAnalysis.invalidate(uri);
        documentAnalysis.changed(openDocument);
    } else if (workspaceIndex.getModule(uri)) {
        /* Не загружаем изменённый файл, если он не был частью активного Import-графа. */
        await moduleLoader.reload(uri);
    }

    dependents.forEach(dependentUri =>
        diagnosticsCoordinator.scheduleWorkspace(dependentUri, 650)
    );
}

function refreshOpenDependents(uri: string): void {
    workspaceIndex.getDependents(uri).forEach(dependentUri => {
        if (documents.get(dependentUri)) {
            diagnosticsCoordinator.scheduleWorkspace(dependentUri, 650);
        }
    });
}

connection.onShutdown(async () => {
    await referenceIndex.flush();
    await performanceLogger.shutdown();
});

documents.listen(connection);
connection.listen();

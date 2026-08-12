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

import { RslSymbol } from "./symbols/rslSymbol";
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
import {
    PlatformModuleCatalog
} from "./builtins/platformModuleCatalog";
import { IRslSettings } from "./interfaces";
import { RSL_SEMANTIC_TOKENS_LEGEND } from "./semanticTokens";
import { RslSettingsService } from "./services/settingsService";
import { IIndexedModule, WorkspaceIndex } from "./workspaceIndex";
import { WorkspaceModuleLoader } from "./indexing/workspaceModuleLoader";
import {
    CompactModuleWorkerService
} from "./indexing/compactModuleWorkerService";
import { WorkspaceFileDiscoveryService } from "./indexing/workspaceFileDiscoveryService";
import { ReferenceIndex } from "./analysis/referenceIndex";
import {
    PerformanceLogger,
    type IPerformanceFields
} from "./performanceLogger";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments<TextDocument>(TextDocument);
const workspaceIndex = new WorkspaceIndex();
/*
 * Каталог прикладных модулей читается лениво: см. ensureLoaded ниже, он
 * вызывается по готовности списка Import, а не из обработчика Completion.
 */
const platformModules = new PlatformModuleCatalog({
    log: message => logMessage(message)
});
const scopeResolver = new RslScopeResolver(
    workspaceIndex,
    undefined,
    platformModules
);

const defaultSettings: IRslSettings = {
    language: { dialect: "rsBank" },
    imports: { enabled: true },
    autoImport: { enabled: true },
    analysis: { workspaceIndexing: "activeImports" },
    semanticHighlighting: { maxFileSizeKb: 512 },
    diagnostics: DEFAULT_DIAGNOSTIC_SETTINGS
};
const settingsService = new RslSettingsService(defaultSettings);
const diagnosticEngine = new RslDiagnosticEngine();
const referenceIndex = new ReferenceIndex({ log: logMessage });
const performanceLogger = new PerformanceLogger(message => logMessage(message));

let hasWorkspaceFolderCapability = false;
/*
 * Клиент умеет перезапрашивать semantic tokens по просьбе сервера. Без этого
 * подсветка обновится только со следующей правкой документа, поэтому просить
 * бессмысленно.
 */
let hasSemanticTokensRefreshCapability = false;
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

/*
 * Внешние файлы читает и сканирует отдельный поток: это единственная работа,
 * вынос которой в worker подтверждён замерами (компактный ответ вместо AST,
 * npm run bench --scenario=external). Поток создаётся лениво первым запросом.
 */
const compactModules = new CompactModuleWorkerService({ log: logMessage });

/** Import активного файла загружается в первую очередь. */
function enqueueActiveImports(
    uri: string,
    imports: readonly string[]
): void {
    if (uri === activeDocumentUri) {
        moduleLoader.enqueueImports(imports, "foreground");
    }
}

const moduleLoader = new WorkspaceModuleLoader(
    workspaceIndex,
    {
        log: logMessage,
        performance: performanceLogger,
        compactModules,
        onModuleLoaded: module => {
            refreshOpenDependents(module.uri);
        },
        onModuleCountChanged: () => notifyModuleCount(),
        requestMissingImport: name => notifyClient("getFilebyName", name)
    },
    referenceIndex
);

const workspaceDiscovery = new WorkspaceFileDiscoveryService({
    log: logMessage,
    performance: performanceLogger,
    onFiles: uris => {
        moduleLoader.registerWorkspaceFiles(uris);
        definitionProvider?.clearCaches();
    }
});

const documentAnalysis = new DocumentAnalysisService(
    documents,
    workspaceIndex,
    settingsService,
    {
        log: logMessage,
        performance: performanceLogger,
        invalidateProviderCaches,
        /*
         * Разбор своего файла запускает обе волны: локальные ошибки сразу,
         * межфайловые — отложенно, но обязательно для той же версии.
         * Загрузка чужого модуля (onModuleLoaded выше) запускает только
         * вторую волну зависимых файлов: их собственный текст не менялся,
         * пересчитывать локальные ошибки было бы лишней работой и лишним
         * поводом для мерцания Problems.
         */
        onParsed: (module, wasKnown) => {
            diagnosticsCoordinator.scheduleLocal(module.uri, 0);
            diagnosticsCoordinator.scheduleWorkspace(module.uri);
            notifyModuleCount();
            /* Подсветка, отданная до готовности модели, теперь уточняется. */
            languageFeatures?.notifyParsed(module.uri);

            if (!wasKnown) {
                refreshOpenDependents(module.uri);
            }
        },
        onImports: (uri, imports) => {
            /*
             * Единственное место, где готовится состав прикладных модулей.
             *
             * Здесь AST уже построен, то есть список Import окончателен и
             * транзитивные Import разобранных файлов видны. Диагностика
             * сообщает те же Import позже и своего вызова не делает: он был бы
             * повторным для того же файла.
             */
            platformModules.ensureModules(
                scopeResolver.visiblePlatformModules(uri)
            );
            enqueueActiveImports(uri, imports);
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
        waitForIdle: uri => documentAnalysis.whenIdle(uri),
        log: logMessage,
        performance: performanceLogger,
        /* Прикладные модули готовит onImports после разбора: см. выше. */
        onImports: enqueueActiveImports
    }
);

/*
 * Resource-настройки приходят вместе с уведомлением об активном документе.
 * Пересчитываем Problems только при реальном изменении snapshot.
 */
settingsService.onDidResolve((uri, settings) => {
    const document = documents.get(uri);

    workspaceIndex.setImportsEnabled(settings.imports.enabled);
    moduleLoader.setIndexingMode(settings.analysis.workspaceIndexing);

    const module = document &&
        workspaceIndex.getCurrentModule(uri, document.version);

    if (!document || !module) {
        return;
    }

    if (uri === activeDocumentUri && settings.imports.enabled) {
        moduleLoader.enqueueImports(module.imports, "foreground");
    }

    diagnosticsCoordinator.scheduleLocal(uri, 0);
    diagnosticsCoordinator.scheduleWorkspace(uri, 0);
});

connection.onNotification("clientReady", () => {
    clientReady = true;
    /* По умолчанию загружается только транзитивная цепочка Import открытых файлов. */
    notifyModuleCount(true);
    workspaceDiscovery.schedule();
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
        workspaceIndex.setImportsEnabled(settings.imports.enabled);
        moduleLoader.setIndexingMode(settings.analysis.workspaceIndexing);
        moduleLoader.beginForegroundGeneration();
        moduleLoader.noteInteractiveActivity();
        workspaceDiscovery.noteInteractiveActivity();
        documentAnalysis.setActiveDocument(uri);
        diagnosticsCoordinator.setActiveDocument(uri);

        const module = uri ? workspaceIndex.getModule(uri) : undefined;
        if (module && settings.imports.enabled) {
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

export function getTree(): IIndexedModule[] {
    return workspaceIndex.getModules();
}

function getCurDoc(uri: string): TextDocument | undefined {
    return documents.get(uri);
}

const definitionProvider = new RslDefinitionProvider({
    getOpenDocument: getCurDoc,
    ensureDocumentParsed,
    getLoadedModules: () => workspaceIndex.getModules(),
    getImportedModules: uri => workspaceIndex.getImportedModules(uri),
    findWorkspaceFileUri: name =>
        workspaceIndex.findWorkspaceFileUri(name),
    resolveWorkspaceFileUri: name =>
        workspaceIndex.resolveWorkspaceFile(name),
    ensureModuleByName: name => moduleLoader.ensureLoadedByName(name),
    ensureImportedSymbol: (uri, symbolName) =>
        moduleLoader.ensureImportedSymbol(uri, symbolName),
    getDefinitionRange: (uri, object) =>
        workspaceIndex.getDefinitionRange(uri, object),
    resolveMethodReference: (uri, tree, receiverOffset, methodName) => {
        const resolved = scopeResolver.resolveMemberReference(
            uri,
            tree,
            receiverOffset,
            methodName
        );
        return resolved
            ? { uri: resolved.uri, symbol: resolved.symbol }
            : undefined;
    },
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
    findAutoImportModules: (symbolName, options) =>
        moduleLoader.findModulesExportingSymbol(symbolName, 10, options),
    getSettings: uri => settingsService.getAvailable(uri),
    supportsRefresh: () => hasSemanticTokensRefreshCapability,
    noteInteractiveActivity: () => {
        moduleLoader.noteInteractiveActivity();
        workspaceDiscovery.noteInteractiveActivity();
    },
    log: logMessage,
    performance: performanceLogger
});
languageFeatures.register();

connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities;
    const initializationOptions = params.initializationOptions as
        {
            referenceIndexCachePath?: string;
            compactModuleCachePath?: string;
            performanceLogFile?: string;
            initialSettings?: IRslSettings;
            activeDocumentUri?: string | null;
        } | undefined;
    referenceIndex.configurePersistence(
        initializationOptions?.referenceIndexCachePath
    );
    compactModules.configureCache(
        initializationOptions?.compactModuleCachePath
    );
    performanceLogger.configure(
        initializationOptions?.performanceLogFile
    );
    definitionProvider.configureWorkspace(params);
    workspaceDiscovery.configure(params);
    activeDocumentUri = initializationOptions?.activeDocumentUri || undefined;
    documentAnalysis.setActiveDocument(activeDocumentUri);
    workFolderOpened = !!(
        (params.workspaceFolders && params.workspaceFolders.length > 0) ||
        params.rootUri ||
        params.rootPath
    );
    hasWorkspaceFolderCapability = !!(
        capabilities.workspace &&
        capabilities.workspace.workspaceFolders
    );
    hasSemanticTokensRefreshCapability = !!(
        capabilities.workspace &&
        capabilities.workspace.semanticTokens &&
        capabilities.workspace.semanticTokens.refreshSupport
    );
    settingsService.updateFromConfiguration({
        rslPlus: initializationOptions?.initialSettings
    });
    const initialSettings = settingsService.getWorkspaceSnapshot();
    workspaceIndex.setImportsEnabled(initialSettings.imports.enabled);
    moduleLoader.setIndexingMode(
        initialSettings.analysis.workspaceIndexing
    );

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: {
                resolveProvider: true,
                triggerCharacters: [".", "\"", "'", "/", "\\"]
            },
            signatureHelpProvider: {
                triggerCharacters: ["(", ","],
                retriggerCharacters: [","]
            },
            hoverProvider: true,
            documentHighlightProvider: true,
            selectionRangeProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            renameProvider: { prepareProvider: true },
            workspaceSymbolProvider: true,
            callHierarchyProvider: true,
            executeCommandProvider: {
                commands: [
                    GO_TO_BLOCK_START_COMMAND,
                    GO_TO_BLOCK_END_COMMAND
                ]
            },
            codeActionProvider: {
                codeActionKinds: [
                    CodeActionKind.QuickFix,
                    CodeActionKind.Refactor,
                    CodeActionKind.SourceOrganizeImports,
                    CodeActionKind.SourceFixAll,
                    `${CodeActionKind.SourceFixAll}.rsl`
                ]
            },
            semanticTokensProvider: {
                legend: RSL_SEMANTIC_TOKENS_LEGEND,
                full: { delta: true },
                range: true
            },
            documentSymbolProvider: true,
            documentFormattingProvider: true,
            documentRangeFormattingProvider: true,
            foldingRangeProvider: true
        }
    };
});

connection.onInitialized(() => {
    if (!workFolderOpened) {
        sendClientNotification("noRootFolder");
    }

    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(event => {
            definitionProvider.clearCaches();
            workspaceDiscovery.updateWorkspaceFolders(
                event.added,
                event.removed
            );
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
): Promise<RslSymbol | undefined> {
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

/**
 * Загрузился модуль, от которого зависят открытые файлы.
 *
 * Их собственные версии не изменились, но изменилось Import-замыкание:
 * пересчитываются межфайловые Problems, а подсветка получает шанс
 * перекраситься — известный внешний символ выглядит иначе, чем неизвестный.
 */
function refreshOpenDependents(uri: string): void {
    const openDependents = workspaceIndex.getDependents(uri)
        .filter(dependentUri => !!documents.get(dependentUri));

    openDependents.forEach(dependentUri =>
        diagnosticsCoordinator.scheduleWorkspace(dependentUri, 650)
    );

    if (openDependents.length > 0) {
        /*
         * Прикладные модули зависимых файлов готовятся именно здесь.
         *
         * Транзитивный Import виден только после того, как импортированный
         * файл попал в индекс: пока он не разобран, его собственные Import
         * загрузчику каталога неизвестны. Открытый файл при этом уже
         * разобран, и своего onImports у него больше не будет — то есть без
         * этого вызова классы CommonInter, импортированного внутри
         * middle.mac, не появлялись бы до правки активного файла.
         */
        for (const dependentUri of openDependents) {
            platformModules.ensureModules(
                scopeResolver.visiblePlatformModules(dependentUri)
            );
        }

        languageFeatures?.notifyImportContextChanged(openDependents);
    }
}

connection.onShutdown(async () => {
    languageFeatures?.dispose();

    /*
     * Постоянные кэши записываются до остановки worker'а.
     *
     * Обычная запись отложена на паузу простоя, и при закрытии редактора сразу
     * после индексации она не успевала произойти: следующий запуск заново
     * сканировал всё, что уже было посчитано. Ошибка записи не должна помешать
     * остановке, поэтому обе операции завершаются независимо.
     */
    const saved = await Promise.allSettled([referenceIndex.flush()]);

    for (const result of saved) {
        if (result.status === "rejected") {
            logMessage(
                `Кэш не сохранён при остановке: ${String(result.reason)}`
            );
        }
    }

    /* Кэш compact-модулей пишет сам worker: файлом владеет он. */
    return compactModules.dispose();
});

documents.listen(connection);
connection.listen();

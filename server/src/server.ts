import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import {
    CodeActionKind,
    CompletionItem,
    Definition,
    Diagnostic,
    DidChangeConfigurationNotification,
    FileChangeType,
    FormattingOptions,
    Hover,
    InitializeParams,
    ProposedFeatures,
    Range,
    SymbolInformation,
    TextDocumentPositionParams,
    TextDocumentSyncKind,
    TextEdit,
    createConnection,
    TextDocuments
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";

import { CBase, configureSymbolTreeProvider } from "./common";
import { buildRslCodeActions } from "./codeActions";
import { RslDefinitionProvider } from "./definitionProvider";
import {
    buildRslDiagnostics,
    DEFAULT_DIAGNOSTIC_SETTINGS
} from "./diagnostics";
import { getCIInfoForArray, getDefaults } from "./defaults";
import { getSymbols } from "./docsymbols";
import { GetFoldingRanges } from "./folding";
import { FormatCode } from "./format";
import { IFAStruct, IRslSettings, IToken } from "./interfaces";
import { findRslReferences } from "./references";
import { RslScopeResolver } from "./scopeResolver";
import {
    buildRslSemanticTokens,
    RSL_SEMANTIC_TOKENS_LEGEND
} from "./semanticTokens";
import { IIndexedModule, WorkspaceIndex } from "./workspaceIndex";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments<TextDocument>(TextDocument);
const workspaceIndex = new WorkspaceIndex();
configureSymbolTreeProvider(() => workspaceIndex.getModules());
const scopeResolver = new RslScopeResolver(workspaceIndex);

const logFilePath = path.resolve(__dirname, "..", "rsl-server.log");
const defaultSettings: IRslSettings = {
    import: "ДА",
    diagnostics: DEFAULT_DIAGNOSTIC_SETTINGS
};
const documentSettings = new Map<string, Promise<IRslSettings>>();
const parseGeneration = new Map<string, number>();
const parsedVersions = new Map<string, number>();
const parseTimers = new Map<string, NodeJS.Timeout>();
const diagnosticTimers = new Map<string, NodeJS.Timeout>();
const diagnosticsCache = new Map<string, Diagnostic[]>();
const publishedDiagnosticSignatures = new Map<string, string>();
const semanticTokensCache = new Map<string, {
    version: number;
    value: ReturnType<typeof buildRslSemanticTokens>;
}>();
const foldingRangesCache = new Map<string, {
    version: number;
    value: ReturnType<typeof GetFoldingRanges>;
}>();
const documentSymbolsCache = new Map<string, {
    version: number;
    value: SymbolInformation[];
}>();
const defaultCompletionItems = getCIInfoForArray(getDefaults());
const pendingImportNames = new Set<string>();
const requestedImportNames = new Set<string>();
const workspaceFileUris = new Set<string>();
const externalModuleQueue: string[] = [];
const queuedExternalModules = new Set<string>();

/*
 * Разбор открытого документа выполняется быстро после паузы ввода.
 * Более тяжёлые семантические диагностики запускаются отдельно, когда
 * пользователь уже закончил короткую серию нажатий.
 */
const PARSE_DEBOUNCE_MS = 80;
const DIAGNOSTICS_DEBOUNCE_MS = 300;
const LARGE_DIAGNOSTICS_DEBOUNCE_MS = 550;
const VERY_LARGE_DIAGNOSTICS_DEBOUNCE_MS = 800;
const DEPENDENT_DIAGNOSTICS_DEBOUNCE_MS = 650;
const SLOW_PARSE_LOG_MS = 75;
const SLOW_DIAGNOSTICS_LOG_MS = 100;

let globalSettings: IRslSettings = defaultSettings;
let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let workFolderOpened = false;
let clientReady = false;
let externalModuleLoadRunning = false;
let activeDocumentUri: string | undefined;
let lastReportedModuleCount = -1;

interface IPositionContext {
    document: TextDocument;
    tree: CBase;
    offset: number;
    token?: IToken;
}

function logMessage(message: string): void {
    const line =
        `[${new Date().toISOString()}] ` +
        `PID=${process.pid} ${message}\r\n`;

    fs.promises.appendFile(logFilePath, line, "utf8")
        .catch(() => undefined);
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
    /* Ошибка фиксируется, но отдельный запрос не должен убивать сервер. */
    logMessage(`UNCAUGHT EXCEPTION\n${errorToString(error)}`);
});

process.on("exit", code => {
    logMessage(`Language server exited. Code=${code}`);
});

function sendClientNotification(
    method: string,
    params?: unknown
): void {
    connection.sendNotification(method, params).then(
        undefined,
        error => logMessage(
            `Client notification failed: ${method}\n` +
            errorToString(error)
        )
    );
}

function notifyClient(method: string, params?: unknown): void {
    if (clientReady) {
        sendClientNotification(method, params);
    }
}

function notifyModuleCount(force: boolean = false): void {
    const count = workspaceIndex.size;

    if (!force && count === lastReportedModuleCount) {
        return;
    }

    lastReportedModuleCount = count;
    notifyClient("updateStatusBar", count);
}

function invalidateProviderCaches(uri: string): void {
    semanticTokensCache.delete(uri);
    foldingRangesCache.delete(uri);
    documentSymbolsCache.delete(uri);
}

function diagnosticSignature(diagnostics: Diagnostic[]): string {
    return diagnostics.map(item => [
        item.code || "",
        item.severity || "",
        item.range.start.line,
        item.range.start.character,
        item.range.end.line,
        item.range.end.character,
        item.message
    ].join(":")).join("\u0001");
}

function sendDiagnosticsIfChanged(
    uri: string,
    diagnostics: Diagnostic[]
): void {
    const signature = diagnosticSignature(diagnostics);

    if (publishedDiagnosticSignatures.get(uri) === signature) {
        return;
    }

    publishedDiagnosticSignatures.set(uri, signature);
    connection.sendDiagnostics({ uri, diagnostics });
}

/**
 * Импортируемые модули разбираются последовательно в фоне. Это не даёт
 * большой цепочке IMPORT занять event loop и задержать подсказки активного
 * редактора.
 */
function enqueueExternalModuleLoad(uri: string): void {
    if (
        !uri ||
        workspaceIndex.getModule(uri) ||
        queuedExternalModules.has(uri)
    ) {
        return;
    }

    queuedExternalModules.add(uri);
    externalModuleQueue.push(uri);
    processExternalModuleQueue();
}

function processExternalModuleQueue(): void {
    if (externalModuleLoadRunning) {
        return;
    }

    const uri = externalModuleQueue.shift();

    if (!uri) {
        return;
    }

    externalModuleLoadRunning = true;

    setTimeout(() => {
        loadExternalModule(uri).then(
            undefined,
            error => logMessage(
                `Background import load failed: ${uri}\n` +
                errorToString(error)
            )
        ).finally(() => {
            queuedExternalModules.delete(uri);
            externalModuleLoadRunning = false;
            processExternalModuleQueue();
        });
    }, 0);
}

function flushPendingImports(): void {
    if (!clientReady || globalSettings.import !== "ДА") {
        return;
    }

    pendingImportNames.forEach(name => {
        if (
            requestedImportNames.has(name.toLowerCase()) ||
            workspaceIndex.findModuleByName(name)
        ) {
            return;
        }

        const normalizedName = name.toLowerCase();
        const indexedUri = workspaceIndex.findWorkspaceFileUri(name);
        requestedImportNames.add(normalizedName);

        if (indexedUri) {
            enqueueExternalModuleLoad(indexedUri);
        } else {
            notifyClient("getFilebyName", name);
        }
    });

    pendingImportNames.clear();
}

connection.onNotification("workspaceFiles", (uris: string[]) => {
    const items = Array.isArray(uris) ? uris : [];
    workspaceFileUris.clear();
    items.forEach(uri => workspaceFileUris.add(uri));
    workspaceIndex.registerWorkspaceFiles(items);
    definitionProvider.clearCaches();
    flushPendingImports();
});

connection.onNotification("clientReady", () => {
    clientReady = true;
    flushPendingImports();
    notifyModuleCount(true);
});

/**
 * VS Code сортирует группы Problems по важности и пути файла и не даёт
 * расширению поставить активный URI первым. Поэтому при активном RSL-файле
 * публикуем в Problems только его диагностики. При переходе в другой тип
 * файла снова показываются диагностики всех открытых RSL-документов.
 */
connection.onNotification(
    "activeDocumentChanged",
    (uri: string | null | undefined) => {
        const nextUri = typeof uri === "string" && uri.length > 0
            ? uri
            : undefined;
        const previousUri = activeDocumentUri;

        if (previousUri === nextUri) {
            return;
        }

        activeDocumentUri = nextUri;

        if (previousUri && previousUri !== nextUri) {
            sendDiagnosticsIfChanged(previousUri, []);
        }

        if (activeDocumentUri) {
            const cached = diagnosticsCache.get(activeDocumentUri);

            if (cached) {
                if (cached.length > 0) {
                    showActiveDiagnosticsOnly(activeDocumentUri, cached);
                } else {
                    showAllCachedDiagnostics();
                }
            } else {
                /* Старый список остаётся видимым, пока активный файл считается. */
                scheduleDiagnostics(activeDocumentUri, 0);
            }
            return;
        }

        showAllCachedDiagnostics();
    }
);

export function GetFileByNameRequest(name: string): void {
    if (
        !workFolderOpened ||
        globalSettings.import !== "ДА" ||
        !name ||
        workspaceIndex.findModuleByName(name)
    ) {
        return;
    }

    const normalizedName = name.toLowerCase();
    const indexedUri = workspaceIndex.findWorkspaceFileUri(name);

    if (indexedUri && !requestedImportNames.has(normalizedName)) {
        requestedImportNames.add(normalizedName);
        enqueueExternalModuleLoad(indexedUri);
        return;
    }

    pendingImportNames.add(name);
    flushPendingImports();
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

function getCurObj(uri: string): CBase | undefined {
    const module = workspaceIndex.getModule(uri);
    return module ? module.object : undefined;
}

function getPositionContext(
    params: TextDocumentPositionParams
): IPositionContext | undefined {
    const document = getCurDoc(params.textDocument.uri);
    const tree = getCurObj(params.textDocument.uri);

    if (!document || !tree) {
        return undefined;
    }

    const offset = document.offsetAt(params.position);

    return {
        document,
        tree,
        offset,
        token: tree.getCurrentToken(offset)
    };
}

function isBlockedToken(token?: IToken): boolean {
    return !!token && (
        token.kind === "string" ||
        token.kind === "square" ||
        token.kind === "comment"
    );
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
    log: logMessage
});

connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities;
    definitionProvider.configureWorkspace(params);
    workFolderOpened = !!(
        (params.workspaceFolders && params.workspaceFolders.length > 0) ||
        params.rootUri ||
        params.rootPath
    );
    hasConfigurationCapability = !!(
        capabilities.workspace &&
        capabilities.workspace.configuration
    );
    hasWorkspaceFolderCapability = !!(
        capabilities.workspace &&
        capabilities.workspace.workspaceFolders
    );

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: {
                resolveProvider: false,
                triggerCharacters: ["."]
            },
            hoverProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            codeActionProvider: {
                codeActionKinds: [CodeActionKind.QuickFix]
            },
            semanticTokensProvider: {
                legend: RSL_SEMANTIC_TOKENS_LEGEND,
                full: true
            },
            documentSymbolProvider: true,
            documentFormattingProvider: true,
            foldingRangeProvider: true
        }
    };
});

connection.onInitialized(async () => {
    if (!workFolderOpened) {
        sendClientNotification("noRootFolder");
    }

    if (hasConfigurationCapability) {
        await connection.client.register(
            DidChangeConfigurationNotification.type,
            undefined
        );
    }

    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(() => {
            definitionProvider.clearCaches();
            requestedImportNames.clear();
        });
    }

    connection.onRequest("getMacros", () =>
        workspaceIndex.getIndexedModules().map(module => module.uri)
    );
});

connection.onDidChangeConfiguration(change => {
    if (hasConfigurationCapability) {
        documentSettings.clear();
    } else {
        globalSettings = <IRslSettings>(
            change.settings.RSLanguageServer || defaultSettings
        );
    }

    /* Настройки диагностик не требуют повторного синтаксического разбора. */
    documents.all().forEach(document => {
        scheduleDiagnostics(document.uri, 0);
    });
});

function getDocumentSettings(resource: string): Promise<IRslSettings> {
    if (!hasConfigurationCapability) {
        return Promise.resolve(globalSettings);
    }

    let result = documentSettings.get(resource);

    if (!result) {
        result = connection.workspace.getConfiguration({
            scopeUri: resource,
            section: "RSLanguageServer"
        });
        documentSettings.set(resource, result);
    }

    return result;
}

documents.onDidOpen(event => {
    workspaceIndex.markOpen(event.document.uri);
    scheduleValidation(event.document);
});

documents.onDidClose(event => {
    const uri = event.document.uri;
    documentSettings.delete(uri);
    parsedVersions.delete(uri);
    parseGeneration.set(uri, (parseGeneration.get(uri) || 0) + 1);
    cancelScheduledValidation(uri);
    cancelScheduledDiagnostics(uri);
    diagnosticsCache.delete(uri);
    invalidateProviderCaches(uri);
    workspaceIndex.markClosed(uri);
    sendDiagnosticsIfChanged(uri, []);
    publishedDiagnosticSignatures.delete(uri);
});

documents.onDidChangeContent(change => {
    scheduleValidation(change.document);
});

function cancelScheduledValidation(uri: string): void {
    const timer = parseTimers.get(uri);

    if (timer) {
        clearTimeout(timer);
        parseTimers.delete(uri);
    }
}

function cancelScheduledDiagnostics(uri: string): void {
    const timer = diagnosticTimers.get(uri);

    if (timer) {
        clearTimeout(timer);
        diagnosticTimers.delete(uri);
    }
}

function showAllCachedDiagnostics(): void {
    documents.all().forEach(document => {
        const cached = diagnosticsCache.get(document.uri);

        if (cached) {
            sendDiagnosticsIfChanged(document.uri, cached);
        }
    });
}

function showActiveDiagnosticsOnly(
    uri: string,
    diagnostics: Diagnostic[]
): void {
    /*
     * У Problems нет API пользовательской сортировки ресурсов. Если в
     * активном файле есть проблемы, временно скрываем остальные группы,
     * сохраняя их в кэше для мгновенного переключения.
     */
    documents.all().forEach(document => {
        if (document.uri !== uri) {
            sendDiagnosticsIfChanged(document.uri, []);
        }
    });

    sendDiagnosticsIfChanged(uri, diagnostics);
}

function publishDiagnostics(uri: string, diagnostics: Diagnostic[]): void {
    diagnosticsCache.set(uri, diagnostics);

    if (!activeDocumentUri) {
        sendDiagnosticsIfChanged(uri, diagnostics);
        return;
    }

    if (activeDocumentUri === uri) {
        if (diagnostics.length > 0) {
            showActiveDiagnosticsOnly(uri, diagnostics);
        } else {
            showAllCachedDiagnostics();
        }
        return;
    }

    const activeDiagnostics = diagnosticsCache.get(activeDocumentUri);

    if (activeDiagnostics && activeDiagnostics.length > 0) {
        sendDiagnosticsIfChanged(uri, []);
    } else {
        sendDiagnosticsIfChanged(uri, diagnostics);
    }
}

function getDiagnosticsDelay(uri: string): number {
    const module = workspaceIndex.getModule(uri);
    const length = module ? module.source.length : 0;

    if (length >= 250000) {
        return VERY_LARGE_DIAGNOSTICS_DEBOUNCE_MS;
    }

    if (length >= 100000) {
        return LARGE_DIAGNOSTICS_DEBOUNCE_MS;
    }

    return DIAGNOSTICS_DEBOUNCE_MS;
}

function scheduleDiagnostics(
    uri: string,
    delay?: number
): void {
    cancelScheduledDiagnostics(uri);

    const actualDelay = delay === undefined
        ? getDiagnosticsDelay(uri)
        : Math.max(0, delay);

    const timer = setTimeout(() => {
        diagnosticTimers.delete(uri);
        runDiagnostics(uri).catch(error => {
            logMessage(
                `Diagnostics failed: ${uri}\n${errorToString(error)}`
            );
        });
    }, actualDelay);

    diagnosticTimers.set(uri, timer);
}

async function runDiagnostics(uri: string): Promise<void> {
    const document = documents.get(uri);
    const module = workspaceIndex.getModule(uri);

    if (!document || !module || module.version !== document.version) {
        return;
    }

    const settings = await getDocumentSettings(uri);
    const currentDocument = documents.get(uri);
    const currentModule = workspaceIndex.getModule(uri);

    if (
        !currentDocument ||
        !currentModule ||
        currentDocument.version !== module.version ||
        currentModule.version !== module.version
    ) {
        return;
    }

    globalSettings = settings || defaultSettings;
    const started = Date.now();
    const diagnostics = buildRslDiagnostics(
        currentModule,
        workspaceIndex,
        globalSettings.diagnostics
    );

    publishDiagnostics(uri, diagnostics);

    if (globalSettings.import === "ДА") {
        currentModule.imports.forEach(GetFileByNameRequest);
    }

    const elapsed = Date.now() - started;

    if (elapsed >= SLOW_DIAGNOSTICS_LOG_MS) {
        logMessage(
            `Slow diagnostics: ${uri}; version=${currentModule.version}; ` +
            `ms=${elapsed}; count=${diagnostics.length}`
        );
    }
}

function scheduleValidation(document: TextDocument): void {
    const uri = document.uri;
    const version = document.version;
    const generation = (parseGeneration.get(uri) || 0) + 1;
    parseGeneration.set(uri, generation);
    cancelScheduledValidation(uri);
    cancelScheduledDiagnostics(uri);

    const timer = setTimeout(() => {
        parseTimers.delete(uri);
        const current = documents.get(uri);

        if (!current || current.version !== version) {
            return;
        }

        validateTextDocument(current, generation).catch(error => {
            logMessage(
                `Validation failed: ${uri}\n${errorToString(error)}`
            );
        });
    }, PARSE_DEBOUNCE_MS);

    parseTimers.set(uri, timer);
}

async function validateTextDocument(
    document: TextDocument,
    generation: number
): Promise<void> {
    const uri = document.uri;
    const version = document.version;

    if (
        parsedVersions.get(uri) === version &&
        workspaceIndex.getModule(uri)
    ) {
        return;
    }

    const text = document.getText();
    const started = Date.now();
    const wasKnown = !!workspaceIndex.getModule(uri);
    const parsedObject = new CBase(text, 0);

    if (parseGeneration.get(uri) !== generation) {
        return;
    }

    const indexed = workspaceIndex.updateModule(
        uri,
        text,
        parsedObject,
        version,
        true
    );
    parsedVersions.set(uri, version);
    invalidateProviderCaches(uri);

    /*
     * Дерево становится доступно completion/hover сразу. Диагностики и
     * разрешение IMPORT выполняются после отдельной паузы и не задерживают
     * визуальный отклик редактора.
     */
    scheduleDiagnostics(uri);
    notifyModuleCount();

    getDocumentSettings(uri).then(settings => {
        const current = workspaceIndex.getModule(uri);

        if (
            !current ||
            current.version !== version ||
            parseGeneration.get(uri) !== generation
        ) {
            return;
        }

        globalSettings = settings || defaultSettings;

        if (globalSettings.import === "ДА") {
            indexed.imports.forEach(GetFileByNameRequest);
        }
    }).catch(error => {
        logMessage(
            `Settings read failed: ${uri}\n${errorToString(error)}`
        );
    });

    if (!wasKnown) {
        refreshOpenDependents(uri);
    }

    const elapsed = Date.now() - started;

    if (elapsed >= SLOW_PARSE_LOG_MS) {
        logMessage(
            `Slow parse: ${uri}; version=${version}; ` +
            `ms=${elapsed}; symbols=${parsedObject.getChilds().length}`
        );
    }
}

async function ensureDocumentParsed(
    document: TextDocument
): Promise<CBase | undefined> {
    if (
        parsedVersions.get(document.uri) === document.version &&
        workspaceIndex.getModule(document.uri)
    ) {
        return getCurObj(document.uri);
    }

    cancelScheduledValidation(document.uri);
    cancelScheduledDiagnostics(document.uri);
    const generation = (parseGeneration.get(document.uri) || 0) + 1;
    parseGeneration.set(document.uri, generation);
    await validateTextDocument(document, generation);
    return getCurObj(document.uri);
}

connection.onDidChangeWatchedFiles(change => {
    requestedImportNames.clear();

    change.changes.forEach(fileChange => {
        handleWatchedFileChange(
            fileChange.uri,
            fileChange.type
        ).catch(error => {
            logMessage(
                `Watched file processing failed: ${fileChange.uri}\n` +
                errorToString(error)
            );
        });
    });
});

async function handleWatchedFileChange(
    uri: string,
    type: FileChangeType
): Promise<void> {
    definitionProvider.invalidateUri(uri);
    const dependents = workspaceIndex.getDependents(uri);

    if (type === FileChangeType.Deleted) {
        workspaceFileUris.delete(uri);
        workspaceIndex.unregisterWorkspaceFile(uri);
        workspaceIndex.removeModule(uri);
        parsedVersions.delete(uri);
        dependents.forEach(uri =>
            scheduleDiagnostics(uri, DEPENDENT_DIAGNOSTICS_DEBOUNCE_MS)
        );
        notifyModuleCount();
        return;
    }

    workspaceFileUris.add(uri);
    workspaceIndex.registerWorkspaceFile(uri);
    const openDocument = documents.get(uri);

    if (openDocument) {
        parsedVersions.delete(uri);
        scheduleValidation(openDocument);
    } else {
        await loadExternalModule(uri);
    }

    dependents.forEach(uri =>
        scheduleDiagnostics(uri, DEPENDENT_DIAGNOSTICS_DEBOUNCE_MS)
    );
}

async function loadExternalModule(uri: string): Promise<void> {
    let filePath: string;

    try {
        filePath = fileURLToPath(uri);
    } catch (_error) {
        return;
    }

    try {
        const text = await fs.promises.readFile(filePath, "utf8");
        const stat = await fs.promises.stat(filePath);
        const tree = CBase.forExternalModule(text);
        const module = workspaceIndex.updateModule(
            uri,
            text,
            tree,
            Math.floor(stat.mtimeMs),
            false
        );

        module.imports.forEach(GetFileByNameRequest);
        refreshOpenDependents(uri);
        notifyModuleCount();
    } catch (error) {
        logMessage(
            `External module load failed: ${uri}\n` +
            errorToString(error)
        );
    }
}

function refreshOpenDependents(uri: string): void {
    workspaceIndex.getDependents(uri).forEach(dependentUri => {
        if (documents.get(dependentUri)) {
            scheduleDiagnostics(
                dependentUri,
                DEPENDENT_DIAGNOSTICS_DEBOUNCE_MS
            );
        }
    });
}

async function ensureWorkspaceModulesLoaded(): Promise<void> {
    for (const uri of workspaceFileUris) {
        if (!workspaceIndex.getModule(uri)) {
            await loadExternalModule(uri);
        }
    }
}

connection.onCompletion(async params => {
    const document = getCurDoc(params.textDocument.uri);

    if (!document) {
        return [];
    }

    await ensureDocumentParsed(document);
    const context = getPositionContext(params);

    if (!context || isBlockedToken(context.token)) {
        return [];
    }

    return deduplicateCompletionItems(
        scopeResolver.getCompletions(
            document.uri,
            context.tree,
            context.offset
        ),
        defaultCompletionItems
    );
});

connection.onHover(async (
    params: TextDocumentPositionParams
): Promise<Hover | null> => {
    const document = getCurDoc(params.textDocument.uri);

    if (!document) {
        return null;
    }

    await ensureDocumentParsed(document);
    const context = getPositionContext(params);

    if (!context || isBlockedToken(context.token)) {
        return null;
    }

    const resolved = scopeResolver.resolveAt(
        document.uri,
        context.tree,
        context.offset
    );

    if (!resolved) {
        return null;
    }

    const info = resolved.object.CIInfo;
    const documentation = info.documentation
        ? info.documentation.toString()
        : "";

    return {
        contents:
            `${info.detail || ""}` +
            (documentation ? `  \n${documentation}` : ""),
        range: {
            start: document.positionAt(resolved.token.start),
            end: document.positionAt(resolved.token.end)
        }
    };
});

connection.onDefinition(async (params): Promise<Definition | null> => {
    const document = getCurDoc(params.textDocument.uri);

    if (!document) {
        return null;
    }

    await ensureDocumentParsed(document);
    const context = getPositionContext(params);

    if (!context) {
        return null;
    }

    const importedFile = await definitionProvider
        .findImportDefinition(context);

    if (importedFile) {
        return importedFile;
    }

    const dynamic = await definitionProvider.findDynamicDefinition(context);

    if (dynamic) {
        return dynamic;
    }

    if (isBlockedToken(context.token)) {
        return null;
    }

    const resolved = scopeResolver.resolveAt(
        document.uri,
        context.tree,
        context.offset
    );

    return resolved
        ? definitionProvider.createObjectLocationByUri(
            resolved.uri,
            resolved.object
        )
        : null;
});

connection.onReferences(async params => {
    const document = getCurDoc(params.textDocument.uri);

    if (!document) {
        return [];
    }

    await ensureDocumentParsed(document);
    await ensureWorkspaceModulesLoaded();
    const context = getPositionContext(params);

    if (!context || isBlockedToken(context.token)) {
        return [];
    }

    return findRslReferences(
        workspaceIndex,
        scopeResolver,
        document.uri,
        context.offset,
        params.context.includeDeclaration
    );
});

connection.onCodeAction(params => {
    const module = workspaceIndex.getModule(params.textDocument.uri);
    return module ? buildRslCodeActions(module, params) : [];
});

connection.languages.semanticTokens.on(async params => {
    const document = getCurDoc(params.textDocument.uri);

    if (!document) {
        return { data: [] };
    }

    await ensureDocumentParsed(document);
    const module = workspaceIndex.getModule(document.uri);

    if (!module) {
        return { data: [] };
    }

    const cached = semanticTokensCache.get(document.uri);

    if (cached && cached.version === module.version) {
        return cached.value;
    }

    const value = buildRslSemanticTokens(module, workspaceIndex);
    semanticTokensCache.set(document.uri, {
        version: module.version,
        value
    });
    return value;
});

connection.onDocumentSymbol(async ({ textDocument }) => {
    const document = getCurDoc(textDocument.uri);

    if (!document) {
        return [];
    }

    const tree = await ensureDocumentParsed(document);

    if (!tree) {
        return [];
    }

    const module = workspaceIndex.getModule(document.uri);

    if (!module) {
        return [];
    }

    const cached = documentSymbolsCache.get(document.uri);

    if (cached && cached.version === module.version) {
        return cached.value;
    }

    const value = getSymbols(document, tree).filter(
        (symbol): symbol is SymbolInformation => symbol !== undefined
    );
    documentSymbolsCache.set(document.uri, {
        version: module.version,
        value
    });
    return value;
});

connection.onFoldingRanges(({ textDocument }) => {
    const document = getCurDoc(textDocument.uri);

    if (!document) {
        return [];
    }

    const cached = foldingRangesCache.get(document.uri);

    if (cached && cached.version === document.version) {
        return cached.value;
    }

    const module = workspaceIndex.getModule(document.uri);
    const lex = module && module.version === document.version
        ? module.lex
        : undefined;
    const value = GetFoldingRanges(document.getText(), lex);
    foldingRangesCache.set(document.uri, {
        version: document.version,
        value
    });
    return value;
});

connection.onDocumentFormatting(params => {
    const document = documents.get(params.textDocument.uri);

    if (!document) {
        return [];
    }

    try {
        const source = document.getText();
        const formatted = formattingFunction(source, params.options);

        if (formatted === source) {
            return [];
        }

        return [
            TextEdit.replace(fullDocumentRange(document), formatted)
        ];
    } catch (error) {
        logMessage(
            `Formatting failed: ${document.uri}\n` +
            errorToString(error)
        );
        return [];
    }
});

function formattingFunction(
    text: string,
    options: FormattingOptions
): string {
    return FormatCode(text, options.tabSize);
}

function fullDocumentRange(document: TextDocument): Range {
    return {
        start: { line: 0, character: 0 },
        end: document.positionAt(document.getText().length)
    };
}

function deduplicateCompletionItems(
    ...groups: CompletionItem[][]
): CompletionItem[] {
    const result: CompletionItem[] = [];
    const seen = new Set<string>();

    for (const items of groups) {
        for (const item of items) {
            const key = String(item.label).toLowerCase();

            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            result.push(item);
        }
    }

    return result;
}

documents.listen(connection);
connection.listen();

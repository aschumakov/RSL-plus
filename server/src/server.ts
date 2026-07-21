import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import {
    CodeActionKind,
    CompletionItem,
    Definition,
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
const pendingImportNames = new Set<string>();
const requestedImportNames = new Set<string>();
const workspaceFileUris = new Set<string>();
const PARSE_DEBOUNCE_MS = 200;

let globalSettings: IRslSettings = defaultSettings;
let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let workFolderOpened = false;
let clientReady = false;

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
            loadExternalModule(indexedUri).catch(error => {
                requestedImportNames.delete(normalizedName);
                logMessage(
                    `Pending import load failed: ${indexedUri}\n` +
                    errorToString(error)
                );
            });
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
    notifyClient("updateStatusBar", workspaceIndex.size);
});

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
        loadExternalModule(indexedUri).catch(error => {
            requestedImportNames.delete(normalizedName);
            logMessage(
                `Indexed import load failed: ${indexedUri}\n` +
                errorToString(error)
            );
        });
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

    documents.all().forEach(document => {
        parsedVersions.delete(document.uri);
        scheduleValidation(document);
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
    workspaceIndex.markClosed(uri);
    connection.sendDiagnostics({
        uri,
        diagnostics: []
    });
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

function scheduleValidation(document: TextDocument): void {
    const uri = document.uri;
    const version = document.version;
    const generation = (parseGeneration.get(uri) || 0) + 1;
    parseGeneration.set(uri, generation);
    cancelScheduledValidation(uri);

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

    const settings = await getDocumentSettings(uri);

    if (parseGeneration.get(uri) !== generation) {
        return;
    }

    globalSettings = settings || defaultSettings;
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

    if (globalSettings.import === "ДА") {
        indexed.imports.forEach(GetFileByNameRequest);
    }

    connection.sendDiagnostics({
        uri,
        diagnostics: buildRslDiagnostics(
            indexed,
            workspaceIndex,
            globalSettings.diagnostics
        )
    });
    notifyClient("updateStatusBar", workspaceIndex.size);

    if (!wasKnown) {
        refreshOpenDependents(uri);
    }

    logMessage(
        `Parsed: ${uri}; version=${version}; ` +
        `ms=${Date.now() - started}; ` +
        `symbols=${parsedObject.getChilds().length}`
    );
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
        dependents.forEach(refreshOpenDocument);
        notifyClient("updateStatusBar", workspaceIndex.size);
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

    dependents.forEach(refreshOpenDocument);
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
        const tree = new CBase(text, 0);
        const module = workspaceIndex.updateModule(
            uri,
            text,
            tree,
            Math.floor(stat.mtimeMs),
            false
        );

        module.imports.forEach(GetFileByNameRequest);
        refreshOpenDependents(uri);
        notifyClient("updateStatusBar", workspaceIndex.size);
    } catch (error) {
        logMessage(
            `External module load failed: ${uri}\n` +
            errorToString(error)
        );
    }
}

function refreshOpenDependents(uri: string): void {
    workspaceIndex.getDependents(uri).forEach(refreshOpenDocument);
}

function refreshOpenDocument(uri: string): void {
    const document = documents.get(uri);

    if (!document) {
        return;
    }

    parsedVersions.delete(uri);
    scheduleValidation(document);
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

    return deduplicateCompletionItems([
        ...scopeResolver.getCompletions(
            document.uri,
            context.tree,
            context.offset
        ),
        ...getCIInfoForArray(getDefaults())
    ]);
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

    return module
        ? buildRslSemanticTokens(module, workspaceIndex)
        : { data: [] };
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

    return getSymbols(document, tree).filter(
        (symbol): symbol is SymbolInformation => symbol !== undefined
    );
});

connection.onFoldingRanges(({ textDocument }) => {
    const document = getCurDoc(textDocument.uri);
    return document ? GetFoldingRanges(document.getText()) : [];
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
    items: CompletionItem[]
): CompletionItem[] {
    const result: CompletionItem[] = [];
    const seen = new Set<string>();

    for (const item of items) {
        const key = String(item.label).toLowerCase();

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(item);
    }

    return result;
}

documents.listen(connection);
connection.listen();

import * as fs from 'fs';
import * as path from 'path';

import {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    CompletionItem,
    TextDocumentPositionParams,
    Hover,
    Definition,
    Diagnostic,
    DiagnosticSeverity,
    TextEdit,
    TextDocumentSyncKind,
    FormattingOptions,
    Range,
    SymbolInformation
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { IFAStruct, IRslSettings, IToken } from './interfaces';
import { getDefaults, getCIInfoForArray } from './defaults';
import { CBase } from './common';
import { getSymbols } from './docsymbols';
import { FormatCode } from './format';
import { GetFoldingRanges } from './folding';
import { RslDefinitionProvider } from './definitionProvider';

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> =
    new TextDocuments(TextDocument);

const logFilePath = path.resolve(__dirname, '..', 'rsl-server.log');

function logMessage(message: string): void {
    const line =
        `[${new Date().toISOString()}] ` +
        `PID=${process.pid} ` +
        `${message}\r\n`;

    try {
        fs.appendFileSync(logFilePath, line, {
            encoding: 'utf8'
        });
    } catch (_error) {
        // Ошибка журналирования не должна останавливать language server.
    }
}

function errorToString(error: any): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}\n${error.stack || ''}`;
    }

    return String(error);
}

logMessage(`Language server started. Node=${process.version}`);

process.on('unhandledRejection', (reason: any) => {
    logMessage(
        `UNHANDLED REJECTION\n${errorToString(reason)}`
    );
});

process.on('uncaughtException', (error: Error) => {
    logMessage(
        `UNCAUGHT EXCEPTION\n${errorToString(error)}`
    );

    process.exit(1);
});

process.on('exit', (code: number) => {
    logMessage(`Language server exited. Code=${code}`);
});

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;
let workFolderOpened = false;

const defaultSettings: IRslSettings = { import: 'ДА' };
let globalSettings: IRslSettings = defaultSettings;
const documentSettings: Map<string, Promise<IRslSettings>> =
    new Map<string, Promise<IRslSettings>>();
let Imports: IFAStruct[] = [];

let clientReady = false;
const pendingImportNames: Set<string> = new Set<string>();
const requestedImportNames: Set<string> = new Set<string>();
const parseGeneration: Map<string, number> =
    new Map<string, number>();

const parsedVersions: Map<string, number> =
    new Map<string, number>();

const parseTimers: Map<string, NodeJS.Timeout> =
    new Map<string, NodeJS.Timeout>();

const PARSE_DEBOUNCE_MS = 200;

interface IPositionContext {
    document: TextDocument;
    tree: CBase;
    offset: number;
    token?: IToken;
}

interface IFoundObject extends IFAStruct {
    token: IToken;
}

function normalizeName(value: string): string {
    return (value || '').toLowerCase();
}

function namesEqual(
    left: string,
    right: string
): boolean {
    return normalizeName(left) === normalizeName(right);
}

function isBlockedToken(token?: IToken): boolean {
    return !!(
        token &&
        (
            token.kind === 'string' ||
            token.kind === 'square' ||
            token.kind === 'comment'
        )
    );
}

function sendClientNotification(
    method: string,
    params?: unknown
): void {
    connection.sendNotification(method, params).then(
        undefined,
        error => {
            logMessage(
                `Client notification failed: ${method}\n` +
                errorToString(error)
            );
        }
    );
}

function notifyClient(method: string, params?: unknown): void {
    if (!clientReady) {
        return;
    }

    sendClientNotification(method, params);
}

function flushPendingImports(): void {
    if (!clientReady) {
        return;
    }

    pendingImportNames.forEach(name => {
        if (requestedImportNames.has(name)) {
            return;
        }

        requestedImportNames.add(name);
        notifyClient('getFilebyName', name);
    });

    pendingImportNames.clear();
}

connection.onNotification('clientReady', () => {
    clientReady = true;
    logMessage('Client handlers are ready.');
    flushPendingImports();
    notifyClient('updateStatusBar', Imports.length);
});

export function GetFileByNameRequest(nameInter: string): void {
    if (
        !workFolderOpened ||
        globalSettings.import !== 'ДА' ||
        !nameInter
    ) {
        return;
    }

    pendingImportNames.add(nameInter);
    flushPendingImports();
}

export function GetFileRequest(filePath: string): void {
    if (!filePath) {
        return;
    }

    notifyClient('getFile', filePath);
}

export function getTree(): IFAStruct[] {
    return Imports;
}

function getCurDoc(uri: string): TextDocument | undefined {
    /*
     * Получение документа не должно иметь побочного эффекта.
     * Раньше каждый hover/completion/Outline отправлял клиенту
     * запрос на повторное открытие файла и мог вызвать каскад didOpen.
     */
    return documents.get(uri);
}

function getCurObj(uri: string): CBase | undefined {
    const currentImport = Imports.find(m => m.uri === uri);
    return currentImport ? currentImport.object : undefined;
}

function getPositionContext(
    tdpp: TextDocumentPositionParams
): IPositionContext | undefined {
    const document = getCurDoc(
        tdpp.textDocument.uri
    );

    const tree = getCurObj(
        tdpp.textDocument.uri
    );

    if (!document || !tree) {
        return undefined;
    }

    const offset =
        document.offsetAt(tdpp.position);

    return {
        document,
        tree,
        offset,
        token: tree.getCurrentToken(offset)
    };
}

function FindObject(
    tdpp: TextDocumentPositionParams,
    existingContext?: IPositionContext
): IFoundObject | undefined {
    const context =
        existingContext ||
        getPositionContext(tdpp);

    if (
        !context ||
        !context.token ||
        isBlockedToken(context.token)
    ) {
        return undefined;
    }

    let uri = tdpp.textDocument.uri;
    let cBaseObject: CBase | undefined;

    const token = context.token;
    const normalizedToken =
        normalizeName(token.str);

    const objArr =
        context.tree.getActualChilds(
            context.offset
        );

    const objects: CBase[] = [];

    for (const element of objArr) {
        if (element.isObject()) {
            element.getChilds().forEach(child => {
                if (
                    namesEqual(
                        child.Name,
                        normalizedToken
                    )
                ) {
                    objects.push(child);
                }
            });
        }

        if (
            namesEqual(
                element.Name,
                normalizedToken
            )
        ) {
            objects.push(element);
        }
    }

    if (objects.length > 1) {
        let minDistance =
            token.range.start;

        for (const iterator of objects) {
            const currentDistance =
                token.range.start -
                iterator.Range.end;

            if (
                currentDistance >= 0 &&
                currentDistance < minDistance
            ) {
                cBaseObject = iterator;
                minDistance = currentDistance;
            }
        }

        /*
         * Если все найденные объявления находятся правее
         * курсора, сохраняем первый best-effort результат.
         */
        if (!cBaseObject) {
            cBaseObject = objects[0];
        }
    } else if (objects.length === 1) {
        cBaseObject = objects[0];
    }

    if (!cBaseObject) {
        for (const iterator of Imports) {
            if (
                iterator.uri ===
                tdpp.textDocument.uri
            ) {
                continue;
            }

            const actualChildren =
                iterator.object.getActualChilds(0);

            for (const element of actualChildren) {
                if (
                    namesEqual(
                        element.Name,
                        normalizedToken
                    )
                ) {
                    cBaseObject = element;
                    uri = iterator.uri;
                    break;
                }
            }

            if (cBaseObject) {
                break;
            }
        }
    }

    if (!cBaseObject) {
        return undefined;
    }

    return {
        object: cBaseObject,
        uri,
        token
    };
}

const definitionProvider = new RslDefinitionProvider({
    getOpenDocument: getCurDoc,
    ensureDocumentParsed,
    getLoadedModules: () => Imports,
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

    hasDiagnosticRelatedInformationCapability = !!(
        capabilities.textDocument &&
        capabilities.textDocument.publishDiagnostics &&
        capabilities.textDocument.publishDiagnostics.relatedInformation
    );

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: {
                resolveProvider: true,
                triggerCharacters: ['.']
            },
            hoverProvider: true,
            definitionProvider: true,
            documentSymbolProvider: true,
            documentFormattingProvider: true,
            foldingRangeProvider: true
        }
    };
});

connection.onInitialized(async () => {

    if (!workFolderOpened) {
        sendClientNotification('noRootFolder');
    }

    if (hasConfigurationCapability) {
        await connection.client.register(
            DidChangeConfigurationNotification.type,
            undefined
        );
    }

    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(_event => {
            connection.console.log(
                'Workspace folder change event received.'
            );
        });
    }

    connection.onRequest('getMacros', () => {
        return Imports.map(element => element.uri);
    });
});

connection.onDidChangeConfiguration(change => {
    if (hasConfigurationCapability) {
        documentSettings.clear();
    } else {
        globalSettings = <IRslSettings>(
            (change.settings.RSLanguageServer || defaultSettings)
        );
    }

    documents.all().forEach(scheduleValidation);
});

function getDocumentSettings(resource: string): Promise<IRslSettings> {
    if (!hasConfigurationCapability) {
        return Promise.resolve(globalSettings);
    }

    let result = documentSettings.get(resource);

    if (!result) {
        result = connection.workspace.getConfiguration({
            scopeUri: resource,
            section: 'RSLanguageServer'
        });
        documentSettings.set(resource, result);
    }

    return result;
}

documents.onDidClose(event => {
    const uri = event.document.uri;

    documentSettings.delete(uri);
    parsedVersions.delete(uri);
    cancelScheduledValidation(uri);
});

documents.onDidChangeContent(change => {
    connection.console.log(
        `Парсинг файла: ${change.document.uri.toString()}`
    );
    scheduleValidation(change.document);
});

function cancelScheduledValidation(
    uri: string
): void {
    const timer = parseTimers.get(uri);

    if (timer) {
        clearTimeout(timer);
        parseTimers.delete(uri);
    }
}

function scheduleValidation(
    textDocument: TextDocument
): void {
    const uri = textDocument.uri;
    const expectedVersion =
        textDocument.version;

    const generation =
        (parseGeneration.get(uri) || 0) + 1;

    parseGeneration.set(uri, generation);
    cancelScheduledValidation(uri);

    const timer = setTimeout(() => {
        parseTimers.delete(uri);

        const currentDocument =
            documents.get(uri);

        if (
            !currentDocument ||
            currentDocument.version !==
                expectedVersion
        ) {
            return;
        }

        validateTextDocument(
            currentDocument,
            generation
        ).then(undefined, error => {
            logMessage(
                `Validation failed: ${uri}\n` +
                errorToString(error)
            );
        });
    }, PARSE_DEBOUNCE_MS);

    parseTimers.set(uri, timer);
}

async function validateTextDocument(
    textDocument: TextDocument,
    generation: number
): Promise<void> {
    const uri = textDocument.uri;
    const version = textDocument.version;

    if (
        parsedVersions.get(uri) === version &&
        getCurObj(uri)
    ) {
        return;
    }

    try {
        const settings =
            await getDocumentSettings(uri);

        if (
            parseGeneration.get(uri) !==
            generation
        ) {
            return;
        }

        globalSettings =
            settings || defaultSettings;

        const text =
            textDocument.getText();

        const parseStartedAt = Date.now();
        const parsedObject =
            new CBase(text, 0);

        if (
            parseGeneration.get(uri) !==
            generation
        ) {
            return;
        }

        const module =
            Imports.find(m => m.uri === uri);

        if (module) {
            module.object = parsedObject;
        } else {
            Imports.push({
                uri,
                object: parsedObject
            });
        }

        parsedVersions.set(
            uri,
            version
        );

        notifyClient(
            'updateStatusBar',
            Imports.length
        );

        const pattern =
            /\b(record|array)\b/gi;

        let match: RegExpExecArray | null;

        const diagnostics: Diagnostic[] = [];

        while (
            (match = pattern.exec(text)) !== null
        ) {
            diagnostics.push({
                severity:
                    DiagnosticSeverity.Information,
                range: {
                    start:
                        textDocument.positionAt(
                            match.index
                        ),
                    end:
                        textDocument.positionAt(
                            match.index +
                            match[0].length
                        )
                },
                message:
                    `Определение ${match[0].toUpperCase()} устарело, ` +
                    'от такого надо избавляться по возможности',
                source: 'RSL parser'
            });
        }

        connection.sendDiagnostics({
            uri,
            diagnostics
        });

        logMessage(
            `Parsed successfully: ${uri}; ` +
            `version=${version}; ` +
            `ms=${Date.now() - parseStartedAt}; ` +
            `symbols=${parsedObject.getChilds().length}`
        );
    } catch (error) {
        const errorText =
            errorToString(error);

        logMessage(
            `Parse failed: ${uri}\n${errorText}`
        );

        connection.console.error(
            `Ошибка разбора ${uri}: ${errorText}`
        );
    }
}

async function ensureDocumentParsed(
    textDocument: TextDocument
): Promise<CBase | undefined> {
    const uri = textDocument.uri;

    if (
        parsedVersions.get(uri) ===
            textDocument.version
    ) {
        return getCurObj(uri);
    }

    /*
     * Outline запросил актуальное дерево раньше debounce.
     * Отменяем таймер и выполняем ровно один немедленный разбор.
     */
    cancelScheduledValidation(uri);

    const generation =
        (parseGeneration.get(uri) || 0) + 1;

    parseGeneration.set(uri, generation);

    await validateTextDocument(
        textDocument,
        generation
    );

    return getCurObj(uri);
}

connection.onDidChangeWatchedFiles(_change => {
    definitionProvider.clearCaches();
    connection.console.log('We received an file change event');
});

connection.onCompletion(
    (
        tdpp: TextDocumentPositionParams
    ): CompletionItem[] => {
        let completionItems: CompletionItem[] = [];

        const context =
            getPositionContext(tdpp);

        if (
            !context ||
            isBlockedToken(context.token)
        ) {
            return completionItems;
        }

        const obj =
            FindObject(tdpp, context);

        if (obj) {
            if (
                normalizeName(obj.object.Type) !==
                'variant'
            ) {
                let objClass:
                    CBase | undefined;

                for (const iterator of Imports) {
                    const objArr =
                        iterator.object.getActualChilds(
                            iterator.uri ===
                                tdpp.textDocument.uri
                                ? context.offset
                                : 0
                        );

                    for (const objIter of objArr) {
                        if (
                            namesEqual(
                                objIter.Name,
                                obj.object.Type
                            )
                        ) {
                            objClass = objIter;
                            break;
                        }
                    }

                    if (objClass) {
                        break;
                    }
                }

                if (objClass) {
                    completionItems =
                        objClass.ChildsCIInfo(true);
                }
            }
        } else {
            Imports.forEach(element => {
                const actualChildren =
                    element.object.getActualChilds(
                        element.uri ===
                            tdpp.textDocument.uri
                            ? context.offset
                            : 0
                    );

                for (
                    const child of actualChildren
                ) {
                    completionItems.push(
                        child.CIInfo
                    );
                }
            });

            completionItems =
                completionItems.concat(
                    getCIInfoForArray(
                        getDefaults()
                    )
                );
        }

        return completionItems;
    }
);

connection.onCompletionResolve(
    (item: CompletionItem): CompletionItem => item
);

connection.onHover(
    (
        tdpp: TextDocumentPositionParams
    ): Hover | null => {
        const context =
            getPositionContext(tdpp);

        if (
            !context ||
            !context.token ||
            isBlockedToken(context.token)
        ) {
            return null;
        }

        const obj =
            FindObject(tdpp, context);

        if (!obj) {
            return null;
        }

        const completionInfo =
            obj.object.CIInfo;

        const documentation =
            completionInfo.documentation
                ? completionInfo.documentation.toString()
                : '';

        const comment =
            documentation.length > 0
                ? ` \n\r${documentation}`
                : '';

        return {
            contents:
                `${completionInfo.detail || ''}` +
                comment,
            range: {
                start:
                    context.document.positionAt(
                        obj.token.range.start
                    ),
                end:
                    context.document.positionAt(
                        obj.token.range.end
                    )
            }
        };
    }
);

connection.onDefinition(
    async (
        tdpp: TextDocumentPositionParams
    ): Promise<Definition | null> => {
        const document = getCurDoc(
            tdpp.textDocument.uri
        );

        if (!document) {
            return null;
        }

        /*
         * Definition может прийти раньше отложенного разбора после
         * редактирования. Всегда используем актуальное дерево.
         */
        await ensureDocumentParsed(document);

        const context = getPositionContext(tdpp);

        if (!context) {
            return null;
        }

        const dynamicLocation =
            await definitionProvider.findDynamicDefinition(
                context
            );

        if (dynamicLocation) {
            return dynamicLocation;
        }

        if (isBlockedToken(context.token)) {
            return null;
        }

        const obj = FindObject(tdpp, context);

        if (!obj) {
            return null;
        }

        return definitionProvider.createObjectLocationByUri(
            obj.uri,
            obj.object
        );
    }
);

connection.onDocumentSymbol(
    async ({ textDocument }) => {
        const document =
            getCurDoc(textDocument.uri);

        if (!document) {
            return [];
        }

        const tree =
            await ensureDocumentParsed(
                document
            );

        if (!tree) {
            return [];
        }

        return getSymbols(
            document,
            tree
        ).filter(
            (
                symbol
            ): symbol is SymbolInformation =>
                symbol !== undefined
        );
    }
);

connection.onFoldingRanges(({ textDocument }) => {
    const document = getCurDoc(textDocument.uri);

    if (!document) {
        return [];
    }

    return GetFoldingRanges(document.getText());
});

connection.onDocumentFormatting(formatParams => {
    const uri = formatParams.textDocument.uri;
    const document = documents.get(uri);

    if (!document) {
        logMessage(`Formatting skipped: document not found: ${uri}`);
        return [];
    }

    try {
        logMessage(`Formatting started: ${uri}`);

        const text = document.getText();
        const formattedText = formattingFunction(
            text,
            formatParams.options
        );

        logMessage(`Formatting completed: ${uri}`);

        return [
            TextEdit.replace(
                fullDocumentRange(document),
                formattedText
            )
        ];
    } catch (error) {
        const errorText = errorToString(error);

        logMessage(
            `Formatting failed: ${uri}\n${errorText}`
        );

        connection.console.error(
            `Ошибка форматирования ${uri}: ${errorText}`
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
        start: {
            line: 0,
            character: 0
        },
        end: {
            line: document.lineCount,
            character: 0
        }
    };
}

documents.listen(connection);
connection.listen();

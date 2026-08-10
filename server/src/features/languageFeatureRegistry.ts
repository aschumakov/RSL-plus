import {
    CancellationToken,
    CodeActionKind,
    CodeActionParams,
    CodeActionTriggerKind,
    CompletionItem,
    Definition,
    DocumentHighlightParams,
    ExecuteCommandParams,
    Hover,
    Range,
    ReferenceParams,
    SelectionRangeParams,
    TextDocumentPositionParams,
    type Connection,
    type TextDocuments
} from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

import { RslSymbol } from "../symbols/rslSymbol";
import { RslDefinitionProvider } from "./definitionProvider";
import { getDefaults } from "../defaults";
import { buildEnhancedRslCodeActions } from "./enhancedCodeActions";
import { buildRslDocumentHighlights } from "./documentHighlights";
import { buildRslHoverContent } from "./hoverFormatter";
import {
    buildBlockNavigationActions,
    buildSelectionRanges,
    GO_TO_BLOCK_END_COMMAND,
    GO_TO_BLOCK_START_COMMAND,
    resolveCurrentBlockRange,
    resolveBlockNavigationPosition
} from "./blockNavigation";
import type { IRslSettings } from "../interfaces";
import { tokenAtOffset, type IRslToken } from "../lexer";
import {
    describeFormatSpecifier,
    getFormatSpecifierAt
} from "../parsing/outputFormParser";
import { findRslReferencesInWorkspace } from "../analysis/references";
import { ReferenceIndex } from "../analysis/referenceIndex";
import type { IFastDocumentSnapshot } from "../services/fastDocumentSnapshot";
import {
    RSL_BUILTIN_URI,
    RslScopeResolver
} from "../scopeResolver";
import type { WorkspaceIndex } from "../workspaceIndex";
import type { PerformanceLogger } from "../performanceLogger";
import {
    buildKnownAutoImportCompletions,
    buildMissingImportActions
} from "./autoImportProvider";
import {
    RslCallHierarchyProvider
} from "./callHierarchyProvider";
import { buildRslSignatureHelp } from "./signatureHelpProvider";
import { buildRslContextCompletions } from "./contextCompletionProvider";
import {
    completionPrefixAt,
    rankCompletionItemsForPrefix
} from "./completionRanking";
import { findRslWorkspaceSymbols } from "./workspaceSymbolProvider";
import {
    buildRslSourceCodeActions,
    RSL_FIX_ALL_KIND
} from "./sourceCodeActions";
import { CompletionTransport } from "./completionTransport";
import { PresentationFeatureRegistry } from "./presentationFeatureRegistry";
import { SemanticTokensFeatureRegistry } from "./semanticTokensFeatureRegistry";
import { buildRslRenameEdit, prepareRslRename } from "./renameProvider";

interface IRslCurrentBlockRangeParams {
    textDocument: { uri: string };
    position: { line: number; character: number };
    currentRange?: Range;
}

export interface IRslLanguageFeatureEnvironment {
    connection: Connection;
    documents: TextDocuments<TextDocument>;
    index: WorkspaceIndex;
    resolver: RslScopeResolver;
    definitionProvider: RslDefinitionProvider;
    referenceIndex?: ReferenceIndex;
    getFastDocumentSnapshot(document: TextDocument): IFastDocumentSnapshot;
    ensureDocumentParsed(document: TextDocument): Promise<RslSymbol | undefined>;
    ensureImportedSymbol?(
        fromUri: string,
        symbolName: string
    ): Promise<boolean>;
    findAutoImportModules?(
        symbolName: string,
        options: {
            scanWorkspace: boolean;
            isCancelled(): boolean;
        }
    ): Promise<import("../workspaceIndex").IIndexedModule[]>;
    getSettings(uri: string): IRslSettings;
    noteInteractiveActivity?(): void;
    log(message: string): void;
    performance?: PerformanceLogger;
}

interface IPositionContext {
    document: TextDocument;
    tree: RslSymbol;
    offset: number;
    token?: IRslToken;
    tokens: IRslToken[];
}

/** Регистрирует LSP provider-ы и владеет их versioned-кэшами. */
export class RslLanguageFeatureRegistry {
    private defaultCompletionItems = getDefaults().completionItems;
    private registered = false;
    private referenceIndex: ReferenceIndex;
    private callHierarchyProvider: RslCallHierarchyProvider;
    private completionTransport = new CompletionTransport();
    private presentationFeatures: PresentationFeatureRegistry;
    private semanticTokensFeatures: SemanticTokensFeatureRegistry;

    constructor(private environment: IRslLanguageFeatureEnvironment) {
        this.referenceIndex = environment.referenceIndex || new ReferenceIndex();
        this.callHierarchyProvider = new RslCallHierarchyProvider({
            index: environment.index,
            resolver: environment.resolver,
            referenceIndex: this.referenceIndex
        });
        this.presentationFeatures = new PresentationFeatureRegistry(environment);
        this.semanticTokensFeatures = new SemanticTokensFeatureRegistry(environment);
    }

    register(): void {
        if (this.registered) {
            return;
        }

        this.registered = true;
        this.presentationFeatures.register();
        this.semanticTokensFeatures.register();
        const {
            connection,
            documents,
            index,
            resolver,
            definitionProvider,
            ensureDocumentParsed
        } = this.environment;

        connection.onCompletion(async (
            params: TextDocumentPositionParams,
            cancellationToken: CancellationToken
        ) => {
            const document = documents.get(params.textDocument.uri);

            if (!document) {
                return { isIncomplete: false, items: [] };
            }

            this.environment.noteInteractiveActivity?.();
            const version = document.version;
            await waitForParseBudget(
                ensureDocumentParsed(document),
                INTERACTIVE_PARSE_BUDGET_MS
            );
            if (requestIsStale(document, version, cancellationToken)) {
                return { isIncomplete: false, items: [] };
            }
            const module = index.getModule(document.uri);
            if (!module) {
                return { isIncomplete: false, items: [] };
            }
            const contextual = buildRslContextCompletions(
                module,
                index,
                document.offsetAt(params.position)
            );
            if (contextual !== undefined) {
                return this.completionTransport.prepare(contextual);
            }
            const context = this.getPositionContext(params);

            if (!context || isBlockedToken(context.token)) {
                return { isIncomplete: false, items: [] };
            }

            const prefix = completionPrefixAt(
                module.source,
                context.offset
            );
            const items = deduplicateCompletionItems(
                resolver.getCompletions(
                    document.uri,
                    context.tree,
                    context.offset
                ),
                this.defaultCompletionItems,
                this.environment.getSettings(document.uri).autoImport.enabled
                    ? buildKnownAutoImportCompletions(
                        index.getModule(document.uri)!,
                        index,
                        prefix
                    )
                    : []
            );
            return this.completionTransport.prepare(
                rankCompletionItemsForPrefix(items, prefix)
            );
        });

        connection.onCompletionResolve(item =>
            this.completionTransport.resolve(item)
        );

        connection.onSignatureHelp(async (params, cancellationToken) => {
            const document = documents.get(params.textDocument.uri);
            if (!document) {
                return null;
            }

            this.environment.noteInteractiveActivity?.();
            const version = document.version;
            await waitForParseBudget(
                ensureDocumentParsed(document),
                INTERACTIVE_PARSE_BUDGET_MS
            );
            if (requestIsStale(document, version, cancellationToken)) {
                return null;
            }
            const module = index.getModule(document.uri);
            return module
                ? buildRslSignatureHelp(
                    module,
                    resolver,
                    document.offsetAt(params.position)
                )
                : null;
        });

        connection.onHover(async (
            params: TextDocumentPositionParams,
            cancellationToken: CancellationToken
        ): Promise<Hover | null> => {
            const document = documents.get(params.textDocument.uri);

            if (!document) {
                return null;
            }

            this.environment.noteInteractiveActivity?.();
            const version = document.version;
            await waitForParseBudget(
                ensureDocumentParsed(document),
                INTERACTIVE_PARSE_BUDGET_MS
            );
            if (requestIsStale(document, version, cancellationToken)) {
                return null;
            }
            const context = this.getPositionContext(params);

            if (!context || isBlockedToken(context.token)) {
                return null;
            }

            const formatSpecifier = getFormatSpecifierAt(
                context.tokens,
                context.offset
            );
            if (formatSpecifier) {
                return {
                    contents: {
                        kind: "markdown",
                        value:
                            `**Спецификатор форматирования :${formatSpecifier.raw}**  \n` +
                            describeFormatSpecifier(formatSpecifier.raw)
                    },
                    range: {
                        start: document.positionAt(formatSpecifier.start),
                        end: document.positionAt(formatSpecifier.end)
                    }
                };
            }

            const resolved = resolver.resolveAt(
                document.uri,
                context.tree,
                context.offset
            );

            if (!resolved) {
                return null;
            }

            return {
                contents: buildRslHoverContent(
                    index,
                    resolved.uri,
                    resolved.symbol
                ),
                range: {
                    start: document.positionAt(resolved.token.start),
                    end: document.positionAt(resolved.token.end)
                }
            };
        });

        connection.onDocumentHighlight(async (
            params: DocumentHighlightParams,
            cancellationToken: CancellationToken
        ) => {
            const document = documents.get(params.textDocument.uri);
            if (!document) {
                return [];
            }

            this.environment.noteInteractiveActivity?.();
            const version = document.version;
            await ensureDocumentParsed(document);
            if (requestIsStale(document, version, cancellationToken)) {
                return [];
            }
            const context = this.getPositionContext(params);
            const module = index.getModule(document.uri);
            if (!context || !module || isBlockedToken(context.token)) {
                return [];
            }

            return buildRslDocumentHighlights(
                module,
                index,
                resolver,
                context.offset
            );
        });

        connection.onDefinition(async (
            params: TextDocumentPositionParams,
            cancellationToken: CancellationToken
        ): Promise<Definition | null> => {
            const document = documents.get(params.textDocument.uri);

            if (!document) {
                return null;
            }

            const performance = this.environment.performance;
            const span = performance?.enabled
                ? performance.start("definition.resolve", {
                    uri: document.uri,
                    version: document.version
                })
                : undefined;
            let outcome = "none";
            let loadedOnDemand = false;

            try {
                this.environment.noteInteractiveActivity?.();
                const version = document.version;
                await ensureDocumentParsed(document);
                if (requestIsStale(document, version, cancellationToken)) {
                    outcome = "cancelled";
                    return null;
                }
                const context = this.getPositionContext(params);

                if (!context || !context.token) {
                    return null;
                }

                if (
                    context.token.kind === "comment" ||
                    context.token.kind === "square"
                ) {
                    return null;
                }

                const importedFile = await definitionProvider
                    .findImportDefinition(context);

                if (importedFile) {
                    outcome = "import";
                    return importedFile;
                }

                if (context.token.kind === "string") {
                    const dynamic = await definitionProvider
                        .findDynamicDefinition(context);

                    if (dynamic) {
                        outcome = "dynamic";
                        return dynamic;
                    }
                }

                if (isBlockedToken(context.token)) {
                    return null;
                }

                let resolved = resolver.resolveAt(
                    document.uri,
                    context.tree,
                    context.offset
                );
                const identifierToken = tokenAtOffset(
                    context.tokens,
                    context.offset,
                    true
                );

                if (
                    !resolved &&
                    identifierToken?.kind === "identifier" &&
                    this.environment.ensureImportedSymbol
                ) {
                    loadedOnDemand =
                        await this.environment.ensureImportedSymbol(
                            document.uri,
                            identifierToken.value
                        );
                    resolved = resolver.resolveAt(
                        document.uri,
                        context.tree,
                        context.offset
                    );
                }

                if (!resolved) {
                    return null;
                }

                if (resolved.uri === RSL_BUILTIN_URI) {
                    outcome = "builtin";
                    return null;
                }

                outcome = resolved.uri === document.uri
                    ? "local"
                    : "imported";
                return definitionProvider.createObjectLocationByUri(
                    resolved.uri,
                    resolved.symbol
                );
            } finally {
                if (span) {
                    performance.end(span, {
                        outcome,
                        loadedOnDemand
                    });
                }
            }
        });

        connection.onReferences(async (
            params: ReferenceParams,
            cancellationToken: CancellationToken
        ) => {
            const document = documents.get(params.textDocument.uri);

            if (!document) {
                return [];
            }

            this.environment.noteInteractiveActivity?.();
            const version = document.version;
            await ensureDocumentParsed(document);
            if (requestIsStale(document, version, cancellationToken)) {
                return [];
            }
            const context = this.getPositionContext(params);

            if (!context || isBlockedToken(context.token)) {
                return [];
            }

            /* ReferenceIndex отбирает файлы до точного transient parse. */
            return findRslReferencesInWorkspace(
                index,
                resolver,
                this.referenceIndex,
                document.uri,
                context.offset,
                params.context.includeDeclaration,
                () => cancellationToken.isCancellationRequested
            );
        });

        connection.onPrepareRename?.(async (params, cancellationToken) => {
            const document = documents.get(params.textDocument.uri);
            if (!document) return null;
            this.environment.noteInteractiveActivity?.();
            const version = document.version;
            await ensureDocumentParsed(document);
            if (requestIsStale(document, version, cancellationToken)) {
                return null;
            }
            const module = index.getModule(document.uri);
            return module
                ? prepareRslRename(
                    module,
                    resolver,
                    document.offsetAt(params.position)
                )
                : null;
        });

        connection.onRenameRequest?.(async (params, cancellationToken) => {
            const document = documents.get(params.textDocument.uri);
            if (!document) return null;
            this.environment.noteInteractiveActivity?.();
            const version = document.version;
            await ensureDocumentParsed(document);
            if (requestIsStale(document, version, cancellationToken)) {
                return null;
            }
            const module = index.getModule(document.uri);
            return module
                ? buildRslRenameEdit(
                    module,
                    index,
                    resolver,
                    this.referenceIndex,
                    document.offsetAt(params.position),
                    params.newName,
                    () => cancellationToken.isCancellationRequested
                )
                : null;
        });

        connection.onCodeAction(async (
            params: CodeActionParams,
            cancellationToken: CancellationToken
        ) => {
            const module = index.getModule(params.textDocument.uri);
            if (!module) {
                return [];
            }

            this.environment.noteInteractiveActivity?.();
            const sourceActions = buildRslSourceCodeActions(module, params);
            if (isSourceActionRequest(params)) {
                return sourceActions;
            }
            const navigation = supportsRefactorActions(params)
                ? buildBlockNavigationActions(module, params.range)
                : [];
            const settings = this.environment.getSettings(module.uri);
            const scanWorkspace =
                params.context.triggerKind === CodeActionTriggerKind.Invoked;
            const autoImports =
                settings.autoImport.enabled &&
                this.environment.findAutoImportModules
                ? await buildMissingImportActions(
                    module,
                    index,
                    resolver,
                    params.range,
                    name => this.environment.findAutoImportModules!(name, {
                        scanWorkspace,
                        isCancelled: () =>
                            cancellationToken.isCancellationRequested
                    })
                )
                : [];
            if (cancellationToken.isCancellationRequested) {
                return [];
            }
            return [
                ...buildEnhancedRslCodeActions(module, params),
                ...navigation,
                ...autoImports,
                ...sourceActions
            ];
        });

        connection.onWorkspaceSymbol((params, cancellationToken) => {
            this.environment.noteInteractiveActivity?.();
            if (cancellationToken.isCancellationRequested) {
                return [];
            }
            return findRslWorkspaceSymbols(index, params.query);
        });

        connection.languages.callHierarchy.onPrepare(async (
            params,
            cancellationToken
        ) => {
            const document = documents.get(params.textDocument.uri);
            if (!document) {
                return [];
            }

            this.environment.noteInteractiveActivity?.();
            const version = document.version;
            await ensureDocumentParsed(document);
            if (requestIsStale(document, version, cancellationToken)) {
                return [];
            }
            return this.callHierarchyProvider.prepare(
                document.uri,
                document.offsetAt(params.position)
            );
        });

        connection.languages.callHierarchy.onIncomingCalls((
            params,
            cancellationToken
        ) => this.callHierarchyProvider.incoming(
            params.item,
            () => cancellationToken.isCancellationRequested
        ));

        connection.languages.callHierarchy.onOutgoingCalls((
            params,
            cancellationToken
        ) => this.callHierarchyProvider.outgoing(
            params.item,
            () => cancellationToken.isCancellationRequested
        ));

        connection.onSelectionRanges(async (params: SelectionRangeParams) => {
            const document = documents.get(params.textDocument.uri);
            if (!document) {
                return [];
            }

            await ensureDocumentParsed(document);
            const module = index.getModule(document.uri);
            return module
                ? buildSelectionRanges(module, params.positions)
                : [];
        });

        connection.onRequest(
            "rsl/currentBlockRange",
            async (params: IRslCurrentBlockRangeParams) => {
                const document = documents.get(params.textDocument.uri);
                if (!document) {
                    return null;
                }

                this.environment.noteInteractiveActivity?.();
                await ensureDocumentParsed(document);
                const module = index.getModule(document.uri);
                return module
                    ? resolveCurrentBlockRange(
                        module,
                        params.position,
                        params.currentRange
                    ) || null
                    : null;
            }
        );

        connection.onExecuteCommand(async (params: ExecuteCommandParams) => {
            const direction = params.command === GO_TO_BLOCK_START_COMMAND
                ? "start"
                : params.command === GO_TO_BLOCK_END_COMMAND
                    ? "end"
                    : undefined;
            if (!direction) {
                return null;
            }

            const args = Array.isArray(params.arguments) ? params.arguments : [];
            const uri = typeof args[0] === "string" ? args[0] : "";
            const line = typeof args[1] === "number" ? args[1] : 0;
            const character = typeof args[2] === "number" ? args[2] : 0;
            const document = documents.get(uri);
            if (document) {
                await ensureDocumentParsed(document);
            }
            const module = index.getModule(uri);
            const position = module
                ? resolveBlockNavigationPosition(
                    module,
                    { line, character },
                    direction
                )
                : undefined;
            if (!position) {
                return null;
            }

            await connection.sendRequest("window/showDocument", {
                uri,
                takeFocus: true,
                selection: { start: position, end: position }
            });
            return null;
        });

    }

    invalidate(uri: string): void {
        this.presentationFeatures.invalidate(uri);
        this.semanticTokensFeatures.invalidate(uri);
    }

    forget(uri: string): void {
        this.presentationFeatures.forget(uri);
        this.semanticTokensFeatures.forget(uri);
    }

    private getPositionContext(
        params: TextDocumentPositionParams
    ): IPositionContext | undefined {
        const document = this.environment.documents.get(
            params.textDocument.uri
        );
        const module = this.environment.index.getModule(
            params.textDocument.uri
        );
        const tree = module?.symbolTree;

        if (!document || !module || !tree) {
            return undefined;
        }

        const offset = document.offsetAt(params.position);

        return {
            document,
            tree,
            offset,
            token: tokenAtOffset(module.lex.tokens, offset, true),
            tokens: module.lex.tokens
        };
    }
}


function supportsRefactorActions(params: CodeActionParams): boolean {
    const only = params.context.only;
    return !only || only.length === 0 || only.some(kind =>
        kind === CodeActionKind.Refactor ||
        String(kind).startsWith(CodeActionKind.Refactor + ".")
    );
}

function isSourceActionRequest(params: CodeActionParams): boolean {
    const only = params.context.only;
    return !!only && only.length > 0 && only.every(kind =>
        String(kind) === CodeActionKind.Source ||
        String(kind).startsWith(CodeActionKind.Source + ".") ||
        String(kind) === RSL_FIX_ALL_KIND
    );
}

function isBlockedToken(token?: IRslToken): boolean {
    return !!token && (
        token.kind === "string" ||
        token.kind === "square" ||
        token.kind === "comment"
    );
}

/*
 * Completion/Hover/Signature Help чувствительны к задержке сильнее, чем к
 * свежести AST на несколько сотен мс. Если полный parse не успевает за
 * это время (занятый worker, большой файл), отвечаем по уже
 * проиндексированной модели вместо того, чтобы ждать освобождения —
 * сам parse не отменяется и следующий запрос увидит свежий результат.
 */
const INTERACTIVE_PARSE_BUDGET_MS = 200;

function waitForParseBudget(
    pending: Promise<unknown>,
    budgetMs: number
): Promise<void> {
    return new Promise(resolve => {
        let settled = false;
        const finish = (): void => {
            if (!settled) {
                settled = true;
                resolve();
            }
        };
        pending.then(finish, finish);
        setTimeout(finish, budgetMs);
    });
}

function requestIsStale(
    document: TextDocument,
    version: number,
    cancellationToken?: CancellationToken
): boolean {
    return document.version !== version ||
        cancellationToken?.isCancellationRequested === true;
}

function deduplicateCompletionItems(
    ...groups: readonly (readonly CompletionItem[])[]
): CompletionItem[] {
    const result: CompletionItem[] = [];
    const seen = new Set<string>();

    for (const items of groups) {
        for (const item of items) {
            const autoImportUri = (
                item.data as { rslAutoImportUri?: unknown } | undefined
            )?.rslAutoImportUri;
            const key = autoImportUri
                ? `${String(item.label).toLowerCase()}:${autoImportUri}`
                : String(item.label).toLowerCase();

            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            result.push(item);
        }
    }

    return result;
}

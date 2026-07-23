import {
    CancellationToken,
    CodeActionParams,
    CompletionItem,
    Definition,
    DocumentFormattingParams,
    DocumentSymbolParams,
    FoldingRangeParams,
    FormattingOptions,
    Hover,
    Range,
    ReferenceParams,
    SemanticTokens,
    SemanticTokensDelta,
    SemanticTokensDeltaParams,
    SemanticTokensParams,
    SemanticTokensRangeParams,
    SymbolInformation,
    TextDocumentPositionParams,
    TextEdit,
    type Connection,
    type TextDocuments
} from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

import { CBase } from "../common";
import { RslDefinitionProvider } from "./definitionProvider";
import { getSymbols } from "../docsymbols";
import { getCIInfoForArray, getDefaults } from "../defaults";
import { buildEnhancedRslCodeActions } from "./enhancedCodeActions";
import { GetFoldingRanges, type IRslFoldingRange } from "../folding";
import { FormatCode } from "../format";
import type { IToken } from "../interfaces";
import type { IRslToken } from "../lexer";
import { findRslReferencesInWorkspace } from "../analysis/references";
import { ReferenceIndex } from "../analysis/referenceIndex";
import type { IFastDocumentSnapshot } from "../services/fastDocumentSnapshot";
import { RslScopeResolver } from "../scopeResolver";
import { buildRslSemanticTokens } from "../semanticTokens";
import type { WorkspaceIndex } from "../workspaceIndex";

export interface IRslLanguageFeatureEnvironment {
    connection: Connection;
    documents: TextDocuments<TextDocument>;
    index: WorkspaceIndex;
    resolver: RslScopeResolver;
    definitionProvider: RslDefinitionProvider;
    referenceIndex?: ReferenceIndex;
    getFastDocumentSnapshot?(document: TextDocument): IFastDocumentSnapshot;
    ensureDocumentParsed(document: TextDocument): Promise<CBase | undefined>;
    log(message: string): void;
}

interface IPositionContext {
    document: TextDocument;
    tree: CBase;
    offset: number;
    token?: IToken;
    tokens: IRslToken[];
}

/** Регистрирует LSP provider-ы и владеет их versioned-кэшами. */
export class RslLanguageFeatureRegistry {
    private semanticTokensCache = new Map<string, {
        version: number;
        resultId: string;
        value: SemanticTokens;
    }>();
    private semanticResultSequence = 0;
    private foldingRangesCache = new Map<string, {
        version: number;
        value: IRslFoldingRange[];
    }>();
    private documentSymbolsCache = new Map<string, {
        version: number;
        value: SymbolInformation[];
    }>();
    private defaultCompletionItems = getCIInfoForArray(getDefaults());
    private registered = false;
    private referenceIndex: ReferenceIndex;

    constructor(private environment: IRslLanguageFeatureEnvironment) {
        this.referenceIndex = environment.referenceIndex || new ReferenceIndex();
    }

    register(): void {
        if (this.registered) {
            return;
        }

        this.registered = true;
        const {
            connection,
            documents,
            index,
            resolver,
            definitionProvider,
            getFastDocumentSnapshot,
            ensureDocumentParsed
        } = this.environment;

        connection.onCompletion(async (params: TextDocumentPositionParams) => {
            const document = documents.get(params.textDocument.uri);

            if (!document) {
                return [];
            }

            await ensureDocumentParsed(document);
            const context = this.getPositionContext(params);

            if (!context || isBlockedToken(context.token)) {
                return [];
            }

            return deduplicateCompletionItems(
                resolver.getCompletions(
                    document.uri,
                    context.tree,
                    context.offset
                ),
                this.defaultCompletionItems
            );
        });

        connection.onHover(async (
            params: TextDocumentPositionParams
        ): Promise<Hover | null> => {
            const document = documents.get(params.textDocument.uri);

            if (!document) {
                return null;
            }

            await ensureDocumentParsed(document);
            const context = this.getPositionContext(params);

            if (!context || isBlockedToken(context.token)) {
                return null;
            }

            const resolved = resolver.resolveAt(
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

        connection.onDefinition(async (
            params: TextDocumentPositionParams
        ): Promise<Definition | null> => {
            const document = documents.get(params.textDocument.uri);

            if (!document) {
                return null;
            }

            await ensureDocumentParsed(document);
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
                return importedFile;
            }

            if (context.token.kind === "string") {
                const dynamic = await definitionProvider
                    .findDynamicDefinition(context);

                if (dynamic) {
                    return dynamic;
                }
            }

            if (isBlockedToken(context.token)) {
                return null;
            }

            const resolved = resolver.resolveAt(
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

        connection.onReferences(async (
            params: ReferenceParams,
            cancellationToken: CancellationToken
        ) => {
            const document = documents.get(params.textDocument.uri);

            if (!document) {
                return [];
            }

            await ensureDocumentParsed(document);
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

        connection.onCodeAction((params: CodeActionParams) => {
            const module = index.getModule(params.textDocument.uri);
            return module ? buildEnhancedRslCodeActions(module, params) : [];
        });

        connection.languages.semanticTokens.on(async (
            params: SemanticTokensParams
        ): Promise<SemanticTokens> => {
            return this.getSemanticTokens(params.textDocument.uri);
        });

        connection.languages.semanticTokens.onDelta(async (
            params: SemanticTokensDeltaParams
        ): Promise<SemanticTokens | SemanticTokensDelta> => {
            const previous = this.semanticTokensCache.get(
                params.textDocument.uri
            );
            const current = await this.getSemanticTokens(
                params.textDocument.uri
            );

            if (
                previous &&
                previous.resultId === params.previousResultId &&
                previous.resultId === current.resultId
            ) {
                return { resultId: current.resultId, edits: [] };
            }

            if (!previous || previous.resultId !== params.previousResultId) {
                return current;
            }

            return {
                resultId: current.resultId,
                edits: semanticTokenEdits(previous.value.data, current.data)
            };
        });

        connection.languages.semanticTokens.onRange(async (
            params: SemanticTokensRangeParams
        ): Promise<SemanticTokens> => {
            const document = documents.get(params.textDocument.uri);
            if (!document) {
                return { data: [] };
            }

            await ensureDocumentParsed(document);
            const module = index.getModule(document.uri);
            if (!module || module.version !== document.version) {
                return { data: [] };
            }

            return buildRslSemanticTokens(
                module,
                index,
                resolver,
                {
                    startLine: params.range.start.line,
                    startCharacter: params.range.start.character,
                    endLine: params.range.end.line,
                    endCharacter: params.range.end.character
                }
            );
        });

        connection.onDocumentSymbol(async (params: DocumentSymbolParams) => {
            const document = documents.get(params.textDocument.uri);
            if (!document) {
                return [];
            }

            const cached = this.documentSymbolsCache.get(document.uri);
            if (cached && cached.version === document.version) {
                return cached.value;
            }

            let value: SymbolInformation[];

            if (getFastDocumentSnapshot) {
                value = getFastDocumentSnapshot(document).symbols.slice();
            } else {
                const tree = await ensureDocumentParsed(document);
                value = tree
                    ? getSymbols(document, tree).filter(
                        (item): item is SymbolInformation => !!item
                    )
                    : [];
            }

            this.documentSymbolsCache.set(document.uri, {
                version: document.version,
                value
            });
            return value;
        });

        connection.onFoldingRanges(async (params: FoldingRangeParams) => {
            const document = documents.get(params.textDocument.uri);
            if (!document) {
                return [];
            }

            const cached = this.foldingRangesCache.get(document.uri);
            if (cached && cached.version === document.version) {
                return cached.value;
            }

            let value: IRslFoldingRange[];

            if (getFastDocumentSnapshot) {
                value = getFastDocumentSnapshot(document).foldingRanges.slice();
            } else {
                await ensureDocumentParsed(document);
                const module = index.getModule(document.uri);
                value = module && module.version === document.version
                    ? GetFoldingRanges(document.getText(), module.lex)
                    : [];
            }

            this.foldingRangesCache.set(document.uri, {
                version: document.version,
                value
            });
            return value;
        });

        connection.onDocumentFormatting((params: DocumentFormattingParams) => {
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
                this.environment.log(
                    `Formatting failed: ${document.uri}\n` +
                    errorToString(error)
                );
                return [];
            }
        });
    }

    private async getSemanticTokens(uri: string): Promise<SemanticTokens> {
        const document = this.environment.documents.get(uri);

        if (!document) {
            return { data: [] };
        }

        await this.environment.ensureDocumentParsed(document);
        const module = this.environment.index.getModule(uri);

        if (!module) {
            return { data: [] };
        }

        const cached = this.semanticTokensCache.get(uri);
        if (cached && cached.version === module.version) {
            return cached.value;
        }

        const built = buildRslSemanticTokens(
            module,
            this.environment.index,
            this.environment.resolver
        );
        const resultId = `${module.version}:${++this.semanticResultSequence}`;
        const value: SemanticTokens = {
            data: built.data,
            resultId
        };
        this.semanticTokensCache.set(uri, {
            version: module.version,
            resultId,
            value
        });
        return value;
    }

    invalidate(uri: string): void {
        /* Старый semantic result нужен клиенту для следующего delta-запроса. */
        this.foldingRangesCache.delete(uri);
        this.documentSymbolsCache.delete(uri);
    }

    forget(uri: string): void {
        this.semanticTokensCache.delete(uri);
        this.foldingRangesCache.delete(uri);
        this.documentSymbolsCache.delete(uri);
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
        const tree = module?.object;

        if (!document || !module || !tree) {
            return undefined;
        }

        const offset = document.offsetAt(params.position);

        return {
            document,
            tree,
            offset,
            token: tree.getCurrentToken(offset),
            tokens: module.lex.tokens
        };
    }
}

function semanticTokenEdits(
    previous: number[],
    current: number[]
): Array<{ start: number; deleteCount: number; data?: number[] }> {
    let start = 0;
    const commonLimit = Math.min(previous.length, current.length);
    while (start < commonLimit && previous[start] === current[start]) {
        start++;
    }

    if (start === previous.length && start === current.length) {
        return [];
    }

    let previousEnd = previous.length - 1;
    let currentEnd = current.length - 1;
    while (
        previousEnd >= start &&
        currentEnd >= start &&
        previous[previousEnd] === current[currentEnd]
    ) {
        previousEnd--;
        currentEnd--;
    }

    const data = current.slice(start, currentEnd + 1);
    return [{
        start,
        deleteCount: previousEnd - start + 1,
        ...(data.length > 0 ? { data } : {})
    }];
}

function isBlockedToken(token?: IToken): boolean {
    return !!token && (
        token.kind === "string" ||
        token.kind === "square" ||
        token.kind === "comment"
    );
}

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

function errorToString(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}\n${error.stack || ""}`;
    }

    return String(error);
}

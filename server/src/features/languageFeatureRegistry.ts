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
    SemanticTokensParams,
    SymbolInformation,
    TextDocumentPositionParams,
    TextEdit,
    type Connection,
    type TextDocuments
} from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

import { CBase } from "../common";
import { RslDefinitionProvider } from "./definitionProvider";
import { getCIInfoForArray, getDefaults } from "../defaults";
import { getSymbols } from "../docsymbols";
import { buildEnhancedRslCodeActions } from "./enhancedCodeActions";
import { GetFoldingRanges } from "../folding";
import { FormatCode } from "../format";
import type { IToken } from "../interfaces";
import type { IRslToken } from "../lexer";
import { findRslReferencesInWorkspace } from "../analysis/references";
import { RslScopeResolver } from "../scopeResolver";
import { buildRslSemanticTokens } from "../semanticTokens";
import type { WorkspaceIndex } from "../workspaceIndex";

export interface IRslLanguageFeatureEnvironment {
    connection: Connection;
    documents: TextDocuments<TextDocument>;
    index: WorkspaceIndex;
    resolver: RslScopeResolver;
    definitionProvider: RslDefinitionProvider;
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
        value: ReturnType<typeof buildRslSemanticTokens>;
    }>();
    private foldingRangesCache = new Map<string, {
        version: number;
        value: ReturnType<typeof GetFoldingRanges>;
    }>();
    private documentSymbolsCache = new Map<string, {
        version: number;
        value: SymbolInformation[];
    }>();
    private defaultCompletionItems = getCIInfoForArray(getDefaults());
    private registered = false;

    constructor(private environment: IRslLanguageFeatureEnvironment) {}

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

            /* Workspace индексируется фоном; запрос не читает все файлы сам. */
            return findRslReferencesInWorkspace(
                index,
                resolver,
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
        ) => {
            const document = documents.get(params.textDocument.uri);

            if (!document) {
                return { data: [] };
            }

            await ensureDocumentParsed(document);
            const module = index.getModule(document.uri);

            if (!module) {
                return { data: [] };
            }

            const cached = this.semanticTokensCache.get(document.uri);

            if (cached && cached.version === module.version) {
                return cached.value;
            }

            const value = buildRslSemanticTokens(module, index, resolver);
            this.semanticTokensCache.set(document.uri, {
                version: module.version,
                value
            });
            return value;
        });

        connection.onDocumentSymbol(async (params: DocumentSymbolParams) => {
            const { textDocument } = params;
            const document = documents.get(textDocument.uri);

            if (!document) {
                return [];
            }

            const tree = await ensureDocumentParsed(document);

            if (!tree) {
                return [];
            }

            const module = index.getModule(document.uri);

            if (!module) {
                return [];
            }

            const cached = this.documentSymbolsCache.get(document.uri);

            if (cached && cached.version === module.version) {
                return cached.value;
            }

            const value = getSymbols(document, tree).filter(
                (symbol): symbol is SymbolInformation => symbol !== undefined
            );
            this.documentSymbolsCache.set(document.uri, {
                version: module.version,
                value
            });
            return value;
        });

        connection.onFoldingRanges((params: FoldingRangeParams) => {
            const { textDocument } = params;
            const document = documents.get(textDocument.uri);

            if (!document) {
                return [];
            }

            const cached = this.foldingRangesCache.get(document.uri);

            if (cached && cached.version === document.version) {
                return cached.value;
            }

            const module = index.getModule(document.uri);
            const lex = module && module.version === document.version
                ? module.lex
                : undefined;
            const value = GetFoldingRanges(document.getText(), lex);
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

    invalidate(uri: string): void {
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

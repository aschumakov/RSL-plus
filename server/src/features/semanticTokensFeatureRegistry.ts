import {
    type CancellationToken,
    type Connection,
    type SemanticTokens,
    type SemanticTokensDelta,
    type TextDocuments
} from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

import type { IRslSettings } from "../interfaces";
import type { PerformanceLogger } from "../performanceLogger";
import type { RslScopeResolver } from "../scopeResolver";
import { buildRslSemanticTokens } from "../semanticTokens";
import type { RslSymbol } from "../symbols/rslSymbol";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

export interface ISemanticTokensFeatureEnvironment {
    connection: Connection;
    documents: TextDocuments<TextDocument>;
    index: WorkspaceIndex;
    resolver: RslScopeResolver;
    ensureDocumentParsed(document: TextDocument): Promise<RslSymbol | undefined>;
    getSettings(uri: string): IRslSettings;
    noteInteractiveActivity?(): void;
    performance?: PerformanceLogger;
}

/** Владеет semantic-token lifecycle, resultId и delta-кэшем. */
export class SemanticTokensFeatureRegistry {
    private cache = new Map<string, {
        version: number;
        resultId: string;
        value: SemanticTokens;
    }>();
    private sequence = 0;

    constructor(private environment: ISemanticTokensFeatureEnvironment) {}

    register(): void {
        const { connection, documents, index, resolver } = this.environment;
        connection.languages.semanticTokens.on((params, token) =>
            this.getTokens(params.textDocument.uri, token)
        );
        connection.languages.semanticTokens.onDelta(async (
            params,
            token
        ): Promise<SemanticTokens | SemanticTokensDelta> => {
            const previous = this.cache.get(params.textDocument.uri);
            const current = await this.getTokens(params.textDocument.uri, token);
            if (
                previous &&
                previous.resultId === params.previousResultId &&
                previous.resultId === current.resultId
            ) return { resultId: current.resultId, edits: [] };
            if (!previous || previous.resultId !== params.previousResultId) {
                return current;
            }
            return {
                resultId: current.resultId,
                edits: semanticTokenEdits(previous.value.data, current.data)
            };
        });
        connection.languages.semanticTokens.onRange(async (params, token) => {
            const document = documents.get(params.textDocument.uri);
            if (!document) return { data: [] };
            this.environment.noteInteractiveActivity?.();
            const version = document.version;
            await this.environment.ensureDocumentParsed(document);
            const module = index.getModule(document.uri);
            if (
                !module ||
                module.version !== document.version ||
                requestIsStale(document, version, token) ||
                this.isTooLarge(module)
            ) return { data: [] };
            return buildRslSemanticTokens(module, index, resolver, {
                startLine: params.range.start.line,
                startCharacter: params.range.start.character,
                endLine: params.range.end.line,
                endCharacter: params.range.end.character
            });
        });
    }

    /** При изменении старый result остаётся для следующего delta-запроса. */
    invalidate(_uri: string): void {}

    forget(uri: string): void { this.cache.delete(uri); }

    private async getTokens(
        uri: string,
        cancellationToken?: CancellationToken
    ): Promise<SemanticTokens> {
        const document = this.environment.documents.get(uri);
        if (!document) return { data: [] };
        this.environment.noteInteractiveActivity?.();
        const version = document.version;
        await this.environment.ensureDocumentParsed(document);
        const module = this.environment.index.getModule(uri);
        if (
            !module ||
            requestIsStale(document, version, cancellationToken) ||
            this.isTooLarge(module)
        ) return { data: [] };

        const cached = this.cache.get(uri);
        if (cached?.version === module.version) return cached.value;
        const built = buildRslSemanticTokens(
            module,
            this.environment.index,
            this.environment.resolver
        );
        const resultId = `${module.version}:${++this.sequence}`;
        const value = { data: built.data, resultId };
        this.cache.set(uri, { version: module.version, resultId, value });
        return value;
    }

    private isTooLarge(module: IIndexedModule): boolean {
        const maxFileSizeKb = this.environment.getSettings(module.uri)
            .semanticHighlighting.maxFileSizeKb;
        const tooLarge = maxFileSizeKb > 0 &&
            module.sourceLength > maxFileSizeKb * 1024;
        if (tooLarge) {
            this.environment.performance?.mark("semanticTokens.skipped", {
                uri: module.uri,
                chars: module.sourceLength,
                maxFileSizeKb,
                reason: "fileSize"
            });
        }
        return tooLarge;
    }
}

function requestIsStale(
    document: TextDocument,
    version: number,
    token?: CancellationToken
): boolean {
    return document.version !== version || token?.isCancellationRequested === true;
}

function semanticTokenEdits(previous: number[], current: number[]) {
    let start = 0;
    const limit = Math.min(previous.length, current.length);
    while (start < limit && previous[start] === current[start]) start++;
    if (start === previous.length && start === current.length) return [];
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

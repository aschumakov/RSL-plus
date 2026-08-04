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
    private static readonly MAX_CACHED_DOCUMENTS = 4;
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
            const span = this.startSpan("semanticTokens.range", document);
            await this.environment.ensureDocumentParsed(document);
            await yieldToEventLoop();
            const module = index.getModule(document.uri);
            if (
                !module ||
                module.version !== document.version ||
                requestIsStale(document, version, token) ||
                this.isTooLarge(module)
            ) {
                this.endSpan(span, { cancelled: true, dataInts: 0 });
                return { data: [] };
            }
            const result = buildRslSemanticTokens(module, index, resolver, {
                startLine: params.range.start.line,
                startCharacter: params.range.start.character,
                endLine: params.range.end.line,
                endCharacter: params.range.end.character
            });
            this.endSpan(span, { cancelled: false, dataInts: result.data.length });
            return result;
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
        const span = this.startSpan("semanticTokens.full", document);
        await this.environment.ensureDocumentParsed(document);
        /* Outline/hover/completion, уже стоящие в IPC-очереди, идут первыми. */
        await yieldToEventLoop();
        const module = this.environment.index.getModule(uri);
        if (
            !module ||
            requestIsStale(document, version, cancellationToken) ||
            this.isTooLarge(module)
        ) {
            this.endSpan(span, { cancelled: true, dataInts: 0 });
            return { data: [] };
        }

        const cached = this.cache.get(uri);
        if (cached?.version === module.version) {
            this.touchCache(uri, cached);
            this.endSpan(span, {
                cacheHit: true,
                cancelled: false,
                dataInts: cached.value.data.length
            });
            return cached.value;
        }
        const built = buildRslSemanticTokens(
            module,
            this.environment.index,
            this.environment.resolver
        );
        const resultId = `${module.version}:${++this.sequence}`;
        const value = { data: built.data, resultId };
        this.touchCache(uri, { version: module.version, resultId, value });
        while (this.cache.size > SemanticTokensFeatureRegistry.MAX_CACHED_DOCUMENTS) {
            const oldest = this.cache.keys().next().value as string | undefined;
            if (!oldest) break;
            this.cache.delete(oldest);
        }
        this.endSpan(span, {
            cacheHit: false,
            cancelled: false,
            dataInts: value.data.length
        });
        return value;
    }

    private touchCache(
        uri: string,
        entry: { version: number; resultId: string; value: SemanticTokens }
    ): void {
        this.cache.delete(uri);
        this.cache.set(uri, entry);
    }

    private startSpan(event: string, document: TextDocument) {
        return this.environment.performance?.enabled
            ? this.environment.performance.start(event, {
                uri: document.uri,
                version: document.version,
                chars: document.getText().length
            })
            : undefined;
    }

    private endSpan(
        span: ReturnType<PerformanceLogger["start"]> | undefined,
        fields: Record<string, string | number | boolean | null | undefined>
    ): void {
        if (span) this.environment.performance!.end(span, fields);
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

function yieldToEventLoop(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
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

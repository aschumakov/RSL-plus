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
import type { IRslToken } from "../lexer";
import {
    buildRslBasicSemanticTokens,
    buildRslSemanticTokensChunked
} from "../semanticTokens";
import type { RslSymbol } from "../symbols/rslSymbol";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

export interface ISemanticTokensFeatureEnvironment {
    connection: Connection;
    documents: TextDocuments<TextDocument>;
    index: WorkspaceIndex;
    resolver: RslScopeResolver;
    ensureDocumentParsed(document: TextDocument): Promise<RslSymbol | undefined>;
    /**
     * Просит разобрать документ, не снимая debounce набора текста.
     *
     * Подсветка приходит на каждое нажатие клавиши, и разбор по её запросу
     * означал бы полный разбор на каждый символ.
     */
    requestDocumentParse?(document: TextDocument): void;
    getSettings(uri: string): IRslSettings;
    noteInteractiveActivity?(): void;
    performance?: PerformanceLogger;
    /**
     * Поддерживает ли клиент workspace/semanticTokens/refresh. Без этой
     * возможности сервер не может попросить перезапросить подсветку, и
     * обновление придёт только со следующим изменением документа.
     */
    supportsRefresh?(): boolean;
    /**
     * Токены документа без ожидания разбора — из быстрого снимка.
     *
     * Нужны базовой подсветке, которая отдаётся, пока модель не готова.
     */
    getFastLexTokens?(document: TextDocument): readonly IRslToken[];
    log?(message: string): void;
}

/*
 * Как часто разрешено просить клиента перезапросить подсветку.
 *
 * Загрузка Import-графа — это десятки модулей подряд, и каждый меняет
 * Import-контекст открытых файлов. Без объединения запросов клиент
 * перезапрашивал бы токены всего файла на каждый загруженный модуль.
 */
const REFRESH_COALESCE_MS = 300;

/** Владеет semantic-token lifecycle, resultId и delta-кэшем. */
export class SemanticTokensFeatureRegistry {
    private static readonly MAX_CACHED_DOCUMENTS = 4;
    /** Сколько документов держит кэш: для отчёта о памяти. */
    get cachedDocumentCount(): number {
        return this.cache.size;
    }

    private cache = new Map<string, {
        version: number;
        /**
         * Ключ Import-замыкания на момент построения токенов.
         *
         * Версии документа недостаточно: подсветка различает известный
         * импортированный символ и неизвестный, а загрузка внешнего модуля
         * версию открытого документа не меняет. Без этого ключа токены
         * оставались бы закэшированными с прежней раскраской, хотя нужные
         * внешние символы уже появились в индексе.
         */
        closureKey: string;
        resultId: string;
        value: SemanticTokens;
    }>();
    private sequence = 0;
    private refreshTimer: NodeJS.Timeout | undefined;
    /**
     * Файлы, которым отдали базовую подсветку вместо полной.
     *
     * По готовности модели именно им нужно попросить перезапрос: остальные и
     * так получили окончательный ответ.
     */
    private provisional = new Set<string>();

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

            if (this.documentIsTooLarge(document)) {
                this.endSpan(span, { cancelled: true, dataInts: 0 });
                return { data: [] };
            }

            /*
             * Готовая модель не форсируется — как и в запросе на весь файл.
             * Раньше здесь стоял await разбора, и подсветка видимого куска
             * снимала склейку правок на каждое нажатие клавиши.
             */
            this.requestParse(document);
            await yieldToEventLoop();
            const module = index.getModule(document.uri);
            if (
                !module ||
                module.version !== document.version ||
                requestIsStale(document, version, token) ||
                this.isTooLarge(module)
            ) {
                /* Модель ещё строится: по её готовности клиента попросят
                 * перезапросить токены (см. notifyParsed). */
                this.provisional.add(document.uri);
                this.endSpan(span, { cancelled: true, dataInts: 0 });
                return { data: [] };
            }
            const result = await buildRslSemanticTokensChunked(
                module,
                index,
                resolver,
                {
                    startLine: params.range.start.line,
                    startCharacter: params.range.start.character,
                    endLine: params.range.end.line,
                    endCharacter: params.range.end.character
                },
                /* Отмена проверяется после каждой порции, а не только до расчёта. */
                () => requestIsStale(document, version, token)
            );

            if (requestIsStale(document, version, token)) {
                this.endSpan(span, { cancelled: true, dataInts: 0 });
                return { data: [] };
            }
            this.endSpan(span, { cancelled: false, dataInts: result.data.length });
            return result;
        });
    }

    /** При изменении старый result остаётся для следующего delta-запроса. */
    invalidate(_uri: string): void {}

    forget(uri: string): void { this.cache.delete(uri); }

    /**
     * Import-контекст перечисленных открытых файлов изменился: загрузился
     * внешний модуль, и раскраска их символов могла стать другой.
     *
     * Кэш при этом не сбрасывается: он сам себя признает устаревшим по
     * closureKey. Клиенту отправляется просьба перезапросить токены, иначе
     * до следующей правки он показывал бы прежнюю раскраску. Запросы
     * объединяются: загрузка Import-графа даёт десятки таких событий подряд.
     */
    notifyImportContextChanged(uris: readonly string[]): void {
        if (this.environment.supportsRefresh?.() === false) {
            return;
        }

        const affected = uris.some(uri => {
            const cached = this.cache.get(uri);
            return !!cached &&
                cached.closureKey !==
                    this.environment.resolver.getImportContextKey(uri);
        });

        if (!affected) {
            return;
        }

        this.scheduleRefresh();
    }

    /**
     * Модель файла построена — если ему отдавали базовую подсветку, просим
     * клиента перезапросить токены.
     *
     * Без этого уточнённая подсветка появлялась бы только со следующей правкой
     * документа: сам клиент о готовности модели не знает.
     */
    notifyParsed(uri: string): void {
        if (!this.provisional.delete(uri)) {
            return;
        }
        if (this.environment.supportsRefresh?.() === false) {
            return;
        }
        this.scheduleRefresh();
    }

    dispose(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    /** Запросы перезапроса объединяются: см. REFRESH_COALESCE_MS. */
    private scheduleRefresh(): void {
        if (this.refreshTimer) {
            return;
        }

        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            this.requestRefresh();
        }, REFRESH_COALESCE_MS);
    }

    private requestRefresh(): void {
        this.environment.performance?.mark?.("semanticTokens.refresh", {
            cachedDocuments: this.cache.size
        });

        try {
            const result = this.environment.connection.languages
                .semanticTokens.refresh();
            void Promise.resolve(result).catch(error =>
                this.environment.log?.(
                    `Semantic tokens refresh failed: ${errorText(error)}`
                )
            );
        } catch (error) {
            this.environment.log?.(
                `Semantic tokens refresh failed: ${errorText(error)}`
            );
        }
    }

    private async getTokens(
        uri: string,
        cancellationToken?: CancellationToken
    ): Promise<SemanticTokens> {
        const document = this.environment.documents.get(uri);
        if (!document) return { data: [] };
        this.environment.noteInteractiveActivity?.();
        const version = document.version;
        const span = this.startSpan("semanticTokens.full", document);

        /*
         * Готовая модель этой версии не ждётся.
         *
         * Раньше здесь стоял await полного разбора, и первый запрос подсветки
         * держал документ непокрашенным всё время разбора — на большом файле
         * это десятки миллисекунд после каждого открытия. Теперь пока модели
         * нет, отдаётся базовая подсветка по токенам, разбор идёт своим ходом,
         * а по его готовности сервер просит клиента перезапросить токены
         * (notifyParsed).
         */
        if (this.documentIsTooLarge(document)) {
            this.endSpan(span, { cancelled: true, dataInts: 0 });
            return { data: [] };
        }

        let module = this.environment.index.getCurrentModule(uri, version);

        if (!module) {
            this.requestParse(document);
            this.provisional.add(uri);
            const basic = buildRslBasicSemanticTokens(
                this.environment.getFastLexTokens?.(document) || []
            );
            this.endSpan(span, {
                provisional: true,
                cancelled: false,
                dataInts: basic.data.length
            });
            /* Без resultId: результат неполный, delta от него строить нельзя. */
            return basic;
        }

        /* Outline/hover/completion, уже стоящие в IPC-очереди, идут первыми. */
        await yieldToEventLoop();
        module = this.environment.index.getCurrentModule(uri, version);
        if (
            !module ||
            requestIsStale(document, version, cancellationToken) ||
            this.isTooLarge(module)
        ) {
            this.endSpan(span, { cancelled: true, dataInts: 0 });
            return { data: [] };
        }
        this.provisional.delete(uri);

        const closureKey = this.environment.resolver
            .getImportContextKey(uri);
        const cached = this.cache.get(uri);
        if (
            cached?.version === module.version &&
            cached.closureKey === closureKey
        ) {
            this.touchCache(uri, cached);
            this.endSpan(span, {
                cacheHit: true,
                cancelled: false,
                dataInts: cached.value.data.length
            });
            return cached.value;
        }
        const built = await buildRslSemanticTokensChunked(
            module,
            this.environment.index,
            this.environment.resolver,
            undefined,
            () => requestIsStale(document, version, cancellationToken)
        );

        if (requestIsStale(document, version, cancellationToken)) {
            /* Отменённый результат не кладётся в кэш: он может быть неполным. */
            this.endSpan(span, { cancelled: true, dataInts: 0 });
            return { data: [] };
        }
        const resultId = `${module.version}:${++this.sequence}`;
        const value = { data: built.data, resultId };
        this.touchCache(uri, {
            version: module.version,
            closureKey,
            resultId,
            value
        });
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
        entry: {
            version: number;
            closureKey: string;
            resultId: string;
            value: SemanticTokens;
        }
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

    /**
     * Разбор запланирован, но не приближен.
     *
     * Fallback на ensureDocumentParsed нужен для окружений, где новый метод не
     * передан: без него подсветка осталась бы базовой навсегда.
     */
    private requestParse(document: TextDocument): void {
        if (this.environment.requestDocumentParse) {
            this.environment.requestDocumentParse(document);
            return;
        }

        void this.environment.ensureDocumentParsed(document);
    }

    /**
     * Размер проверяется до базовой подсветки, а не только после разбора.
     *
     * Прежняя проверка принимала модуль, то есть работала лишь тогда, когда
     * модель уже построена. До этого файл любого размера успевал целиком
     * пройти через buildRslBasicSemanticTokens ради временной подсветки,
     * которую настройка как раз и запрещает.
     */
    private documentIsTooLarge(document: TextDocument): boolean {
        const maxFileSizeKb = this.environment.getSettings(document.uri)
            .semanticHighlighting.maxFileSizeKb;
        const chars = document.getText().length;
        const tooLarge = maxFileSizeKb > 0 && chars > maxFileSizeKb * 1024;

        if (tooLarge) {
            this.environment.performance?.mark("semanticTokens.skipped", {
                uri: document.uri,
                chars,
                maxFileSizeKb,
                reason: "fileSize"
            });
        }

        return tooLarge;
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

function errorText(error: unknown): string {
    return error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
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

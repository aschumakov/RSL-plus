import {
    TextEdit,
    type Connection,
    type DocumentRangeFormattingParams,
    type TextDocuments
} from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

import { FORMATTER_REVISION, FormatCode } from "../format";
import type { IRslFoldingRange } from "../folding";
import type { PerformanceLogger } from "../performanceLogger";
import {
    getFastDocumentSymbols,
    getFastFoldingRanges,
    type IFastDocumentSnapshot
} from "../services/fastDocumentSnapshot";
import { formatRslDocumentRange } from "./rangeFormatting";
import {
    resolveRslFormatOptions,
} from "./formatOptions";
import type {
    IRslIndentStyle
} from "../services/editorConfigService";
import type { IRslFormatSettings } from "../interfaces";

export interface IPresentationFeatureEnvironment {
    connection: Connection;
    documents: TextDocuments<TextDocument>;
    getFastDocumentSnapshot(document: TextDocument): IFastDocumentSnapshot;
    /**
     * Строки, с которых начинаются верхнеуровневые блоки документа.
     *
     * Нужны диапазонному форматированию: от такой строки его можно начать, не
     * форматируя весь файл. undefined — модель этой версии ещё не готова.
     */
    getBlockStartLines?(
        document: TextDocument
    ): readonly number[] | undefined;
    /**
     * Настройки форматирования и отступ проекта.
     *
     * Без них форматирование слушало бы только редактор, а .editorconfig
     * проекта и настройки плагина не значили бы ничего.
     */
    getFormatSettings?(uri: string): IRslFormatSettings | undefined;
    getProjectIndentStyle?(uri: string): IRslIndentStyle | undefined;
    noteInteractiveActivity?(): void;
    log(message: string): void;
    performance?: PerformanceLogger;
}

/** Быстрые presentation provider-ы не зависят от semantic/workspace анализа. */
export class PresentationFeatureRegistry {
    private folding = new Map<string, { version: number; value: IRslFoldingRange[] }>();
    private outline = new Map<string, { version: number; value: ReturnType<typeof getFastDocumentSymbols> }>();

    constructor(private environment: IPresentationFeatureEnvironment) {}

    register(): void {
        const { connection, documents, getFastDocumentSnapshot } = this.environment;

        connection.onDocumentSymbol(params => {
            this.environment.noteInteractiveActivity?.();
            const performance = this.environment.performance;
            const span = performance?.enabled
                ? performance.start("outline.resolve", { uri: params.textDocument.uri })
                : undefined;
            const document = documents.get(params.textDocument.uri);
            if (!document) {
                if (span) performance.end(span, { outcome: "documentMissing", topLevelSymbols: 0 });
                return [];
            }
            const cached = this.outline.get(document.uri);
            if (cached?.version === document.version) {
                if (span) performance.end(span, {
                    version: document.version,
                    outcome: "providerCache",
                    topLevelSymbols: cached.value.length
                });
                return cached.value;
            }
            const snapshot = getFastDocumentSnapshot(document);
            const prepared = snapshot.symbols !== undefined;
            const value = getFastDocumentSymbols(document, snapshot).slice();
            this.outline.set(document.uri, { version: document.version, value });
            if (span) performance.end(span, {
                version: document.version,
                outcome: prepared ? "preparedFastSnapshot" : "onDemandFastSnapshot",
                snapshotAgeMs: Math.max(0, Date.now() - snapshot.createdAtMs),
                outlineReadyAgeMs: Math.max(0, Date.now() - (
                    snapshot.symbolsPreparedAtMs ?? snapshot.createdAtMs
                )),
                topLevelSymbols: value.length
            });
            return value;
        });

        connection.onFoldingRanges(params => {
            const document = documents.get(params.textDocument.uri);
            if (!document) return [];
            const cached = this.folding.get(document.uri);
            if (cached?.version === document.version) return cached.value;
            const value = getFastFoldingRanges(
                getFastDocumentSnapshot(document)
            ).slice();
            this.folding.set(document.uri, { version: document.version, value });
            return value;
        });

        connection.onDocumentFormatting(params => {
            const document = documents.get(params.textDocument.uri);
            if (!document) return [];
            const source = document.getText();
            const performance = this.environment.performance;
            const span = performance?.enabled
                ? performance.start("format.document", {
                    uri: document.uri,
                    version: document.version,
                    chars: source.length
                })
                : undefined;
            try {
                const options = this.formatOptions(
                    document.uri,
                    params.options
                );
                /*
                 * Разбор берётся из снимка текущей версии: он уже есть, и
                 * лексировать тот же текст второй раз незачем.
                 */
                const snapshot = getFastDocumentSnapshot(document);
                const formatted = FormatCode(
                    source,
                    options.tabSize,
                    options,
                    snapshot.lex.tokens.length > 0 &&
                        snapshot.text === source
                        ? snapshot.lex
                        : undefined
                );
                if (span) performance.end(span, {
                    changed: formatted !== source,
                    failed: false,
                    formatterRevision: FORMATTER_REVISION
                });
                return formatted === source
                    ? []
                    : [TextEdit.replace({
                        start: { line: 0, character: 0 },
                        end: document.positionAt(source.length)
                    }, formatted)];
            } catch (error) {
                if (span) performance.end(span, { failed: true });
                this.environment.log(`Formatting failed: ${document.uri}\n${errorText(error)}`);
                return [];
            }
        });

        connection.onDocumentRangeFormatting((params: DocumentRangeFormattingParams) => {
            const document = documents.get(params.textDocument.uri);
            if (!document) return [];
            try {
                /*
                 * Токены версии уже посчитаны снимком: повторное лексирование
                 * файла на 705 КБ стоило бы дороже самого форматирования.
                 */
                return formatRslDocumentRange(document, params, {
                    blockStartLines: this.environment.getBlockStartLines
                        ? this.environment.getBlockStartLines(document)
                        : undefined,
                    lex: this.environment.getFastDocumentSnapshot(document).lex,
                    format: this.formatOptions(
                        document.uri,
                        params.options
                    )
                });
            } catch (error) {
                this.environment.log(`Range formatting failed: ${document.uri}\n${errorText(error)}`);
                return [];
            }
        });
    }

    /** Настройки одного форматирования: см. resolveRslFormatOptions. */
    private formatOptions(
        uri: string,
        editor: { tabSize: number; insertSpaces: boolean }
    ): ReturnType<typeof resolveRslFormatOptions> {
        return resolveRslFormatOptions(
            editor,
            this.environment.getFormatSettings?.(uri),
            this.environment.getProjectIndentStyle?.(uri)
        );
    }

    invalidate(uri: string): void {
        this.folding.delete(uri);
        this.outline.delete(uri);
    }

    forget(uri: string): void { this.invalidate(uri); }
}

function errorText(error: unknown): string {
    return error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack || ""}`
        : String(error);
}

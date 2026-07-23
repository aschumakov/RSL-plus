import type { TextDocuments } from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

import { CBase } from "../common";
import { parseRslSyntax } from "../syntaxParser";
import type { RslSettingsService } from "./settingsService";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";
import {
    createFastDocumentSnapshot,
    type IFastDocumentSnapshot
} from "./fastDocumentSnapshot";

export interface IDocumentAnalysisOptions {
    changeDebounceMs?: number;
    slowParseLogMs?: number;
    fastSnapshotDebounceMs?: number;
    initialParseDelayMs?: number;
    log(message: string): void;
    invalidateProviderCaches(uri: string): void;
    onParsed(module: IIndexedModule, wasKnown: boolean): void;
    onImports(uri: string, imports: readonly string[]): void;
}

/**
 * Управляет versioned-разбором документа.
 * Fast snapshot строится сразу; полный parse запускается после короткого
 * приоритетного окна, а изменения текста объединяются.
 */
export class DocumentAnalysisService {
    private parseGeneration = new Map<string, number>();
    private parsedVersions = new Map<string, number>();
    private parseTimers = new Map<string, NodeJS.Timeout>();
    private running = new Map<string, Promise<void>>();
    private fastSnapshots = new Map<string, IFastDocumentSnapshot>();
    private fastSnapshotTimers = new Map<string, NodeJS.Timeout>();
    private changeDebounceMs: number;
    private slowParseLogMs: number;
    private fastSnapshotDebounceMs: number;
    private initialParseDelayMs: number;

    constructor(
        private documents: TextDocuments<TextDocument>,
        private index: WorkspaceIndex,
        private settings: RslSettingsService,
        private options: IDocumentAnalysisOptions
    ) {
        this.changeDebounceMs = options.changeDebounceMs ?? 90;
        this.slowParseLogMs = options.slowParseLogMs ?? 75;
        this.fastSnapshotDebounceMs = options.fastSnapshotDebounceMs ?? 35;
        this.initialParseDelayMs = options.initialParseDelayMs ?? 25;
    }

    get isBusy(): boolean {
        return this.parseTimers.size > 0 ||
            this.fastSnapshotTimers.size > 0 ||
            this.running.size > 0;
    }

    isBusyFor(uri: string): boolean {
        return this.parseTimers.has(uri) ||
            this.fastSnapshotTimers.has(uri) ||
            this.running.has(uri);
    }

    /**
     * Snapshot создаётся синхронно; полный parser получает короткое окно, чтобы
     * Folding и Outline успели ответить без блокировки event loop.
     */
    open(document: TextDocument): void {
        this.refreshFastSnapshot(document);
        this.scheduleWithDelay(document, this.initialParseDelayMs);
    }

    /** Частые изменения текста объединяются в один разбор. */
    changed(document: TextDocument): void {
        this.scheduleFastSnapshot(document);
        this.scheduleWithDelay(document, this.changeDebounceMs);
    }

    /** Совместимость со старым API: считается изменением документа. */
    schedule(document: TextDocument): void {
        this.changed(document);
    }


    /** Folding и Outline получают snapshot без ожидания полного parser. */
    getFastSnapshot(document: TextDocument): IFastDocumentSnapshot {
        const current = this.fastSnapshots.get(document.uri);
        if (current && current.version === document.version) {
            return current;
        }

        this.cancelFastSnapshotTimer(document.uri);
        return this.refreshFastSnapshot(document);
    }

    async ensureParsed(document: TextDocument): Promise<CBase | undefined> {
        if (this.isCurrent(document)) {
            return this.index.getModule(document.uri)?.object;
        }

        this.cancelTimer(document.uri);
        const active = this.running.get(document.uri);

        if (active) {
            await active;
            if (this.isCurrent(document)) {
                return this.index.getModule(document.uri)?.object;
            }
        }

        const generation = this.nextGeneration(document.uri);
        await this.startValidation(document, generation);
        return this.index.getModule(document.uri)?.object;
    }

    close(uri: string): void {
        this.cancelTimer(uri);
        this.cancelFastSnapshotTimer(uri);
        this.fastSnapshots.delete(uri);
        this.parsedVersions.delete(uri);
        this.nextGeneration(uri);
        this.index.compactModule(uri);
    }

    invalidate(uri: string): void {
        this.fastSnapshots.delete(uri);
        this.parsedVersions.delete(uri);
    }


    private scheduleFastSnapshot(document: TextDocument): void {
        const uri = document.uri;
        const version = document.version;
        this.cancelFastSnapshotTimer(uri);
        this.fastSnapshotTimers.set(uri, setTimeout(() => {
            this.fastSnapshotTimers.delete(uri);
            const current = this.documents.get(uri);
            if (current && current.version === version) {
                this.refreshFastSnapshot(current);
            }
        }, this.fastSnapshotDebounceMs));
    }

    private refreshFastSnapshot(
        document: TextDocument
    ): IFastDocumentSnapshot {
        const snapshot = createFastDocumentSnapshot(document);
        this.fastSnapshots.set(document.uri, snapshot);
        this.options.invalidateProviderCaches(document.uri);
        return snapshot;
    }

    private cancelFastSnapshotTimer(uri: string): void {
        const timer = this.fastSnapshotTimers.get(uri);
        if (timer) {
            clearTimeout(timer);
            this.fastSnapshotTimers.delete(uri);
        }
    }

    private scheduleWithDelay(document: TextDocument, delay: number): void {
        const uri = document.uri;
        const version = document.version;
        const generation = this.nextGeneration(uri);
        this.cancelTimer(uri);

        const timer = setTimeout(() => {
            this.parseTimers.delete(uri);
            const current = this.documents.get(uri);

            if (!current || current.version !== version) {
                return;
            }

            this.startValidation(current, generation).catch(error => {
                this.options.log(
                    `Validation failed: ${uri}\n${errorToString(error)}`
                );
            });
        }, Math.max(0, delay));

        this.parseTimers.set(uri, timer);
    }

    private startValidation(
        document: TextDocument,
        generation: number
    ): Promise<void> {
        const uri = document.uri;
        const existing = this.running.get(uri);

        if (existing) {
            return existing.then(() => {
                if (this.isCurrent(document)) {
                    return;
                }
                return this.startValidation(document, generation);
            });
        }

        const task = Promise.resolve()
            .then(() => this.validate(document, generation))
            .finally(() => {
                if (this.running.get(uri) === task) {
                    this.running.delete(uri);
                }
            });
        this.running.set(uri, task);
        return task;
    }

    private async validate(
        document: TextDocument,
        generation: number
    ): Promise<void> {
        const uri = document.uri;
        const version = document.version;

        if (this.isCurrent(document)) {
            return;
        }

        const text = document.getText();
        const fastSnapshot = this.getFastSnapshot(document);
        const started = Date.now();
        const wasKnown = !!this.index.getModule(uri);

        /* Один parser/lexer pass на версию документа. */
        const syntax = parseRslSyntax(text, fastSnapshot.lex, {
            buildExpressionTree: false
        });
        const parsedObject = CBase.fromSyntax(text, 0, syntax, true, false);

        if (
            this.parseGeneration.get(uri) !== generation ||
            this.documents.get(uri)?.version !== version
        ) {
            return;
        }

        const indexed = this.index.updateOpenModule(
            uri,
            text,
            parsedObject,
            version,
            syntax
        );
        this.parsedVersions.set(uri, version);
        this.options.invalidateProviderCaches(uri);
        this.options.onParsed(indexed, wasKnown);

        try {
            const settings = await this.settings.get(uri);
            const current = this.index.getModule(uri);

            if (
                current &&
                current.version === version &&
                this.parseGeneration.get(uri) === generation &&
                settings.import === "ДА"
            ) {
                this.options.onImports(uri, indexed.imports);
            }
        } catch (error) {
            this.options.log(
                `Settings read failed: ${uri}\n${errorToString(error)}`
            );
        }

        const elapsed = Date.now() - started;

        if (elapsed >= this.slowParseLogMs) {
            this.options.log(
                `Slow parse: ${uri}; version=${version}; ` +
                `ms=${elapsed}; symbols=${parsedObject.getChilds().length}`
            );
        }
    }

    private isCurrent(document: TextDocument): boolean {
        return this.parsedVersions.get(document.uri) === document.version &&
            !!this.index.getModule(document.uri) &&
            this.index.getModule(document.uri)?.kind === "open";
    }

    private nextGeneration(uri: string): number {
        const generation = (this.parseGeneration.get(uri) || 0) + 1;
        this.parseGeneration.set(uri, generation);
        return generation;
    }

    private cancelTimer(uri: string): void {
        const timer = this.parseTimers.get(uri);

        if (timer) {
            clearTimeout(timer);
            this.parseTimers.delete(uri);
        }
    }
}

function errorToString(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}\n${error.stack || ""}`;
    }

    return String(error);
}

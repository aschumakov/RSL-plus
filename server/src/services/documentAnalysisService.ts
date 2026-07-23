import type { TextDocuments } from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

import { CBase } from "../common";
import { parseRslSyntax } from "../syntaxParser";
import type { RslSettingsService } from "./settingsService";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

export interface IDocumentAnalysisOptions {
    changeDebounceMs?: number;
    slowParseLogMs?: number;
    log(message: string): void;
    invalidateProviderCaches(uri: string): void;
    onParsed(module: IIndexedModule, wasKnown: boolean): void;
    onImports(uri: string, imports: readonly string[]): void;
}

/**
 * Управляет versioned-разбором документа.
 * Первый разбор после открытия запускается без debounce; изменения объединяются.
 */
export class DocumentAnalysisService {
    private parseGeneration = new Map<string, number>();
    private parsedVersions = new Map<string, number>();
    private parseTimers = new Map<string, NodeJS.Timeout>();
    private running = new Map<string, Promise<void>>();
    private changeDebounceMs: number;
    private slowParseLogMs: number;

    constructor(
        private documents: TextDocuments<TextDocument>,
        private index: WorkspaceIndex,
        private settings: RslSettingsService,
        private options: IDocumentAnalysisOptions
    ) {
        this.changeDebounceMs = options.changeDebounceMs ?? 90;
        this.slowParseLogMs = options.slowParseLogMs ?? 75;
    }

    get isBusy(): boolean {
        return this.parseTimers.size > 0 || this.running.size > 0;
    }

    isBusyFor(uri: string): boolean {
        return this.parseTimers.has(uri) || this.running.has(uri);
    }

    /** Первый snapshot нужен folding/Outline сразу, поэтому delay отсутствует. */
    open(document: TextDocument): void {
        this.scheduleWithDelay(document, 0);
    }

    /** Частые изменения текста объединяются в один разбор. */
    changed(document: TextDocument): void {
        this.scheduleWithDelay(document, this.changeDebounceMs);
    }

    /** Совместимость со старым API: считается изменением документа. */
    schedule(document: TextDocument): void {
        this.changed(document);
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
        this.parsedVersions.delete(uri);
        this.nextGeneration(uri);
        this.index.compactModule(uri);
    }

    invalidate(uri: string): void {
        this.parsedVersions.delete(uri);
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
        const started = Date.now();
        const wasKnown = !!this.index.getModule(uri);

        /* Один parser/lexer pass на версию документа. */
        const syntax = parseRslSyntax(text, undefined, {
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

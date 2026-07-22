import type { TextDocuments } from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

import { CBase } from "./common";
import type { RslSettingsService } from "./settingsService";
import type { IIndexedModule, WorkspaceIndex } from "./workspaceIndex";

export interface IDocumentAnalysisOptions {
    parseDebounceMs?: number;
    slowParseLogMs?: number;
    log(message: string): void;
    invalidateProviderCaches(uri: string): void;
    onParsed(module: IIndexedModule, wasKnown: boolean): void;
    onImports(uri: string, imports: readonly string[]): void;
}

/** Управляет версиями, debounce и публикацией нового syntax/module model. */
export class DocumentAnalysisService {
    private parseGeneration = new Map<string, number>();
    private parsedVersions = new Map<string, number>();
    private parseTimers = new Map<string, NodeJS.Timeout>();
    private parseDebounceMs: number;
    private slowParseLogMs: number;

    constructor(
        private documents: TextDocuments<TextDocument>,
        private index: WorkspaceIndex,
        private settings: RslSettingsService,
        private options: IDocumentAnalysisOptions
    ) {
        this.parseDebounceMs = options.parseDebounceMs ?? 80;
        this.slowParseLogMs = options.slowParseLogMs ?? 75;
    }

    get isBusy(): boolean {
        return this.parseTimers.size > 0;
    }

    schedule(document: TextDocument): void {
        const uri = document.uri;
        const version = document.version;
        const generation = (this.parseGeneration.get(uri) || 0) + 1;
        this.parseGeneration.set(uri, generation);
        this.cancel(uri);

        const timer = setTimeout(() => {
            this.parseTimers.delete(uri);
            const current = this.documents.get(uri);

            if (!current || current.version !== version) {
                return;
            }

            this.validate(current, generation).catch(error => {
                this.options.log(
                    `Validation failed: ${uri}\n${errorToString(error)}`
                );
            });
        }, this.parseDebounceMs);

        this.parseTimers.set(uri, timer);
    }

    async ensureParsed(document: TextDocument): Promise<CBase | undefined> {
        if (
            this.parsedVersions.get(document.uri) === document.version &&
            this.index.getModule(document.uri)
        ) {
            return this.index.getModule(document.uri)?.object;
        }

        this.cancel(document.uri);
        const generation = (this.parseGeneration.get(document.uri) || 0) + 1;
        this.parseGeneration.set(document.uri, generation);
        await this.validate(document, generation);
        return this.index.getModule(document.uri)?.object;
    }

    close(uri: string): void {
        this.cancel(uri);
        this.parsedVersions.delete(uri);
        this.parseGeneration.set(uri, (this.parseGeneration.get(uri) || 0) + 1);
    }

    invalidate(uri: string): void {
        this.parsedVersions.delete(uri);
    }

    private cancel(uri: string): void {
        const timer = this.parseTimers.get(uri);

        if (timer) {
            clearTimeout(timer);
            this.parseTimers.delete(uri);
        }
    }

    private async validate(
        document: TextDocument,
        generation: number
    ): Promise<void> {
        const uri = document.uri;
        const version = document.version;

        if (
            this.parsedVersions.get(uri) === version &&
            this.index.getModule(uri)
        ) {
            return;
        }

        const text = document.getText();
        const started = Date.now();
        const wasKnown = !!this.index.getModule(uri);
        const parsedObject = new CBase(text, 0);

        if (this.parseGeneration.get(uri) !== generation) {
            return;
        }

        const indexed = this.index.updateModule(
            uri,
            text,
            parsedObject,
            version,
            true
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
}

function errorToString(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}\n${error.stack || ""}`;
    }

    return String(error);
}

import type {
    Connection,
    TextDocuments
} from "vscode-languageserver/node";
import type { Diagnostic } from "vscode-languageserver";
import type { TextDocument } from "vscode-languageserver-textdocument";

import type { RslDiagnosticEngine } from "./diagnosticEngine";
import {
    type IDiagnosticPublication,
    planActiveDocumentDiagnostics,
    planUpdatedDiagnostics
} from "./diagnosticVisibility";
import type { RslSettingsService } from "../services/settingsService";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

export interface IDiagnosticsCoordinatorOptions {
    isParseBusy(): boolean;
    log(message: string): void;
    onImports(uri: string, imports: readonly string[]): void;
    diagnosticsDebounceMs?: number;
    largeDiagnosticsDebounceMs?: number;
    veryLargeDiagnosticsDebounceMs?: number;
    interactiveRetryMs?: number;
    slowDiagnosticsLogMs?: number;
}

/**
 * Единственная точка расписания, кэширования и публикации Problems.
 * Фоновые результаты никогда не перехватывают активный файл.
 */
export class DiagnosticsCoordinator {
    private timers = new Map<string, NodeJS.Timeout>();
    private cache = new Map<string, Diagnostic[]>();
    private publishedSignatures = new Map<string, string>();
    private buildKeys = new Map<string, string>();
    private staleUris = new Set<string>();
    private activeDocumentUri: string | undefined;
    private diagnosticsDebounceMs: number;
    private largeDiagnosticsDebounceMs: number;
    private veryLargeDiagnosticsDebounceMs: number;
    private interactiveRetryMs: number;
    private slowDiagnosticsLogMs: number;

    constructor(
        private connection: Connection,
        private documents: TextDocuments<TextDocument>,
        private index: WorkspaceIndex,
        private settings: RslSettingsService,
        private engine: RslDiagnosticEngine,
        private options: IDiagnosticsCoordinatorOptions
    ) {
        this.diagnosticsDebounceMs = options.diagnosticsDebounceMs ?? 300;
        this.largeDiagnosticsDebounceMs =
            options.largeDiagnosticsDebounceMs ?? 550;
        this.veryLargeDiagnosticsDebounceMs =
            options.veryLargeDiagnosticsDebounceMs ?? 800;
        this.interactiveRetryMs = options.interactiveRetryMs ?? 120;
        this.slowDiagnosticsLogMs = options.slowDiagnosticsLogMs ?? 100;
    }

    setActiveDocument(uri: string | null | undefined): void {
        const next = typeof uri === "string" && uri.length > 0
            ? uri
            : undefined;

        if (this.activeDocumentUri === next) {
            return;
        }

        this.activeDocumentUri = next;

        if (next) {
            this.publishPlan(planActiveDocumentDiagnostics(
                next,
                this.getOpenUris(),
                this.cache
            ));

            if (!this.cache.has(next) || this.staleUris.has(next)) {
                this.schedule(next, 0);
            }
        } else {
            /* Вне RSL показываем уже готовые результаты, но не грузим CPU. */
            this.showAllCached();
        }
    }

    schedule(uri: string, delay?: number): void {
        this.staleUris.add(uri);

        /* Problems показывает активный RSL-файл — остальные считаем по запросу. */
        if (!this.activeDocumentUri || this.activeDocumentUri !== uri) {
            this.cancel(uri);
            return;
        }

        this.cancel(uri);
        const actualDelay = delay === undefined
            ? this.getDelay(uri)
            : Math.max(0, delay);
        const timer = setTimeout(() => {
            this.timers.delete(uri);
            this.run(uri).catch(error => {
                this.options.log(
                    `Diagnostics failed: ${uri}\n${errorToString(error)}`
                );
            });
        }, actualDelay);

        this.timers.set(uri, timer);
    }

    cancel(uri: string): void {
        const timer = this.timers.get(uri);

        if (timer) {
            clearTimeout(timer);
            this.timers.delete(uri);
        }
    }

    close(uri: string): void {
        this.cancel(uri);
        this.cache.delete(uri);
        this.buildKeys.delete(uri);
        this.staleUris.delete(uri);
        this.sendIfChanged(uri, []);
        this.publishedSignatures.delete(uri);

        if (this.activeDocumentUri === uri) {
            this.activeDocumentUri = undefined;
            this.showAllCached();
        }
    }

    refreshAll(): void {
        for (const document of this.documents.all()) {
            this.staleUris.add(document.uri);
        }

        if (this.activeDocumentUri) {
            this.schedule(this.activeDocumentUri, 0);
        }
    }

    getCached(uri: string): readonly Diagnostic[] | undefined {
        return this.cache.get(uri);
    }

    private async run(uri: string): Promise<void> {
        await yieldToInteractiveRequests();

        if (this.options.isParseBusy()) {
            this.schedule(uri, this.interactiveRetryMs);
            return;
        }

        const document = this.documents.get(uri);
        const module = this.index.getModule(uri);

        if (!document || !module || module.version !== document.version) {
            return;
        }

        const settings = await this.settings.get(uri);
        const currentDocument = this.documents.get(uri);
        const currentModule = this.index.getModule(uri);

        if (
            !currentDocument ||
            !currentModule ||
            currentDocument.version !== module.version ||
            currentModule.version !== module.version
        ) {
            return;
        }

        const buildKey = [
            currentModule.version,
            this.index.revision,
            JSON.stringify(settings.diagnostics || {})
        ].join(":");
        const cached = this.cache.get(uri);

        if (cached && this.buildKeys.get(uri) === buildKey) {
            this.staleUris.delete(uri);
            this.publishPlan(planUpdatedDiagnostics(
                this.activeDocumentUri,
                uri,
                cached,
                this.getOpenUris()
            ));
            return;
        }

        const started = Date.now();
        const diagnostics = this.engine.build(
            currentModule,
            this.index,
            settings.diagnostics
        );
        this.cache.set(uri, diagnostics);
        this.buildKeys.set(uri, buildKey);
        this.staleUris.delete(uri);
        this.publishPlan(planUpdatedDiagnostics(
            this.activeDocumentUri,
            uri,
            diagnostics,
            this.getOpenUris()
        ));

        if (settings.import === "ДА") {
            this.options.onImports(uri, currentModule.imports);
        }

        const elapsed = Date.now() - started;

        if (elapsed >= this.slowDiagnosticsLogMs) {
            this.options.log(
                `Slow diagnostics: ${uri}; version=${currentModule.version}; ` +
                `ms=${elapsed}; count=${diagnostics.length}`
            );
        }
    }

    private getDelay(uri: string): number {
        const module = this.index.getModule(uri);
        const length = module ? module.sourceLength : 0;

        if (length >= 250000) {
            return this.veryLargeDiagnosticsDebounceMs;
        }

        if (length >= 100000) {
            return this.largeDiagnosticsDebounceMs;
        }

        return this.diagnosticsDebounceMs;
    }

    private showAllCached(): void {
        for (const document of this.documents.all()) {
            const diagnostics = this.cache.get(document.uri);

            if (diagnostics) {
                this.sendIfChanged(document.uri, diagnostics);
            }
        }
    }

    private getOpenUris(): string[] {
        return this.documents.all().map(
            (document: TextDocument) => document.uri
        );
    }

    private publishPlan(publications: IDiagnosticPublication[]): void {
        for (const publication of publications) {
            this.sendIfChanged(
                publication.uri,
                publication.diagnostics
            );
        }
    }

    private sendIfChanged(uri: string, diagnostics: Diagnostic[]): void {
        const signature = diagnosticSignature(diagnostics);

        if (this.publishedSignatures.get(uri) === signature) {
            return;
        }

        this.publishedSignatures.set(uri, signature);
        this.connection.sendDiagnostics({ uri, diagnostics });
    }
}

function diagnosticSignature(diagnostics: readonly Diagnostic[]): string {
    return diagnostics.map(item => [
        item.code || "",
        item.severity || "",
        item.range.start.line,
        item.range.start.character,
        item.range.end.line,
        item.range.end.character,
        item.message
    ].join(":")).join("\u0001");
}

function yieldToInteractiveRequests(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

function errorToString(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}\n${error.stack || ""}`;
    }

    return String(error);
}

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
    planUpdatedDiagnostics,
    resolveActiveDocumentUri
} from "./diagnosticVisibility";
import type { RslSettingsService } from "../services/settingsService";
import type { WorkspaceIndex } from "../workspaceIndex";
import type { PerformanceLogger } from "../performanceLogger";
import type { IRslSettings } from "../interfaces";

export interface IDiagnosticsCoordinatorOptions {
    isParseBusy(uri: string): boolean;
    log(message: string): void;
    performance?: PerformanceLogger;
    onImports(uri: string, imports: readonly string[]): void;
    localDebounceMs?: number;
    largeLocalDebounceMs?: number;
    workspaceDebounceMs?: number;
    workspaceMaxWaitMs?: number;
    interactiveRetryMs?: number;
    slowDiagnosticsLogMs?: number;
}

/**
 * Двухфазная публикация Problems:
 * local не зависит от Import-графа, workspace обновляет результат вторым пакетом.
 */
export class DiagnosticsCoordinator {
    private localTimers = new Map<string, NodeJS.Timeout>();
    private workspaceTimers = new Map<string, NodeJS.Timeout>();
    private workspaceFirstScheduled = new Map<string, number>();
    private localCache = new Map<string, Diagnostic[]>();
    private workspaceCache = new Map<string, Diagnostic[]>();
    private localKeys = new Map<string, string>();
    private workspaceKeys = new Map<string, string>();
    private publishedSignatures = new Map<string, string>();
    private staleLocal = new Set<string>();
    private staleWorkspace = new Set<string>();
    private maxProblems = new Map<string, number>();
    private activeDocumentUri: string | undefined;
    private localDebounceMs: number;
    private largeLocalDebounceMs: number;
    private workspaceDebounceMs: number;
    private workspaceMaxWaitMs: number;
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
        this.localDebounceMs = options.localDebounceMs ?? 180;
        this.largeLocalDebounceMs = options.largeLocalDebounceMs ?? 350;
        this.workspaceDebounceMs = options.workspaceDebounceMs ?? 700;
        this.workspaceMaxWaitMs = options.workspaceMaxWaitMs ?? 1800;
        this.interactiveRetryMs = options.interactiveRetryMs ?? 100;
        this.slowDiagnosticsLogMs = options.slowDiagnosticsLogMs ?? 100;
    }

    setActiveDocument(uri: string | null | undefined): void {
        const next = resolveActiveDocumentUri(
            this.activeDocumentUri,
            uri,
            this.getOpenUris()
        );

        if (this.activeDocumentUri === next) {
            return;
        }

        const previous = this.activeDocumentUri;
        this.activeDocumentUri = next;

        if (previous && previous !== next) {
            this.cancelLocal(previous);
            this.cancelWorkspaceTimer(previous);
            this.workspaceFirstScheduled.delete(previous);
        }

        if (next) {
            this.publishPlan(planActiveDocumentDiagnostics(
                next,
                this.getOpenUris(),
                this.getCombinedCache()
            ));
            if (!this.localCache.has(next) || this.staleLocal.has(next)) {
                this.scheduleLocal(next, 0);
            }
            if (!this.workspaceCache.has(next) || this.staleWorkspace.has(next)) {
                this.scheduleWorkspace(next, 300);
            }
        } else {
            this.showAllCached();
        }
    }

    /** Совместимый вызов после parse: обе фазы, но с разными сроками. */
    schedule(uri: string): void {
        this.scheduleLocal(uri);
        this.scheduleWorkspace(uri);
    }

    scheduleLocal(uri: string, delay?: number): void {
        this.staleLocal.add(uri);
        if (!this.isActive(uri)) {
            this.cancelLocal(uri);
            return;
        }

        this.cancelLocal(uri);
        const actualDelay = delay === undefined
            ? this.getLocalDelay(uri)
            : Math.max(0, delay);
        this.localTimers.set(uri, setTimeout(() => {
            this.localTimers.delete(uri);
            this.runLocal(uri).catch(error => this.logFailure("Local", uri, error));
        }, actualDelay));
    }

    scheduleWorkspace(uri: string, delay?: number): void {
        this.staleWorkspace.add(uri);
        if (!this.isActive(uri)) {
            this.cancelWorkspaceTimer(uri);
            return;
        }

        const now = Date.now();
        const first = this.workspaceFirstScheduled.get(uri) ?? now;
        this.workspaceFirstScheduled.set(uri, first);
        const requestedAt = now + Math.max(0, delay ?? this.workspaceDebounceMs);
        const deadline = first + this.workspaceMaxWaitMs;
        const actualDelay = Math.max(0, Math.min(requestedAt, deadline) - now);

        this.cancelWorkspaceTimer(uri);
        this.workspaceTimers.set(uri, setTimeout(() => {
            this.workspaceTimers.delete(uri);
            this.runWorkspace(uri).catch(error =>
                this.logFailure("Workspace", uri, error)
            );
        }, actualDelay));
    }

    cancel(uri: string): void {
        this.cancelLocal(uri);
        this.cancelWorkspaceTimer(uri);
        this.workspaceFirstScheduled.delete(uri);
    }

    close(uri: string): void {
        this.cancel(uri);
        this.localCache.delete(uri);
        this.workspaceCache.delete(uri);
        this.localKeys.delete(uri);
        this.workspaceKeys.delete(uri);
        this.staleLocal.delete(uri);
        this.staleWorkspace.delete(uri);
        this.maxProblems.delete(uri);
        this.sendIfChanged(uri, []);
        this.publishedSignatures.delete(uri);

        if (this.activeDocumentUri === uri) {
            this.activeDocumentUri = undefined;
            this.showAllCached();
        }
    }

    refreshAll(): void {
        for (const document of this.documents.all()) {
            this.staleLocal.add(document.uri);
            this.staleWorkspace.add(document.uri);
        }
        if (this.activeDocumentUri) {
            this.scheduleLocal(this.activeDocumentUri, 0);
            this.scheduleWorkspace(this.activeDocumentUri, 250);
        }
    }

    getCached(uri: string): readonly Diagnostic[] | undefined {
        const result = this.combine(uri);
        return result.length > 0 || this.localCache.has(uri) || this.workspaceCache.has(uri)
            ? result
            : undefined;
    }

    private async runLocal(uri: string): Promise<void> {
        await yieldToInteractiveRequests();
        if (this.options.isParseBusy(uri)) {
            this.scheduleLocal(uri, this.interactiveRetryMs);
            return;
        }

        const state = this.getCurrentState(uri);
        if (!state) {
            return;
        }

        const key = [
            state.module.version,
            JSON.stringify(localSettingsKey(state.settings.diagnostics))
        ].join(":");
        this.maxProblems.set(uri, state.settings.diagnostics?.maxProblems ?? 200);

        if (this.localKeys.get(uri) !== key || !this.localCache.has(uri)) {
            /* Workspace-результат предыдущей версии не должен мигать вместе с новым local. */
            this.workspaceCache.delete(uri);
            this.workspaceKeys.delete(uri);
            this.staleWorkspace.add(uri);
            const started = Date.now();
            const performance = this.options.performance;
            const span = performance?.enabled
                ? performance.start("diagnostics.local", {
                    uri,
                    version: state.module.version,
                    chars: state.module.sourceLength
                })
                : undefined;
            const diagnostics = this.engine.buildLocal(
                state.module,
                this.index,
                state.settings.diagnostics
            );
            if (span) {
                performance.end(span, {
                    diagnostics: diagnostics.length
                });
            }
            this.localCache.set(uri, diagnostics);
            this.localKeys.set(uri, key);
            this.logSlow("local", uri, state.module.version, started);
        }

        this.staleLocal.delete(uri);
        this.publishCombined(uri);
        if (state.settings.import === "ДА") {
            this.options.onImports(uri, state.module.imports);
        }
    }

    private async runWorkspace(uri: string): Promise<void> {
        await yieldToInteractiveRequests();
        if (this.options.isParseBusy(uri)) {
            this.scheduleWorkspace(uri, this.interactiveRetryMs);
            return;
        }

        const state = this.getCurrentState(uri);
        if (!state) {
            return;
        }

        const key = [
            state.module.version,
            this.index.getImportClosureKey(uri),
            JSON.stringify(workspaceSettingsKey(state.settings.diagnostics))
        ].join(":");
        this.maxProblems.set(uri, state.settings.diagnostics?.maxProblems ?? 200);

        if (this.workspaceKeys.get(uri) !== key || !this.workspaceCache.has(uri)) {
            const started = Date.now();
            const performance = this.options.performance;
            const span = performance?.enabled
                ? performance.start("diagnostics.workspace", {
                    uri,
                    version: state.module.version,
                    chars: state.module.sourceLength
                })
                : undefined;
            const diagnostics = this.engine.buildWorkspace(
                state.module,
                this.index,
                state.settings.diagnostics
            );
            if (span) {
                performance.end(span, {
                    diagnostics: diagnostics.length,
                    indexedModules: this.index.size
                });
            }
            this.workspaceCache.set(uri, diagnostics);
            this.workspaceKeys.set(uri, key);
            this.logSlow("workspace", uri, state.module.version, started);
        }

        this.workspaceFirstScheduled.delete(uri);
        this.staleWorkspace.delete(uri);
        this.publishCombined(uri);
    }

    private getCurrentState(uri: string): {
        document: TextDocument;
        module: NonNullable<ReturnType<WorkspaceIndex["getModule"]>>;
        settings: IRslSettings;
    } | undefined {
        const document = this.documents.get(uri);
        const module = this.index.getModule(uri);
        if (!document || !module || module.version !== document.version) {
            return undefined;
        }
        return {
            document,
            module,
            settings: this.settings.getAvailable(uri)
        };
    }

    private publishCombined(uri: string): void {
        const diagnostics = this.combine(uri);
        this.publishPlan(planUpdatedDiagnostics(
            this.activeDocumentUri,
            uri,
            diagnostics,
            this.getOpenUris()
        ));
    }

    private combine(uri: string): Diagnostic[] {
        const limit = Math.max(0, this.maxProblems.get(uri) ?? 200);
        if (limit === 0) {
            return [];
        }
        const result: Diagnostic[] = [];
        const seen = new Set<string>();
        for (const item of [
            ...(this.localCache.get(uri) || []),
            ...(this.workspaceCache.get(uri) || [])
        ]) {
            const key = diagnosticItemKey(item);
            if (!seen.has(key)) {
                seen.add(key);
                result.push(item);
                if (result.length >= limit) {
                    break;
                }
            }
        }
        return result;
    }

    private getCombinedCache(): Map<string, Diagnostic[]> {
        const result = new Map<string, Diagnostic[]>();
        for (const document of this.documents.all()) {
            if (this.localCache.has(document.uri) || this.workspaceCache.has(document.uri)) {
                result.set(document.uri, this.combine(document.uri));
            }
        }
        return result;
    }

    private getLocalDelay(uri: string): number {
        const length = this.index.getModule(uri)?.sourceLength || 0;
        return length >= 150000 ? this.largeLocalDebounceMs : this.localDebounceMs;
    }

    private showAllCached(): void {
        for (const document of this.documents.all()) {
            const diagnostics = this.getCached(document.uri);
            if (diagnostics) {
                this.sendIfChanged(document.uri, diagnostics.slice());
            }
        }
    }

    private getOpenUris(): string[] {
        return this.documents.all().map(document => document.uri);
    }

    private publishPlan(publications: IDiagnosticPublication[]): void {
        for (const publication of publications) {
            this.sendIfChanged(publication.uri, publication.diagnostics);
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

    private isActive(uri: string): boolean {
        return this.activeDocumentUri === uri;
    }

    private cancelLocal(uri: string): void {
        const timer = this.localTimers.get(uri);
        if (timer) {
            clearTimeout(timer);
            this.localTimers.delete(uri);
        }
    }

    private cancelWorkspaceTimer(uri: string): void {
        const timer = this.workspaceTimers.get(uri);
        if (timer) {
            clearTimeout(timer);
            this.workspaceTimers.delete(uri);
        }
    }

    private logSlow(
        phase: string,
        uri: string,
        version: number,
        started: number
    ): void {
        const elapsed = Date.now() - started;
        if (elapsed >= this.slowDiagnosticsLogMs) {
            this.options.log(
                `Slow ${phase} diagnostics: ${uri}; version=${version}; ms=${elapsed}`
            );
        }
    }

    private logFailure(phase: string, uri: string, error: unknown): void {
        this.options.log(
            `${phase} diagnostics failed: ${uri}\n${errorToString(error)}`
        );
    }
}

function localSettingsKey(settings: any): unknown {
    const value = settings || {};
    return {
        enabled: value.enabled,
        deprecatedDeclarations: value.deprecatedDeclarations,
        structure: value.structure,
        unusedVariables: value.unusedVariables,
        debugBreak: value.debugBreak,
        useBeforeDeclaration: value.useBeforeDeclaration,
        maxProblems: value.maxProblems
    };
}

function workspaceSettingsKey(settings: any): unknown {
    const value = settings || {};
    return {
        enabled: value.enabled,
        unusedImports: value.unusedImports,
        ambiguousReferences: value.ambiguousReferences,
        maxProblems: value.maxProblems
    };
}

function diagnosticItemKey(item: Diagnostic): string {
    return [
        item.code || "",
        item.range.start.line,
        item.range.start.character,
        item.range.end.line,
        item.range.end.character,
        item.message
    ].join(":");
}

function diagnosticSignature(diagnostics: readonly Diagnostic[]): string {
    return diagnostics.map(diagnosticItemKey).join("\u0001");
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

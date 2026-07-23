import * as fs from "fs";
import { fileURLToPath } from "url";

import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

export type ModuleLoadPriority = "interactive" | "background";
export type WorkspaceIndexingMode = "activeImports" | "workspaceIdle" | "full";

export interface IWorkspaceModuleLoaderOptions {
    log(message: string): void;
    onModuleLoaded(module: IIndexedModule): void;
    onModuleCountChanged(): void;
    onIndexProgress?(loaded: number, total: number): void;
    requestMissingImport?(name: string): void;
    idleDelayMs?: number;
}

/**
 * Очередь загрузки compact external summaries.
 * По умолчанию индексируются только Import открытых документов.
 */
export class WorkspaceModuleLoader {
    private interactiveQueue: string[] = [];
    private backgroundQueue: string[] = [];
    private queued = new Set<string>();
    private workspaceUris = new Set<string>();
    private indexedUris = new Set<string>();
    private pendingImportNames = new Set<string>();
    private running = false;
    private runningUri: string | undefined;
    private loadingPromises = new Map<
        string,
        Promise<IIndexedModule | undefined>
    >();
    private indexingMode: WorkspaceIndexingMode = "activeImports";
    private idleTimer: NodeJS.Timeout | undefined;
    private idleDelayMs: number;

    constructor(
        private index: WorkspaceIndex,
        private options: IWorkspaceModuleLoaderOptions
    ) {
        this.idleDelayMs = Math.max(1000, options.idleDelayMs ?? 10000);
    }

    registerWorkspaceFiles(uris: readonly string[]): void {
        const previousUris = this.workspaceUris;
        const nextUris = new Set<string>();

        for (const uri of uris) {
            if (uri) {
                nextUris.add(uri);
            }
        }

        for (const uri of previousUris) {
            if (nextUris.has(uri)) {
                continue;
            }

            this.removeQueued(uri);
            this.indexedUris.delete(uri);
            this.index.unregisterWorkspaceFile(uri);
            const module = this.index.getModule(uri);

            if (module && !module.isOpen) {
                this.index.removeModule(uri);
            }
        }

        this.workspaceUris = nextUris;
        this.indexedUris = new Set(
            Array.from(nextUris).filter(uri => !!this.index.getModule(uri))
        );
        this.index.registerWorkspaceFiles(Array.from(this.workspaceUris));

        const pending = Array.from(this.pendingImportNames);
        this.pendingImportNames.clear();
        pending.forEach(name => this.enqueueImport(name));
        this.applyIndexingMode();
    }

    setIndexingMode(mode: WorkspaceIndexingMode): void {
        if (this.indexingMode === mode) {
            return;
        }

        this.indexingMode = mode;
        this.backgroundQueue = [];
        this.clearIdleTimer();
        this.rebuildQueuedSet();
        this.applyIndexingMode();
    }

    /** Совместимость со старым API. */
    setBackgroundIndexingEnabled(enabled: boolean): void {
        this.setIndexingMode(enabled ? "full" : "activeImports");
    }

    startBackgroundIndexing(): void {
        if (this.indexingMode === "activeImports") {
            return;
        }

        for (const uri of this.workspaceUris) {
            if (!this.index.getModule(uri)) {
                this.enqueue(uri, "background");
            }
        }

        this.reportProgress();
    }

    enqueueImport(name: string): void {
        if (!name) {
            return;
        }

        if (this.index.workspaceFilesReady === false) {
            this.pendingImportNames.add(name);
            return;
        }

        const resolution = this.index.resolveWorkspaceFile(name);

        if (resolution.kind === "resolved") {
            this.enqueue(resolution.value, "interactive");
            return;
        }

        if (resolution.kind === "missing") {
            this.options.requestMissingImport?.(name);
        }
    }

    enqueue(uri: string, priority: ModuleLoadPriority): void {
        if (!uri || this.index.getModule(uri) || this.runningUri === uri) {
            return;
        }

        if (this.queued.has(uri)) {
            if (priority === "interactive") {
                this.backgroundQueue = this.backgroundQueue.filter(
                    item => item !== uri
                );

                if (!this.interactiveQueue.includes(uri)) {
                    this.interactiveQueue.push(uri);
                }
            }

            this.processQueue();
            return;
        }

        this.queued.add(uri);

        if (priority === "interactive") {
            this.interactiveQueue.push(uri);
        } else {
            this.backgroundQueue.push(uri);
        }

        this.processQueue();
    }

    async ensureLoadedByName(name: string): Promise<IIndexedModule | undefined> {
        const loaded = this.index.findModuleByName(name);

        if (loaded) {
            return loaded;
        }

        const resolution = this.index.resolveWorkspaceFile(name);
        return resolution.kind === "resolved"
            ? this.ensureLoadedUri(resolution.value)
            : undefined;
    }

    async ensureLoadedUri(uri: string): Promise<IIndexedModule | undefined> {
        const loaded = this.index.getModule(uri);

        if (loaded) {
            return loaded;
        }

        this.removeQueued(uri);
        return this.loadOnce(uri);
    }

    async reload(uri: string): Promise<void> {
        this.removeQueued(uri);
        await this.loadOnce(uri);
    }

    remove(uri: string): void {
        this.removeQueued(uri);
        this.workspaceUris.delete(uri);
        this.indexedUris.delete(uri);
        this.index.unregisterWorkspaceFile(uri);
        this.index.removeModule(uri);
        this.options.onModuleCountChanged();
        this.reportProgress();
    }

    get isIndexing(): boolean {
        return this.running ||
            this.interactiveQueue.length > 0 ||
            this.backgroundQueue.length > 0;
    }

    get indexedCount(): number {
        return this.indexedUris.size;
    }

    get totalCount(): number {
        return this.workspaceUris.size;
    }

    get mode(): WorkspaceIndexingMode {
        return this.indexingMode;
    }

    private applyIndexingMode(): void {
        if (this.indexingMode === "full") {
            this.startBackgroundIndexing();
        } else if (this.indexingMode === "workspaceIdle") {
            this.clearIdleTimer();
            this.idleTimer = setTimeout(() => {
                this.idleTimer = undefined;
                this.startBackgroundIndexing();
            }, this.idleDelayMs);
        }
    }

    private clearIdleTimer(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }
    }

    private processQueue(): void {
        if (this.running) {
            return;
        }

        const uri = this.interactiveQueue.shift() ||
            this.backgroundQueue.shift();

        if (!uri) {
            this.reportProgress();
            return;
        }

        this.running = true;
        this.runningUri = uri;

        setImmediate(() => {
            this.loadOnce(uri).catch(error => {
                this.options.log(
                    `Background module load failed: ${uri}\n` +
                    errorToString(error)
                );
            }).finally(() => {
                this.queued.delete(uri);
                this.running = false;
                this.runningUri = undefined;
                this.reportProgress();
                this.processQueue();
            });
        });
    }

    private loadOnce(uri: string): Promise<IIndexedModule | undefined> {
        const running = this.loadingPromises.get(uri);

        if (running) {
            return running;
        }

        const created = this.load(uri).finally(() => {
            this.loadingPromises.delete(uri);
        });
        this.loadingPromises.set(uri, created);
        return created;
    }

    private async load(uri: string): Promise<IIndexedModule | undefined> {
        let filePath: string;

        try {
            filePath = fileURLToPath(uri);
        } catch (_error) {
            return undefined;
        }

        const stat = await fs.promises.stat(filePath);
        const text = await fs.promises.readFile(filePath, "utf8");
        const module = this.index.updateExternalModule(
            uri,
            text,
            Math.floor(stat.mtimeMs)
        );
        this.indexedUris.add(uri);

        for (const importName of module.imports) {
            const resolution = this.index.resolveWorkspaceFile(importName);

            if (resolution.kind === "resolved") {
                this.enqueue(resolution.value, "interactive");
            }
        }

        this.options.onModuleLoaded(module);
        this.options.onModuleCountChanged();
        return module;
    }

    private removeQueued(uri: string): void {
        this.interactiveQueue = this.interactiveQueue.filter(item => item !== uri);
        this.backgroundQueue = this.backgroundQueue.filter(item => item !== uri);
        this.queued.delete(uri);
    }

    private rebuildQueuedSet(): void {
        this.queued = new Set([
            ...this.interactiveQueue,
            ...this.backgroundQueue
        ]);
    }

    private reportProgress(): void {
        this.options.onIndexProgress?.(this.indexedCount, this.totalCount);
    }
}

function errorToString(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}\n${error.stack || ""}`;
    }

    return String(error);
}

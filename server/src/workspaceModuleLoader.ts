import * as fs from "fs";
import { fileURLToPath } from "url";

import { CBase } from "./common";
import type { IIndexedModule, WorkspaceIndex } from "./workspaceIndex";

export type ModuleLoadPriority = "interactive" | "background";

export interface IWorkspaceModuleLoaderOptions {
    log(message: string): void;
    onModuleLoaded(module: IIndexedModule): void;
    onModuleCountChanged(): void;
    onIndexProgress?(loaded: number, total: number): void;
    requestMissingImport?(name: string): void;
}

/**
 * Последовательная очередь I/O и разбора закрытых .mac.
 * Интерактивные Import имеют приоритет перед фоновым обходом workspace.
 */
export class WorkspaceModuleLoader {
    private interactiveQueue: string[] = [];
    private backgroundQueue: string[] = [];
    private queued = new Set<string>();
    private workspaceUris = new Set<string>();
    private running = false;
    private runningUri: string | undefined;
    private backgroundEnabled = true;

    constructor(
        private index: WorkspaceIndex,
        private options: IWorkspaceModuleLoaderOptions
    ) {}

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
            this.index.unregisterWorkspaceFile(uri);
            const module = this.index.getModule(uri);

            if (module && !module.isOpen) {
                this.index.removeModule(uri);
            }
        }

        this.workspaceUris = nextUris;
        this.index.registerWorkspaceFiles(Array.from(this.workspaceUris));

        if (this.backgroundEnabled) {
            this.startBackgroundIndexing();
        }
    }

    setBackgroundIndexingEnabled(enabled: boolean): void {
        this.backgroundEnabled = enabled;

        if (enabled) {
            this.startBackgroundIndexing();
        } else {
            this.backgroundQueue = [];
            this.rebuildQueuedSet();
        }
    }

    startBackgroundIndexing(): void {
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

        const resolution = this.index.resolveWorkspaceFile(name);

        if (resolution.kind === "resolved") {
            this.enqueue(resolution.value, "interactive");
            return;
        }

        if (resolution.kind === "missing") {
            this.options.requestMissingImport?.(name);
        }
        /* ambiguous Import остаётся диагностикой и не выбирается молча. */
    }

    enqueue(uri: string, priority: ModuleLoadPriority): void {
        if (
            !uri ||
            this.index.getModule(uri) ||
            this.runningUri === uri
        ) {
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

    async reload(uri: string): Promise<void> {
        this.removeQueued(uri);
        await this.load(uri);
    }

    remove(uri: string): void {
        this.removeQueued(uri);
        this.workspaceUris.delete(uri);
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
        return Array.from(this.workspaceUris)
            .filter(uri => !!this.index.getModule(uri)).length;
    }

    get totalCount(): number {
        return this.workspaceUris.size;
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
            this.load(uri).catch(error => {
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

    private async load(uri: string): Promise<void> {
        let filePath: string;

        try {
            filePath = fileURLToPath(uri);
        } catch (_error) {
            return;
        }

        const text = await fs.promises.readFile(filePath, "utf8");
        const stat = await fs.promises.stat(filePath);
        const tree = CBase.forExternalModule(text);
        const module = this.index.updateModule(
            uri,
            text,
            tree,
            Math.floor(stat.mtimeMs),
            false
        );

        for (const importName of module.imports) {
            const resolution = this.index.resolveWorkspaceFile(importName);

            if (resolution.kind === "resolved") {
                this.enqueue(resolution.value, "interactive");
            }
        }

        this.options.onModuleLoaded(module);
        this.options.onModuleCountChanged();
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
        this.options.onIndexProgress?.(
            this.indexedCount,
            this.totalCount
        );
    }
}

function errorToString(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}\n${error.stack || ""}`;
    }

    return String(error);
}

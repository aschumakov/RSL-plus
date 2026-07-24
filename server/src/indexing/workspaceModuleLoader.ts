import * as fs from "fs";
import { fileURLToPath } from "url";

import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";
import { ReferenceIndex } from "../analysis/referenceIndex";
import type { PerformanceLogger } from "../performanceLogger";

export type ModuleLoadPriority = "foreground" | "background";
export type WorkspaceIndexingMode = "activeImports" | "workspaceIdle" | "full";

interface IQueuedModule {
    uri: string;
    priority: ModuleLoadPriority;
    generation: number;
}

export interface IWorkspaceModuleLoaderOptions {
    log(message: string): void;
    performance?: PerformanceLogger;
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
    private foregroundQueue: IQueuedModule[] = [];
    private backgroundQueue: IQueuedModule[] = [];
    private queued = new Map<string, IQueuedModule>();
    private workspaceUris = new Set<string>();
    private indexedUris = new Set<string>();
    private pendingImportNames = new Map<string, IQueuedModule>();
    private running = false;
    private runningUri: string | undefined;
    private runningItem: IQueuedModule | undefined;
    private foregroundGeneration = 0;
    private loadingPromises = new Map<
        string,
        Promise<IIndexedModule | undefined>
    >();
    private indexingMode: WorkspaceIndexingMode = "activeImports";
    private idleTimer: NodeJS.Timeout | undefined;
    private idleDelayMs: number;

    private referenceIndex: ReferenceIndex;

    constructor(
        private index: WorkspaceIndex,
        private options: IWorkspaceModuleLoaderOptions,
        referenceIndex?: ReferenceIndex
    ) {
        this.referenceIndex = referenceIndex || new ReferenceIndex({
            log: options.log
        });
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
        const workspaceList = Array.from(this.workspaceUris);
        this.index.registerWorkspaceFiles(workspaceList);
        this.referenceIndex.retainWorkspaceFiles(workspaceList);

        const pending = Array.from(this.pendingImportNames.values());
        this.pendingImportNames.clear();
        pending.forEach(item => this.enqueueImport(
            item.uri,
            item.priority,
            item.generation
        ));
        this.applyIndexingMode();
    }

    setIndexingMode(mode: WorkspaceIndexingMode): void {
        if (this.indexingMode === mode) {
            return;
        }

        this.indexingMode = mode;
        this.backgroundQueue = [];
        this.clearIdleTimer();
        this.rebuildQueuedMap();
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

    /**
     * Начинает новую интерактивную ветвь анализа.
     * Остаток очереди предыдущего активного документа сохраняется, но
     * переводится в фон и больше не может задержать новый документ.
     */
    beginForegroundGeneration(): void {
        this.foregroundGeneration++;

        for (const item of this.foregroundQueue) {
            item.priority = "background";
            item.generation = 0;
            this.backgroundQueue.push(item);
        }
        this.foregroundQueue = [];

        for (const item of this.pendingImportNames.values()) {
            if (item.priority === "foreground") {
                item.priority = "background";
                item.generation = 0;
            }
        }

        this.rebuildQueuedMap();
    }

    enqueueImports(
        names: readonly string[],
        priority: ModuleLoadPriority = "foreground"
    ): void {
        const generation = priority === "foreground"
            ? this.foregroundGeneration
            : 0;

        for (const name of names) {
            this.enqueueImport(name, priority, generation);
        }
    }

    enqueueImport(
        name: string,
        priority: ModuleLoadPriority = "foreground",
        generation = priority === "foreground"
            ? this.foregroundGeneration
            : 0
    ): void {
        if (!name) {
            return;
        }

        if (this.index.workspaceFilesReady === false) {
            const pending = this.pendingImportNames.get(name);

            if (!pending || priority === "foreground") {
                this.pendingImportNames.set(name, {
                    uri: name,
                    priority,
                    generation
                });
            }
            return;
        }

        const resolution = this.index.resolveWorkspaceFile(name);

        if (resolution.kind === "resolved") {
            this.enqueue(resolution.value, priority, generation);
            return;
        }

        if (resolution.kind === "missing") {
            this.options.requestMissingImport?.(name);
        }
    }

    enqueue(
        uri: string,
        priority: ModuleLoadPriority,
        generation = priority === "foreground"
            ? this.foregroundGeneration
            : 0
    ): void {
        if (!uri || this.index.getModule(uri)) {
            return;
        }

        if (this.runningUri === uri) {
            if (priority === "foreground" && this.runningItem) {
                this.runningItem.priority = "foreground";
                this.runningItem.generation = this.foregroundGeneration;
            }
            return;
        }

        const queued = this.queued.get(uri);

        if (queued) {
            if (priority === "foreground" && (
                queued.priority !== "foreground" ||
                queued.generation !== this.foregroundGeneration
            )) {
                this.removeQueued(uri);
                const promoted: IQueuedModule = {
                    uri,
                    priority: "foreground",
                    generation: this.foregroundGeneration
                };
                this.queued.set(uri, promoted);
                this.foregroundQueue.push(promoted);
            }

            this.processQueue();
            return;
        }

        const item: IQueuedModule = {
            uri,
            priority,
            generation: priority === "foreground"
                ? generation
                : 0
        };
        this.queued.set(uri, item);

        if (priority === "foreground") {
            this.foregroundQueue.push(item);
        } else {
            this.backgroundQueue.push(item);
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

        if (this.runningUri === uri && this.runningItem) {
            this.runningItem.priority = "foreground";
            this.runningItem.generation = this.foregroundGeneration;
        }
        this.removeQueued(uri);
        return this.loadOnce(uri, {
            uri,
            priority: "foreground",
            generation: this.foregroundGeneration
        });
    }

    /**
     * Интерактивно загружает только Import-ветвь до первого подходящего
     * публичного символа. Используется Ctrl+Click, если фоновая очередь ещё
     * не успела построить нужную часть графа.
     */
    async ensureImportedSymbol(
        fromUri: string,
        symbolName: string
    ): Promise<boolean> {
        if (this.index.findImportedSymbols(fromUri, symbolName).length > 0) {
            return true;
        }

        const root = this.index.getModule(fromUri);

        if (!root) {
            return false;
        }

        const queue = root.imports.slice();
        const visitedNames = new Set<string>();
        const visitedUris = new Set<string>([fromUri]);

        for (let position = 0; position < queue.length; position++) {
            const importName = queue[position];
            const key = importName.replace(/\\/g, "/").toLowerCase();

            if (visitedNames.has(key)) {
                continue;
            }
            visitedNames.add(key);

            const imported = await this.ensureLoadedByName(importName);

            if (!imported || visitedUris.has(imported.uri)) {
                continue;
            }
            visitedUris.add(imported.uri);

            if (
                this.index.findImportedSymbols(fromUri, symbolName).length > 0
            ) {
                return true;
            }

            queue.push(...imported.imports);
        }

        return this.index.findImportedSymbols(fromUri, symbolName).length > 0;
    }

    async reload(uri: string): Promise<void> {
        this.removeQueued(uri);
        await this.loadOnce(uri, {
            uri,
            priority: "foreground",
            generation: this.foregroundGeneration
        });
    }

    remove(uri: string): void {
        this.removeQueued(uri);
        this.workspaceUris.delete(uri);
        this.indexedUris.delete(uri);
        this.referenceIndex.invalidate(uri);
        this.index.unregisterWorkspaceFile(uri);
        this.index.removeModule(uri);
        this.options.onModuleCountChanged();
        this.reportProgress();
    }

    get isIndexing(): boolean {
        return this.running ||
            this.foregroundQueue.length > 0 ||
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

        const item = this.foregroundQueue.shift() ||
            this.backgroundQueue.shift();

        if (!item) {
            this.reportProgress();
            return;
        }

        const { uri } = item;
        this.running = true;
        this.runningUri = uri;
        this.runningItem = item;

        setImmediate(() => {
            this.loadOnce(uri, item).catch(error => {
                this.options.log(
                    `Background module load failed: ${uri}\n` +
                    errorToString(error)
                );
            }).finally(() => {
                this.queued.delete(uri);
                this.running = false;
                this.runningUri = undefined;
                this.runningItem = undefined;
                this.reportProgress();
                this.processQueue();
            });
        });
    }

    private loadOnce(
        uri: string,
        item?: IQueuedModule
    ): Promise<IIndexedModule | undefined> {
        const running = this.loadingPromises.get(uri);

        if (running) {
            return running;
        }

        const created = this.load(uri, item).finally(() => {
            this.loadingPromises.delete(uri);
        });
        this.loadingPromises.set(uri, created);
        return created;
    }

    private async load(
        uri: string,
        item?: IQueuedModule
    ): Promise<IIndexedModule | undefined> {
        let filePath: string;

        try {
            filePath = fileURLToPath(uri);
        } catch (_error) {
            return undefined;
        }

        const performance = this.options.performance;
        const loadSpan = performance?.enabled
            ? performance.start("workspaceModule.load", {
                uri,
                priority: item?.priority || "foreground",
                generation: item?.generation || 0
            })
            : undefined;
        const ioSpan = performance?.enabled
            ? performance.start("workspaceModule.io", { uri })
            : undefined;
        const [stat, text] = await Promise.all([
            fs.promises.stat(filePath),
            fs.promises.readFile(filePath, "utf8")
        ]);
        if (ioSpan) {
            performance.end(ioSpan, {
                chars: text.length
            });
        }
        const indexSpan = performance?.enabled
            ? performance.start("workspaceModule.index", {
                uri,
                chars: text.length
            })
            : undefined;
        const module = this.index.updateExternalModule(
            uri,
            text,
            Math.floor(stat.mtimeMs)
        );
        if (indexSpan) {
            performance.end(indexSpan, {
                imports: module.imports.length,
                topLevelSymbols: module.object.getChilds().length
            });
        }
        this.indexedUris.add(uri);

        const keepForeground = item?.priority === "foreground" &&
            item.generation === this.foregroundGeneration;
        const childPriority: ModuleLoadPriority = keepForeground
            ? "foreground"
            : "background";
        const childGeneration = keepForeground
            ? item.generation
            : 0;

        for (const importName of module.imports) {
            const resolution = this.index.resolveWorkspaceFile(importName);

            if (resolution.kind === "resolved") {
                this.enqueue(
                    resolution.value,
                    childPriority,
                    childGeneration
                );
            }
        }

        this.options.onModuleLoaded(module);
        this.options.onModuleCountChanged();
        if (loadSpan) {
            performance.end(loadSpan, {
                chars: text.length,
                imports: module.imports.length,
                indexedModules: this.index.size
            });
        }
        return module;
    }

    private removeQueued(uri: string): void {
        this.foregroundQueue = this.foregroundQueue.filter(
            item => item.uri !== uri
        );
        this.backgroundQueue = this.backgroundQueue.filter(
            item => item.uri !== uri
        );
        this.queued.delete(uri);
    }

    private rebuildQueuedMap(): void {
        this.queued = new Map([
            ...this.foregroundQueue,
            ...this.backgroundQueue
        ].map(item => [item.uri, item]));
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

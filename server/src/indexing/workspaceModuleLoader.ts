import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";
import { ReferenceIndex } from "../analysis/referenceIndex";
import type { PerformanceLogger } from "../performanceLogger";
import {
    systemRslClock,
    type IRslClock,
    type IRslTimerHandle
} from "../core/clock";
import { normalizeIdentifier } from "../lexer";
import { pickDeterministicCandidate } from "./moduleNames";
import { readCompactModule } from "./compactModuleReader";
import type {
    CompactModulePriority,
    ICompactModuleIndexer,
    ICompactModuleResponse
} from "./compactModuleProtocol";

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
    /**
     * Компактная индексация внешних файлов в отдельном потоке.
     *
     * Без него чтение и сканирование выполняются на основном потоке — это и
     * есть резервный путь: если worker не запустился (ограниченная среда,
     * упавший поток), навигация по Import обязана продолжать работать, пусть
     * и с блокировкой основного потока на время сканирования.
     */
    compactModules?: ICompactModuleIndexer;
    onModuleLoaded(module: IIndexedModule): void;
    onModuleCountChanged(): void;
    onIndexProgress?(loaded: number, total: number): void;
    /**
     * Часы службы: задержки и текущее время.
     *
     * По умолчанию системные. Тесты расписания подставляют виртуальные и
     * двигают время сами — иначе проверка склейки правок и пауз стоит
     * секунд реального ожидания на каждый случай.
     */
    clock?: IRslClock;
    idleDelayMs?: number;
    interactivePauseMs?: number;
}

export interface IExportSearchOptions {
    scanWorkspace?: boolean;
    isCancelled?(): boolean;
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
    /* Имена, о которых уже сказано в лог: без этого он растёт на каждый разбор. */
    private reportedMissingImports = new Set<string>();
    private running = false;
    private runningUri: string | undefined;
    private runningItem: IQueuedModule | undefined;
    private foregroundGeneration = 0;
    private loadingPromises = new Map<
        string,
        Promise<IIndexedModule | undefined>
    >();
    private exportSearchCache = new Map<string, string[]>();
    /*
     * Версия содержимого файла для загрузчика.
     *
     * Ответ на запрос к worker приходит асинхронно, и за это время файл могли
     * изменить, удалить или исключить из проекта. Само по себе поколение
     * очереди этого не ловит: оно про приоритет ветви Import, а не про то,
     * актуально ли прочитанное содержимое. Номер увеличивается на каждое
     * такое событие, и ответ со старым номером отбрасывается.
     */
    private fileEpochs = new Map<string, number>();
    private indexingMode: WorkspaceIndexingMode = "activeImports";
    private idleTimer: IRslTimerHandle | undefined;
    private readonly clock: IRslClock;
    private idleDelayMs: number;
    private interactivePauseMs: number;
    private interactiveUntilMs = 0;
    private backgroundResumeTimer: IRslTimerHandle | undefined;

    private referenceIndex: ReferenceIndex;

    constructor(
        private index: WorkspaceIndex,
        private options: IWorkspaceModuleLoaderOptions,
        referenceIndex?: ReferenceIndex
    ) {
        this.referenceIndex = referenceIndex || new ReferenceIndex({
            log: options.log
        });
        this.clock = options.clock ?? systemRslClock;
        this.idleDelayMs = Math.max(1000, options.idleDelayMs ?? 10000);
        this.interactivePauseMs = Math.max(
            0,
            options.interactivePauseMs ?? 350
        );
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
            /* Файл больше не в проекте: ответ по нему уже не нужен. */
            this.bumpEpoch(uri);
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
        this.exportSearchCache.clear();

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

    /** Фоновая индексация уступает короткому всплеску запросов редактора. */
    noteInteractiveActivity(): void {
        this.interactiveUntilMs = this.clock.now() + this.interactivePauseMs;

        if (this.indexingMode === "workspaceIdle") {
            this.clearIdleTimer();
            this.applyIndexingMode();
        }

        if (!this.running && this.backgroundQueue.length > 0) {
            this.scheduleBackgroundResume();
        }
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
            /*
             * Модуля нет среди .mac проекта — и это не ошибка: Import
             * бывает у модуля RSM, DLM или встроенного, которых в
             * workspace нет вовсе.
             *
             * Прежде сервер просил клиента найти файл по имени и открыть
             * его. Открытый анализом документ получал didOpen, ломал
             * preview-вкладку пользователя и заодно запускал глобальный
             * findFiles в Extension Host. Каталог файлов строит сам
             * сервер (WorkspaceFileDiscoveryService), и до его готовности
             * имя ждёт в очереди выше.
             */
            if (!this.reportedMissingImports.has(name)) {
                this.reportedMissingImports.add(name);
                this.options.log(
                    `Import "${name}" is not a workspace .mac file`
                );
            }

            return;
        }

        /*
         * Неоднозначный Import раньше молча пропускался: ничего не
         * загружалось, а Ctrl+Click/Completion для символов из такого
         * Import не работали без единого сообщения в лог. Детерминированный
         * выбор хотя бы одного кандидата сохраняет навигацию рабочей;
         * пользователя предупреждает отдельная диагностика ambiguous-import.
         */
        const chosen = pickDeterministicCandidate(
            resolution.candidates,
            uri => uri
        );
        this.options.log(
            `Ambiguous import "${name}" resolved to ${chosen} ` +
            `(candidates: ${resolution.candidates.join(", ")})`
        );
        this.enqueue(chosen, priority, generation);
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

    /**
     * Точный поиск модулей, экспортирующих символ. Полный workspace читается
     * только по явному Quick Fix; обычный Completion использует уже известные
     * compact summaries и не запускает этот обход.
     */
    async findModulesExportingSymbol(
        symbolName: string,
        maxResults: number = 10,
        options: IExportSearchOptions = {}
    ): Promise<IIndexedModule[]> {
        const normalized = normalizeIdentifier(symbolName);
        if (!normalized) {
            return [];
        }

        const known = this.index.findSymbols(normalized)
            .filter(symbol => !symbol.symbol.isPrivate)
            .map(symbol => this.index.getModule(symbol.uri))
            .filter((module): module is IIndexedModule => !!module);
        const uniqueKnown = uniqueModules(known);

        if (options.isCancelled?.()) {
            return uniqueKnown.slice(0, maxResults);
        }

        const cachedUris = this.exportSearchCache.get(normalized);
        if (cachedUris) {
            return cachedUris
                .map(uri => this.index.getModule(uri))
                .filter((module): module is IIndexedModule => !!module)
                .slice(0, maxResults);
        }

        /* Автоматический lightbulb не имеет права сканировать весь проект. */
        if (options.scanWorkspace === false) {
            return uniqueKnown.slice(0, maxResults);
        }

        const candidates = Array.from(this.workspaceUris).filter(uri =>
            !this.index.getModule(uri)
        );
        const result: IIndexedModule[] = uniqueKnown.slice(0, maxResults);
        const batchSize = 16;
        const maxScanFiles = 500;
        const scanLimit = Math.min(candidates.length, maxScanFiles);

        for (
            let start = 0;
            start < scanLimit && result.length < maxResults;
            start += batchSize
        ) {
            if (options.isCancelled?.()) {
                return result;
            }
            const batch = candidates.slice(start, start + batchSize);
            const matches = await Promise.all(batch.map(uri =>
                this.inspectExport(uri, normalized)
            ));

            for (const module of matches) {
                if (module) {
                    result.push(module);
                    if (result.length >= maxResults) {
                        break;
                    }
                }
            }

            await yieldToInteractiveRequests();
        }

        if (
            result.length < maxResults &&
            candidates.length > maxScanFiles
        ) {
            this.options.log(
                `Export search for "${symbolName}" stopped after ` +
                `${maxScanFiles} files; ${candidates.length - maxScanFiles} ` +
                "unindexed workspace files were not scanned."
            );
        }

        if (options.isCancelled?.()) {
            return result;
        }

        this.exportSearchCache.set(
            normalized,
            result.map(module => module.uri)
        );
        return result;
    }

    async reload(uri: string): Promise<void> {
        this.exportSearchCache.clear();
        this.removeQueued(uri);
        /*
         * Файл изменился: уже полученный ответ относится к прежнему
         * содержимому и должен быть отброшен.
         */
        this.bumpEpoch(uri);
        const epoch = this.epochOf(uri);

        /*
         * Дедупликация по uri не должна превратить перезагрузку в ожидание
         * устаревшего запроса: его результат уже отброшен по epoch, поэтому
         * дожидаемся завершения и читаем файл заново.
         */
        const running = this.loadingPromises.get(uri);
        if (running) {
            await running.catch(() => undefined);

            /*
             * За время ожидания файл могли удалить или исключить из проекта.
             * Проверять это обязательно здесь: повторное чтение получит уже
             * свежий epoch, и staleReason в load() пропустит ответ, вернув
             * исключённый файл в индекс.
             */
            const cancelled = this.reloadCancelReason(uri, epoch);
            if (cancelled) {
                this.options.log(
                    `Reload skipped: ${uri}; reason=${cancelled}`
                );
                return;
            }
        }

        await this.loadOnce(uri, {
            uri,
            priority: "foreground",
            generation: this.foregroundGeneration
        });
    }

    remove(uri: string): void {
        this.exportSearchCache.clear();
        this.removeQueued(uri);
        /* Ответ на запрос, начатый до удаления, не должен вернуть модуль. */
        this.bumpEpoch(uri);
        this.workspaceUris.delete(uri);
        this.indexedUris.delete(uri);
        this.referenceIndex.invalidate(uri);
        this.index.unregisterWorkspaceFile(uri);
        this.index.removeModule(uri);
        this.options.onModuleCountChanged();
        this.reportProgress();
    }

    private epochOf(uri: string): number {
        return this.fileEpochs.get(uri) ?? 0;
    }

    private bumpEpoch(uri: string): void {
        this.fileEpochs.set(uri, this.epochOf(uri) + 1);
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
            this.idleTimer = this.clock.setTimeout(() => {
                this.idleTimer = undefined;
                this.startBackgroundIndexing();
            }, this.idleDelayMs);
        }
    }

    private clearIdleTimer(): void {
        if (this.idleTimer) {
            this.clock.clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }
    }

    private processQueue(): void {
        if (this.running) {
            return;
        }

        const foreground = this.foregroundQueue.shift();
        if (
            !foreground &&
            this.backgroundQueue.length > 0 &&
            this.clock.now() < this.interactiveUntilMs
        ) {
            this.scheduleBackgroundResume();
            return;
        }

        const item = foreground || this.backgroundQueue.shift();

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

    private scheduleBackgroundResume(): void {
        if (this.backgroundResumeTimer) {
            this.clock.clearTimeout(this.backgroundResumeTimer);
        }

        const delay = Math.max(1, this.interactiveUntilMs - this.clock.now());
        this.backgroundResumeTimer = this.clock.setTimeout(() => {
            this.backgroundResumeTimer = undefined;
            this.processQueue();
        }, delay);
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
        const performance = this.options.performance;
        const loadSpan = performance?.enabled
            ? performance.start("workspaceModule.load", {
                uri,
                priority: item?.priority || "foreground",
                generation: item?.generation || 0
            })
            : undefined;
        const known = this.index.getModule(uri);
        /* Номер фиксируется ДО запроса: сравнивать будем с ним. */
        const epoch = this.epochOf(uri);
        const response = await this.readCompactModule({
            uri,
            generation: item?.generation ?? 0,
            priority: item?.priority ?? "foreground",
            /*
             * Известный отпечаток позволяет worker'у ответить unchanged, не
             * сканируя файл. Нужно для reload(): наблюдатель за файлами
             * срабатывает и на сохранение без изменений.
             *
             * Отпечаток берётся только у внешнего модуля: у открытого в
             * индексе лежит модель из буфера редактора, и с содержимым на
             * диске она не связана.
             */
            knownFingerprint: known && !known.isOpen
                ? known.fingerprint
                : undefined
        });

        if (response.status !== "indexed") {
            if (response.status === "missing" || response.status === "failed") {
                this.options.log(
                    `Compact indexing skipped: ${uri}; ` +
                    `status=${response.status}; ${response.error ?? ""}`
                );
            }
            if (loadSpan) {
                performance.end(loadSpan, { outcome: response.status });
            }
            return response.status === "unchanged" ? known : undefined;
        }

        const stale = this.staleReason(uri, epoch);
        if (stale) {
            if (loadSpan) {
                performance.end(loadSpan, { outcome: stale });
            }
            return undefined;
        }

        const indexSpan = performance?.enabled
            ? performance.start("workspaceModule.index", {
                uri,
                chars: response.sourceLength
            })
            : undefined;
        const module = this.index.updateExternalModuleFromDeclarations(
            uri,
            response.sourceLength,
            {
                declarations: response.declarations,
                imports: response.imports
            },
            response.mtimeMs,
            response.fingerprint
        );
        if (indexSpan) {
            performance.end(indexSpan, {
                imports: module.imports.length,
                topLevelSymbols: module.symbolTree.children.length,
                reusedScan: response.reused
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
                outcome: "indexed",
                chars: response.sourceLength,
                imports: module.imports.length,
                indexedModules: this.index.size,
                reusedScan: response.reused
            });
        }
        return module;
    }

    /**
     * Причина отбросить уже полученный компактный результат, либо undefined.
     *
     * Пока запрос шёл в worker, могло случиться два события. Файл открыли в
     * редакторе — тогда в индексе лежит точная модель, и перезапись её
     * компактной означала бы потерю областей видимости и AST до следующего
     * разбора. Либо файл изменили, удалили или исключили из проекта — тогда
     * прочитанное содержимое уже не соответствует диску, и индексировать его
     * нельзя ни при каких условиях.
     *
     * Поколение очереди здесь не проверяется намеренно: разбор уже выполнен,
     * данные корректны, и выбрасывать их только потому, что пользователь
     * успел переключить вкладку, значит считать их заново при возврате. На
     * приоритет это влияет — дочерние Import уходят в фон.
     */
    private staleReason(uri: string, epoch: number): string | undefined {
        if (this.epochOf(uri) !== epoch) {
            return "fileChanged";
        }

        return this.index.getModule(uri)?.isOpen === true
            ? "documentOpened"
            : undefined;
    }

    /**
     * Причина не начинать повторное чтение после ожидания старого запроса.
     *
     * staleReason проверяет уже полученный ответ и здесь не помогает: он
     * сравнивает epoch, зафиксированный ПЕРЕД запросом, а новый запрос
     * стартовал бы уже после исключения — со свежим epoch. Поэтому события,
     * случившиеся во время ожидания, отсекаются отдельно.
     *
     * Каталог проекта здесь авторитетнее собственного workspaceUris: файл,
     * созданный во время сессии, попадает в каталог сразу по событию
     * наблюдателя, а в workspaceUris — только со следующим обходом проекта.
     */
    private reloadCancelReason(
        uri: string,
        epoch: number
    ): string | undefined {
        if (this.epochOf(uri) !== epoch) {
            return "fileChanged";
        }

        return this.index.workspaceFilesReady !== false &&
            !this.index.hasWorkspaceFile(uri)
            ? "notInWorkspace"
            : undefined;
    }

    /**
     * Компактный разбор внешнего файла: обычно в worker, иначе на месте.
     *
     * Ответ worker'а не отклоняется исключениями — недоступный файл и
     * упавший поток приходят как status, потому что для загрузчика это
     * штатные исходы очереди.
     */
    private async readCompactModule(
        request: {
            uri: string;
            generation: number;
            knownFingerprint?: string;
            expectedExport?: string;
            priority?: CompactModulePriority;
        }
    ): Promise<ICompactModuleResponse> {
        const indexer = this.options.compactModules;

        if (indexer) {
            const response = await indexer.index(request);

            if (response.status !== "failed") {
                return response;
            }

            this.options.log(
                `Compact indexing worker failed, using main thread: ` +
                `${request.uri}; ${response.error ?? ""}`
            );
        }

        return readCompactModule({ ...request, id: 0 });
    }

    /**
     * Адресная проверка: экспортирует ли файл нужное имя.
     *
     * Идёт через тот же worker, что обычная загрузка, поэтому обход
     * кандидатов по явно вызванному Auto Import не блокирует основной поток.
     * Файл, который имени не экспортирует, не попадает в индекс — иначе поиск
     * по одному символу раздувал бы индекс всеми просмотренными файлами.
     */
    private async inspectExport(
        uri: string,
        normalizedName: string
    ): Promise<IIndexedModule | undefined> {
        const epoch = this.epochOf(uri);
        const response = await this.readCompactModule({
            uri,
            generation: this.foregroundGeneration,
            expectedExport: normalizedName,
            /*
             * Обход кандидатов ставит в очередь сразу пачку файлов (batchSize
             * в findModulesExportingSymbol). С приоритетом активного документа
             * она задерживала бы адресную навигацию: FIFO внутри очереди
             * означает, что Ctrl+Click оказывается за всей пачкой. Отдельный
             * уровень search держит лампочку впереди индексации проекта, но
             * позади того, чего пользователь ждёт прямо сейчас.
             */
            priority: "search"
        });

        if (
            response.status !== "indexed" ||
            response.exportsRequestedName !== true ||
            this.staleReason(uri, epoch)
        ) {
            return undefined;
        }

        const module = this.index.updateExternalModuleFromDeclarations(
            uri,
            response.sourceLength,
            {
                declarations: response.declarations,
                imports: response.imports
            },
            response.mtimeMs,
            response.fingerprint
        );
        this.indexedUris.add(uri);
        this.options.onModuleLoaded(module);
        this.options.onModuleCountChanged();
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

function uniqueModules(items: readonly IIndexedModule[]): IIndexedModule[] {
    const result: IIndexedModule[] = [];
    const seen = new Set<string>();

    for (const item of items) {
        if (!seen.has(item.uri)) {
            seen.add(item.uri);
            result.push(item);
        }
    }

    return result;
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

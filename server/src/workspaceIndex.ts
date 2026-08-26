import { CompletionItem } from "vscode-languageserver";

import { LruCache } from "./core/lruCache";
import {
    compactOpenModuleModel,
    createExternalModuleSummary,
    createExternalModuleSummaryFromDeclarations,
    createOpenModuleModel,
    type IRslModuleModel
} from "./moduleModel";
import type { IRslParseResult } from "./syntaxParser";
import type {
    IExternalLocationRange,
    IRslDeclarationSnapshot
} from "./analysis/declarationExtractor";
import type { RslSymbol } from "./symbols/rslSymbol";
import { FileCatalog } from "./indexing/fileCatalog";
import { WorkspaceCatalog } from "./indexing/workspaceCatalog";
import { ImportGraph } from "./indexing/importGraph";
import { ModuleStore } from "./indexing/moduleStore";
import { SymbolIndex } from "./indexing/symbolIndex";
import type {
    IIndexedModule,
    IIndexedSymbol,
    ModuleResolution
} from "./indexing/indexTypes";

export type { IIndexedModule, IIndexedSymbol, ModuleResolution } from
    "./indexing/indexTypes";

export interface IWorkspaceIndexOptions {
    importCacheEntries?: number;
    /** Верхняя граница числа external-модулей, не открытых в редакторе. */
    maxExternalModules?: number;
    /**
     * Верхняя граница их суммарного объёма.
     *
     * Числа модулей недостаточно: одна и та же тысяча сводок может стоить и
     * десятки мегабайт, и гигабайты — зависит от размеров файлов.
     */
    maxExternalBytes?: number;
}

interface IImportContext {
    modules: IIndexedModule[];
    symbolsByName: Map<string, IIndexedSymbol[]>;
    completionItems?: CompletionItem[];
    closureKey: string;
}

/**
 * Координатор независимых индексов. Он не хранит собственные копии каталогов,
 * символов или Import-рёбер и отвечает только за атомарное обновление модели.
 */
export class WorkspaceIndex {
    private readonly files = new FileCatalog();
    private readonly modules = new ModuleStore();
    private readonly symbols = new SymbolIndex();
    private readonly imports = new ImportGraph();
    private readonly importContexts: LruCache<string, IImportContext>;
    /*
     * Отслеживает порядок загрузки external-модулей (кроме открытых в
     * редакторе), чтобы workspaceIndexing: "full"/"workspaceIdle" не росли
     * неограниченно на очень больших проектах. Собственный cap этой
     * структуры не используется — реальное вытеснение считает
     * maxExternalModules ниже, чтобы дополнительно снести данные из
     * symbols/imports/importContexts через обычный removeModule().
     */
    private readonly externalModuleOrder = new LruCache<string, true>(
        Number.MAX_SAFE_INTEGER
    );
    private readonly maxExternalModules: number;
    /**
     * Объём сводки каждого внешнего модуля и их сумма.
     *
     * Размеры хранятся поимённо, а не одним счётчиком. Счётчик приходилось бы
     * править в шести местах — добавление, замена, открытие, закрытие,
     * удаление, очистка, — и первая же версия этого не делала: вычитания не
     * было нигде, а повторная запись того же модуля прибавляла второй раз.
     * Индекс из-за этого считал себя переполненным и вытеснял нужные модули.
     */
    private readonly externalSizeByUri = new Map<string, number>();
    private readonly maxExternalBytes: number;
    private externalBytes = 0;
    private importsEnabled = true;
    private revisionValue = 0;
    private catalogValue = new WorkspaceCatalog();

    constructor(options: IWorkspaceIndexOptions = {}) {
        this.importContexts = new LruCache(
            Math.max(1, options.importCacheEntries ?? 8)
        );
        this.maxExternalModules = Math.max(
            1,
            options.maxExternalModules ?? 4000
        );
        /*
         * 256 МБ исходников, из которых построены сводки. Порядок выбран по
         * тому же принципу, что и в компактном кэше: предел нужен не для
         * экономии, а чтобы очень большой проект не упирался в память,
         * оставаясь в пределах числа модулей.
         */
        this.maxExternalBytes = Math.max(
            1,
            options.maxExternalBytes ?? 256 * 1024 * 1024
        );
    }

    updateOpenModule(
        uri: string,
        source: string,
        version: number,
        parsedSyntax?: IRslParseResult
    ): IIndexedModule {
        return this.replace(
            uri,
            createOpenModuleModel(source, parsedSyntax),
            version,
            true
        );
    }

    /** Регистрирует заранее построенную полную модель открытого документа. */
    updateOpenModuleModel(
        uri: string,
        model: IRslModuleModel,
        version: number
    ): IIndexedModule {
        if (model.kind !== "open") {
            throw new Error("Expected an open RSL module model");
        }
        return this.replace(uri, model, version, true);
    }

    /**
     * Индексация внешнего модуля из исходного текста.
     *
     * Загрузчик workspace этим путём больше не пользуется: текст внешнего
     * файла в основной поток не попадает, результат приходит компактными
     * объявлениями (updateExternalModuleFromDeclarations). Метод оставлен для
     * тестов и прямой индексации, где текст уже на руках.
     */
    updateExternalModule(
        uri: string,
        source: string,
        version: number
    ): IIndexedModule {
        return this.replace(
            uri,
            createExternalModuleSummary(source),
            version,
            false
        );
    }

    updateExternalModuleFromDeclarations(
        uri: string,
        sourceLength: number,
        declarations: IRslDeclarationSnapshot,
        version: number,
        fingerprint?: string
    ): IIndexedModule {
        return this.replace(
            uri,
            createExternalModuleSummaryFromDeclarations(
                sourceLength,
                declarations
            ),
            version,
            false,
            fingerprint
        );
    }

    compactModule(uri: string): IIndexedModule | undefined {
        const current = this.modules.get(uri);
        if (!current) return undefined;
        if (current.kind === "external") {
            current.isOpen = false;
            return current;
        }
        return this.replace(
            uri,
            compactOpenModuleModel(current),
            current.version,
            false
        );
    }

    markClosed(uri: string): void {
        const module = this.modules.get(uri);
        if (module) module.isOpen = false;
    }

    markOpen(uri: string): void {
        const module = this.modules.get(uri);
        if (module) module.isOpen = true;
        /* Открытый документ никогда не вытесняется LRU external-модулей. */
        this.externalModuleOrder.delete(uri);
        this.dropExternalSize(uri);
    }

    removeModule(uri: string): void {
        const affected = this.collectAffectedUris(uri);
        const previous = this.modules.delete(uri);
        if (previous) {
            this.symbols.remove(previous);
            this.imports.remove(previous);
        }
        this.externalModuleOrder.delete(uri);
        this.dropExternalSize(uri);
        affected.add(uri);
        this.invalidateImportContexts(affected);
        this.revisionValue++;
    }

    clear(): void {
        this.modules.clear();
        this.symbols.clear();
        this.imports.clear();
        this.files.clear();
        this.importContexts.clear();
        this.externalModuleOrder.clear();
        this.externalSizeByUri.clear();
        this.externalBytes = 0;
        this.revisionValue++;
    }

    registerWorkspaceFiles(uris: readonly string[]): void {
        this.files.registerAll(uris);
    }
    registerWorkspaceFile(uri: string): void { this.files.register(uri); }
    unregisterWorkspaceFile(uri: string): void {
        /* Файла нет в проекте — записи о нём тоже быть не должно. */
        this.catalogValue.remove(uri);
        this.files.unregister(uri);
    }
    getWorkspaceFileUris(): string[] { return this.files.values(); }
    hasWorkspaceFile(uri: string): boolean { return this.files.has(uri); }
    resolveWorkspaceFile(name: string): ModuleResolution<string> {
        return this.files.resolve(name);
    }
    findWorkspaceFileUri(name: string): string | undefined {
        const result = this.files.resolve(name);
        return result.kind === "resolved" ? result.value : undefined;
    }

    getModule(uri: string): IIndexedModule | undefined {
        return this.modules.get(uri);
    }

    /**
     * Единая проверка актуальности версии модуля.
     *
     * DocumentAnalysisService, DiagnosticsCoordinator и обработчик настроек
     * раньше повторяли это сравнение независимо, что создавало риск
     * рассинхронизации условий и публикации Problems для устаревшей версии.
     */
    getCurrentModule(
        uri: string,
        version: number
    ): IIndexedModule | undefined {
        const module = this.modules.get(uri);

        if (!module || module.version !== version) {
            return undefined;
        }

        return module;
    }
    getModules(): IIndexedModule[] { return this.modules.values(); }
    getIndexedModules(): IIndexedModule[] { return this.modules.values(); }
    /**
     * Постоянный каталог символов проекта.
     *
     * Подробные модели вытесняются по объёму, каталог — нет: глобальные
     * ответы (Ctrl+T, Auto Import, отбор кандидатов) обязаны видеть весь
     * проект, а не только то, что сейчас держится в памяти.
     */
    get catalog(): WorkspaceCatalog { return this.catalogValue; }
    getOpenModules(): IIndexedModule[] {
        return this.modules.values().filter(module => module.isOpen);
    }
    getImportNames(uri: string): string[] {
        return this.modules.get(uri)?.imports.slice() || [];
    }
    getImportedModules(uri: string): IIndexedModule[] {
        return this.importsEnabled ? this.getImportContext(uri).modules.slice() : [];
    }
    /**
     * Ключ замыкания БЕЗ самого документа.
     *
     * Отвечает на вопрос «узнал ли сервер что-то новое о других файлах».
     * Обычный ключ включает и сам документ, поэтому меняется от того, что
     * достроилась его собственная модель, — а это не новые сведения.
     */
    getImportedClosureKey(uri: string): string {
        if (!this.importsEnabled) {
            return "imports-disabled";
        }

        return this.getImportContext(uri).modules
            .map(item => item.uri + "@" + item.version)
            .sort()
            .join("|");
    }
    getImportClosureKey(uri: string): string {
        return this.importsEnabled
            ? this.getImportContext(uri).closureKey
            : "imports-disabled";
    }
    resolveModule(name: string): ModuleResolution<IIndexedModule> {
        return this.modules.resolve(name);
    }
    findModuleByName(name: string): IIndexedModule | undefined {
        const result = this.modules.resolve(name);
        return result.kind === "resolved" ? result.value : undefined;
    }

    findSymbols(name: string): IIndexedSymbol[] { return this.symbols.find(name); }
    findImportedSymbols(uri: string, name: string): IIndexedSymbol[] {
        return (this.getImportContext(uri).symbolsByName.get(
            normalizeName(name)
        ) || []).slice();
    }
    /**
     * Неподключённые символы, чьё имя начинается с prefix.
     *
     * Отдельно от findUnimportedSymbols: тот перебирает и копирует все символы
     * проекта, а Auto Import спрашивают на каждую нажатую букву.
     */
    findUnimportedSymbolsByPrefix(
        uri: string,
        prefix: string,
        limit: number
    ): IIndexedSymbol[] {
        const imported = new Set(
            this.getImportedModules(uri).map(item => item.uri)
        );
        imported.add(uri);
        const result: IIndexedSymbol[] = [];
        /*
         * Повторные объявления одного имени в одном модуле — один кандидат.
         *
         * Отбор идёт здесь, а не у вызывающего: иначе число найденного и
         * признак «нашлось больше, чем поместилось» считались бы по списку с
         * повторами, и результат зависел бы от предела.
         */
        const seen = new Set<string>();

        /*
         * Запрашивается с запасом: часть найденного отсеется как приватное,
         * как уже подключённое или как повтор, а вернуть надо ровно столько,
         * сколько просили.
         */
        for (const item of this.symbols.findByPrefix(prefix, limit * 4)) {
            if (item.symbol.isPrivate || imported.has(item.uri)) {
                continue;
            }

            const key = normalizeName(item.symbol.name) + " " + item.uri;

            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            result.push(item);

            if (result.length >= limit) {
                break;
            }
        }

        return result;
    }

    findUnimportedSymbols(uri: string, name?: string): IIndexedSymbol[] {
        const imported = new Set(this.getImportedModules(uri).map(item => item.uri));
        imported.add(uri);
        const candidates = name ? this.symbols.find(name) : this.symbols.all();
        return candidates.filter(item =>
            !item.symbol.isPrivate && !imported.has(item.uri)
        );
    }

    getImportedCompletionItems(uri: string): CompletionItem[] {
        if (!this.importsEnabled) return [];
        const context = this.getImportContext(uri);
        if (context.completionItems) return context.completionItems.slice();
        const result: CompletionItem[] = [];
        const seen = new Set<string>();
        for (const module of context.modules) {
            for (const symbol of module.symbolTree.children) {
                if (symbol.isPrivate) continue;
                const key = normalizeName(symbol.name);
                if (seen.has(key)) continue;
                seen.add(key);
                const item = symbol.completionItem;
                result.push({
                    ...item,
                    detail: [
                        item.detail || "",
                        `Import: ${this.files.importName(module.uri)}`
                    ].filter(Boolean).join("\n"),
                    sortText: `5_${key}`,
                    data: {
                        ...(item.data as object || {}),
                        uri: module.uri,
                        symbolId: symbol.id
                    }
                });
            }
        }
        context.completionItems = result;
        return result.slice();
    }

    getDefinitionRange(
        uri: string,
        symbol: RslSymbol
    ): IExternalLocationRange | undefined {
        return this.modules.get(uri)?.definitionRanges?.get(symbol);
    }
    getDependents(uri: string): string[] { return this.imports.dependents(uri); }
    /**
     * Все файлы, чьё Import-замыкание содержит uri, — транзитивно.
     *
     * getDependents отвечает только про прямую зависимость: в цепочке
     * `main -> middle -> lib` изменение lib даёт middle и ничего про main,
     * хотя замыкание main изменилось. Индекс этот обход и так делает для
     * своих сбросов; наружу он нужен диагностикам.
     */
    getAffectedUris(uri: string): string[] {
        return [...this.collectAffectedUris(uri)];
    }
    getImportNameForUri(uri: string): string { return this.files.importName(uri); }

    setImportsEnabled(enabled: boolean): void {
        if (this.importsEnabled === enabled) return;
        this.importsEnabled = enabled;
        this.importContexts.clear();
        this.revisionValue++;
    }

    withTransientOpenModule<T>(
        uri: string,
        source: string,
        action: (module: IIndexedModule) => T
    ): T {
        const previous = this.modules.get(uri);
        const model = createOpenModuleModel(source);
        const transient: IIndexedModule = {
            uri,
            ...model,
            version: previous?.version ?? 0,
            isOpen: true
        };
        const cached = this.importContexts.get(uri);
        this.importContexts.delete(uri);
        this.modules.set(transient);
        try {
            return action(transient);
        } finally {
            if (previous) this.modules.set(previous);
            else this.modules.delete(uri);
            this.importContexts.delete(uri);
            if (cached) this.importContexts.set(uri, cached);
        }
    }

    get areImportsEnabled(): boolean { return this.importsEnabled; }
    get workspaceFilesReady(): boolean { return this.files.ready; }
    get size(): number { return this.modules.size; }
    get revision(): number { return this.revisionValue; }
    get importCacheSize(): number { return this.importContexts.size; }
    /** Учтённый объём внешних модулей: по нему работает вытеснение. */
    get externalModuleBytes(): number { return this.externalBytes; }

    private replace(
        uri: string,
        model: IRslModuleModel,
        version: number,
        isOpen: boolean,
        fingerprint?: string
    ): IIndexedModule {
        const affected = this.collectAffectedUris(uri);
        const previous = this.modules.delete(uri);
        if (previous) {
            this.symbols.remove(previous);
            this.imports.remove(previous);
        }
        const module: IIndexedModule = {
            uri,
            ...model,
            version,
            isOpen,
            fingerprint
        };
        this.modules.set(module);
        this.catalogValue.record(module);
        this.files.register(uri);
        this.symbols.add(module);
        this.imports.add(module);
        this.collectAffectedUris(uri).forEach(value => affected.add(value));
        affected.add(uri);
        this.invalidateImportContexts(affected);

        if (isOpen) {
            /*
             * Открытие снимает модуль с учёта: он больше не внешний и не
             * вытесняется. Без этого его объём оставался бы в сумме навсегда.
             */
            this.externalModuleOrder.delete(uri);
            this.dropExternalSize(uri);
        } else {
            this.touchExternalModule(uri);
        }

        this.revisionValue++;
        return module;
    }

    /**
     * Отмечает external-модуль как недавно загруженный и вытесняет самые
     * старые, если превышено число модулей ИЛИ их суммарный объём. Открытые
     * документы в этом cap не участвуют.
     *
     * Одного лимита по числу модулей недостаточно: 4000 сводок по 200 КБ и
     * 4000 по 2 МБ — это разные величины, и вторая обходится в гигабайты. Объём
     * считается по длине исходника, из которого сводка построена: это
     * единственная величина, известная без обхода символов, и она пропорциональна
     * их числу.
     */
    private touchExternalModule(uri: string): void {
        this.externalModuleOrder.set(uri, true);
        this.setExternalSize(uri, this.modules.get(uri)?.sourceLength ?? 0);

        while (
            this.externalModuleOrder.size > this.maxExternalModules ||
            this.externalBytes > this.maxExternalBytes
        ) {
            const oldest = this.externalModuleOrder.peekOldest();

            if (oldest === undefined || oldest === uri) {
                break;
            }

            this.externalModuleOrder.delete(oldest);
            this.removeModule(oldest);
        }
    }

    /** Единственное место, где учтённый объём модуля меняется. */
    private setExternalSize(uri: string, size: number): void {
        this.externalBytes += size - (this.externalSizeByUri.get(uri) ?? 0);
        this.externalSizeByUri.set(uri, size);
    }

    /** Модуль перестал быть внешним: закрыт открытием, удалён или вытеснен. */
    private dropExternalSize(uri: string): void {
        const known = this.externalSizeByUri.get(uri);

        if (known === undefined) {
            return;
        }

        this.externalBytes = Math.max(0, this.externalBytes - known);
        this.externalSizeByUri.delete(uri);
    }

    private getImportContext(uri: string): IImportContext {
        const cacheable = this.modules.get(uri)?.isOpen === true;
        const cached = cacheable ? this.importContexts.get(uri) : undefined;
        if (cached) return cached;

        const modules: IIndexedModule[] = [];
        const visited = new Set<string>([uri]);
        const queue = [uri];
        for (let position = 0; position < queue.length; position++) {
            const current = this.modules.get(queue[position]);
            if (!current) continue;
            for (const name of current.imports) {
                const imported = this.findModuleByName(name);
                if (!imported || visited.has(imported.uri)) continue;
                visited.add(imported.uri);
                modules.push(imported);
                queue.push(imported.uri);
            }
        }

        const symbolsByName = new Map<string, IIndexedSymbol[]>();
        for (const module of modules) {
            for (const symbol of module.symbolTree.children) {
                if (symbol.isPrivate) continue;
                const key = normalizeName(symbol.name);
                const values = symbolsByName.get(key) || [];
                values.push({ uri: module.uri, symbolId: symbol.id, symbol });
                symbolsByName.set(key, values);
            }
        }
        const root = this.modules.get(uri);
        const closureKey = [root, ...modules]
            .filter((item): item is IIndexedModule => !!item)
            .map(item => `${item.uri}@${item.version}`)
            .sort()
            .join("|");
        const context = { modules, symbolsByName, closureKey };
        if (cacheable) this.importContexts.set(uri, context);
        return context;
    }

    private collectAffectedUris(uri: string): Set<string> {
        const result = new Set<string>([uri]);
        const queue = [uri];
        for (let position = 0; position < queue.length; position++) {
            for (const dependent of this.imports.dependents(queue[position])) {
                if (!result.has(dependent)) {
                    result.add(dependent);
                    queue.push(dependent);
                }
            }
        }
        return result;
    }

    private invalidateImportContexts(uris: Iterable<string>): void {
        for (const uri of uris) this.importContexts.delete(uri);
    }
}

function normalizeName(value: string): string {
    return (value || "").toLowerCase();
}

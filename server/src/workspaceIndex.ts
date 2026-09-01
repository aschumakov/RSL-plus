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
     * Что нельзя вытеснять: транзитивное Import-замыкание открытых документов.
     *
     * Подсказки, Problems и переходы открытого файла считаются по его
     * зависимостям. Пока фоновая индексация читает проект, LRU внешних модулей
     * доходил до предела и выбрасывал в том числе эти зависимости — и ответ
     * открытому файлу становился неполным ровно тогда, когда пользователь в
     * нём работает. Замыкание закрепляется и вытеснению не подлежит.
     */
    private readonly pinnedModules = new Set<string>();
    /**
     * Имена, которых замыканию не хватает.
     *
     * Модуль может быть написан в Import, но ещё не загружен. Как только он
     * появится, закрепление обязано его подхватить — иначе он попадёт в общую
     * очередь и будет вытеснен раньше, чем понадобится. Пересчёт замыкания на
     * каждую загрузку стоил бы дорого при обходе проекта, поэтому пересчёт
     * идёт только на загрузку ожидаемого имени.
     */
    private readonly pinnedWantedNames = new Set<string>();
    /**
     * Почему вытеснялись сводки.
     *
     * Одного числа удержанных модулей мало: рост памяти объясняется не тем,
     * сколько их сейчас, а тем, упирается ли индекс в предел по числу, в
     * предел по объёму — или не вытесняет вовсе, потому что всё закреплено.
     */
    private evictionCounters = {
        byCount: 0,
        byBytes: 0,
        blockedByPinned: 0
    };
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
    /**
     * Ревизия окружения документа: меняется только от того, что его касается.
     *
     * Общая ревизия индекса растёт от любого модуля проекта. Кэши resolver
     * сверялись именно с ней, и фоновая индексация постороннего файла сбрасывала
     * горячие кэши открытого документа — при том, что ни сам документ, ни его
     * Import, ни их замыкание не менялись. В режимах workspaceIdle и full в
     * фоне читаются тысячи модулей, и кэш обнулялся тысячи раз подряд.
     *
     * Здесь у каждого документа своё число. Оно не пересчитывается, а
     * назначается заново, когда запись сбрасывают: сброс идёт по зависимым
     * рёбрам Import-графа — тем же путём, что и сброс Import-контекста.
     */
    private readonly semanticRevisionByUri = new Map<string, number>();
    private semanticRevisionCounter = 0;
    private pinnedRebuildCount = 0;
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

        if (!module) {
            return;
        }

        module.isOpen = false;
        /* Закрытый документ больше никого не удерживает. */
        this.refreshPinnedModules();
    }

    /** Сколько раз замыкание перестраивалось целиком; для проверок и лога. */
    get pinnedRebuilds(): number {
        return this.pinnedRebuildCount;
    }

    /**
     * Пересчитывает закрепление по всем открытым документам.
     *
     * Обход идёт по графу Import вширь — тот же обход, что строит
     * Import-контекст, — и попутно запоминает имена, которые пока никуда не
     * разрешились: их загрузка расширит закрепление.
     */
    private refreshPinnedModules(): void {
        this.pinnedRebuildCount++;
        this.pinnedModules.clear();
        this.pinnedWantedNames.clear();

        if (!this.importsEnabled) {
            /* Закреплять нечего, но освободившееся обязано вытесниться. */
            this.enforceExternalLimits();

            return;
        }

        const queue: string[] = [];

        for (const module of this.modules.values()) {
            if (module.isOpen) {
                queue.push(module.uri);
                this.pinnedModules.add(module.uri);
            }
        }

        for (let at = 0; at < queue.length; at++) {
            const current = this.modules.get(queue[at]);

            if (!current) {
                continue;
            }

            for (const name of current.imports) {
                const imported = this.findModuleByName(name);

                if (!imported) {
                    this.pinnedWantedNames.add(normalizeName(
                        withMacExtension(name)
                    ));
                    continue;
                }

                if (this.pinnedModules.has(imported.uri)) {
                    continue;
                }

                this.pinnedModules.add(imported.uri);
                queue.push(imported.uri);
            }
        }

        /*
         * Закрепление изменилось — пределы пересчитываются здесь.
         *
         * Закрытие документа снимает закрепление именно через этот метод, и
         * без пересчёта проект остаётся над пределом до следующего чтения.
         */
        this.enforceExternalLimits();
    }

    /** Сколько модулей закреплено: для отчёта о памяти и для тестов. */
    get pinnedModuleCount(): number {
        return this.pinnedModules.size;
    }

    /** Почему вытеснялись сводки: для отчёта о памяти. */
    get evictionStats(): {
        byCount: number;
        byBytes: number;
        blockedByPinned: number;
    } {
        return { ...this.evictionCounters };
    }

    /** Предел числа сводок: для отчёта о памяти. */
    get externalModuleLimit(): number {
        return this.maxExternalModules;
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
        this.semanticRevisionByUri.clear();
        this.externalModuleOrder.clear();
        this.externalSizeByUri.clear();
        /* Каталог — часть индекса: без этого он отвечал бы про прежний проект. */
        this.catalogValue.clear();
        this.externalBytes = 0;
        this.revisionValue++;
    }

    registerWorkspaceFiles(uris: readonly string[]): void {
        this.files.registerAll(uris);
        /* Состав файлов изменился: имя могло начать разрешаться или стать неоднозначным. */
        this.semanticRevisionByUri.clear();
    }
    registerWorkspaceFile(uri: string): void {
        this.files.register(uri);
        this.semanticRevisionByUri.clear();
    }
    unregisterWorkspaceFile(uri: string): void {
        /* Файла нет в проекте — записи о нём тоже быть не должно. */
        this.catalogValue.remove(uri);
        this.files.unregister(uri);
        this.semanticRevisionByUri.clear();
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
    /**
     * Ключ написанных в файле Import.
     *
     * Отдельно от замыкания, потому что замыкание знает только те модули,
     * которые нашлись. Написанный `Import notyet`, который пока никуда не
     * разрешается, замыкание не меняет — а смысл файла меняет: как только
     * модуль появится, имена из него начнут разрешаться. Без этой части
     * ключа добавление и удаление такого Import прошли бы незамеченными.
     */
    getDeclaredImportsKey(uri: string): string {
        if (!this.importsEnabled) {
            return "imports-disabled";
        }

        return (this.modules.get(uri)?.imports || [])
            .map(name => normalizeName(name))
            .sort()
            .join(",");
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
        this.semanticRevisionByUri.clear();
        /*
         * Закрепление пересчитывается в обе стороны.
         *
         * Выключение Import обязано отпустить прежнее замыкание, иначе оно
         * остаётся закреплённым и держит проект над пределом. Включение —
         * построить новое сразу, а не ждать следующей правки документа.
         */
        this.refreshPinnedModules();
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

        /*
         * Замыкание пересчитывается по изменению Import, а не по факту
         * замены модуля.
         *
         * Прежде оно перестраивалось на КАЖДУЮ правку открытого документа:
         * `a = 1` -> `a = 2` тоже запускало полный обход Import-графа, хотя
         * подключённые модули те же самые. При наборе текста это происходило
         * на каждое нажатие клавиши.
         */
        const importsChanged = !sameImportSet(previous?.imports, module.imports);
        const openChanged = (previous?.isOpen === true) !== isOpen;

        if (
            openChanged ||
            (isOpen && importsChanged) ||
            /* У закреплённого модуля появились новые зависимости. */
            (this.pinnedModules.has(uri) && importsChanged) ||
            /* Загрузился модуль, которого замыканию не хватало. */
            this.pinnedWantedNames.has(normalizeName(moduleNameOfUri(uri)))
        ) {
            this.refreshPinnedModules();
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
        this.enforceExternalLimits(uri);
    }

    /**
     * Приводит число и объём external-модулей к пределам.
     *
     * Отдельным методом, а не хвостом загрузки. Вытеснение упирается в
     * закрепление, и снятие закрепления — такое же основание пересчитать
     * пределы, как и загрузка нового модуля. Пока это жило внутри загрузки,
     * закрытие документа оставляло проект над пределом до следующего чтения:
     * порядок на сервере — сначала compactModule (замыкание ещё закреплено, и
     * вытеснение упирается в него), потом markClosed (закрепление снято, но
     * пересчитывать пределы было уже некому).
     *
     * protectedUri — модуль, который только что понадобился: выбрасывать его
     * тут же значило бы прочитать его заново следующим действием.
     */
    private enforceExternalLimits(protectedUri?: string): void {
        /*
         * Очередь на вытеснение — от самых старых, но мимо закреплённых.
         *
         * Закреплённое замыкание открытых документов вытеснять нельзя: без
         * него подсказки и Problems открытого файла становятся неполными. Если
         * незакреплённых модулей не осталось, вытеснение прекращается —
         * выбрасывать нужное и тут же читать заново означало бы бесконечный
         * круг.
         */
        let queue: string[] | undefined;
        let at = 0;

        while (
            this.externalModuleOrder.size > this.maxExternalModules ||
            this.externalBytes > this.maxExternalBytes
        ) {
            if (!queue) {
                queue = this.externalModuleOrder.keysOldestFirst();
            }

            let victim: string | undefined;

            while (at < queue.length) {
                const candidate = queue[at++];

                if (
                    candidate === protectedUri ||
                    this.pinnedModules.has(candidate) ||
                    !this.externalModuleOrder.get(candidate)
                ) {
                    continue;
                }

                victim = candidate;
                break;
            }

            if (victim === undefined) {
                this.evictionCounters.blockedByPinned++;
                break;
            }

            if (this.externalModuleOrder.size > this.maxExternalModules) {
                this.evictionCounters.byCount++;
            } else {
                this.evictionCounters.byBytes++;
            }

            this.externalModuleOrder.delete(victim);
            this.removeModule(victim);
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
        for (const uri of uris) {
            this.importContexts.delete(uri);
            /* Окружение этих документов изменилось: их ревизия больше не та. */
            this.semanticRevisionByUri.delete(uri);
        }
    }

    /**
     * Ревизия семантического окружения документа.
     *
     * Меняется, если изменилось то, от чего зависит разрешение имён в этом
     * документе: он сам, любой модуль его транзитивного Import-замыкания, или
     * состав файлов проекта — от него зависит, разрешится ли имя вообще и не
     * стало ли оно неоднозначным.
     *
     * Не меняется от чужого модуля. Именно ради этого она и заведена.
     *
     * Сброс идёт по обратным рёбрам Import-графа, а они ключуются ИМЕНЕМ, а не
     * URI: документ, чей Import пока никуда не разрешается, всё равно числится
     * зависимым от этого имени и получит сброс, как только файл с таким именем
     * появится или будет прочитан.
     */
    getSemanticRevision(uri: string): number {
        const known = this.semanticRevisionByUri.get(uri);

        if (known !== undefined) {
            return known;
        }

        const value = ++this.semanticRevisionCounter;

        this.semanticRevisionByUri.set(uri, value);

        return value;
    }
}

function normalizeName(value: string): string {
    return (value || "").toLowerCase();
}

/** Имя файла модуля по его URI: то же правило, что и у каталога проекта. */
function moduleNameOfUri(uri: string): string {
    const at = uri.lastIndexOf("/");

    return at < 0 ? uri : uri.slice(at + 1);
}

/** Имя с расширением: в Import его пишут не всегда. */
function withMacExtension(name: string): string {
    const value = (name || "").trim();

    return /\.mac$/i.test(value) ? value : value + ".mac";
}

/**
 * Один ли и тот же набор Import.
 *
 * Сравниваются нормализованные имена как множества: порядок в тексте роли не
 * играет, а тождество массивов меняется на каждую правку файла.
 */
function sameImportSet(
    left: readonly string[] | undefined,
    right: readonly string[]
): boolean {
    if (!left) {
        return right.length === 0;
    }

    if (left.length !== right.length) {
        return false;
    }

    const known = new Set(left.map(normalizeName));

    return right.every(name => known.has(normalizeName(name)));
}

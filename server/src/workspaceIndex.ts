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
import {
    findRslSymbolById,
    rslSymbolRef,
    type IRslSymbolRef
} from "./symbols/symbolRef";
import { FileCatalog } from "./indexing/fileCatalog";
import {
    RslLibraryModuleIndex
} from "./indexing/libraryModuleIndex";
import { WorkspaceCatalog } from "./indexing/workspaceCatalog";
import { ImportGraph } from "./indexing/importGraph";
import { computeRslModuleInterface } from "./indexing/moduleInterface";
import { ModuleStore } from "./indexing/moduleStore";
import {
    moduleBaseNameOfUri,
    moduleIdOf
} from "./core/identity/uriKey";
import { rslModuleBaseName } from "./core/language/moduleName";
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
    /**
     * URI модулей замыкания в порядке обхода — не сами модули.
     *
     * Объекты держать нельзя. Модель модуля пересобирается при каждой
     * его правке, и запомненный объект становится устаревшим: именно
     * поэтому контекст сбрасывался всем зависимым файлам на любую
     * правку чужого тела. По URI он остаётся верным, пока верен СОСТАВ
     * замыкания, а состав от правки тела не меняется.
     */
    uris: string[];
    /**
     * Место модуля в замыкании: URI -> порядковый номер.
     *
     * Раньше контекст сразу собирал карту ВСЕХ публичных символов всего
     * замыкания. Резолверу при этом обычно нужно одно конкретное имя, и
     * карта строилась целиком, чтобы взять из неё одну запись: на
     * настоящем проекте это 0,5-1,1 мс на каждую сборку контекста, то
     * есть на каждую правку открытого файла.
     *
     * Имя ищется общим индексом символов и отсеивается по видимости;
     * порядок ответа задаёт этот номер — он обязан совпадать с прежним
     * порядком обхода замыкания, иначе при одинаковых именах из разных
     * модулей победил бы другой символ.
     */
    orderByUri: Map<string, number>;
    completionItems?: CompletionItem[];
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
    /**
     * Ревизия СОСТАВА файлов проекта.
     *
     * Отдельно от общей ревизии индекса: та растёт от каждого
     * прочитанного модуля, а состав меняется на порядки реже — при
     * обходе проекта, создании и удалении файла, смене области поиска.
     * От состава зависит, разрешится ли имя вообще и не стало ли оно
     * неоднозначным, и это отдельное от содержимого модулей условие.
     */
    private workspaceFilesRevisionValue = 0;
    private pinnedRebuildCount = 0;
    /**
     * Номер последнего выданного интерфейса и счётчики.
     *
     * Счётчики нужны проверкам и логу: разницу здесь видно не
     * секундомером, а тем, сколько работы не сделано.
     */
    private interfaceRevisionCounter = 0;
    private interfaceStats = {
        modules: 0,
        interfaceChanges: 0,
        dependentInvalidations: 0,
        importGraphUpdates: 0,
        skippedDependentInvalidations: 0,
        /** Сколько раз Import-контекст собирался заново. */
        importContextRebuilds: 0,
        /** Сколько раз ревизия окружения документа назначалась заново. */
        semanticRevisionResets: 0
    };
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
    /** Счётчики интерфейсов: сколько межфайловой работы не сделано. */
    get interfaceCounters(): {
        modules: number;
        interfaceChanges: number;
        dependentInvalidations: number;
        importGraphUpdates: number;
        skippedDependentInvalidations: number;
        importContextRebuilds: number;
        semanticRevisionResets: number;
    } {
        return { ...this.interfaceStats };
    }

    /** Ревизия внешнего интерфейса модуля; 0, если модуля нет. */
    getInterfaceRevision(uri: string): number {
        return this.modules.get(uri)?.interfaceRevision ?? 0;
    }

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
                const imported = this.importedModule(name);

                if (!imported) {
                    /*
                     * Базовое имя, а не написание с путём. Написание
                     * `Import sub\lib` сравнивалось с именем файла
                     * `lib.mac` и не совпадало никогда: такой модуль
                     * не попадал в закрепление, даже когда его
                     * дочитывали.
                     */
                    this.pinnedWantedNames.add(rslModuleBaseName(name));
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
        this.forgetSemanticRevisions();
        this.externalModuleOrder.clear();
        this.externalSizeByUri.clear();
        /* Каталог — часть индекса: без этого он отвечал бы про прежний проект. */
        this.catalogValue.clear();
        this.externalBytes = 0;
        this.revisionValue++;
    }

    /**
     * Забыть состав проекта: он собран по прежним правилам поиска.
     *
     * Смена области поиска — новые корни или новые исключения — делает
     * прежний состав недействительным целиком. Пока новый обход не прошёл,
     * каталог не вправе считаться готовым: иначе адресный поиск верит ему
     * на слово и продолжает находить уже исключённый файл, а нового не
     * находит вовсе. Ответ зависел бы от того, успел ли закончиться обход.
     *
     * Загруженные модули при этом остаются: перечитывать их незачем, а
     * какие из них ещё в проекте, решит новый обход.
     */
    resetWorkspaceFiles(): void {
        this.files.clear();
        this.importContexts.clear();
        this.forgetSemanticRevisions();
        this.revisionValue++;
    }

    registerWorkspaceFiles(uris: readonly string[]): void {
        this.files.registerAll(uris);
        /* Состав файлов изменился: имя могло начать разрешаться или стать неоднозначным. */
        this.forgetSemanticRevisions();
    }
    registerWorkspaceFile(uri: string): void {
        this.files.register(uri);
        this.forgetSemanticRevisions();
    }
    unregisterWorkspaceFile(uri: string): void {
        /* Файла нет в проекте — записи о нём тоже быть не должно. */
        this.catalogValue.remove(uri);
        this.files.unregister(uri);
        this.forgetSemanticRevisions();
    }
    /** Состав проекта изменился: и ревизия состава, и окружения документов. */
    private forgetSemanticRevisions(): void {
        this.workspaceFilesRevisionValue++;
        this.interfaceStats.semanticRevisionResets +=
            this.semanticRevisionByUri.size;
        this.semanticRevisionByUri.clear();
    }
    /** Ревизия состава файлов проекта: см. workspaceFilesRevisionValue. */
    get workspaceFilesRevision(): number {
        return this.workspaceFilesRevisionValue;
    }
    getWorkspaceFileUris(): string[] { return this.files.values(); }
    hasWorkspaceFile(uri: string): boolean { return this.files.has(uri); }
    /**
     * Файл по имени модуля: сперва проект, затем библиотеки.
     *
     * Порядок повторяет USERMACRODIR платформы. Проект сильнее: пока
     * он отвечает хоть что-нибудь — найденное или неоднозначность, —
     * библиотеки не спрашиваются вовсе. Неоднозначности между
     * библиотеками не бывает: следующая спрашивается только тогда,
     * когда в предыдущей ничего не нашлось.
     */
    private libraryPathList: readonly string[] = [];
    private temporaryLibraryRoot: string | undefined;
    private libraries = new RslLibraryModuleIndex({
        paths: () => this.libraryPathList,
        temporaryRoot: () => this.temporaryLibraryRoot
    });

    resolveWorkspaceFile(name: string): ModuleResolution<string> {
        const own = this.files.resolve(name);

        if (own.kind !== "missing") {
            return own;
        }

        /*
         * Пока состав проекта не обойдён, «нет в каталоге» ещё не
         * значит «нет в проекте»: адресный поиск по диску проекта
         * не отработал. Ответить в этот момент библиотекой значит
         * дать одноимённому файлу поставки выиграть у проекта
         * просто потому, что обход не успел. Библиотеку в этом
         * случае спросит сам адресный поиск — после своего
         * прохода по корням проекта, см. resolveLibraryFile.
         */
        if (!this.files.ready) {
            return own;
        }

        const library = this.resolveLibraryFile(name);

        return library
            ? { kind: "resolved", value: library }
            : own;
    }

    /**
     * Файл библиотеки по имени, без оглядки на готовность проекта.
     *
     * Зовётся адресным поиском, когда он уже прошёл по корням
     * проекта и ничего не нашёл: порядок «проект, потом библиотеки»
     * соблюдён, а ждать конца обхода в этот момент незачем.
     */
    resolveLibraryFile(name: string): string | undefined {
        const found = this.libraries.resolve(name);

        if (found) {
            this.libraries.remember(found);
        }

        return found;
    }
    findWorkspaceFileUri(name: string): string | undefined {
        const result = this.resolveWorkspaceFile(name);
        return result.kind === "resolved" ? result.value : undefined;
    }

    /**
     * Библиотеки модулей: путь и порядок задаёт настройка.
     *
     * Папками проекта они не становятся: их состав не обходится, в
     * каталог и в индекс ссылок не попадает, и читается из них
     * только то, что кто-то попросил по имени.
     */
    setLibraryPaths(paths: readonly string[]): void {
        const next = paths.filter(item => item.trim().length > 0);

        if (
            next.length === this.libraryPathList.length &&
            next.every((item, at) => item === this.libraryPathList[at])
        ) {
            return;
        }

        this.libraryPathList = next;
        this.libraries.invalidate();
    }

    /**
     * Каталог открытого вне проекта файла — временный первый корень.
     *
     * У такого файла соседи по каталогу и есть его библиотека; так же
     * разрешает имена и платформа. Настройкой это не становится:
     * корень живёт, пока файл открыт.
     */
    setTemporaryLibraryRoot(directory: string | undefined): void {
        if (this.temporaryLibraryRoot === directory) {
            return;
        }

        this.temporaryLibraryRoot = directory;
        this.libraries.invalidate();
    }

    /** Библиотечный ли это файл: в состав проекта он не входит. */
    isLibraryFile(uri: string): boolean {
        return this.libraries.owns(uri);
    }

    /** Сколько библиотек прочитано и сколько имён: см. тесты. */
    get libraryCounters(): RslLibraryModuleIndex["counters"] {
        return this.libraries.counters;
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
        return this.importsEnabled
            ? this.contextModules(this.getImportContext(uri))
            : [];
    }

    /**
     * Модули замыкания в их ТЕКУЩЕМ виде.
     *
     * Вытесненный модуль выпадает: контекст помнит состав, а не
     * содержимое, и держать вытесненное он не вправе.
     */
    private contextModules(context: IImportContext): IIndexedModule[] {
        const result: IIndexedModule[] = [];

        for (const uri of context.uris) {
            const module = this.modules.get(uri);

            if (module) {
                result.push(module);
            }
        }

        return result;
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

        /*
         * Ключ собирается из ревизии ИНТЕРФЕЙСА, а не версии модуля.
         *
         * Потребителей этого ключа волнует не то, что сосед изменился,
         * а то, изменилось ли в нём что-то видимое снаружи. Версия
         * растёт от любой правки чужого тела и от каждого фонового
         * перечитывания файла, и ключ устаревал без всякой причины.
         */
        return this.contextModules(this.getImportContext(uri))
            .map(item => item.uri + "@i" + item.interfaceRevision)
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
            .map(name => moduleIdOf(name) as string)
            .sort()
            .join(",");
    }

    /**
     * Условия семантического расчёта документа одной строкой.
     *
     * Своя версия — плюс ИНТЕРФЕЙСЫ модулей замыкания, а не их версии.
     * Прежде здесь стояли версии, и правка чужого тела отменяла
     * посчитанные Problems соседнего файла: ключ переставал совпадать,
     * хотя ни один вывод в этом файле измениться не мог. На популярном
     * модуле это значило пересчёт межфайловой фазы у каждого открытого
     * зависимого — на каждое нажатие клавиши в библиотеке.
     */
    getImportClosureKey(uri: string): string {
        if (!this.importsEnabled) {
            return "imports-disabled";
        }

        const own = this.modules.get(uri);

        return (own ? own.uri + "@v" + own.version : uri + "@-") +
            "|" + this.getImportedClosureKey(uri);
    }
    resolveModule(name: string): ModuleResolution<IIndexedModule> {
        return this.modules.resolve(name);
    }
    findModuleByName(name: string): IIndexedModule | undefined {
        const result = this.modules.resolve(name);
        return result.kind === "resolved" ? result.value : undefined;
    }

    /**
     * Модель модуля по имени из Import — в порядке поиска.
     *
     * Сперва имя превращается в точный URI общим resolver'ом, и
     * только потом берётся модель этого URI. Прежде здесь спрашивали
     * загруженные модели по базовому имени, а они порядка поиска не
     * знают: кто прочитан первым, тот и отвечал. Переключение на
     * другую папку после этого ничего не меняло — старая модель
     * оставалась в памяти и продолжала выигрывать.
     *
     * Когда файла нет нигде, последнее слово остаётся за
     * загруженными моделями: так отвечают заглушки и модули,
     * которых на диске ещё нет.
     */
    importedModule(name: string): IIndexedModule | undefined {
        const resolution = this.resolveWorkspaceFile(name);

        if (resolution.kind === "resolved") {
            return this.modules.get(resolution.value);
        }

        /* Неоднозначность выбором по базовому имени не решается. */
        return resolution.kind === "ambiguous"
            ? undefined
            : this.findModuleByName(name);
    }

    findSymbols(name: string): IIndexedSymbol[] { return this.symbols.find(name); }
    /**
     * Символы подключённых модулей с этим именем.
     *
     * Отвечает общий индекс символов, а видимость решает замыкание. Прежде
     * контекст сразу собирал карту всех публичных имён всего замыкания —
     * чтобы взять из неё одну запись.
     */
    findImportedSymbols(uri: string, name: string): IIndexedSymbol[] {
        if (!this.importsEnabled) {
            return [];
        }

        const order = this.getImportContext(uri).orderByUri;

        if (order.size === 0) {
            return [];
        }

        return this.symbols.find(name)
            .filter(item =>
                !item.symbol.isPrivate && order.has(item.uri))
            /*
             * Порядок — обхода замыкания, как и прежде: при одинаковых именах
             * из разных модулей побеждает тот, кто ближе к документу.
             */
            .sort((left, right) =>
                (order.get(left.uri) ?? 0) - (order.get(right.uri) ?? 0));
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
        for (const module of this.contextModules(context)) {
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
        const module = this.modules.get(uri);

        if (!module?.definitionRanges) {
            return undefined;
        }

        /*
         * Диапазон ищется по АКТУАЛЬНОМУ объекту той же
         * идентичности, а не по переданному.
         *
         * Переданный мог быть запомнен соседним файлом до того,
         * как тело этого модуля правили: карта диапазонов
         * ключуется объектом, и по устаревшему объекту ответа в ней
         * нет вовсе — переход уходил читать файл с диска заново.
         * А там, где диапазон брали прямо у символа, он указывал на
         * строку, где объявления уже нет.
         */
        const live = this.liveSymbol(uri, symbol);

        return module.definitionRanges.get(live);
    }

    /**
     * Актуальный объект того же объявления в текущей модели файла.
     *
     * Если модель не загружена или объявления в ней больше нет,
     * возвращается переданный объект: ответ по устаревшим сведениям
     * лучше отсутствия ответа, и раньше он и был единственным.
     */
    liveSymbol(uri: string, symbol: RslSymbol): RslSymbol {
        const module = this.modules.get(uri);

        if (!module) {
            return symbol;
        }

        return findRslSymbolById(module.symbolTree, symbol.id) ||
            symbol;
    }

    /**
     * Диапазон объявления по его межфайловой идентичности.
     *
     * Пусто, если модели файла в памяти нет или объявления в ней больше
     * не осталось: тогда спрашивающий берёт то, что помнит каталог.
     */
    getDefinitionRangeByRef(
        ref: IRslSymbolRef
    ): IExternalLocationRange | undefined {
        const module = this.modules.get(ref.uri);
        const symbol = module &&
            findRslSymbolById(module.symbolTree, ref.symbolId);

        return symbol
            ? module.definitionRanges?.get(symbol)
            : undefined;
    }

    /** Актуальный объект по межфайловой идентичности. */
    resolveSymbolRef(ref: IRslSymbolRef): RslSymbol | undefined {
        const module = this.modules.get(ref.uri);

        return module
            ? findRslSymbolById(module.symbolTree, ref.symbolId)
            : undefined;
    }

    /** Идентичность символа этого файла. */
    symbolRef(uri: string, symbol: RslSymbol): IRslSymbolRef {
        return rslSymbolRef(uri, symbol);
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
            isOpen: true,
            /*
             * Временная модель живёт один вызов и в индексе не остаётся:
             * ревизия интерфейса берётся прежняя, чтобы ключи замыкания
             * соседних файлов от неё не дрогнули.
             */
            interfaceFingerprint: previous?.interfaceFingerprint ?? "",
            interfaceRevision: previous?.interfaceRevision ?? 0
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
        /*
         * Рёбра Import трогаются только при изменившемся наборе.
         *
         * Граф хранит одни URI, и при том же наборе снятие и постановка
         * рёбер возвращают его в прежнее состояние — работа впустую на
         * каждую правку и на каждый фоновый модуль.
         */
        const importsUnchanged = previous !== undefined &&
            sameImportSet(previous.imports, model.imports);

        if (previous) {
            this.symbols.remove(previous);

            if (!importsUnchanged) {
                this.imports.remove(previous);
            }
        }
        /*
         * Интерфейс считается по уже построенной модели: ни разбора,
         * ни сканирования текста здесь нет.
         */
        const declared = computeRslModuleInterface(model);
        const interfaceChanged =
            previous?.interfaceFingerprint !== declared.fingerprint;

        this.interfaceStats.modules++;

        if (interfaceChanged) {
            this.interfaceStats.interfaceChanges++;
        }

        const module: IIndexedModule = {
            uri,
            ...model,
            version,
            isOpen,
            fingerprint,
            interfaceFingerprint: declared.fingerprint,
            interfaceRevision: interfaceChanged
                ? ++this.interfaceRevisionCounter
                : previous!.interfaceRevision
        };
        this.modules.set(module);

        /*
         * Загруженный модуль — не модуль проекта.
         *
         * Библиотечный файл читается по имени из Import, но частью
         * проекта от этого не становится: ни в Ctrl+T, ни в поиске
         * использований, ни в разрешении одноимённых его быть не
         * должно. Иначе однажды прочитанный `base/utils.mac`
         * начинает перекрывать `utils.mac` проекта.
         */
        if (!this.libraries.owns(uri)) {
            this.catalogValue.record(module);
            this.files.register(uri);
        }
        /*
         * Символы обновляются всегда: индекс держит сами объекты, а их
         * диапазоны от правки тела съезжают.
         */
        this.symbols.add(module);

        if (!importsUnchanged) {
            this.imports.add(module);
            this.interfaceStats.importGraphUpdates++;
        }
        this.collectAffectedUris(uri).forEach(value => affected.add(value));
        affected.delete(uri);

        /*
         * Зависимые сбрасываются ТОЛЬКО при изменившемся интерфейсе.
         *
         * Соседний файл видит от модуля его Import и публичные
         * объявления с подписями, типами и базовыми классами — ровно то,
         * что учтено в отпечатке. Что написано внутри Macro, снаружи не
         * видно, и ни один вывод в соседнем файле от этого не меняется.
         *
         * Единственное, чего в отпечатке нет, — положения в тексте. Их
         * спрашивают у ТЕКУЩЕЙ модели по паре «файл и номер объявления»
         * (см. symbols/symbolRef), поэтому запомненный объект соседнего
         * файла устаревшего положения дать больше не может.
         */
        if (interfaceChanged) {
            this.invalidateImportContexts(affected);
            this.interfaceStats.dependentInvalidations += affected.size;
        } else {
            this.interfaceStats.skippedDependentInvalidations +=
                affected.size;
        }

        /* Свой контекст сбрасывается всегда: правка была в нём. */
        this.invalidateImportContexts([uri]);

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
            this.pinnedWantedNames.has(moduleBaseNameOfUri(uri))
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
                const imported = this.importedModule(name);
                if (!imported || visited.has(imported.uri)) continue;
                visited.add(imported.uri);
                modules.push(imported);
                queue.push(imported.uri);
            }
        }

        const orderByUri = new Map<string, number>();

        modules.forEach((module, at) => orderByUri.set(module.uri, at));

        const context: IImportContext = {
            uris: modules.map(module => module.uri),
            orderByUri
        };

        this.interfaceStats.importContextRebuilds++;
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
            if (this.semanticRevisionByUri.delete(uri)) {
                this.interfaceStats.semanticRevisionResets++;
            }
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




/**
 * Один ли и тот же набор Import.
 *
 * Сравниваются КАНОНИЧЕСКИЕ имена — те же, по которым разрешаются ссылки:
 * разделитель пути, регистр и расширение `.mac` в RSL не значимы. Прежде
 * здесь стоял простой toLowerCase, и `Import lib` с `Import lib.mac`
 * считались разными наборами. Дописать в директиве расширение значило
 * снять и поставить рёбра Import-графа, пересчитать закрепление и сбросить
 * Import-контекст всем зависимым — при том, что зависимость та же самая.
 *
 * Порядок в тексте роли не играет: сравниваются множества. Повторы —
 * играют по числу элементов, но `Import lib; Import lib;` и без того
 * ошибка, о которой сообщает отдельная диагностика.
 */
function sameImportSet(
    left: readonly string[] | undefined,
    right: readonly string[]
): boolean {
    if (!left) {
        return right.length === 0;
    }

    const known = new Set(left.map(name => moduleIdOf(name) as string));
    const wanted = new Set(right.map(name => moduleIdOf(name) as string));

    if (known.size !== wanted.size) {
        return false;
    }

    for (const name of wanted) {
        if (!known.has(name)) {
            return false;
        }
    }

    return true;
}

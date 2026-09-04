import {
    collectRslImportClosure
} from "./indexing/importClosure";
import {
    CompletionItem,
    CompletionItemKind
} from "vscode-languageserver";

import { createSymbolId, RslSymbol } from "./symbols/rslSymbol";
import {
    buildImportContextState,
    type IRslImportContextState
} from "./analysis/importContextState";
import {
    displayTypeName,
    isRslType,
    PRIMITIVE_TYPES
} from "./language/rslLanguageReference";
import {
    IRslToken,
    tokenAtOffset,
    normalizeIdentifier,
    normalizeReferenceIdentifier
} from "./lexer";
import {
    IIndexedModule,
    IIndexedSymbol,
    WorkspaceIndex
} from "./workspaceIndex";
import { LruCache } from "./core/lruCache";
import {
    RslSemanticState,
    sameRslHotStamp,
    type IRslHotStamp,
    type IRslSemanticDependencies,
    type IRslSemanticStamp
} from "./analysis/semanticState";
import { getDefaults } from "./defaults";
import type { IRslSyntaxNode } from "./syntaxParser";
import type { BuiltinCatalog } from "./builtins/builtinSymbol";
import type {
    PlatformModuleCatalog
} from "./builtins/platformModuleCatalog";

export const RSL_BUILTIN_URI = "rsl-builtin:/standard-library";

/**
 * Сколько документов держат свои производные наборы.
 *
 * Resolver живёт всё время работы сервера, а ключом здесь служит URI: без
 * границы обе карты росли бы на каждый открытый за сессию файл и не уменьшались
 * никогда. Открытых документов одновременно единицы, поэтому запас велик.
 */
const DOCUMENT_CACHE_ENTRIES = 32;

/**
 * Полнота Import-контекста зависит от окружения документа целиком.
 *
 * Обобщающего числа довольно: различать, ЧТО именно изменилось, здесь
 * незачем — ответ пересчитывается при любом изменении окружения.
 */
const IMPORT_CONTEXT_STATE_DEPENDS = {
    semantic: true,
    platform: true
} as const;

/**
 * Полные условия семантического расчёта документа.
 *
 * Свой текст плюс окружение: написанные Import, интерфейсы замыкания и
 * каталог платформы. Ключ один на всех потребителей — иначе один из них
 * признавал бы свой кэш устаревшим, а другой нет, и подсветка расходилась
 * бы с переходом.
 */
const FULL_CONTEXT_DEPENDS = {
    text: true,
    imports: true,
    closure: true,
    platform: true
} as const;

/**
 * То же, но без самого документа: «узнал ли сервер что-то о других файлах».
 *
 * Полный ключ содержит версию открытого документа и меняется от каждой
 * правки. Потребителям, которых волнует только окружение файла, это
 * обнуляет кэш на каждое нажатие клавиши — при том что об импортах ничего
 * не изменилось. Собственное содержимое документа такие потребители обязаны
 * учитывать сами: см. moduleWideNamesFingerprint в diagnostics.
 */
const IMPORTED_CONTEXT_DEPENDS = {
    imports: true,
    closure: true,
    platform: true
} as const;

export interface IResolvedSymbol {
    uri: string;
    symbol: RslSymbol;
    token: IRslToken;
    /**
     * Имя прикладного модуля-владельца, если символ оттуда.
     *
     * У символа платформы файла нет вовсе: его uri — общий
     * `rsl-builtin:`, и по нему модуль не назвать. А назвать надо:
     * подключается такой символ по имени модуля.
     */
    platformModuleName?: string;
}

interface IResolutionCache {
    /* Горячий набор состояний вместо строкового ключа: см. resolveAt. */
    stamp: IRslHotStamp;
    byTokenStart: Map<number, IResolvedSymbol | null>;
}

/**
 * Присваивание, из которого можно вывести тип переменной.
 *
 * Ни тип, ни класс получателя здесь не вычисляются: и то и другое требует
 * разрешения имён В ПОЗИЦИИ ВЫЗОВА, а индекс строится один раз на модуль.
 * Раньше тип прямого вызова считался при построении индекса — глобальным
 * поиском по всему workspace, без области видимости и без позиции, — и
 * `x = Get()` получал тип чужого класса Get из произвольного файла проекта.
 */
/**
 * Запись кэша разрешения имён: результат и интервал его действительности.
 *
 * Интервал обязателен. До объявления имя видит внешнюю область, после —
 * местную, и кэш без границ отвечал бы на «использование выше объявления» так
 * же, как на «использование ниже».
 */
interface IResolutionCacheEntry {
    from: number;
    to: number;
    resolved: IIndexedSymbol | undefined;
}

/**
 * Класс для быстрого пути вместе с источником.
 *
 * moduleUri — класс файла workspace, owner — встроенный или прикладной.
 * Источник нужен, чтобы разрешить базу в его собственном контексте.
 */
export interface IRslFastClass {
    symbol: RslSymbol;
    moduleUri?: string;
    owner?: IRslExternalClass;
}

/** Внешний класс вместе с модулем-владельцем; пустой ключ — библиотека. */
export interface IRslExternalClass {
    symbol: RslSymbol;
    moduleKey: string;
}

/** Фильтр «годится любой символ»: узнаётся по ссылке, поэтому он один. */
const ACCEPT_ANY = (): boolean => true;

/**
 * Фильтр «только класс»: тоже один на весь модуль.
 *
 * Именно ссылка на функцию служит ключом кэша разрешения имён. Пока такой
 * фильтр создавался литералом внутри метода, каждый вызов давал новую ссылку,
 * новый ключ и новую запись: кэш только рос и не попадал ни разу.
 */
const ACCEPT_CLASS = (symbol: RslSymbol): boolean =>
    symbol.kind === CompletionItemKind.Class;

/*
 * Прочие фильтры различаются по ссылке на функцию. Их всего несколько и все
 * заданы константами модуля, поэтому ссылка — устойчивый ключ; переменные в
 * замыкании фильтров не участвуют.
 */
const acceptTags = new WeakMap<(symbol: RslSymbol) => boolean, string>();
let acceptTagCounter = 0;

function acceptTag(accept: (symbol: RslSymbol) => boolean): string {
    let tag = acceptTags.get(accept);

    if (tag === undefined) {
        tag = `f${++acceptTagCounter}`;
        acceptTags.set(accept, tag);
    }

    return tag;
}

interface IConstructorAssignment {
    /** Позиция имени цели присваивания. */
    offset: number;
    /**
     * Условный блок, внутри которого стоит присваивание.
     *
     * Пусто — присваивание выполняется всегда. Иначе оно могло не выполниться, и
     * за пределами этого блока считать его тип действующим нельзя: у кода
     *
     *     If (c) x = A(); Else x = B(); End;
     *
     * последнее по тексту присваивание — B, но тип на выходе из IF зависит от
     * ветки. Ранее выбиралось просто последнее, и подсказка уверенно предлагала
     * члены B.
     */
    guard?: { start: number; end: number };
    /** Имя в правой части: конструктор класса или процедура. */
    callee?: string;
    /**
     * Голое имя в правой части: `MessageText = TStringList;`.
     *
     * Отличается от callee тем, что типом считается только класс. Пропустить
     * такое имя через getCallableResultType нельзя: у `callback = SomeMacro`
     * переменная получила бы тип результата процедуры, хотя присвоена сама
     * процедура, а не то, что она возвращает.
     */
    bareClass?: string;
    /**
     * Вызов метода получателя: `rs = cmd.Execute()`.
     *
     * Тип здесь нельзя посчитать на этапе разбора токенов: сначала нужно
     * выяснить класс получателя, а это уже разрешение имён. Поэтому имена
     * запоминаются, а тип берётся при выводе (см. inferAssignedType).
     */
    member?: {
        receiver: string;
        method: string;
    };
}

/**
 * Ключ присваивания.
 *
 * Объявленная переменная адресуется своим symbolId — то есть областью, в
 * которой объявлена. Переменная без объявления symbolId не имеет, и ключом
 * становится область самого присваивания плюс имя.
 *
 * Раньше ключом было одно имя на весь модуль, и тип «протекал» между
 * одноимёнными переменными разных Macro, методов и классов: `doc = TBFile(...)`
 * в одной процедуре задавал тип `doc` во всех остальных. Именно поэтому ключ
 * теперь всегда содержит область.
 */
function declaredAssignmentKey(symbol: RslSymbol): string {
    return `sym:${symbol.id}`;
}

function implicitAssignmentKey(scope: RslSymbol, name: string): string {
    return `scope:${scope.id}/${normalizeIdentifier(name)}`;
}

/*
 * RslSymbol после построения syntax tree фактически неизменяем. Кэши WeakMap
 * не удерживают старые деревья после обновления документа.
 */
const objectChildrenCache = new WeakMap<RslSymbol, RslSymbol[]>();
const childrenByNameCache = new WeakMap<RslSymbol, Map<string, RslSymbol[]>>();

/**
 * Разрешает имена с учётом областей видимости RSL.
 *
 * Горячий путь используется semantic tokens для каждого идентификатора,
 * поэтому здесь нельзя заново фильтровать весь token stream или линейно
 * перебирать все объявления scope при каждом вызове.
 */
export class RslScopeResolver {
    private tokensByModule = new WeakMap<IIndexedModule, IRslToken[]>();
    private resolutionByModule = new WeakMap<IIndexedModule, IResolutionCache>();
    private constructorAssignmentsByModule = new WeakMap<
        IIndexedModule,
        Map<string, IConstructorAssignment[]>
    >();
    private resolutionCacheHits = 0;
    private resolutionCacheMisses = 0;
    /**
     * Разрешение имени по паре «область + имя», а не по позиции токена.
     *
     * Кэш по позиции помогает только повторному запросу той же версии: внутри
     * одного построения подсветки каждый токен — свой ключ, и все промахиваются.
     * Между тем на файле 379 КБ 37 627 идентификаторов дают 34 различные пары
     * «область + имя».
     */
    private namesByModule = new WeakMap<IIndexedModule, {
        stamp: IRslHotStamp;
        byKey: Map<string, IResolutionCacheEntry>;
    }>();
    /** Присваивания, тип которых сейчас вычисляется: защита от цикла. */
    private memberTypeGuard = new Set<IConstructorAssignment>();
    /** Модули, индекс присваиваний которых строится сейчас. */
    private assignmentIndexInProgress = new WeakSet<IIndexedModule>();
    /*
     * Видимые прикладные модули на документ.
     *
     * Считаются по Import и сбрасываются по номеру ревизии индекса: набор
     * зависит и от текста файла, и от того, какие импортированные модули уже
     * разобраны. Кэш нужен потому, что обход вызывается из Completion, а тот
     * срабатывает на каждое нажатие.
     */
    private visibleModulesByUri = new LruCache<
        string,
        { revision: string; modules: readonly string[] }
    >(DOCUMENT_CACHE_ENTRIES);
    /**
     * Общая модель актуальности семантических ответов.
     *
     * Живёт здесь, потому что resolver и есть общий семантический узел:
     * у него на руках и индекс проекта, и каталог платформы, и его
     * держат все прочие потребители. Заводить её отдельным объектом и
     * протаскивать через десяток конструкторов — то же самое, только
     * длиннее.
     */
    private readonly state: RslSemanticState;

    constructor(
        private index: WorkspaceIndex,
        private builtins: BuiltinCatalog = getDefaults(),
        private platformModules?: PlatformModuleCatalog
    ) {
        this.state = new RslSemanticState({
            textVersion: uri => this.index.getModule(uri)?.version ?? -1,
            importsKey: uri => this.index.getDeclaredImportsKey(uri),
            closureKey: uri => this.index.getImportedClosureKey(uri),
            catalogRevision: () => this.index.catalog?.revision ?? 0,
            workspaceRevision: () =>
                this.index.workspaceFilesRevision,
            platformRevision: () => this.platformModules?.revision ?? 0,
            semanticRevision: uri => this.index.getSemanticRevision(uri)
        });
    }

    /**
     * Модель актуализации для прочих семантических потребителей.
     *
     * Одна на всех намеренно. Пока каждый складывал свой ключ, они
     * расходились: один признавал свой кэш устаревшим, другой нет, и
     * подсветка расходилась с переходом.
     */
    /**
     * Каталог прикладных модулей, если он есть.
     *
     * Нужен проверке «модуль не подключён»: обратный указатель имён лежит в
     * каталоге, а второй его копии заводить незачем.
     */
    get platformModuleCatalog(): PlatformModuleCatalog | undefined {
        return this.platformModules;
    }

    get semanticState(): RslSemanticState {
        return this.state;
    }

    /** Слепок условий: см. RslSemanticState.capture. */
    captureSemanticStamp(
        uri: string,
        depends: IRslSemanticDependencies,
        settings?: string
    ): IRslSemanticStamp {
        return this.state.capture(uri, depends, { settings });
    }

    /** Устарели ли условия, при которых считался ответ. */
    isSemanticStampStale(
        stamp: IRslSemanticStamp,
        settings?: string
    ): boolean {
        return this.state.isStale(stamp, { settings });
    }

    resolveAt(
        uri: string,
        tree: RslSymbol,
        offset: number
    ): IResolvedSymbol | undefined {
        const module = this.index.getModule(uri);

        if (!module) {
            return undefined;
        }

        const tokens = this.getTokens(module);
        let token = tokenAtOffset(tokens, offset, true);

        /*
         * По грамматике @ — отдельный унарный оператор, а не часть NAME.
         * При переходе с самого символа @ всё равно разрешаем следующий
         * идентификатор, чтобы навигация по ссылочному аргументу не ухудшилась.
         */
        if (token?.kind === "symbol" && token.raw === "@") {
            const operatorIndex = findTokenIndex(tokens, token);
            const operand = tokens[operatorIndex + 1];

            if (operand?.kind === "identifier") {
                token = operand;
            }
        }

        if (!token || token.kind !== "identifier") {
            return undefined;
        }

        /*
         * Актуальность — по ревизиям, а не по ключу Import-контекста: ключ
         * собирает Import-замыкание в строку, а вызывался он здесь на каждый
         * идентификатор файла. На файле 379 КБ это 37 627 сборок ключа.
         *
         * Ревизия берётся документа, а не всего индекса. Общая росла от любого
         * модуля проекта, и фоновая индексация постороннего файла обнуляла этот
         * кэш — тысячи раз подряд в режимах workspaceIdle и full.
         */
        const stamp = this.state.hotStamp(module.uri);
        let cache = this.resolutionByModule.get(module);

        if (!cache || !sameRslHotStamp(cache.stamp, stamp)) {
            cache = {
                stamp,
                byTokenStart: new Map<number, IResolvedSymbol | null>()
            };
            this.resolutionByModule.set(module, cache);
        }

        if (cache.byTokenStart.has(token.start)) {
            this.resolutionCacheHits++;
            return cache.byTokenStart.get(token.start) || undefined;
        }

        this.resolutionCacheMisses++;
        const resolved = this.resolveTokenAt(
            uri,
            tree,
            offset,
            token,
            tokens
        );
        cache.byTokenStart.set(token.start, resolved || null);
        return resolved;
    }

    /**
     * Ключ, по которому кэшируется всё, что зависит от Import-контекста.
     *
     * Кроме Import-замыкания в него входит ревизия каталога прикладных модулей:
     * имя, не разрешившееся до чтения состава модуля, обязано разрешиться после.
     * Ключ один на всех потребителей — иначе один из них признавал бы свой кэш
     * устаревшим, а другой нет, и подсветка расходилась бы с переходом.
     */
    getImportContextKey(uri: string): string {
        return this.state.capture(uri, FULL_CONTEXT_DEPENDS).key;
    }

    /**
     * То же, но без самого документа: «узнал ли сервер что-то о других файлах».
     *
     * Полный ключ содержит версию открытого документа, и от каждой правки
     * меняется. Потребителям, которых волнует только окружение файла, это
     * обнуляет кэш на каждое нажатие клавиши — при том что об импортах ничего
     * не изменилось. Собственное содержимое документа такие потребители обязаны
     * учитывать сами: см. moduleWideNamesFingerprint в diagnostics.
     */
    getImportedContextKey(uri: string): string {
        return this.state.capture(uri, IMPORTED_CONTEXT_DEPENDS).key;
    }

    /**
     * Полнота Import-контекста документа.
     *
     * Нужна проверкам, которые делают вывод из отсутствия символа: пока
     * контекст не complete, «не нашли» и «нет» — разные утверждения.
     */
    getImportContextState(uri: string): IRslImportContextState {
        return this.state.remember(
            uri,
            "importContextState",
            IMPORT_CONTEXT_STATE_DEPENDS,
            () => buildImportContextState(
                this.index,
                uri,
                this.platformModules
            )
        );
    }

    getCacheStats(): { hits: number; misses: number } {
        return {
            hits: this.resolutionCacheHits,
            misses: this.resolutionCacheMisses
        };
    }

    /**
     * Имена, допустимые в позиции типа.
     *
     * Примитивы, встроенные классы, классы текущего файла, классы полного
     * Import-замыкания и классы импортированных прикладных модулей. Классы
     * неимпортированных файлов сюда НЕ попадают: подставленное имя не
     * скомпилировалось бы, а Auto Import для позиции типа не предусмотрен.
     */
    getTypeCompletions(uri: string, tree: RslSymbol): CompletionItem[] {
        const result: CompletionItem[] = PRIMITIVE_TYPES.map(name => ({
            label: displayTypeName(name),
            kind: CompletionItemKind.TypeParameter,
            detail: "Тип RSL",
            insertText: displayTypeName(name)
        }));

        for (const item of this.builtins.completionItems) {
            if (item.kind === CompletionItemKind.Class) {
                result.push(asTypeItem(item));
            }
        }

        for (const child of tree.children) {
            if (child.kind === CompletionItemKind.Class) {
                result.push(asTypeItem(child.completionItem));
            }
        }

        for (const module of this.index.getImportedModules(uri)) {
            for (const child of module.symbolTree.children) {
                if (
                    child.kind === CompletionItemKind.Class &&
                    !child.isPrivate
                ) {
                    result.push(asTypeItem(child.completionItem));
                }
            }
        }

        if (this.platformModules) {
            for (const item of this.platformModules.classCompletionItems(
                this.visiblePlatformModules(uri)
            )) {
                result.push(asTypeItem(item));
            }
        }

        return deduplicateCompletionItems(result);
    }

    /** Разрешает имя в позиции типа, не позволяя переменной затенить CLASS. */
    resolveTypeName(
        uri: string,
        tree: RslSymbol,
        name: string
    ): IIndexedSymbol | undefined {
        return this.findClassSymbol(uri, tree, name);
    }

    /**
     * Разрешает имя метода, переданное строкой в R2M(object, "Method").
     * Обычный resolveAt здесь неприменим: строковый token не является NAME,
     * но тип receiver определяется тем же способом, что для object.Method().
     */
    resolveMemberReference(
        uri: string,
        tree: RslSymbol,
        receiverOffset: number,
        memberName: string
    ): IIndexedSymbol | undefined {
        const module = this.index.getModule(uri);
        if (!module) {
            return undefined;
        }

        const receiver = tokenAtOffset(
            this.getTokens(module),
            receiverOffset,
            true
        );
        if (!receiver || receiver.kind !== "identifier") {
            return undefined;
        }

        return this.resolveMember(
            uri,
            tree,
            receiverOffset,
            receiver,
            memberName
        );
    }

    private resolveTokenAt(
        uri: string,
        tree: RslSymbol,
        offset: number,
        token: IRslToken,
        tokens: IRslToken[]
    ): IResolvedSymbol | undefined {
        const tokenIndex = findTokenIndex(tokens, token);
        const receiver = this.getReceiverToken(tokens, tokenIndex);
        const referenceName = normalizeReferenceIdentifier(token.value);

        if (receiver) {
            const member = this.resolveMember(
                uri,
                tree,
                offset,
                receiver,
                token.value
            );

            return member
                ? {
                    uri: member.uri,
                    symbol: member.symbol,
                    token
                }
                : undefined;
        }

        const resolved = this.resolveName(uri, tree, referenceName, offset);

        if (!resolved) {
            return undefined;
        }

        return {
            uri: resolved.uri,
            symbol: resolved.symbol,
            token,
            platformModuleName: resolved.platformModule
                ? this.platformModules?.moduleDisplayName(
                    resolved.platformModule
                ) || resolved.platformModule
                : undefined
        };
    }

    /**
     * Обычное разрешение имени: только то, что видно компилятору в этой точке.
     *
     * Порядок фиксирован и совпадает с правилами языка:
     *
     *   1. параметры и локальные переменные текущего Macro или метода;
     *   2. собственные свойства и методы текущего класса — по имени, без this;
     *   3. унаследованные свойства и методы;
     *   4. имена текущего модуля;
     *   5. полное Import-замыкание;
     *   6. стандартная библиотека;
     *   7. импортированные прикладные модули.
     *
     * Глобального поиска по workspace здесь НЕТ. Он находил символ в файле,
     * который документ не импортирует: Hover, Definition, подсветка и вывод типа
     * показывали имя как известное, а компилятор его не знает. Неимпортированные
     * имена — дело Auto Import, у которого поиск по проекту свой (см.
     * findAutoImportCandidates).
     */
    /**
     * Ревизия прикладных каталогов.
     *
     * Входит в ключ сеанса Completion: состав подсказок зависит от того,
     * какие модули уже прочитаны, и догрузка каталога обязана попасть в
     * следующий сеанс, а не изменить уже открытый список.
     */
    get catalogRevision(): number {
        return this.platformModules?.revision ?? 0;
    }

    resolveName(
        uri: string,
        tree: RslSymbol,
        name: string,
        offset: number,
        /*
         * Ограничение на род символа.
         *
         * В позиции вызова годятся только класс, процедура и метод: переменная
         * с тем же именем вызываемым быть не может. Без этого `service =
         * Service()` внутри `Var service;` разрешал бы Service в саму
         * переменную — и тип переменной остался бы неизвестным.
         */
        accept: (symbol: RslSymbol) => boolean = ACCEPT_ANY
    ): IIndexedSymbol | undefined {
        const referenceName = normalizeReferenceIdentifier(name);
        const chain = getScopeChain(tree, offset);
        /*
         * Кэш по паре «область + имя» с интервалом действительности.
         *
         * Одно и то же имя в одной области разрешается в одно и то же — но
         * только пока смещение не пересекло объявление-кандидата: до объявления
         * имя видит внешнюю область, после — местную. Поэтому ключа мало,
         * нужен ещё интервал, внутри которого набор видимых кандидатов тот же.
         *
         * Ради этого всё и делается: на файле 379 КБ 37 627 идентификаторов
         * дают 34 различные пары «область + имя», то есть повторность 1107 раз,
         * и без кэша каждый из них заново обходит цепочку областей, наследование
         * и Import-замыкание. Разрешение имён — 98% времени семантической
         * подсветки.
         */
        const cache = this.nameResolutionCache(uri);
        const key = cache
            ? this.resolutionKey(chain, referenceName, accept)
            : "";
        const entry = cache?.get(key);

        if (entry && offset >= entry.from && offset <= entry.to) {
            this.resolutionCacheHits++;
            return entry.resolved;
        }

        this.resolutionCacheMisses++;
        const resolved = this.resolveNameUncached(
            uri,
            tree,
            referenceName,
            offset,
            accept,
            chain
        );

        if (cache) {
            cache.set(key, {
                ...this.resolutionValidity(chain, referenceName, offset),
                resolved
            });
        }

        return resolved;
    }

    private resolveNameUncached(
        uri: string,
        tree: RslSymbol,
        referenceName: string,
        offset: number,
        accept: (symbol: RslSymbol) => boolean,
        chain: RslSymbol[]
    ): IIndexedSymbol | undefined {
        const pick = (scope: RslSymbol): RslSymbol | undefined => {
            const candidates = getChildrenByName(scope).get(referenceName);
            return candidates
                ? selectBestVisibleCandidate(
                    candidates.filter(accept),
                    offset
                )
                : undefined;
        };

        /* 1–2: от внутренней области к внешней, кроме самого модуля. */
        for (let position = chain.length - 1; position >= 1; position--) {
            const selected = pick(chain[position]);

            if (selected) {
                return {
                    uri,
                    symbolId: selected.id,
                    symbol: selected
                };
            }
        }

        /* 3: унаследованные члены текущего класса — ближайшего изнутри. */
        const currentClass = innermostClass(chain);

        if (currentClass) {
            const inherited = this.resolveInheritedMember(
                uri,
                tree,
                offset,
                { uri, symbolId: currentClass.id, symbol: currentClass },
                referenceName
            );

            if (inherited && accept(inherited.symbol)) {
                return inherited;
            }

            /*
             * Предопределённый инициализатор базового класса: Init + имя базы.
             * В тексте его объявления нет, поэтому среди детей класса он и не
             * найдётся — но именем он существует.
             */
            const initializer = this.resolveBaseInitializer(
                uri,
                tree,
                referenceName,
                { uri, symbolId: currentClass.id, symbol: currentClass }
            );

            if (initializer && accept(initializer.symbol)) {
                return initializer;
            }
        }

        /* 4: имена модуля. */
        const moduleSymbol = pick(tree);

        if (moduleSymbol) {
            return {
                uri,
                symbolId: moduleSymbol.id,
                symbol: moduleSymbol
            };
        }

        /* 5: полное Import-замыкание. */
        const imported = this.index
            .findImportedSymbols(uri, referenceName)
            .find(item => accept(item.symbol));

        if (imported) {
            return imported;
        }

        /* 6: стандартная библиотека. */
        const builtin = this.builtins.findSymbol(referenceName);

        if (builtin && accept(builtin)) {
            return {
                uri: RSL_BUILTIN_URI,
                symbolId: builtin.id,
                symbol: builtin
            };
        }

        /*
         * 7: символ импортированного прикладного модуля — последним, после
         * объявлений файла, импортированных модулей проекта и стандартной
         * библиотеки: он доступен только через Import и не должен перекрывать
         * одноимённое объявление, которое ближе к пользователю.
         */
        const platform = this.platformModules?.findSymbol(
            this.visiblePlatformModules(uri),
            referenceName
        );

        return platform && accept(platform.symbol)
            ? {
                uri: RSL_BUILTIN_URI,
                symbolId: platform.symbol.id,
                symbol: platform.symbol,
                platformModule: platform.moduleKey
            }
            : undefined;
    }

    /**
     * Интервал смещений, внутри которого разрешение имени не меняется.
     *
     * Ответ зависит от смещения только через видимость объявлений: пока оно не
     * пересекло ни одного кандидата с этим именем, набор видимого тот же, а
     * значит и результат. Границами служат ближайшие объявления-кандидаты слева
     * и справа, а также границы самой внутренней области — за ней меняется уже
     * цепочка областей.
     */
    private resolutionValidity(
        chain: readonly RslSymbol[],
        referenceName: string,
        offset: number
    ): { from: number; to: number } {
        const innermost = chain[chain.length - 1];
        let from = innermost ? innermost.range.start : 0;
        let to = innermost ? innermost.range.end : Number.MAX_SAFE_INTEGER;

        for (const scope of chain) {
            const candidates = getChildrenByName(scope).get(referenceName);

            if (!candidates) {
                continue;
            }

            for (const candidate of candidates) {
                /*
                 * Границей служит НАЧАЛО имени объявления, а не конец.
                 *
                 * На самом имени запрос обязан разрешиться в это объявление, а
                 * до него — во внешнее. То есть ответ меняется ровно в
                 * selectionRange.start. С границей по концу имени оба смещения
                 * попадали в один интервал, и ответ зависел от того, какой из
                 * них спросили первым: `Var x` внутри Macro разрешался во
                 * внешний x, если до этого спрашивали строку выше.
                 */
                const boundary = candidate.selectionRange.start;

                if (boundary <= offset) {
                    from = Math.max(from, boundary);
                } else {
                    to = Math.min(to, boundary - 1);
                }
            }
        }

        return { from, to };
    }

    /** Ключ кэша: область, имя и род принимаемых символов. */
    private resolutionKey(
        chain: readonly RslSymbol[],
        referenceName: string,
        accept: (symbol: RslSymbol) => boolean
    ): string {
        const innermost = chain[chain.length - 1];
        return `${innermost ? innermost.id : "root"}|${referenceName}|` +
            `${accept === ACCEPT_ANY ? "any" : acceptTag(accept)}`;
    }

    /**
     * Кэш разрешения имён этого модуля.
     *
     * Живёт ровно столько же, сколько кэш по позициям токенов: пока не сменился
     * Import-контекст и пока это та же модель документа. Модель неизменяема, и
     * новая версия файла даёт новый объект — старый кэш уходит с ним.
     */
    private nameResolutionCache(
        uri: string
    ): Map<string, IResolutionCacheEntry> | undefined {
        const module = this.index.getModule(uri);

        if (!module) {
            return undefined;
        }

        /*
         * Актуальность проверяется парой чисел, а не ключом Import-контекста.
         *
         * Ключ — строка, и он собирает Import-замыкание. Первая версия этого
         * кэша звала его на каждое разрешение имени и на каждую запись: 75 288
         * вызовов на файл вместо 37 627 разрешений, и кэш вышел дороже того,
         * что он экономил. Ревизии индекса и каталога меняются ровно тогда же,
         * когда изменился бы ключ, а стоят одно сравнение. Ревизия — документа,
         * а не всего индекса: см. getSemanticRevision.
         */
        const stamp = this.state.hotStamp(module.uri);
        let cache = this.namesByModule.get(module);

        if (!cache || !sameRslHotStamp(cache.stamp, stamp)) {
            cache = { stamp, byKey: new Map() };
            this.namesByModule.set(module, cache);
        }

        return cache.byKey;
    }

    /**
     * Предопределённый инициализатор базового класса.
     *
     * Руководство: «Для инициализации базового класса необходимо вызвать
     * предопределенный метод, название которого образуется путем добавления к
     * имени класса приставки Init». То есть `Class (Персона) Сотрудник`
     * вызывает `InitПерсона` — метод, которого в тексте нет ни у одного из двух
     * классов.
     *
     * Проверяется только НЕПОСРЕДСТВЕННАЯ база: каждый класс инициализирует
     * свою, а та — свою. Придумывать `InitПрародитель` руководство повода не
     * даёт.
     */
    private resolveBaseInitializer(
        uri: string,
        tree: RslSymbol,
        referenceName: string,
        classSymbol: IIndexedSymbol
    ): IIndexedSymbol | undefined {
        if (!referenceName.startsWith(BASE_INITIALIZER_PREFIX)) {
            return undefined;
        }

        const baseName = referenceName.slice(BASE_INITIALIZER_PREFIX.length);

        if (!baseName) {
            return undefined;
        }

        const base = this.resolveBaseClass(uri, tree, classSymbol);

        if (
            !base ||
            normalizeIdentifier(base.symbol.name) !== baseName
        ) {
            return undefined;
        }

        return {
            uri: RSL_BUILTIN_URI,
            symbolId: baseInitializerSymbol(base.symbol).id,
            symbol: baseInitializerSymbol(base.symbol)
        };
    }

    /**
     * Базовый класс, который инициализирует `Init<База>` в этой позиции.
     *
     * Нужно переходу к определению: у самого инициализатора объявления нет, а
     * осмысленная цель перехода есть — объявление базового класса. Возвращается
     * НАСТОЯЩИЙ символ класса, с его файлом и позицией, поэтому переход ведёт
     * туда же, куда переход по имени базы в заголовке `Class (База)`.
     *
     * Переименование этим методом не пользуется намеренно: оно работает через
     * resolveAt и получает синтетический символ, от которого отказывается.
     * Иначе новое имя для `InitПерсона` переписало бы класс `Персона`.
     */
    resolveBaseInitializerClass(
        uri: string,
        tree: RslSymbol,
        offset: number
    ): IIndexedSymbol | undefined {
        const module = this.index.getModule(uri);

        if (!module) {
            return undefined;
        }

        const token = tokenAtOffset(this.getTokens(module), offset, true);

        if (!token || token.kind !== "identifier") {
            return undefined;
        }

        const referenceName = normalizeReferenceIdentifier(token.value);

        if (!referenceName.startsWith(BASE_INITIALIZER_PREFIX)) {
            return undefined;
        }

        const currentClass = innermostClass(getScopeChain(tree, offset));

        if (!currentClass) {
            return undefined;
        }

        const base = this.resolveBaseClass(uri, tree, {
            uri,
            symbolId: currentClass.id,
            symbol: currentClass
        });

        return base &&
            `${BASE_INITIALIZER_PREFIX}${normalizeIdentifier(
                base.symbol.name
            )}` === referenceName
            ? base
            : undefined;
    }

    /**
     * Имя инициализатора базового класса для текущей позиции, если он есть.
     *
     * Нужно автодополнению: подсказать `InitПерсона` внутри `Class (Персона)`
     * иначе неоткуда — объявления с таким именем в проекте не существует.
     */
    private baseInitializerCompletion(
        uri: string,
        tree: RslSymbol,
        offset: number
    ): CompletionItem | undefined {
        const currentClass = innermostClass(getScopeChain(tree, offset));

        if (!currentClass) {
            return undefined;
        }

        const base = this.resolveBaseClass(uri, tree, {
            uri,
            symbolId: currentClass.id,
            symbol: currentClass
        });

        return base
            ? baseInitializerSymbol(base.symbol).completionItem
            : undefined;
    }

    /**
     * Член, унаследованный текущим классом.
     *
     * Собственные члены сюда не попадают: их уже нашла область видимости. Здесь
     * обходятся только базовые классы, поэтому обращение `Amount = 1` внутри
     * метода производного класса разрешается в свойство базового.
     */
    private resolveInheritedMember(
        uri: string,
        tree: RslSymbol,
        offset: number,
        classSymbol: IIndexedSymbol,
        memberName: string
    ): IIndexedSymbol | undefined {
        const base = this.resolveBaseClass(uri, tree, classSymbol);

        return base
            ? this.resolveMemberInHierarchy(
                uri,
                tree,
                offset,
                base,
                memberName,
                new Set<string>([
                    `${classSymbol.uri}#${classSymbol.symbol.id}`
                ])
            )
            : undefined;
    }

    getCompletions(
        uri: string,
        tree: RslSymbol,
        offset: number
    ): CompletionItem[] {
        const module = this.index.getModule(uri);

        if (!module) {
            return [];
        }

        const tokens = this.getTokens(module);
        const dotIndex = this.getDotIndexBeforeOffset(tokens, offset);

        if (dotIndex >= 0) {
            const receiver = this.getPreviousIdentifier(tokens, dotIndex);

            if (receiver) {
                const classObject = this.resolveReceiverClass(
                    uri,
                    tree,
                    offset,
                    receiver
                );

                if (classObject) {
                    return deduplicateCompletionItems(
                        this.collectMembersInHierarchy(
                            uri,
                            tree,
                            offset,
                            classObject
                        ).map(child => withCompletionPriority(
                            child.completionItem,
                            "0"
                        ))
                    );
                }

                /*
                 * После точки предлагаются только члены — и ничего, если класс
                 * получателя неизвестен.
                 *
                 * Раньше здесь начинался общий список области видимости, и на
                 * `doc.rec.` подсказка показывала локальные переменные и
                 * процедуры файла. Членами они не являются: тип Record
                 * описывается словарём базы данных, состав его полей
                 * расширению неизвестен, и честный ответ — пустой список, а не
                 * посторонние имена.
                 */
                return [];
            }
        }

        const result: CompletionItem[] = [];
        const scopes = getScopeChain(tree, offset).reverse();

        for (let scopeIndex = 0; scopeIndex < scopes.length; scopeIndex++) {
            const scope = scopes[scopeIndex];
            const priority = scopeIndex === 0
                ? "0"
                : scope === tree
                    ? "2"
                    : "1";
            for (const child of scope.children) {
                if (!isVisibleAt(child, offset)) {
                    continue;
                }

                result.push(withCompletionPriority(
                    this.completionItemWithInferredType(
                        uri,
                        tree,
                        child,
                        offset
                    ),
                    priority
                ));
            }
        }

        /*
         * Инициализатор базового класса — рядом с локальными именами: внутри
         * `Class (Персона)` он нужен так же часто, как собственные свойства, а
         * подсказать его больше некому — объявления с таким именем нет.
         */
        const initializer = this.baseInitializerCompletion(uri, tree, offset);

        if (initializer) {
            result.push(withCompletionPriority(initializer, "0"));
        }

        result.push(...this.index.getImportedCompletionItems(uri));

        /*
         * Классы прикладных модулей — только тех, что импортированы. Данные к
         * этому моменту уже прочитаны (ensureLoaded вызывается по готовности
         * списка Import), поэтому здесь остаётся чтение готовых map.
         */
        if (this.platformModules) {
            result.push(...this.platformModules.completionItems(
                this.visiblePlatformModules(uri)
            ));
        }

        return deduplicateCompletionItems(result);
    }

    resolveInScopeChain(
        tree: RslSymbol,
        name: string,
        offset: number
    ): RslSymbol | undefined {
        const normalized = normalizeIdentifier(name);
        const scopes = getScopeChain(tree, offset).reverse();

        for (const scope of scopes) {
            const candidates = getChildrenByName(scope).get(normalized);

            if (!candidates || candidates.length === 0) {
                continue;
            }

            const selected = selectBestVisibleCandidate(candidates, offset);

            if (selected) {
                return selected;
            }
        }

        return undefined;
    }

    private getTokens(module: IIndexedModule): IRslToken[] {
        let result = this.tokensByModule.get(module);

        if (!result) {
            /* syntax.tokens уже не содержит trivia/comments. */
            result = module.syntax.tokens.filter(token =>
                token.kind !== "square"
            );
            this.tokensByModule.set(module, result);
        }

        return result;
    }

    /**
     * Прикладные модули, чьи классы видны в этом документе.
     *
     * Только по Import — как прямым, так и через уже разобранные
     * импортированные файлы: модуль, импортированный внутри импортированного
     * файла, тоже доступен. Транзитивный обход идёт ИСКЛЮЧИТЕЛЬНО по модулям,
     * которые уже лежат в индексе: ни чтения файла, ни постановки в очередь
     * загрузки здесь не происходит. Иначе Ctrl+Space в файле с десятком Import
     * запускал бы обход проекта — ровно в тот момент, когда пользователь ждёт
     * ответа. Ещё не разобранный Import просто не даёт своих модулей, а
     * появятся они при следующем запросе, когда индекс их уже построит.
     */
    visiblePlatformModules(
        uri: string,
        /*
         * Import текущего текста, если он свежее разобранной модели.
         *
         * Нужен быстрому пути Completion: там модель отстаёт на одну правку, а
         * только что набранный Import должен действовать сразу. Кэш в этом
         * случае не используется — его ключ состав Import не описывает.
         */
        seedImports?: readonly string[]
    ): readonly string[] {
        const catalog = this.platformModules;

        if (!catalog?.ready) {
            return [];
        }

        if (seedImports) {
            return this.expandPlatformModules(uri, seedImports);
        }

        const cached = this.visibleModulesByUri.get(uri);
        /*
         * Ревизия каталога входит в ключ наравне с ревизией индекса: состав
         * зависит и от Import в тексте, и от того, какие модули уже прочитаны.
         * Индекс каталога читается асинхронно, и первый ответ «модулей не
         * видно» без этого оставался в кэше до следующей правки текста.
         */
        const revision = `${this.index.revision}:${catalog.revision}`;

        if (cached?.revision === revision) {
            return cached.modules;
        }

        const modules = this.expandPlatformModules(
            uri,
            this.index.getModule(uri)?.imports || []
        );
        this.visibleModulesByUri.set(uri, { revision, modules });
        return modules;
    }

    /** Прикладные модули, видимые из заданного списка Import, транзитивно. */
    private expandPlatformModules(
        uri: string,
        seedImports: readonly string[]
    ): readonly string[] {
        const catalog = this.platformModules;

        if (!catalog) {
            return Object.freeze([]);
        }

        const found = new Set<string>();

        /*
         * Обход цепочки Import общий: см. collectRslImportClosure.
         *
         * Прикладные модули забираются до разрешения имени: у каталога
         * платформы преимущество перед файлом проекта с тем же именем, и внутрь
         * такого имени обход не заходит — состав модуля знает каталог.
         */
        /*
         * Модуль открывает и то, что подключает сам.
         *
         * `total` у себя пишет `Import rsd`, и файл, подключивший
         * total, видит имена rsd — так же, как если бы подключил
         * файл проекта, который пишет тот же Import. Обход по
         * подключённому идёт вглубь: цепочка бывает длиннее одного
         * шага, а повторов не будет — их отсекает сам Set.
         */
        const addModule = (moduleName: string): void => {
            if (found.has(moduleName)) {
                return;
            }

            found.add(moduleName);

            for (const next of catalog.importsOfModule(moduleName)) {
                if (catalog.knowsModule(next)) {
                    addModule(next);
                }
            }
        };

        collectRslImportClosure(this.index, uri, {
            seedImports,
            skipName: importName => {
                if (!catalog.knowsModule(importName)) {
                    return false;
                }

                addModule(importName);

                return true;
            }
        });

        return Object.freeze(Array.from(found));
    }

    /**
     * Класс встроенной библиотеки или прикладного модуля — без модели документа.
     *
     * Нужен быстрому пути Completion: до готовности модели дерева символов нет, а
     * эти два источника от него и не зависят. Встроенные классы видны всегда,
     * прикладные — через Import, поэтому его состав передаётся вызывающим: он
     * читает Import из текста текущей версии, а не из отставшей модели.
     */
    findClassWithoutModel(
        uri: string,
        className: string,
        seedImports: readonly string[]
    ): RslSymbol | undefined {
        return this.findExternalClass(uri, className, seedImports)?.symbol;
    }

    /**
     * Встроенный или прикладной класс вместе с модулем-владельцем.
     *
     * Владелец нужен, чтобы разрешить базовый класс в его собственном
     * контексте: имя базы ищется в модуле класса и его зависимостях, а не
     * заново от активного документа. Иначе одноимённый класс проекта
     * подменял бы базу класса прикладного модуля.
     */
    findExternalClassWithOwner(
        uri: string,
        className: string,
        seedImports: readonly string[]
    ): IRslExternalClass | undefined {
        return this.findExternalClass(uri, className, seedImports);
    }

    /**
     * Класс по имени для быстрого пути: модуль workspace, встроенный или
     * прикладной.
     *
     * Порядок тот же, что у полного разрешения имени типа, и живёт он здесь, а
     * не в реестре подсказок: правила видимости — знание resolver, и дублировать
     * их значит однажды разойтись.
     */
    findFastClass(
        uri: string,
        className: string,
        imports: readonly string[]
    ): IRslFastClass | undefined {
        /*
         * Обход начинается со СВЕЖЕГО списка Import, а не с того, что лежит в
         * разобранной модели документа: она отстаёт на правку, и только что
         * набранный Import иначе не действовал бы.
         */
        const found = this.findWorkspaceClasses(
            this.resolveImportUris(imports),
            className,
            2
        );

        /*
         * Одноимённые классы в разных Import — неоднозначность. Какой выберет
         * компилятор, без полной модели неизвестно, и показать члены наугад хуже,
         * чем не показать ничего.
         */
        if (found.length > 1) {
            return undefined;
        }

        if (found.length === 1) {
            return found[0];
        }

        const external = this.findExternalClass(uri, className, imports);

        return external
            ? { symbol: external.symbol, owner: external }
            : undefined;
    }

    /** URI модулей из списка Import; неразрешённые пропускаются. */
    private resolveImportUris(imports: readonly string[]): string[] {
        const result: string[] = [];

        for (const name of imports) {
            const resolved = this.index.resolveWorkspaceFile(name);

            if (resolved.kind === "resolved") {
                result.push(resolved.value);
            }
        }

        return result;
    }

    /**
     * База класса, разрешённая относительно ЕГО источника.
     *
     * Класс модуля workspace может наследовать класс того же модуля, класс его
     * Import, встроенный или прикладной — переход между источниками обязан
     * работать в обе стороны. Класс прикладного модуля разрешает базу через
     * своего владельца: одноимённый класс проекта в его иерархию попасть не
     * должен.
     */
    findFastBaseClass(
        from: IRslFastClass,
        baseClassName: string,
        imports: readonly string[]
    ): IRslFastClass | undefined {
        if (!baseClassName) {
            return undefined;
        }

        if (from.owner) {
            const base = this.findExternalBaseClass(from.owner, baseClassName);

            return base ? { symbol: base.symbol, owner: base } : undefined;
        }

        if (!from.moduleUri) {
            return undefined;
        }

        /*
         * Класс своего модуля перекрывает импортированные, поэтому сначала
         * ищется только он сам.
         */
        const inOwn = this.findClassInModule(from.moduleUri, baseClassName);

        if (inOwn) {
            return inOwn;
        }

        const owned = this.index.getModule(from.moduleUri);
        /*
         * Среди подключений допускается ровно один кандидат: две одноимённые
         * базы — неоднозначность, и какую выберет компилятор, без полной
         * модели неизвестно.
         */
        const imported = this.findWorkspaceClasses(
            this.resolveImportUris(owned ? owned.imports : []),
            baseClassName,
            2
        );

        if (imported.length > 1) {
            return undefined;
        }

        if (imported.length === 1) {
            return imported[0];
        }

        /* В модуле базы нет: остаются встроенные и прикладные классы. */
        const external = this.findExternalClass(
            from.moduleUri,
            baseClassName,
            owned ? owned.imports : imports
        );

        return external
            ? { symbol: external.symbol, owner: external }
            : undefined;
    }

    /** Класс с таким именем в одном модуле, без его подключений. */
    private findClassInModule(
        uri: string,
        className: string
    ): IRslFastClass | undefined {
        const module = this.index.getModule(uri);

        if (!module) {
            return undefined;
        }

        const wanted = normalizeIdentifier(className);
        const symbol = module.symbolTree.children.find(item =>
            normalizeIdentifier(item.name) === wanted &&
            item.kind === CompletionItemKind.Class
        );

        return symbol ? { symbol, moduleUri: uri } : undefined;
    }

    /** Классы с таким именем в модулях и во всём, что видно через их Import. */
    private findWorkspaceClasses(
        seeds: readonly string[],
        className: string,
        limit: number
    ): IRslFastClass[] {
        const wanted = normalizeIdentifier(className);
        const seen = new Set<string>();
        const queue = seeds.slice();
        const result: IRslFastClass[] = [];

        for (let position = 0; position < queue.length; position++) {
            const current = queue[position];

            if (seen.has(current)) {
                continue;
            }
            seen.add(current);
            const module = this.index.getModule(current);

            if (!module) {
                continue;
            }

            const symbol = module.symbolTree.children.find(item =>
                normalizeIdentifier(item.name) === wanted &&
                item.kind === CompletionItemKind.Class
            );

            if (symbol) {
                result.push({ symbol, moduleUri: current });

                if (result.length >= limit) {
                    return result;
                }
            }

            for (const name of module.imports) {
                const resolved = this.index.resolveWorkspaceFile(name);

                if (resolved.kind === "resolved") {
                    queue.push(resolved.value);
                }
            }
        }

        return result;
    }

    /** База внешнего класса, разрешённая относительно его модуля. */
    findExternalBaseClass(
        owner: IRslExternalClass,
        baseClassName: string
    ): IRslExternalClass | undefined {
        if (!baseClassName) {
            return undefined;
        }

        if (owner.moduleKey) {
            const platform = this.platformModules?.findBaseClass(
                owner.moduleKey,
                baseClassName
            );

            if (platform) {
                return {
                    symbol: platform.symbol,
                    moduleKey: platform.moduleKey
                };
            }
        }

        /* У класса стандартной библиотеки модуля нет: база тоже встроенная. */
        const builtin = this.builtins.findClass(baseClassName);

        return builtin ? { symbol: builtin, moduleKey: "" } : undefined;
    }

    private findExternalClass(
        uri: string,
        className: string,
        seedImports: readonly string[]
    ): IRslExternalClass | undefined {
        const builtin = this.builtins.findClass(className);

        if (builtin) {
            return { symbol: builtin, moduleKey: "" };
        }

        const platform = this.platformModules?.findClass(
            this.visiblePlatformModules(uri, seedImports),
            className
        );

        return platform
            ? { symbol: platform.symbol, moduleKey: platform.moduleKey }
            : undefined;
    }

    /**
     * Базовый класс, разрешённый относительно модуля объявления.
     *
     * Имя базового класса ищется в том модуле, где объявлен текущий класс, а
     * не обязательно в исходном документе: Import у них разные. Для класса
     * стандартной библиотеки модуля нет, и имя разрешается от документа
     * запроса — оттуда поиск всё равно доходит до каталога встроенных классов.
     *
     * У класса прикладного модуля владелец известен, и база ищется ТОЛЬКО в нём
     * и в объявленных зависимостях этого модуля. Раньше здесь начинался общий
     * поиск от документа запроса, а он доходил до workspace: база `RsbPayment`
     * класса `RsbBBPayment` могла разрешиться в произвольный одноимённый класс
     * проекта — и подставить его состав членов.
     */
    private resolveBaseClass(
        requestUri: string,
        requestTree: RslSymbol,
        classSymbol: IIndexedSymbol
    ): IIndexedSymbol | undefined {
        const baseClassName = classSymbol.symbol.baseClassName;

        if (!baseClassName) {
            return undefined;
        }

        if (classSymbol.platformModule) {
            const base = this.platformModules?.findBaseClass(
                classSymbol.platformModule,
                baseClassName
            );

            if (base) {
                return {
                    uri: RSL_BUILTIN_URI,
                    symbolId: base.symbol.id,
                    symbol: base.symbol,
                    platformModule: base.moduleKey
                };
            }

            /*
             * Стандартная библиотека — единственный допустимый выход за пределы
             * модуля и его зависимостей: она видна без Import. Так цепочка
             * TAcqDocument -> TPersistVarRecord -> TVarRecord доходит до
             * стандартного TVarRecord, описанного полностью.
             */
            const standard = this.builtins.findClass(baseClassName);

            return standard
                ? {
                    uri: RSL_BUILTIN_URI,
                    symbolId: standard.id,
                    symbol: standard
                }
                : undefined;
        }

        const classModule = classSymbol.uri === RSL_BUILTIN_URI
            ? undefined
            : this.index.getModule(classSymbol.uri);

        return classModule
            ? this.findClassSymbol(
                classSymbol.uri,
                classModule.symbolTree,
                baseClassName
            )
            : this.findClassSymbol(requestUri, requestTree, baseClassName);
    }

    /**
     * Члены класса вместе с унаследованными — для Ctrl+Space после точки.
     *
     * Разрешение одного члена цепочку наследования обходит (см.
     * resolveMemberInHierarchy), а список для автодополнения раньше брал
     * только собственных детей класса. Из-за этого переход по унаследованному
     * свойству работал, но в подсказке его не было — то есть найти его можно
     * было только зная, что оно существует.
     */
    private collectMembersInHierarchy(
        requestUri: string,
        requestTree: RslSymbol,
        offset: number,
        classSymbol: IIndexedSymbol
    ): RslSymbol[] {
        const result: RslSymbol[] = [];
        const taken = new Set<string>();
        const visited = new Set<string>();
        let current: IIndexedSymbol | undefined = classSymbol;

        while (current) {
            const classKey = `${current.uri}#${current.symbol.id}`;

            /* Та же защита от циклической цепочки, что и в разрешении члена. */
            if (visited.has(classKey)) {
                break;
            }
            visited.add(classKey);

            const allowPrivate = this.canAccessPrivateMembers(
                requestUri,
                requestTree,
                offset,
                current
            );

            for (const child of current.symbol.children) {
                if (!allowPrivate && child.isPrivate) {
                    continue;
                }

                const key = normalizeIdentifier(child.name);

                /* Член производного класса перекрывает член базового. */
                if (taken.has(key)) {
                    continue;
                }
                taken.add(key);
                result.push(child);
            }

            current = this.resolveBaseClass(requestUri, requestTree, current);
        }

        return result;
    }

    private resolveMemberInHierarchy(
        requestUri: string,
        requestTree: RslSymbol,
        offset: number,
        classSymbol: IIndexedSymbol,
        memberName: string,
        visited: Set<string>
    ): IIndexedSymbol | undefined {
        const classKey = `${classSymbol.uri}#${classSymbol.symbol.id}`;

        /*
        * Защита от ошибочной циклической цепочки наследования:
        *
        *     Class A(B)
        *     Class B(A)
        */
        if (visited.has(classKey)) {
            return undefined;
        }

        visited.add(classKey);

        const normalizedName = normalizeIdentifier(memberName);
        const allowPrivate = this.canAccessPrivateMembers(
            requestUri,
            requestTree,
            offset,
            classSymbol
        );

        const directCandidates = getChildrenByName(classSymbol.symbol).get(
            normalizedName
        );

        const directMember = directCandidates?.find(
            child => allowPrivate || !child.isPrivate
        );

        /*
        * Член производного класса перекрывает одноимённый член базового.
        */
        if (directMember) {
            return {
                uri: classSymbol.uri,
                symbolId: directMember.id,
                symbol: directMember,
                /*
                 * Владелец наследуется от класса: без этого база класса, до
                 * которого дошли по цепочке, снова искалась бы вне модуля.
                 */
                platformModule: classSymbol.platformModule
            };
        }

        const baseClass = this.resolveBaseClass(
            requestUri,
            requestTree,
            classSymbol
        );

        if (!baseClass) {
            return undefined;
        }

        return this.resolveMemberInHierarchy(
            requestUri,
            requestTree,
            offset,
            baseClass,
            memberName,
            visited
        );
    }

    private resolveMember(
        uri: string,
        tree: RslSymbol,
        offset: number,
        receiver: IRslToken,
        memberName: string
    ): IIndexedSymbol | undefined {
        const receiverClass = this.resolveReceiverClass(
            uri,
            tree,
            offset,
            receiver
        );

        if (!receiverClass) {
            return undefined;
        }

        return this.resolveMemberInHierarchy(
            uri,
            tree,
            offset,
            receiverClass,
            memberName,
            new Set<string>()
        );
    }

    private resolveReceiverClass(
        uri: string,
        tree: RslSymbol,
        offset: number,
        receiver: IRslToken
    ): IIndexedSymbol | undefined {
        const receiverName = normalizeIdentifier(receiver.value);

        if (receiverName === "this") {
            const currentClass = innermostClass(
                getScopeChain(tree, offset)
            );

            return currentClass
                ? { uri, symbolId: currentClass.id, symbol: currentClass }
                : undefined;
        }

        /*
         * Получатель разрешается обычными правилами видимости, включая
         * унаследованные члены класса: `Payment.Sum` внутри метода производного
         * класса — это свойство базового, а не неизвестное имя.
         *
         * Сначала — только то, чему присваивают значение. Слева от точки стоит
         * объект, а RSL не различает регистр: без этого фильтра `ledger.Balance`
         * при наличии класса Ledger разрешался бы в сам класс, и тип получателя
         * терялся.
         */
        const receiverSymbol = this.resolveName(
            uri,
            tree,
            receiver.value,
            offset,
            isAssignableObject
        );
        const receiverObject = receiverSymbol?.uri === uri
            ? receiverSymbol.symbol
            : undefined;
        const module = this.index.getModule(uri);

        /*
         * Отсутствие объявления не повод сдаваться: в RSL переменная возникает
         * и просто от присваивания. Код вида
         *
         *     rs = ExecSQLselect (sql, ..., true);
         *     while (rs.movenext ())
         *
         * не содержит Var, поэтому rs нет в дереве символов — а тип у него
         * тем не менее известен из присваивания.
         */
        if (!receiverSymbol && !module) {
            return undefined;
        }

        /*
         * Кандидаты в порядке убывания доверия.
         *
         * Явно объявленный тип идёт ПЕРВЫМ: по руководству декларация типа —
         * это приведение, и присваивание её не меняет. `Var sql: String` держит
         * строку, чем бы её потом ни присваивали.
         *
         * Присваивание задаёт тип только там, где декларации нет. Руководство:
         * «Любая переменная без декларации типа эквивалентна декларации с
         * использованием ключевого слова Variant. В этом случае переменная может
         * содержать значение любого типа». Поэтому variant — что явный, что
         * подразумеваемый — уступает присваиванию, а всё остальное нет.
         *
         * Вывод из текста работает только по объявлениям ЭТОГО документа:
         * позиции символа чужого модуля к нашему token stream отношения не
         * имеют. Символ из Import или каталога уже несёт готовый тип.
         */
        let typeName = this.declaredTypeOf(
            module,
            receiverSymbol?.symbol,
            receiverObject
        );

        /*
         * Декларации нет — значит Variant, и тип задаёт присваивание.
         *
         * Перебора вариантов здесь быть не должно: если переменная объявлена как
         * String, членов у неё нет, и «не нашли класс String — посмотрим
         * присваивание» вернуло бы состав типа, к которому приведения не было.
         */
        if (!typeName && module && (!receiverSymbol || receiverObject)) {
            typeName = this.inferAssignedType(
                module,
                tree,
                receiver.value,
                offset,
                receiverObject
            );
        }

        /*
         * Получатель мог оказаться не переменной, а вызовом или членом чужого
         * модуля с объявленным типом: `Config().Value`, свойство импортированного
         * класса. Тогда годится обычное разрешение без фильтра.
         */
        if (!typeName && !receiverSymbol) {
            const anySymbol = this.resolveName(
                uri,
                tree,
                receiver.value,
                offset
            );

            typeName = anySymbol
                ? normalizeIdentifier(anySymbol.symbol.typeName)
                : "";
        }

        if (!typeName || normalizeIdentifier(typeName) === "variant") {
            return undefined;
        }

        return this.findClassSymbol(uri, tree, typeName);
    }

    /**
     * Явно объявленный тип символа, если он есть.
     *
     * Пусто означает «декларации нет», то есть Variant: руководство приравнивает
     * переменную без декларации к Variant, и такая переменная может содержать
     * значение любого типа. Всё остальное — приведение, которое присваиванием не
     * отменяется.
     *
     * Второй источник, разбор `: Тип` из текста, нужен там, где symbolTree
     * пришёл из компактной модели и тип в нём не сохранился.
     */
    private declaredTypeOf(
        module: IIndexedModule | undefined,
        symbol: RslSymbol | undefined,
        localSymbol: RslSymbol | undefined
    ): string {
        const declared = normalizeIdentifier(symbol?.typeName || "");

        /*
         * Именно ОБЪЯВЛЕННЫЙ тип. Тип, выведенный из инициализатора
         * (`Var sql = "aaa"`), декларацией не является: переменная остаётся
         * Variant, и следующее присваивание её тип меняет.
         */
        if (symbol && !symbol.isTypeVariant && declared) {
            return declared;
        }

        if (!module || !localSymbol) {
            return "";
        }

        const fromText = inferDeclaredType(
            this.getTokens(module),
            localSymbol
        );

        return fromText && fromText !== "variant" ? fromText : "";
    }

    private findClassSymbol(
        uri: string,
        tree: RslSymbol,
        typeName: string
    ): IIndexedSymbol | undefined {
        const normalizedType = normalizeIdentifier(typeName);
        const localClass = (getChildrenByName(tree).get(normalizedType) || [])
            .find(child =>
                child.kind === CompletionItemKind.Class
            );

        if (localClass) {
            return { uri, symbolId: localClass.id, symbol: localClass };
        }

        /*
         * Полное Import-замыкание — и на этом поиск по проекту заканчивается.
         *
         * Глобального обхода workspace здесь больше нет. Он находил класс в
         * файле, который текущий документ не импортирует: подсказка и переход
         * работали, а компилятор такое имя не знает. Хуже того, при двух
         * одноимённых классах в проекте выбирался произвольный из них — тот, что
         * первым попал в индекс. Неимпортированные имена остаются делом Auto
         * Import (см. findAutoImportCandidates).
         */
        const imported = this.index.findImportedSymbols(uri, normalizedType)
            .find(symbol =>
                symbol.symbol.kind === CompletionItemKind.Class
            );

        if (imported) {
            return imported;
        }

        const builtin = this.builtins.findClass(normalizedType);
        if (builtin) {
            return {
                uri: RSL_BUILTIN_URI,
                symbolId: builtin.id,
                symbol: builtin
            };
        }

        /*
         * Класс прикладного модуля — последним: он доступен только через
         * Import, поэтому не должен перекрывать ни файл проекта, ни встроенный
         * класс с тем же именем.
         */
        const platform = this.platformModules?.findClass(
            this.visiblePlatformModules(uri),
            normalizedType
        );

        return platform
            ? {
                uri: RSL_BUILTIN_URI,
                symbolId: platform.symbol.id,
                symbol: platform.symbol,
                platformModule: platform.moduleKey
            }
            : undefined;
    }

    /**
     * Поддерживает распространённый RSL-шаблон:
     *     Var command;
     *     command = RsdCommand(...);
     *     command.Execute();
     *
     * Индекс присваиваний строится один раз на immutable module model, поэтому
     * Semantic Tokens не сканирует весь Macro заново для каждого вызова.
     *
     * Тип берётся из ближайшего ПРЕДШЕСТВУЮЩЕГО присваивания той же
     * переменной — не одноимённой. Объявленная переменная адресуется своим
     * symbolId, переменная без объявления — областью присваивания и именем; для
     * неявной переменной области просматриваются от текущей к модулю, поэтому
     * `doc = TBFile(...)` на уровне модуля продолжает давать тип внутри Macro, а
     * присваивание в соседнем Macro — нет.
     */
    private inferAssignedType(
        module: IIndexedModule,
        tree: RslSymbol,
        receiverName: string,
        offset: number,
        declaredSymbol?: RslSymbol
    ): string {
        const index = this.getConstructorAssignments(module);
        const keys: string[] = [];

        if (declaredSymbol) {
            keys.push(declaredAssignmentKey(declaredSymbol));
        } else {
            /*
             * От внутренней области к модулю: одноимённая переменная соседнего
             * Macro в эту цепочку не попадает никогда.
             */
            const chain = getScopeChain(tree, offset);
            for (let position = chain.length - 1; position >= 0; position--) {
                keys.push(implicitAssignmentKey(chain[position], receiverName));
            }
        }

        for (const key of keys) {
            const assignments = index.get(key);

            if (!assignments || assignments.length === 0) {
                continue;
            }

            const last = upperBoundAssignmentOffset(assignments, offset) - 1;
            const typeName = this.reachingAssignedType(
                module,
                tree,
                assignments,
                last,
                offset
            );

            if (typeName) {
                return typeName;
            }
        }

        return "";
    }

    /**
     * Тип, к которому приводят ВСЕ пути исполнения до этой точки.
     *
     * Обход идёт назад от ближайшего присваивания. Присваивание вне условного
     * блока — или внутри того, который содержит саму точку запроса, — выполняется
     * гарантированно, и на нём поиск заканчивается. Условное добавляется в число
     * возможных, и обход продолжается: последним могло выполниться и оно, и
     * что-то до него.
     *
     * Расхождение возможных типов означает, что тип неизвестен: подставить один
     * из них — значит предложить члены класса, которого в этой ветке нет.
     * Объединение общих членов было бы точнее, но требует хранить несколько типов
     * сразу; пока честнее не отвечать.
     *
     * Единственное условное присваивание без альтернативы даёт свой тип: путь
     * либо прошёл через него, либо переменная не инициализирована вовсе, а у
     * неинициализированной членов всё равно нет.
     */
    private reachingAssignedType(
        module: IIndexedModule,
        tree: RslSymbol,
        assignments: readonly IConstructorAssignment[],
        from: number,
        offset: number
    ): string {
        let result = "";

        for (let index = from; index >= 0; index--) {
            const assignment = assignments[index];
            const typeName = this.assignedTypeOf(module, tree, assignment);

            /*
             * Тип этой ветки неизвестен — значит неизвестен и общий: именно она
             * могла выполниться последней.
             */
            if (!typeName) {
                return "";
            }

            if (
                result &&
                normalizeIdentifier(result) !== normalizeIdentifier(typeName)
            ) {
                return "";
            }
            result = typeName;

            const definite = !assignment.guard ||
                (assignment.guard.start <= offset &&
                    offset <= assignment.guard.end);

            if (definite) {
                return result;
            }
        }

        return result;
    }

    /**
     * Элемент автодополнения с типом из присваивания.
     *
     * Вывод запускается только для переменных без объявленного типа, поэтому в
     * обычном списке он не стоит почти ничего: остальные элементы возвращаются
     * как есть, без создания нового объекта.
     */
    private completionItemWithInferredType(
        uri: string,
        tree: RslSymbol,
        symbol: RslSymbol,
        offset: number
    ): CompletionItem {
        const item = symbol.completionItem;

        if (
            !isAssignableObject(symbol) ||
            (symbol.typeName &&
                normalizeIdentifier(symbol.typeName) !== "variant")
        ) {
            return item;
        }

        const inferred = this.effectiveTypeName(uri, tree, symbol, offset);

        if (!inferred || normalizeIdentifier(inferred) === "variant") {
            return item;
        }

        return {
            ...item,
            detail: `Переменная: ${symbol.name},\nтип ${inferred}`
        };
    }

    /**
     * Действующий тип символа: объявленный, а если его нет — из присваивания.
     *
     * Тот же вывод, что и для обращения к членам, но доступный снаружи. Без
     * него подсказка и автодополнение показывали `variant` у переменной, по
     * которой при этом успешно предлагались методы класса: тип выводился
     * только внутри разрешения членов и никуда больше не попадал.
     */
    /**
     * Действующий тип имени в этой точке, даже если объявления нет.
     *
     * В RSL переменная возникает и просто от присваивания:
     *
     *     rs = ExecSQLselect(sql, ..., true);
     *     while (rs.movenext())
     *
     * Такого имени в дереве символов нет, и разрешение имени по нему
     * молчит. Разрешение ЧЛЕНА получателя это учитывает — иначе
     * подсказка после точки в таком коде не работала бы, — а прочие
     * потребители получали `variant` там, где тип известен.
     *
     * Правило то же, что у effectiveTypeName: объявленный тип сильнее
     * присваивания, а из присваиваний берётся только достижимое и
     * только подтверждённое — имя неразрешённого вызова типом не
     * считается.
     */
    effectiveTypeNameAt(
        uri: string,
        tree: RslSymbol,
        offset: number
    ): string {
        const module = this.index.getModule(uri);

        if (!module) {
            return "";
        }

        const resolved = this.resolveAt(uri, tree, offset);

        /*
         * Объявление есть и оно наше: обычный расчёт. Объявление из
         * другого файла уже несёт готовый тип, а его положения к нашему
         * потоку токенов отношения не имеют.
         */
        if (resolved) {
            return resolved.uri === uri
                ? this.effectiveTypeName(
                    uri,
                    tree,
                    resolved.symbol,
                    offset
                )
                : resolved.symbol.typeName;
        }

        const token = tokenAtOffset(this.getTokens(module), offset, true);

        if (!token || token.kind !== "identifier") {
            return "";
        }

        const assigned = this.inferAssignedType(
            module,
            tree,
            token.value,
            offset
        );

        return this.isResolvableTypeName(uri, tree, assigned)
            ? assigned
            : "";
    }

    effectiveTypeName(
        uri: string,
        tree: RslSymbol,
        symbol: RslSymbol,
        offset: number
    ): string {
        const declared = symbol.typeName;

        /*
         * Объявленный тип — это приведение, и присваивание его не меняет.
         * Руководство: декларация типа необязательна, а переменная без неё
         * эквивалентна Variant и может содержать значение любого типа. Значит
         * выводить тип из присваивания следует ровно для таких переменных.
         *
         * Тип из инициализатора (`Var sql = "aaa"`) декларацией не считается: он
         * описывает текущее значение Variant, а не приведение.
         */
        if (!symbol.isTypeVariant && declared) {
            return declared;
        }

        const module = isAssignableObject(symbol)
            ? this.index.getModule(uri)
            : undefined;

        if (!module) {
            return declared;
        }

        const fromDeclaration = inferDeclaredType(
            this.getTokens(module),
            symbol
        );

        if (fromDeclaration && fromDeclaration !== "variant") {
            return fromDeclaration;
        }

        /*
         * Присваивание — но только подтверждённое. У неизвестного вызова
         * inferAssignedType возвращает само имя вызываемого: предположение, что
         * это ещё не загруженный класс. Показать такое имя как тип значило бы
         * назвать типом то, что типом не является.
         */
        const assigned = this.inferAssignedType(
            module,
            tree,
            symbol.name,
            offset,
            symbol
        );

        return this.isResolvableTypeName(uri, tree, assigned)
            ? assigned
            : declared;
    }

    /**
     * Тип из самого объявления: написанный либо выведенный из инициализатора.
     *
     * Отличается от effectiveTypeName тем, что не смотрит на присваивания ниже
     * по тексту — и потому не строит индекс присваиваний всего файла. Для
     * подсказки у объявления этого достаточно: она показывает тип начального
     * значения, а не того, что переменной присвоят позже.
     *
     * Замер, ради которого это выделено: первый запрос подсказок после каждой
     * правки стоил 11 мс на файле 54 КБ и 27 мс на 224 КБ, потому что индекс
     * строился заново для каждой новой модели — при том, что редактор просит
     * подсказки только для видимых строк.
     */
    declarationTypeName(
        uri: string,
        tree: RslSymbol,
        symbol: RslSymbol
    ): string {
        const declared = symbol.typeName;

        if (!symbol.isTypeVariant && declared) {
            return declared;
        }

        const module = isAssignableObject(symbol)
            ? this.index.getModule(uri)
            : undefined;

        if (!module) {
            return declared;
        }

        const tokens = this.getTokens(module);
        const fromDeclaration = inferDeclaredType(tokens, symbol);

        if (fromDeclaration && fromDeclaration !== "variant") {
            return fromDeclaration;
        }

        const initializer = this.initializerTypeName(
            uri,
            tree,
            tokens,
            symbol
        );

        return this.isResolvableTypeName(uri, tree, initializer)
            ? initializer
            : declared;
    }

    /**
     * Тип инициализатора объявления: `Var doc = TBFile (...)`.
     *
     * Разбирается ровно то, что стоит сразу за `=` и занимает весь остаток
     * оператора: вызов `Имя (…)` или голое `Имя`. Выражение сложнее этого
     * типом не считается — угадывать тип у `a + b` неоткуда.
     */
    private initializerTypeName(
        uri: string,
        tree: RslSymbol,
        tokens: IRslToken[],
        symbol: RslSymbol
    ): string {
        const nameIndex = lowerBoundByStart(tokens, symbol.range.start);

        if (
            nameIndex >= tokens.length ||
            tokens[nameIndex].start !== symbol.range.start
        ) {
            return "";
        }

        let index = nameIndex + 1;

        /* Написанный тип пропускается: `Var doc: Variant = TBFile ()`. */
        if (
            tokens[index]?.kind === "symbol" && tokens[index].raw === ":" &&
            tokens[index + 1]?.kind === "identifier"
        ) {
            index += 2;
        }

        const equals = tokens[index];

        if (
            !equals || equals.kind !== "symbol" || equals.raw !== "=" ||
            tokens[index + 1]?.kind !== "identifier"
        ) {
            return "";
        }

        const value = tokens[index + 1];
        const after = tokens[index + 2];

        if (endsStatement(after)) {
            return this.bareClassName(uri, tree, value.value, value.start);
        }

        return after.kind === "symbol" && after.raw === "("
            ? this.getCallableResultType(uri, tree, value.value, value.start)
            : "";
    }

    /** Существует ли такой тип: примитив языка или разрешимый класс. */
    private isResolvableTypeName(
        uri: string,
        tree: RslSymbol,
        typeName: string
    ): boolean {
        if (!typeName || normalizeIdentifier(typeName) === "variant") {
            return false;
        }

        return isRslType(typeName) ||
            !!this.findClassSymbol(uri, tree, typeName);
    }

    private assignedTypeOf(
        module: IIndexedModule,
        tree: RslSymbol,
        assignment: IConstructorAssignment
    ): string {
        if (assignment.member) {
            return this.memberResultType(module, tree, assignment);
        }

        if (assignment.bareClass) {
            return this.bareClassName(
                module.uri,
                tree,
                assignment.bareClass,
                assignment.offset
            );
        }

        return assignment.callee
            ? this.getCallableResultType(
                module.uri,
                tree,
                assignment.callee,
                assignment.offset
            )
            : "";
    }

    /**
     * Имя класса, если справа от `=` стоит именно класс.
     *
     * Для всего остального — пусто. Процедура, переменная и ссылка на
     * процедуру справа типом не считаются: `callback = SomeMacro` присваивает
     * саму процедуру, и тип её результата к переменной отношения не имеет.
     */
    private bareClassName(
        uri: string,
        tree: RslSymbol,
        name: string,
        offset: number
    ): string {
        const resolved = this.resolveName(
            uri,
            tree,
            name,
            offset,
            ACCEPT_CLASS
        );

        if (resolved) {
            return resolved.symbol.name;
        }

        /* Класс импортированного прикладного модуля. */
        const platform = this.platformModules?.findClass(
            this.visiblePlatformModules(uri),
            name
        );

        return platform ? platform.symbol.name : "";
    }

    /**
     * Тип результата вызова метода получателя: `rs = cmd.Execute()`.
     *
     * Класс получателя ищется на позиции самого присваивания, а не запроса:
     * дальше по тексту переменной могли присвоить что-то другое.
     *
     * Защита от зацикливания обязательна: у кода вида `a = a.Next()` разрешение
     * получателя привело бы обратно к этому же присваиванию.
     */
    private memberResultType(
        module: IIndexedModule,
        tree: RslSymbol,
        assignment: IConstructorAssignment
    ): string {
        const member = assignment.member;

        if (!member || this.memberTypeGuard.has(assignment)) {
            return "";
        }

        this.memberTypeGuard.add(assignment);
        try {
            const receiverClass = this.resolveReceiverClass(
                module.uri,
                tree,
                assignment.offset,
                { value: member.receiver } as IRslToken
            );

            if (!receiverClass) {
                return "";
            }

            const resolved = this.resolveMemberInHierarchy(
                module.uri,
                tree,
                assignment.offset,
                receiverClass,
                member.method,
                new Set<string>()
            );

            const typeName = resolved?.symbol.typeName || "";
            return normalizeIdentifier(typeName) === "variant" ? "" : typeName;
        } finally {
            this.memberTypeGuard.delete(assignment);
        }
    }

    private getConstructorAssignments(
        module: IIndexedModule
    ): ReadonlyMap<string, IConstructorAssignment[]> {
        const cached = this.constructorAssignmentsByModule.get(module);
        if (cached) {
            return cached;
        }

        /*
         * Защита от повторного входа.
         *
         * Построение индекса разрешает имена целей присваивания, а разрешение
         * имени в принципе способно дойти до вывода типа — то есть обратно
         * сюда. Сегодня такого пути нет, но обнаружился бы он переполнением
         * стека, а не понятной ошибкой. Незавершённый индекс отвечает «нет
         * присваиваний»: тип просто останется невыведенным.
         */
        if (this.assignmentIndexInProgress.has(module)) {
            return EMPTY_ASSIGNMENTS;
        }
        this.assignmentIndexInProgress.add(module);

        const result = new Map<string, IConstructorAssignment[]>();
        const tokens = this.getTokens(module);
        const tree = module.symbolTree;
        const conditionals = getConditionalRanges(module);

        for (let index = 0; index + 3 < tokens.length; index++) {
            const target = tokens[index];
            const equals = tokens[index + 1];
            const callee = tokens[index + 2];
            const next = tokens[index + 3];

            if (
                target.kind !== "identifier" ||
                equals.kind !== "symbol" || equals.raw !== "=" ||
                callee.kind !== "identifier"
            ) {
                continue;
            }

            /*
             * Слева от точки стоит получатель, а не цель присваивания — кроме
             * одного случая: `this.field = ...` присваивает полю текущего
             * класса, то есть ровно тому же символу, что и `field = ...`.
             * Раньше такое присваивание отбрасывалось целиком, и тип поля,
             * заданный через this, не выводился вовсе.
             */
            if (isAfterDot(tokens, index) && !isThisAccess(tokens, index)) {
                continue;
            }

            let assignment: IConstructorAssignment | undefined;

            if (next.kind === "symbol" && next.raw === "(") {
                /*
                 * Прямой вызов: конструктор класса или процедура. Какой именно —
                 * решается при выводе типа, разрешением имени callee в позиции
                 * самого вызова.
                 */
                assignment = {
                    offset: target.start,
                    callee: callee.value
                };
            } else if (
                next.kind === "symbol" && next.raw === "." &&
                tokens[index + 4]?.kind === "identifier" &&
                tokens[index + 5]?.kind === "symbol" &&
                tokens[index + 5].raw === "("
            ) {
                /*
                 * Вызов метода: `rs = cmd.Execute()`. Тип результата у метода
                 * известен каталогу, но чтобы его взять, нужно сначала знать
                 * класс получателя — это делается при выводе, не здесь.
                 */
                assignment = {
                    offset: target.start,
                    member: {
                        receiver: callee.value,
                        method: tokens[index + 4].value
                    }
                };
            } else if (endsStatement(next)) {
                /*
                 * Голое имя: `MessageText = TStringList;`. Классом оно окажется
                 * или нет — решается при выводе типа; здесь запоминается только
                 * то, что справа стоит одно имя и больше ничего.
                 */
                assignment = {
                    offset: target.start,
                    bareClass: callee.value
                };
            }

            if (!assignment) {
                continue;
            }

            assignment.guard = innermostRange(conditionals, target.start);

            const key = this.assignmentKeyAt(module.uri, tree, target);
            const values = result.get(key) || [];
            values.push(assignment);
            result.set(key, values);
        }

        this.assignmentIndexInProgress.delete(module);
        this.constructorAssignmentsByModule.set(module, result);
        return result;
    }

    /**
     * Ключ, под которым запоминается присваивание.
     *
     * Если имя цели разрешается в объявление, ключом становится это объявление:
     * тогда присваивание внутри Macro корректно относится к переменной модуля,
     * а не создаёт вторую запись. Если объявления нет — ключом становится
     * область самого присваивания.
     */
    private assignmentKeyAt(
        uri: string,
        tree: RslSymbol,
        target: IRslToken
    ): string {
        const declared = this.resolveName(
            uri,
            tree,
            target.value,
            target.start
        );

        if (
            declared?.uri === uri &&
            isAssignableObject(declared.symbol)
        ) {
            return declaredAssignmentKey(declared.symbol);
        }

        const chain = getScopeChain(tree, target.start);
        return implicitAssignmentKey(
            chain[chain.length - 1] || tree,
            target.value
        );
    }

    /**
     * Тип значения, которое даёт вызов: класс — сам себя, процедура — свой
     * объявленный тип результата.
     *
     * Имя разрешается В ПОЗИЦИИ ВЫЗОВА и по обычным правилам видимости — то
     * есть локальная область, текущий класс с базовыми, модуль, Import-замыкание,
     * стандартная библиотека, импортированные прикладные модули. Раньше здесь
     * стоял глобальный обход workspace без позиции: `x = Get()` брал тип у
     * произвольного класса или Macro с именем Get из любого файла проекта.
     *
     * Неизвестное имя возвращается как есть: тогда это скорее всего имя класса,
     * который просто ещё не загружен, и findClassSymbol попробует его найти.
     */
    private getCallableResultType(
        uri: string,
        tree: RslSymbol,
        name: string,
        offset: number
    ): string {
        const resolved = this.resolveName(
            uri,
            tree,
            name,
            offset,
            isCallableSymbol
        );

        if (resolved) {
            if (resolved.symbol.kind === CompletionItemKind.Class) {
                return resolved.symbol.name;
            }

            const typeName = resolved.symbol.typeName;
            return normalizeIdentifier(typeName) === "variant" ? "" : typeName;
        }

        /* Процедура импортированного прикладного модуля. */
        const platform = this.platformModules?.findResultType(
            this.visiblePlatformModules(uri),
            name
        );

        return platform || normalizeIdentifier(name);
    }

    private canAccessPrivateMembers(
        uri: string,
        tree: RslSymbol,
        offset: number,
        classSymbol: IIndexedSymbol
    ): boolean {
        if (classSymbol.uri !== uri) {
            return false;
        }

        return innermostClass(getScopeChain(tree, offset)) ===
            classSymbol.symbol;
    }

    private getReceiverToken(
        tokens: IRslToken[],
        tokenIndex: number
    ): IRslToken | undefined {
        if (tokenIndex < 2) {
            return undefined;
        }

        const dot = tokens[tokenIndex - 1];
        const receiver = tokens[tokenIndex - 2];

        return dot.kind === "symbol" &&
            dot.raw === "." &&
            receiver.kind === "identifier"
                ? receiver
                : undefined;
    }

    private getDotIndexBeforeOffset(
        tokens: IRslToken[],
        offset: number
    ): number {
        let candidateIndex = upperBoundByStart(tokens, offset) - 1;

        if (candidateIndex < 0) {
            return -1;
        }

        const candidate = tokens[candidateIndex];

        if (candidate.kind === "symbol" && candidate.raw === ".") {
            return candidateIndex;
        }

        if (candidate.kind === "identifier" && candidateIndex > 0) {
            const previous = tokens[candidateIndex - 1];

            if (previous.kind === "symbol" && previous.raw === ".") {
                return candidateIndex - 1;
            }
        }

        return -1;
    }

    private getPreviousIdentifier(
        tokens: IRslToken[],
        tokenIndex: number
    ): IRslToken | undefined {
        if (tokenIndex <= 0) {
            return undefined;
        }

        const previous = tokens[tokenIndex - 1];
        return previous.kind === "identifier"
            ? previous
            : undefined;
    }
}

/** Приставка предопределённого инициализатора базового класса. */
const BASE_INITIALIZER_PREFIX = "init";

/**
 * Конструкции, тело которых может не выполниться.
 *
 * WITH сюда не входит: он выполняется всегда. Тело WHILE и FOR может не
 * выполниться ни разу, поэтому они условные наравне с IF.
 */
const CONDITIONAL_NODE_KINDS: ReadonlySet<string> = new Set([
    "IfStatement",
    "ElseIfClause",
    "ElseClause",
    "WhileStatement",
    "ForStatement",
    "OnErrorClause"
]);

/*
 * Диапазоны условных блоков считаются один раз на модуль: они нужны каждому
 * присваиванию, а дерево неизменяемо.
 */
const conditionalRangesByModule = new WeakMap<
    IIndexedModule,
    readonly { start: number; end: number }[]
>();

function getConditionalRanges(
    module: IIndexedModule
): readonly { start: number; end: number }[] {
    let result = conditionalRangesByModule.get(module);

    if (!result) {
        const ranges: { start: number; end: number }[] = [];
        const visit = (node: IRslSyntaxNode): void => {
            if (CONDITIONAL_NODE_KINDS.has(node.kind)) {
                ranges.push({ start: node.start, end: node.end });
            }
            node.children.forEach(visit);
        };

        visit(module.syntax.root);
        ranges.sort((left, right) => left.start - right.start);
        result = Object.freeze(ranges);
        conditionalRangesByModule.set(module, result);
    }

    return result;
}

/** Самый внутренний из диапазонов, содержащих offset. */
function innermostRange(
    ranges: readonly { start: number; end: number }[],
    offset: number
): { start: number; end: number } | undefined {
    /*
     * Диапазоны отсортированы по началу, поэтому кандидаты — префикс до первого
     * начинающегося после offset, а самый внутренний из них — последний
     * содержащий. Граница префикса ищется двоичным поиском, дальше идём назад.
     *
     * Прежде префикс просматривался с начала, и для правки в конце файла это
     * означало обход почти всех диапазонов — на каждое присваивание. В профиле
     * диагностики эта строка была одной из самых дорогих.
     */
    let low = 0;
    let high = ranges.length;

    while (low < high) {
        const middle = (low + high) >>> 1;

        if (ranges[middle].start <= offset) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    for (let index = low - 1; index >= 0; index--) {
        if (offset <= ranges[index].end) {
            return ranges[index];
        }
    }

    return undefined;
}

function isAfterDot(tokens: readonly IRslToken[], index: number): boolean {
    const previous = tokens[index - 1];
    return previous?.kind === "symbol" && previous.raw === ".";
}

/** Стоит ли перед `.имя` именно this: `this.field`. */
function isThisAccess(tokens: readonly IRslToken[], index: number): boolean {
    const receiver = tokens[index - 2];
    return receiver?.kind === "identifier" &&
        normalizeIdentifier(receiver.value) === "this" &&
        !isAfterDot(tokens, index - 2);
}

/** Пустой индекс присваиваний: общий на всех, изменять его никто не должен. */
const EMPTY_ASSIGNMENTS: ReadonlyMap<string, IConstructorAssignment[]> =
    new Map<string, IConstructorAssignment[]>();

/*
 * Инициализаторы строятся один раз на базовый класс: имя разрешается на каждое
 * нажатие клавиши, а сам символ от позиции запроса не зависит.
 */
const baseInitializerCache = new WeakMap<RslSymbol, RslSymbol>();

/**
 * Символ `Init<База>`.
 *
 * Тип результата — variant: руководство о возвращаемом значении инициализатора
 * ничего не говорит, и придумывать его нельзя. Символ помечен встроенным, поэтому
 * переименование им отказывается заниматься: в тексте его объявления нет, и
 * переименовать его значило бы переименовать базовый класс, чего пользователь не
 * просил.
 */
function baseInitializerSymbol(base: RslSymbol): RslSymbol {
    const cached = baseInitializerCache.get(base);

    if (cached) {
        return cached;
    }

    const name = `Init${base.name}`;
    const parameterText = base.parameterText || "()";
    const symbol = new RslSymbol({
        id: createSymbolId(
            undefined,
            CompletionItemKind.Method,
            name
        ),
        name,
        kind: CompletionItemKind.Method,
        range: { start: 0, end: 0 },
        selectionRange: { start: 0, end: 0 },
        parameterText,
        builtin: true,
        documentation:
            `Предопределённый инициализатор базового класса ${base.name}. ` +
            "Вызывается один раз в определении дочернего класса; место вызова " +
            "значения не имеет."
    });
    baseInitializerCache.set(base, symbol);
    return symbol;
}

/**
 * Элемент для позиции типа: подставляется одно имя, без скобок вызова.
 *
 * Класс в completionItem конструктора вставляется как `Name`, но метод и
 * процедура — как `Name()`; в позиции типа скобки не нужны никогда.
 */
function asTypeItem(item: CompletionItem): CompletionItem {
    return {
        ...item,
        insertText: String(item.label),
        insertTextFormat: undefined
    };
}

function withCompletionPriority(
    item: CompletionItem,
    priority: string
): CompletionItem {
    return {
        ...item,
        sortText: `${priority}_${normalizeIdentifier(String(item.label))}`
    };
}

/**
 * Ближайший класс изнутри цепочки областей.
 *
 * Цепочка идёт от модуля к внутренней области, поэтому «текущий класс» — это
 * последний класс в ней, а не первый. Раньше это выражалось тремя способами в
 * трёх местах, причём один из них брал внешний класс.
 */
function innermostClass(chain: readonly RslSymbol[]): RslSymbol | undefined {
    for (let position = chain.length - 1; position >= 0; position--) {
        if (chain[position].kind === CompletionItemKind.Class) {
            return chain[position];
        }
    }

    return undefined;
}

export function getScopeChain(
    root: RslSymbol,
    offset: number
): RslSymbol[] {
    const result: RslSymbol[] = [root];
    let current = root;

    while (true) {
        const nested = findContainingObject(
            getObjectChildren(current),
            offset
        );

        if (!nested) {
            break;
        }

        result.push(nested);
        current = nested;
    }

    return result;
}

function getObjectChildren(scope: RslSymbol): RslSymbol[] {
    let result = objectChildrenCache.get(scope);

    if (!result) {
        result = scope.children
            .filter(child => child.isContainer)
            .sort((left, right) =>
                left.range.start - right.range.start
            );
        objectChildrenCache.set(scope, result);
    }

    return result;
}


function findContainingObject(
    objects: RslSymbol[],
    offset: number
): RslSymbol | undefined {
    let left = 0;
    let right = objects.length - 1;
    let candidate = -1;

    while (left <= right) {
        const middle = (left + right) >>> 1;

        if (objects[middle].range.start <= offset) {
            candidate = middle;
            left = middle + 1;
        } else {
            right = middle - 1;
        }
    }

    if (candidate < 0) {
        return undefined;
    }

    const symbol = objects[candidate];
    return offset <= symbol.range.end ? symbol : undefined;
}

function getChildrenByName(scope: RslSymbol): Map<string, RslSymbol[]> {
    let result = childrenByNameCache.get(scope);

    if (!result) {
        result = new Map<string, RslSymbol[]>();

        for (const child of scope.children) {
            const name = normalizeIdentifier(child.name);
            let values = result.get(name);

            if (!values) {
                values = [];
                result.set(name, values);
            }

            values.push(child);
        }

        childrenByNameCache.set(scope, result);
    }

    return result;
}

/** Конец выражения справа от `=`: дальше присваиваемого значения нет. */
function endsStatement(token: IRslToken | undefined): boolean {
    return !token ||
        (token.kind === "symbol" && (token.raw === ";" || token.raw === ","));
}

function inferDeclaredType(
    tokens: IRslToken[],
    symbol: RslSymbol
): string {
    const nameIndex = lowerBoundByStart(tokens, symbol.range.start);

    if (
        nameIndex >= tokens.length ||
        tokens[nameIndex].start !== symbol.range.start
    ) {
        return "";
    }

    let depth = 0;

    for (let index = nameIndex + 1; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind !== "symbol") {
            continue;
        }

        if (token.raw === "(") {
            depth++;
            continue;
        }

        if (token.raw === ")" && depth > 0) {
            depth--;
            continue;
        }

        if (depth === 0 && (token.raw === ";" || token.raw === ",")) {
            break;
        }

        if (depth === 0 && token.raw === ":") {
            const typeToken = tokens[index + 1];
            return typeToken && typeToken.kind === "identifier"
                ? normalizeIdentifier(typeToken.value)
                : "";
        }

        /*
         * Присваивание здесь намеренно не разбирается.
         *
         * Раньше `Var x = Name(...)` давало тип "Name" — верно для
         * конструктора класса и неверно для процедуры: у
         * `Macro Get():RsdRecordset` типом становилось имя Get, класса с таким
         * именем нет, и подсказка по x пропадала совсем. Хуже того, непустой
         * результат отменял разбор присваивания ниже, который как раз умеет
         * посмотреть объявленный тип результата (см. getCallableResultType).
         */
        if (depth === 0 && token.raw === "=") {
            break;
        }
    }

    return "";
}

/**
 * Символы, тип которых имеет смысл выводить из присваивания.
 *
 * Только то, чему присваивают значение. У процедуры typeName — это тип
 * результата, и присваивание переменной с тем же именем к нему отношения не
 * имеет.
 */
/** То, что может стоять в позиции вызова: конструктор класса или процедура. */
function isCallableSymbol(symbol: RslSymbol): boolean {
    return symbol.kind === CompletionItemKind.Class ||
        symbol.kind === CompletionItemKind.Function ||
        symbol.kind === CompletionItemKind.Method;
}

function isAssignableObject(symbol: RslSymbol): boolean {
    return symbol.kind === CompletionItemKind.Variable ||
        symbol.kind === CompletionItemKind.Field ||
        symbol.kind === CompletionItemKind.Property;
}

function isVisibleAt(symbol: RslSymbol, offset: number): boolean {
    if (
        symbol.kind === CompletionItemKind.Variable ||
        symbol.kind === CompletionItemKind.Constant ||
        symbol.kind === CompletionItemKind.Property ||
        symbol.kind === CompletionItemKind.Field
    ) {
        return symbol.range.start <= offset;
    }

    return true;
}

function selectBestVisibleCandidate(
    candidates: RslSymbol[],
    offset: number
): RslSymbol | undefined {
    let firstVisible: RslSymbol | undefined;
    let nearestPreceding: RslSymbol | undefined;

    for (const candidate of candidates) {
        if (!isVisibleAt(candidate, offset)) {
            continue;
        }

        if (!firstVisible) {
            firstVisible = candidate;
        }

        if (
            candidate.range.start <= offset &&
            (
                !nearestPreceding ||
                candidate.range.start > nearestPreceding.range.start
            )
        ) {
            nearestPreceding = candidate;
        }
    }

    return nearestPreceding || firstVisible;
}

function findTokenIndex(
    tokens: IRslToken[],
    token: IRslToken
): number {
    const index = lowerBoundByStart(tokens, token.start);

    for (let current = index; current < tokens.length; current++) {
        const candidate = tokens[current];

        if (candidate.start !== token.start) {
            break;
        }

        if (candidate === token || candidate.end === token.end) {
            return current;
        }
    }

    return -1;
}

function lowerBoundByStart(tokens: IRslToken[], start: number): number {
    let left = 0;
    let right = tokens.length;

    while (left < right) {
        const middle = (left + right) >>> 1;

        if (tokens[middle].start < start) {
            left = middle + 1;
        } else {
            right = middle;
        }
    }

    return left;
}

function upperBoundByStart(tokens: IRslToken[], start: number): number {
    let left = 0;
    let right = tokens.length;

    while (left < right) {
        const middle = (left + right) >>> 1;

        if (tokens[middle].start <= start) {
            left = middle + 1;
        } else {
            right = middle;
        }
    }

    return left;
}

function upperBoundAssignmentOffset(
    assignments: readonly IConstructorAssignment[],
    offset: number
): number {
    let left = 0;
    let right = assignments.length;

    while (left < right) {
        const middle = (left + right) >>> 1;

        if (assignments[middle].offset <= offset) {
            left = middle + 1;
        } else {
            right = middle;
        }
    }

    return left;
}

function deduplicateCompletionItems(
    items: CompletionItem[]
): CompletionItem[] {
    const result: CompletionItem[] = [];
    const seen = new Set<string>();

    for (const item of items) {
        const key = normalizeIdentifier(String(item.label));

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(item);
    }

    return result;
}

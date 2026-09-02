import type { CompletionItemKind } from "vscode-languageserver";

import { normalizeIdentifier } from "../lexer";
import { rslModuleBaseName } from "../core/language/moduleName";
import { sameUri } from "../core/identity/uriKey";
import { rslSymbolRef, type IRslSymbolRef } from "../symbols/symbolRef";
import type { RslSymbol } from "../symbols/rslSymbol";
import type { IRslCatalogSymbol } from "./workspaceCatalog";
import type {
    IIndexedModule,
    ModuleResolution
} from "./indexTypes";
import type { WorkspaceIndex } from "../workspaceIndex";

/**
 * Один вход к сведениям уровня проекта.
 *
 * Сведения о проекте лежат в семи хранилищах: подробные модели загруженных
 * модулей, индекс их символов, обратные рёбра Import, постоянный каталог
 * объявлений, состав файлов, индекс идентификаторов для поиска ссылок и его
 * разбиение. У каждого своя задача, и объединять их незачем.
 *
 * Объединять приходилось потребителям — и каждый делал это по-своему. Дерево
 * зависимостей спрашивало каталог, переход к определению — загруженные модели,
 * Auto Import — только индекс символов, а Ctrl+T — только каталог. Из-за этого
 * один и тот же вопрос получал разные ответы в зависимости от того, кто
 * спрашивает и что успела прочитать фоновая индексация: Auto Import перестаёт
 * предлагать символ, когда модель модуля вытеснена по памяти, хотя объявление
 * из проекта не исчезло.
 *
 * Здесь порядок источников назван один раз:
 *
 *   открытая модель -> загруженная сводка -> постоянный каталог.
 *
 * Верхний источник ПОДРОБНЕЕ, а не полнее: у него есть объект символа с
 * положениями и подписью. Нижний — полнее: он помнит и то, чего сейчас нет в
 * памяти. Поэтому ответ собирается по нижнему, а подробности берутся у
 * верхнего, если он есть. Ответ от этого не зависит от того, что успела
 * прочитать фоновая индексация — а именно этого от него и ждут.
 */

/** Объявление проекта: устойчивая идентичность плюс то, что о нём известно. */
export interface IRslProjectSymbol {
    /** Пара «файл и номер объявления»: см. symbols/symbolRef. */
    ref: IRslSymbolRef;
    name: string;
    kind: CompletionItemKind;
    /** Класс-владелец для члена; пусто у объявления верхнего уровня. */
    container: string;
    isPrivate: boolean;
    baseClassName: string;
    /**
     * Положение на момент, когда файл читали.
     *
     * Запас на случай, когда модели в памяти нет. У открытого документа
     * положение съезжает от каждой правки, поэтому актуальное берут у
     * модели по ref — см. WorkspaceIndex.getDefinitionRangeByRef.
     */
    line: number;
    character: number;
    /**
     * Объект символа — только если модель модуля в памяти.
     *
     * Его отсутствие означает «модуль не загружен», а не «объявления нет».
     * Тот, кому нужны положения, спрашивает их у модели по ref.
     *
     * Ищется ПО ТРЕБОВАНИЮ: поиск по номеру объявления — это спуск по
     * дереву символов файла, и делать его для каждого просмотренного
     * кандидата незачем. Auto Import просматривает их сотнями, а в список
     * попадают десятки.
     */
    readonly symbol?: RslSymbol;
    /** Откуда сведения: подробная модель или постоянный каталог. */
    readonly source: "model" | "catalog";
}

/** Зависимый файл и признак того, что его ссылка неоднозначна. */
export interface IRslProjectDependent {
    uri: string;
    /**
     * Ссылка ведёт сразу в несколько одноимённых файлов.
     *
     * Приписать её одному из них нельзя: выбрать за пользователя значит
     * соврать. Но и промолчать нельзя — на популярном модуле проекта это
     * скрывало больше тысячи настоящих зависимых.
     */
    ambiguous: boolean;
}

export interface IRslProjectIndexViewOptions {
    /** Кандидаты для поиска ссылок; без него отвечает весь состав проекта. */
    referenceCandidates?(
        declarationUri: string,
        workspaceUris: readonly string[],
        loadedModules: readonly IIndexedModule[],
        isCancelled: () => boolean
    ): Promise<string[]>;
}

export class RslProjectIndexView {
    constructor(
        private readonly index: WorkspaceIndex,
        private readonly options: IRslProjectIndexViewOptions = {}
    ) {}

    /**
     * Файл, в который ведёт написанная ссылка на модуль.
     *
     * Отвечает состав проекта, а не граф загруженных модулей: ссылка обязана
     * разрешаться одинаково до и после того, как модуль прочитают.
     */
    resolveModule(reference: string): ModuleResolution<string> {
        return this.index.resolveWorkspaceFile(reference);
    }

    /** Подробная модель модуля, если она в памяти. */
    loadedModule(uri: string): IIndexedModule | undefined {
        return this.index.getModule(uri);
    }

    /**
     * Объявления проекта с этим именем.
     *
     * Собирается по каталогу — он полнее, — а подробности берутся у
     * загруженной модели. Порядок задан ответом каталога и не зависит от
     * порядка обхода проекта.
     */
    findSymbol(name: string): IRslProjectSymbol[] {
        const normalized = normalizeIdentifier(name);

        if (!normalized) {
            return [];
        }

        const result: IRslProjectSymbol[] = [];
        const seen = new Set<string>();

        for (const record of this.index.catalog.findByName(name)) {
            const key = refKey(record.uri, record.symbolId);

            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            result.push(this.fromCatalog(record));
        }

        /*
         * То, что есть в памяти, но ещё не в каталоге.
         *
         * Каталог пополняется той же записью модуля, поэтому это редкость —
         * но открытый документ правят чаще, чем читают проект, и его новое
         * объявление обязано найтись сразу.
         */
        for (const item of this.index.findSymbols(name)) {
            const key = refKey(item.uri, item.symbolId);

            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            result.push({
                ref: rslSymbolRef(item.uri, item.symbol),
                name: item.symbol.name,
                kind: item.symbol.kind,
                container: "",
                isPrivate: item.symbol.isPrivate,
                baseClassName: item.symbol.baseClassName,
                /* Положение спросят у модели: она здесь и есть. */
                line: 0,
                character: 0,
                symbol: item.symbol,
                source: "model"
            });
        }

        return result;
    }

    /** Файлы, объявляющие это имя публично: кандидаты адресной загрузки. */
    findExporters(name: string): string[] {
        const byCatalog = this.index.catalog.modulesExporting(name);

        if (byCatalog.length > 0) {
            return byCatalog;
        }

        /*
         * Каталог мог ещё не знать открытого документа: его правят чаще, чем
         * читают проект.
         */
        const result = new Set<string>();

        for (const item of this.index.findSymbols(name)) {
            if (!item.symbol.isPrivate) {
                result.add(item.uri);
            }
        }

        return [...result].sort();
    }

    /** Написанные в файле ссылки на модули — как они есть в тексте. */
    importsOf(uri: string): string[] {
        const module = this.index.getModule(uri);

        if (module) {
            return module.imports.slice();
        }

        return this.index.catalog.importsOf(uri);
    }

    /**
     * Кто зависит от файла — по всему проекту.
     *
     * Спрашивается каталог, а не граф загруженных модулей: при обычном режиме
     * индексации значительная часть проекта в память не загружена, и ответ по
     * графу зависел бы от того, что успела прочитать фоновая индексация.
     *
     * Совпадения имён мало. `a/lib.mac` и `b/lib.mac` — разные модули, и путь
     * в Import написан именно затем, чтобы их различить. Поэтому каждое
     * НАПИСАНИЕ ссылки разрешается тем же составом файлов, что и обычное
     * разрешение имён, и в зависимые попадает тот, чья ссылка ведёт ровно в
     * этот файл.
     *
     * Перебор сужен обратным индексом каталога: берутся только те написания,
     * у которых базовое имя совпадает с именем файла.
     */
    dependentsOf(uri: string): IRslProjectDependent[] {
        const result = new Map<string, boolean>();
        const catalog = this.index.catalog;

        for (const reference of catalog.importReferencesForBaseName(
            rslModuleBaseName(uri)
        )) {
            const resolved = this.resolveModule(reference);
            const resolvedHere = resolved.kind === "resolved" &&
                sameUri(resolved.value, uri);
            const ambiguousHere = resolved.kind === "ambiguous" &&
                resolved.candidates.some(item => sameUri(item, uri));

            if (!resolvedHere && !ambiguousHere) {
                continue;
            }

            for (const importer of catalog.importersOfReference(reference)) {
                if (sameUri(importer, uri)) {
                    continue;
                }

                /* Однозначная ссылка снимает пометку, поставленную другой. */
                result.set(
                    importer,
                    resolvedHere ? false : result.get(importer) ?? true
                );
            }
        }

        /*
         * Граф загруженных модулей добавляется сверху: открытый документ мог
         * получить новый Import уже после того, как его прочитала достройка
         * каталога.
         *
         * Но добавляется по ТОМУ ЖЕ правилу. Обратные рёбра графа ключуются
         * и базовым именем тоже: `Import "a/cards.mac"` числится ссылкой
         * на `cards`, и по этому ребру зависимым оказывался ещё и
         * `b/cards.mac` — файл, к которому эта ссылка отношения не имеет.
         */
        for (const importer of this.index.getDependents(uri)) {
            if (sameUri(importer, uri) || result.has(importer)) {
                continue;
            }

            const written = this.referenceLeadingTo(importer, uri);

            if (written) {
                result.set(importer, written.ambiguous);
            }
        }

        return [...result]
            .map(([value, ambiguous]) => ({ uri: value, ambiguous }))
            .sort((left, right) => compareUri(left.uri, right.uri));
    }

    /**
     * Ведёт ли хоть одна написанная в файле ссылка ровно в этот файл.
     *
     * Однозначная ссылка сильнее неоднозначной: если файл ссылается и так,
     * и так, зависимость установлена точно.
     */
    private referenceLeadingTo(
        importer: string,
        target: string
    ): { ambiguous: boolean } | undefined {
        let ambiguous: boolean | undefined;

        for (const reference of this.importsOf(importer)) {
            const resolved = this.resolveModule(reference);

            if (
                resolved.kind === "resolved" &&
                sameUri(resolved.value, target)
            ) {
                return { ambiguous: false };
            }

            if (
                resolved.kind === "ambiguous" &&
                resolved.candidates.some(item => sameUri(item, target))
            ) {
                ambiguous = true;
            }
        }

        return ambiguous === undefined ? undefined : { ambiguous };
    }

    /**
     * Файлы, которые стоит прочитать в поисках ссылок на объявление.
     *
     * Сужение — забота индекса идентификаторов; если он не готов или неполон,
     * ответом остаётся весь состав проекта: точность поиска ссылок важнее
     * эвристического ускорения.
     */
    async referencesOf(
        declarationUri: string,
        isCancelled: () => boolean = () => false
    ): Promise<string[]> {
        const workspaceUris = this.index.getWorkspaceFileUris();

        if (!this.options.referenceCandidates) {
            return workspaceUris;
        }

        return this.options.referenceCandidates(
            declarationUri,
            workspaceUris,
            this.index.getModules(),
            isCancelled
        );
    }

    /**
     * Все файлы, видимые из документа через цепочку Import.
     *
     * Обход не останавливается на незагруженном модуле: его собственные
     * Import знает каталог. Без этого замыкание обрывалось там, где кончалась
     * память, и ответ зависел от того, что успела прочитать фоновая
     * индексация: символ уже подключённого модуля предлагался «подключить»
     * заново, стоило его модель вытеснить.
     */
    importClosureUris(uri: string): Set<string> {
        const visited = new Set<string>([uri]);
        const queue: (readonly string[])[] = [this.importsOf(uri)];

        for (let at = 0; at < queue.length; at++) {
            for (const reference of queue[at]) {
                const resolved = this.resolveModule(reference);

                if (resolved.kind !== "resolved") {
                    continue;
                }

                if (visited.has(resolved.value)) {
                    continue;
                }

                visited.add(resolved.value);
                queue.push(this.importsOf(resolved.value));
            }
        }

        return visited;
    }

    /**
     * Публичные объявления проекта, которые документу ещё не подключены.
     *
     * Основа Auto Import. Ответ собирается по каталогу — он помнит и то,
     * чего сейчас нет в памяти, — поэтому предложение не исчезает вместе с
     * вытесненной моделью модуля.
     *
     * Порядок задан целиком: имя, файл, номер объявления. Он не зависит от
     * того, в каком порядке проект успел проиндексироваться, и одинаков у
     * записи каталога и записи открытого файла.
     */
    findUnimportedSymbols(
        fromUri: string,
        prefix: string,
        limit: number
    ): { items: IRslProjectSymbol[]; truncated: boolean } {
        if (limit <= 0) {
            return { items: [], truncated: false };
        }

        const connected = this.importClosureUris(fromUri);
        const found: IRslProjectSymbol[] = [];
        const seen = new Set<string>();
        /*
         * С запасом: часть найденного отсеется как приватное, как уже
         * подключённое или как повтор, а вернуть надо ровно столько,
         * сколько просили.
         */
        const wanted = limit >= Number.MAX_SAFE_INTEGER / 4
            ? limit
            : limit * 4;

        const take = (records: readonly IRslCatalogSymbol[]): void => {
            for (const record of records) {
                /*
                 * На один больше предела — и достаточно.
                 *
                 * Ответ поиска по началу имени уже упорядочен, и дальнейшие
                 * записи в список всё равно не попадут. Но лишний один нужен:
                 * по нему видно, что список пришлось урезать, и признак
                 * неполноты не зависит от того, где остановился просмотр.
                 */
                if (found.length > limit) {
                    return;
                }

                if (record.isPrivate || connected.has(record.uri)) {
                    continue;
                }

                /*
                 * Член класса Import-ом не подключается: подключается
                 * модуль, а имя члена без получателя ничего не значит.
                 */
                if (record.container) {
                    continue;
                }

                const key = normalizeIdentifier(record.name) +
                    " " + record.uri;

                if (seen.has(key)) {
                    continue;
                }

                seen.add(key);
                found.push(this.fromCatalog(record));
            }
        };

        /*
         * Сначала имена, НАЧИНАЮЩИЕСЯ с набранного: их каталог находит
         * двоичным поиском, не обходя проект. Спрашивают это на каждую
         * нажатую букву, и общий отбор здесь стоил бы обхода сотни тысяч
         * объявлений.
         */
        take(this.index.catalog.findByPrefix(prefix, wanted));

        /*
         * Совпадения по середине имени — только если начальных мало.
         *
         * Тогда в списке они уместны, и общий отбор по каталогу оправдан:
         * ровно так же поступал прежний перебор загруженных символов. Пустой
         * префикс попадает сюда же: «все неподключённые» — это не поиск по
         * началу имени, и на него у каталога есть готовый ответ.
         */
        if (found.length <= limit) {
            take(this.index.catalog.find(prefix, wanted));
            /*
             * Пересортировка нужна ТОЛЬКО здесь: добавка приходит в своём
             * порядке — по рангу совпадения, — и склеенный список иначе
             * упорядочен не был бы. Ответ поиска по началу имени каталог
             * отдаёт уже упорядоченным, и сортировать его заново значило бы
             * платить сравнением строк за каждую нажатую букву.
             */
            found.sort(compareProjectSymbols);
        }

        return {
            items: found.slice(0, limit),
            truncated: found.length > limit
        };
    }

    /** Объявления проекта по запросу Ctrl+T. */
    workspaceSymbols(query: string, limit: number): IRslProjectSymbol[] {
        return this.index.catalog
            .find(query, limit)
            .map(record => this.fromCatalog(record));
    }

    /** Состав файлов проекта. */
    get workspaceFiles(): string[] {
        return this.index.getWorkspaceFileUris();
    }

    /** Готов ли состав проекта: до этого «не нашли» и «нет» — разные ответы. */
    get workspaceFilesReady(): boolean {
        return this.index.workspaceFilesReady;
    }

    /**
     * Запись каталога плюс объект символа — но только по требованию.
     *
     * Объект ищется спуском по дереву символов файла. Делать это для
     * каждого просмотренного кандидата значило бы платить за тех, кто в
     * ответ не попал: Auto Import просматривает их сотнями.
     */
    private fromCatalog(record: IRslCatalogSymbol): IRslProjectSymbol {
        const ref = { uri: record.uri, symbolId: record.symbolId };
        const index = this.index;
        let known: RslSymbol | undefined;
        let asked = false;
        const live = (): RslSymbol | undefined => {
            if (!asked) {
                asked = true;
                known = index.resolveSymbolRef(ref);
            }

            return known;
        };

        return {
            ref,
            name: record.name,
            kind: record.kind,
            container: record.container,
            isPrivate: record.isPrivate,
            baseClassName: record.baseClassName,
            line: record.line,
            character: record.character,
            get symbol(): RslSymbol | undefined {
                return live();
            },
            get source(): "model" | "catalog" {
                return live() ? "model" : "catalog";
            }
        };
    }
}

function refKey(uri: string, symbolId: string): string {
    return uri.toLowerCase() + "\u0000" + symbolId;
}

function compareUri(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Порядок кандидатов: имя, затем файл и номер объявления.
 *
 * Сравнение простое, а не localeCompare. Порядок здесь нужен
 * ПОВТОРЯЕМЫЙ, а не алфавитный по правилам языка: пользователь видит
 * список, отсортированный редактором по своему ранжированию. А
 * localeCompare дороже обычного сравнения строк на два порядка, и
 * спрашивают это на каждую нажатую букву.
 */
function compareProjectSymbols(
    left: IRslProjectSymbol,
    right: IRslProjectSymbol
): number {
    const leftName = normalizeIdentifier(left.name);
    const rightName = normalizeIdentifier(right.name);

    if (leftName !== rightName) {
        return leftName < rightName ? -1 : 1;
    }

    if (left.ref.uri !== right.ref.uri) {
        return left.ref.uri < right.ref.uri ? -1 : 1;
    }

    if (left.ref.symbolId === right.ref.symbolId) {
        return 0;
    }

    return left.ref.symbolId < right.ref.symbolId ? -1 : 1;
}

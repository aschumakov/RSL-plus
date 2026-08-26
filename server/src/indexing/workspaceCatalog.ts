import { CompletionItemKind } from "vscode-languageserver";

import { normalizeIdentifier } from "../lexer";
import type { RslSymbol } from "../symbols/rslSymbol";
import type { IIndexedModule } from "../workspaceIndex";

/**
 * Постоянный каталог символов проекта.
 *
 * Отдельно от LRU подробных моделей — и в этом весь смысл. Подробная модель
 * живёт, пока помещается в лимит: у проекта в 5800 файлов их в памяти
 * четыре тысячи, остальные вытесняются, и Ctrl+T перестаёт их видеть. Каталог
 * держит про каждый файл только то, что нужно глобальным ответам: имя, вид,
 * место, владельца, видимость и базовый класс. Запись переживает вытеснение
 * модели и исчезает лишь вместе с файлом.
 *
 * Порядок ответа не зависит от порядка загрузки: результаты сортируются
 * целиком и только потом обрезаются лимитом. Прежде Workspace Symbols
 * перебирал модули в порядке Map и останавливался на двухсотом совпадении —
 * состав ответа менялся от запуска к запуску.
 */
export interface IRslCatalogSymbol {
    name: string;
    /** Нормализованное имя: поиск в RSL регистронезависим. */
    normalized: string;
    kind: CompletionItemKind;
    uri: string;
    start: number;
    end: number;
    line: number;
    character: number;
    /** Класс-владелец для члена; пусто у объявления верхнего уровня. */
    container: string;
    isPrivate: boolean;
    /** Базовый класс: нужен Go to Implementation и иерархии типов. */
    baseClassName: string;
}

export interface IRslCatalogModule {
    uri: string;
    version: number;
    symbols: readonly IRslCatalogSymbol[];
    /** Экспортируемые имена: кандидаты для References и Auto Import. */
    exports: ReadonlySet<string>;
    imports: readonly string[];
}

export interface IRslCatalogStats {
    modules: number;
    symbols: number;
    /** Приблизительный объём хранимого: для отчёта о памяти. */
    approximateBytes: number;
}

export class WorkspaceCatalog {
    private modules = new Map<string, IRslCatalogModule>();
    /**
     * Имя -> файл -> объявления.
     *
     * Двухуровневая карта, а не список: при обновлении модуля запись о
     * нём удаляется по ключу. Плоский список приходилось фильтровать
     * целиком, а у популярного имени вроде `Helper` в нём тысячи
     * записей — обновление одного файла стоило прохода по всему проекту.
     */
    private byName = new Map<string, Map<string, IRslCatalogSymbol[]>>();
    private revisionValue = 0;

    get revision(): number {
        return this.revisionValue;
    }

    /**
     * Запоминает состав модуля.
     *
     * Вызывается на каждое обновление модели — и открытой, и компактной
     * внешней. Дороже одного прохода по объявлениям это не стоит.
     */
    record(module: IIndexedModule): void {
        const symbols: IRslCatalogSymbol[] = [];
        const exports = new Set<string>();
        const lineStarts = module.lex?.lineStarts || [0];

        for (const child of module.symbolTree.children) {
            const added = append(symbols, module.uri, child, "", lineStarts);

            if (added && !child.isPrivate) {
                exports.add(added.normalized);
            }

            if (child.kind === CompletionItemKind.Class) {
                for (const member of child.children) {
                    append(symbols, module.uri, member, child.name, lineStarts);
                }
            }
        }

        this.remove(module.uri);
        this.modules.set(module.uri, {
            uri: module.uri,
            version: module.version,
            symbols,
            exports,
            imports: module.imports.slice()
        });

        for (const symbol of symbols) {
            let byUri = this.byName.get(symbol.normalized);

            if (!byUri) {
                byUri = new Map<string, IRslCatalogSymbol[]>();
                this.byName.set(symbol.normalized, byUri);
            }

            const list = byUri.get(module.uri);

            if (list) {
                list.push(symbol);
            } else {
                byUri.set(module.uri, [symbol]);
            }
        }

        this.revisionValue++;
    }

    /** Файла больше нет в проекте: запись уходит вместе с ним. */
    remove(uri: string): void {
        const previous = this.modules.get(uri);

        if (!previous) {
            return;
        }

        for (const symbol of previous.symbols) {
            const byUri = this.byName.get(symbol.normalized);

            if (!byUri) {
                continue;
            }

            byUri.delete(uri);

            if (byUri.size === 0) {
                this.byName.delete(symbol.normalized);
            }
        }

        this.modules.delete(uri);
        this.revisionValue++;
    }

    has(uri: string): boolean {
        return this.modules.has(uri);
    }

    /** Известная версия модуля: повторно записывать неизменившийся незачем. */
    versionOf(uri: string): number | undefined {
        return this.modules.get(uri)?.version;
    }

    get stats(): IRslCatalogStats {
        let symbols = 0;
        let bytes = 0;

        for (const module of this.modules.values()) {
            symbols += module.symbols.length;
            bytes += module.uri.length * 2 + 64;

            for (const symbol of module.symbols) {
                /*
                 * Две строки на символ (имя и нормализованное имя), URI —
                 * ссылка на общую строку, остальное — числа.
                 */
                bytes += (symbol.name.length * 2) * 2 +
                    symbol.container.length * 2 +
                    symbol.baseClassName.length * 2 +
                    80;
            }
        }

        return { modules: this.modules.size, symbols, approximateBytes: bytes };
    }

    /**
     * Поиск по имени с полной сортировкой до лимита.
     *
     * Порядок: точное имя, начало имени, вхождение, затем URI и стабильный
     * идентификатор. Одинаковый запрос при одинаковом составе проекта даёт
     * один и тот же ответ независимо от того, в каком порядке файлы попали в
     * каталог.
     */
    find(query: string, limit: number): IRslCatalogSymbol[] {
        const normalized = normalizeIdentifier(query.trim());
        const matches: { rank: number; symbol: IRslCatalogSymbol }[] = [];

        for (const module of this.modules.values()) {
            for (const symbol of module.symbols) {
                const rank = matchRank(symbol.normalized, normalized);

                if (rank >= 0) {
                    matches.push({ rank, symbol });
                }
            }
        }

        matches.sort((left, right) =>
            left.rank - right.rank ||
            compare(left.symbol.normalized, right.symbol.normalized) ||
            compare(left.symbol.uri, right.symbol.uri) ||
            (left.symbol.start - right.symbol.start)
        );

        return matches.slice(0, Math.max(0, limit))
            .map(item => item.symbol);
    }

    /** Все объявления с таким именем: кандидаты References и Auto Import. */
    findByName(name: string): readonly IRslCatalogSymbol[] {
        const byUri = this.byName.get(normalizeIdentifier(name));

        if (!byUri) {
            return [];
        }

        /* Порядок ответа не зависит от порядка загрузки файлов. */
        return [...byUri.keys()].sort()
            .flatMap(uri => byUri.get(uri) || []);
    }

    /**
     * Файлы, ссылающиеся на macro-файл: Import или строка с именем.
     *
     * Ответ по каталогу, а не чтением проекта: переименование файла
     * должно предлагать правки сразу, а не после обхода тысяч файлов.
     */
    modulesReferencing(moduleName: string): string[] {
        const wanted = normalizeIdentifier(moduleName);
        const result: string[] = [];

        for (const module of this.modules.values()) {
            const imported = module.imports.some(
                name => normalizeIdentifier(name) === wanted
            );

            if (imported) {
                result.push(module.uri);
            }
        }

        return result.sort();
    }

    /** Файлы, экспортирующие имя: кандидаты для адресной загрузки. */
    modulesExporting(name: string): string[] {
        const wanted = normalizeIdentifier(name);
        const result: string[] = [];

        for (const module of this.modules.values()) {
            if (module.exports.has(wanted)) {
                result.push(module.uri);
            }
        }

        return result.sort();
    }

    /** Классы, унаследованные от базового: основа Go to Implementation. */
    implementationsOf(baseClassName: string): IRslCatalogSymbol[] {
        const wanted = normalizeIdentifier(baseClassName);
        const result: IRslCatalogSymbol[] = [];

        for (const module of this.modules.values()) {
            for (const symbol of module.symbols) {
                if (
                    symbol.kind === CompletionItemKind.Class &&
                    symbol.baseClassName &&
                    normalizeIdentifier(symbol.baseClassName) === wanted
                ) {
                    result.push(symbol);
                }
            }
        }

        return result.sort((left, right) =>
            compare(left.uri, right.uri) || (left.start - right.start)
        );
    }
}

function append(
    result: IRslCatalogSymbol[],
    uri: string,
    symbol: RslSymbol,
    container: string,
    lineStarts: readonly number[]
): IRslCatalogSymbol | undefined {
    if (!symbol.name) {
        return undefined;
    }

    const start = symbol.selectionRange?.start ?? symbol.range.start;
    const end = symbol.selectionRange?.end ?? symbol.range.end;
    const position = positionAt(lineStarts, start);

    const record: IRslCatalogSymbol = {
        name: symbol.name,
        normalized: normalizeIdentifier(symbol.name),
        kind: symbol.kind,
        uri,
        start,
        end,
        line: position.line,
        character: position.character,
        container,
        isPrivate: !!symbol.isPrivate,
        baseClassName: symbol.baseClassName || ""
    };

    result.push(record);

    return record;
}

/** -1 — не подходит; меньше — лучше. */
function matchRank(candidate: string, query: string): number {
    if (!query) {
        return 2;
    }

    if (candidate === query) {
        return 0;
    }

    if (candidate.startsWith(query)) {
        return 1;
    }

    if (candidate.includes(query)) {
        return 2;
    }

    return isSubsequence(query, candidate) ? 3 : -1;
}

/** Нечёткое совпадение: буквы запроса идут по порядку. */
function isSubsequence(query: string, candidate: string): boolean {
    let index = 0;

    for (const letter of candidate) {
        if (letter === query[index]) {
            index++;

            if (index === query.length) {
                return true;
            }
        }
    }

    return false;
}

function compare(left: string, right: string): number {
    if (left === right) {
        return 0;
    }

    return left < right ? -1 : 1;
}

function positionAt(
    lineStarts: readonly number[],
    offset: number
): { line: number; character: number } {
    let low = 0;
    let high = lineStarts.length - 1;

    while (low < high) {
        const middle = (low + high + 1) >> 1;

        if (lineStarts[middle] <= offset) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }

    return { line: low, character: Math.max(0, offset - lineStarts[low]) };
}

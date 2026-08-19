import { CompletionItemKind } from "vscode-languageserver";

import {
    extractCompactDeclarations
} from "./declarationExtractor";
import { normalizeIdentifier, type IRslToken } from "../lexer";
import type { RslSymbol } from "../symbols/rslSymbol";

/**
 * Единица документа — часть файла, которую можно переанализировать отдельно.
 *
 * Замеры на репозитории макросов (1449 файлов больше 20 КБ): единиц на файл
 * p50 = 11, p95 = 44; размер единицы p50 = 0,7 КБ при медианном файле 35 КБ.
 * То есть обычная правка задевает пятидесятую часть файла — ради этого
 * разбиение и делается. Хвост при этом тяжёлый: у половины файлов самая крупная
 * единица занимает 39% файла, а у 5% — 95%, и там выигрыша не будет.
 */
export type RslDocumentUnitKind =
    | "topLevel"
    | "macro"
    | "class"
    | "method"
    | "onError";

export interface IRslDocumentUnit {
    /**
     * Устойчивый идентификатор.
     *
     * Смещения в него не входят намеренно: правка выше по файлу сдвигает все
     * последующие единицы, и идентификатор по смещению менялся бы у каждой.
     * Ключ — вид, имя и порядковый номер среди одноимённых.
     */
    id: string;
    kind: RslDocumentUnitKind;
    /** Имя объявления; у topLevel и onError его нет. */
    name: string;
    /** Имя класса-владельца у метода. */
    owner?: string;
    /** Границы, внутри которых лежит единица: по ним ищут задетую правкой. */
    start: number;
    end: number;
    /**
     * Куски текста, ПРИНАДЛЕЖАЩИЕ единице, — они не пересекаются между
     * единицами.
     *
     * Для Macro, метода и OnError это один кусок, равный границам. Для класса —
     * заголовок, поля и промежутки между методами, без их тел: тела принадлежат
     * методам. Для верхнего уровня — промежутки между верхнеуровневыми блоками.
     *
     * Без этого разделения нельзя было ни сравнить текст единицы (у верхнего
     * уровня границы охватывали файл целиком), ни отличить правку в теле метода
     * от правки в самом классе.
     */
    ranges: ReadonlyArray<{ start: number; end: number }>;
    /** Отпечаток текста единицы: сравнение с прежним отвечает «менялась ли». */
    hash: string;
}

/**
 * Отпечаток текста единицы.
 *
 * Цена коллизии — НЕ лишний пересчёт, а обратное: две разные версии единицы
 * сочтутся одинаковой, и переиспользуется устаревший результат. Это молчаливо
 * неверные подсказки и Problems, поэтому одного 32-битного FNV мало.
 *
 * Берутся два независимых прохода — FNV-1a и вариант с другим множителем и
 * начальным значением — плюс длина. Совпадение обоих на разных текстах той же
 * длины практически исключено, а стоит это по-прежнему один проход по строке.
 * Сравнение самого текста остаётся за вызывающим: см. sameUnitText.
 */
function hashRanges(
    text: string,
    ranges: ReadonlyArray<{ start: number; end: number }>
): string {
    let first = 0x811c9dc5;
    let second = 0x1000193;
    let length = 0;

    for (const range of ranges) {
        for (let index = range.start; index < range.end; index++) {
            const code = text.charCodeAt(index);
            first ^= code;
            first = Math.imul(first, 0x01000193);
            second = Math.imul(second ^ code, 0x85ebca6b);
            second ^= second >>> 13;
        }
        length += Math.max(0, range.end - range.start);
    }

    return `${(first >>> 0).toString(36)}.` +
        `${(second >>> 0).toString(36)}.${length}`;
}

/** Диапазоны блока за вычетом вложенных: тела методов классу не принадлежат. */
function subtractRanges(
    outer: { start: number; end: number },
    inner: ReadonlyArray<{ start: number; end: number }>
): Array<{ start: number; end: number }> {
    const result: Array<{ start: number; end: number }> = [];
    let cursor = outer.start;

    for (const hole of inner.slice().sort((a, b) => a.start - b.start)) {
        if (hole.start > cursor) {
            result.push({ start: cursor, end: Math.min(hole.start, outer.end) });
        }
        cursor = Math.max(cursor, hole.end);
    }

    if (cursor < outer.end) {
        result.push({ start: cursor, end: outer.end });
    }

    return result;
}

/**
 * Совпадает ли текст единицы в двух версиях документа.
 *
 * Отпечаток отвечает «почти наверняка да»; здесь — «да». Проверка нужна там,
 * где по ответу переиспользуется готовый результат: сравнение строк той же
 * длины стоит меньше любого анализа, а ошибка в эту сторону не прощается.
 */
export function sameUnitText(
    previousSource: string,
    previous: IRslDocumentUnit,
    nextSource: string,
    next: IRslDocumentUnit
): boolean {
    if (previous.hash !== next.hash) {
        return false;
    }

    /*
     * Сравниваются принадлежащие единице куски, а не её границы, и сравниваются
     * они по отдельности — без склейки в одну строку.
     *
     * Склейка требовала разделителя: без него сдвиг границы между соседними
     * кусками давал бы ту же строку при другом содержимом. Любой разделитель —
     * это символ, который может встретиться и в самом тексте, а NUL вдобавок
     * заставлял Git считать исходник бинарным. Поэтому куски сверяются подряд:
     * сначала их число, потом длины, потом сам текст.
     */
    if (previous.ranges.length !== next.ranges.length) {
        return false;
    }

    for (let index = 0; index < previous.ranges.length; index++) {
        const before = previous.ranges[index];
        const after = next.ranges[index];

        if (before.end - before.start !== after.end - after.start) {
            return false;
        }
    }

    /*
     * Текст сверяется отдельным проходом: длины дешевле, и на них отсеивается
     * почти всякая правка, а вырезать подстроки приходится только у тех единиц,
     * что совпали по всем длинам.
     */
    for (let index = 0; index < previous.ranges.length; index++) {
        const before = previous.ranges[index];
        const after = next.ranges[index];

        if (
            previousSource.slice(before.start, before.end) !==
            nextSource.slice(after.start, after.end)
        ) {
            return false;
        }
    }

    return true;
}

/**
 * Верхнеуровневый блок: Macro или Class с его методами.
 *
 * Границы блоков берутся из двух источников. У открытого документа уже есть
 * дерево символов, построенное при разборе, и повторное извлечение объявлений
 * ради тех же границ стоило на файле 700 КБ около двадцати миллисекунд —
 * ровно перед первой порцией расчёта, то есть в самом неудачном месте. Там,
 * где дерева нет (внешний модуль, проверка по одному тексту), границы
 * по-прежнему извлекаются по токенам.
 */
interface IUnitBlock {
    kind: "macro" | "class";
    name: string;
    start: number;
    end: number;
    methods: ReadonlyArray<{ name: string; start: number; end: number }>;
}

/** Границы блоков по дереву символов: обход одного уровня детей. */
function blocksFromSymbolTree(tree: RslSymbol): IUnitBlock[] {
    const blocks: IUnitBlock[] = [];

    for (const symbol of tree.children) {
        const isMacro = symbol.kind === CompletionItemKind.Function ||
            symbol.kind === CompletionItemKind.Method;
        const isClass = symbol.kind === CompletionItemKind.Class;

        if (!isMacro && !isClass) {
            continue;
        }

        blocks.push({
            kind: isClass ? "class" : "macro",
            name: symbol.name,
            start: symbol.range.start,
            end: symbol.range.end,
            methods: isClass
                ? symbol.children
                    .filter(child =>
                        child.kind === CompletionItemKind.Method ||
                        child.kind === CompletionItemKind.Function
                    )
                    .map(child => ({
                        name: child.name,
                        start: child.range.start,
                        end: child.range.end
                    }))
                : []
        });
    }

    return blocks;
}

/** Границы блоков по токенам: тот же вид, что и у дерева символов. */
function blocksFromTokens(
    source: string,
    tokens: readonly IRslToken[]
): IUnitBlock[] {
    const declarations = extractCompactDeclarations(source, {
        includePrivate: true,
        tokens: tokens as IRslToken[]
    }).declarations;
    const blocks: IUnitBlock[] = [];

    for (const declaration of declarations) {
        if (declaration.kind !== "macro" && declaration.kind !== "class") {
            continue;
        }

        blocks.push({
            kind: declaration.kind,
            name: declaration.name,
            start: declaration.start,
            end: declaration.end,
            methods: declaration.kind === "class"
                ? declaration.children
                    .filter(member => member.kind === "macro")
                    .map(member => ({
                        name: member.name,
                        start: member.start,
                        end: member.end
                    }))
                : []
        });
    }

    return blocks;
}

/** Верхнеуровневый OnError: обработчик ошибок модуля. */
function findTopLevelOnError(
    tokens: readonly IRslToken[]
): { start: number; end: number } | undefined {
    let depth = 0;

    for (const token of tokens) {
        /*
         * Длина отсеивает почти все идентификаторы файла до приведения к
         * нижнему регистру: интересны только слова длиной 2, 3, 4, 5 и 7
         * символов. На файле 700 КБ приведение каждого идентификатора стоило
         * больше самого поиска.
         */
        if (token.kind !== "identifier") {
            continue;
        }

        const length = token.value.length;

        if (length > 7 || length < 2 || length === 6) {
            continue;
        }

        const word = normalizeIdentifier(token.value);

        if (
            word === "macro" || word === "class" || word === "if" ||
            word === "while" || word === "for" || word === "with"
        ) {
            depth++;
            continue;
        }

        if (word === "end") {
            depth = Math.max(0, depth - 1);
            continue;
        }

        /*
         * OnError внутри блока принадлежит этому блоку и отдельной единицей не
         * является: он анализируется вместе с ним. Отдельная единица — только
         * обработчик самого модуля.
         */
        if (word === "onerror" && depth === 0) {
            return { start: token.start, end: tokens[tokens.length - 1].end };
        }
    }

    return undefined;
}

/**
 * Разбивает документ на единицы: верхний уровень, Macro, Class, методы класса
 * и обработчик ошибок модуля.
 *
 * Границы берутся у того же извлекателя объявлений, что строит Structure: он
 * работает по токенам, без полного разбора, и уже проверен на реальных файлах.
 * Собственного сканирования здесь ровно столько, сколько ему не хватает.
 */
export function splitRslDocumentUnits(
    source: string,
    tokens: readonly IRslToken[],
    /* Готовое дерево символов документа, если оно уже построено. */
    symbolTree?: RslSymbol
): IRslDocumentUnit[] {
    const blocks = symbolTree
        ? blocksFromSymbolTree(symbolTree)
        : blocksFromTokens(source, tokens);

    const units: IRslDocumentUnit[] = [];
    const ordinals = new Map<string, number>();

    const nextId = (
        kind: RslDocumentUnitKind,
        name: string,
        owner?: string
    ): string => {
        const key = owner
            ? `${kind}:${normalizeIdentifier(owner)}.${normalizeIdentifier(name)}`
            : `${kind}:${normalizeIdentifier(name)}`;
        const ordinal = ordinals.get(key) || 0;
        ordinals.set(key, ordinal + 1);
        /*
         * Порядковый номер нужен для одноимённых объявлений: файл с двумя
         * `Macro Save` некорректен, но встречается, и без номера две единицы
         * получили бы один идентификатор.
         */
        return ordinal === 0 ? key : `${key}#${ordinal}`;
    };

    const onError = findTopLevelOnError(tokens);
    const covered: Array<{ start: number; end: number }> = [];

    for (const declaration of blocks) {
        /* OnError модуля не попадает внутрь единицы Macro или Class. */
        const end = onError && declaration.end > onError.start
            ? Math.min(declaration.end, onError.start)
            : declaration.end;

        if (end <= declaration.start) {
            continue;
        }

        covered.push({ start: declaration.start, end });

        /*
         * Методы — отдельные единицы, и их тела классу НЕ принадлежат: иначе
         * правка в теле метода делала бы грязным и класс, то есть разделение
         * не давало бы ничего. Классу остаются заголовок, поля и промежутки
         * между методами — там и живут его собственные объявления.
         */
        const methods: Array<{ start: number; end: number }> = [];

        if (declaration.kind === "class") {
            for (const member of declaration.methods) {
                methods.push({ start: member.start, end: member.end });
                const ranges = [{ start: member.start, end: member.end }];
                units.push({
                    id: nextId("method", member.name, declaration.name),
                    kind: "method",
                    name: member.name,
                    owner: declaration.name,
                    start: member.start,
                    end: member.end,
                    ranges,
                    hash: hashRanges(source, ranges)
                });
            }
        }

        const ownRanges = methods.length > 0
            ? subtractRanges({ start: declaration.start, end }, methods)
            : [{ start: declaration.start, end }];

        units.push({
            id: nextId(declaration.kind, declaration.name),
            kind: declaration.kind,
            name: declaration.name,
            start: declaration.start,
            end,
            ranges: ownRanges,
            hash: hashRanges(source, ownRanges)
        });
    }

    if (onError) {
        covered.push(onError);
        const ranges = [{ start: onError.start, end: onError.end }];
        units.push({
            id: "onError:module",
            kind: "onError",
            name: "",
            start: onError.start,
            end: onError.end,
            ranges,
            hash: hashRanges(source, ranges)
        });
    }

    /*
     * Верхний уровень — всё, что осталось: Import, объявления модуля и код
     * инициализации. Границы охватывают файл, но принадлежат ему только
     * промежутки между верхнеуровневыми блоками.
     */
    covered.sort((left, right) => left.start - right.start);
    const gaps = subtractRanges({ start: 0, end: source.length }, covered);

    units.unshift({
        id: "topLevel:module",
        kind: "topLevel",
        name: "",
        start: 0,
        end: source.length,
        ranges: gaps,
        hash: hashRanges(source, gaps)
    });

    /* Порядок по началу: так проще искать единицу, задетую правкой. */
    return units.sort((left, right) => left.start - right.start);
}

export interface IRslUnitDiff {
    /** Текст единицы изменился: её нужно переанализировать. */
    changed: IRslDocumentUnit[];
    /** Единица появилась. */
    added: IRslDocumentUnit[];
    /** Единица исчезла: её результаты нужно выбросить. */
    removed: IRslDocumentUnit[];
    /** Текст тот же, изменились только смещения. */
    shifted: IRslDocumentUnit[];
    /** Текст и смещения те же: переиспользуется как есть. */
    unchanged: IRslDocumentUnit[];
}

/**
 * Что изменилось между двумя разбиениями.
 *
 * Разделение на changed и shifted — главное, ради чего всё это: сдвинутой
 * единице пересчёт не нужен, ей нужен только перенос смещений, а это на порядки
 * дешевле анализа.
 */
export function diffRslDocumentUnits(
    previous: readonly IRslDocumentUnit[],
    next: readonly IRslDocumentUnit[],
    /*
     * Тексты обеих версий. Без них сравнение идёт по отпечатку, и это
     * допустимо только там, где ошибка стоит лишнего пересчёта. Там, где по
     * ответу переиспользуется готовый результат, тексты обязательны:
     * см. sameUnitText.
     */
    sources?: { previous: string; next: string }
): IRslUnitDiff {
    const before = new Map(previous.map(unit => [unit.id, unit]));
    const diff: IRslUnitDiff = {
        changed: [],
        added: [],
        removed: [],
        shifted: [],
        unchanged: []
    };

    for (const unit of next) {
        const old = before.get(unit.id);

        if (!old) {
            diff.added.push(unit);
            continue;
        }

        before.delete(unit.id);

        const same = sources
            ? sameUnitText(sources.previous, old, sources.next, unit)
            : old.hash === unit.hash;

        if (!same) {
            diff.changed.push(unit);
        } else if (old.start !== unit.start || old.end !== unit.end) {
            diff.shifted.push(unit);
        } else {
            diff.unchanged.push(unit);
        }
    }

    diff.removed.push(...before.values());
    return diff;
}

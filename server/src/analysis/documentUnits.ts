import {
    extractCompactDeclarations
} from "./declarationExtractor";
import { normalizeIdentifier, type IRslToken } from "../lexer";

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
    start: number;
    end: number;
    /** Хеш текста единицы: сравнение с прежним отвечает «менялась ли». */
    hash: string;
}

/**
 * Хеш текста единицы.
 *
 * FNV-1a: одного прохода по строке достаточно, а криптостойкость здесь не
 * нужна — сравниваются только версии одного и того же файла, и цена ошибки
 * не «подделка», а «лишний пересчёт единицы».
 */
function hashText(text: string, from: number, to: number): string {
    let hash = 0x811c9dc5;

    for (let index = from; index < to; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }

    /* Длина в ключе: она разводит коллизии почти бесплатно. */
    return `${(hash >>> 0).toString(36)}.${to - from}`;
}

/** Верхнеуровневый OnError: обработчик ошибок модуля. */
function findTopLevelOnError(
    tokens: readonly IRslToken[]
): { start: number; end: number } | undefined {
    let depth = 0;

    for (const token of tokens) {
        if (token.kind !== "identifier") {
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
    tokens: readonly IRslToken[]
): IRslDocumentUnit[] {
    const declarations = extractCompactDeclarations(source, {
        includePrivate: true,
        tokens: tokens as IRslToken[]
    }).declarations;

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

    for (const declaration of declarations) {
        if (declaration.kind !== "macro" && declaration.kind !== "class") {
            continue;
        }

        /* OnError модуля не попадает внутрь единицы Macro или Class. */
        const end = onError && declaration.end > onError.start
            ? Math.min(declaration.end, onError.start)
            : declaration.end;

        if (end <= declaration.start) {
            continue;
        }

        covered.push({ start: declaration.start, end });
        units.push({
            id: nextId(declaration.kind, declaration.name),
            kind: declaration.kind,
            name: declaration.name,
            start: declaration.start,
            end,
            hash: hashText(source, declaration.start, end)
        });

        if (declaration.kind !== "class") {
            continue;
        }

        /*
         * Методы класса — отдельные единицы ВНУТРИ единицы класса. Класс
         * остаётся целым: его собственные поля и базовый класс относятся к
         * нему, а не к методам. Правка в теле метода делает грязным и метод, и
         * класс, но класс переанализируется без тел остальных методов.
         */
        for (const member of declaration.children) {
            if (member.kind !== "macro") {
                continue;
            }

            units.push({
                id: nextId("method", member.name, declaration.name),
                kind: "method",
                name: member.name,
                owner: declaration.name,
                start: member.start,
                end: member.end,
                hash: hashText(source, member.start, member.end)
            });
        }
    }

    if (onError) {
        covered.push(onError);
        units.push({
            id: "onError:module",
            kind: "onError",
            name: "",
            start: onError.start,
            end: onError.end,
            hash: hashText(source, onError.start, onError.end)
        });
    }

    /*
     * Верхний уровень — всё, что осталось: Import, объявления модуля и код
     * инициализации. Хеш считается по промежуткам между единицами: правка
     * внутри Macro его не меняет, а добавление Import — меняет.
     */
    covered.sort((left, right) => left.start - right.start);
    let gapHash = 0x811c9dc5;
    let gapLength = 0;
    let cursor = 0;

    const addGap = (from: number, to: number): void => {
        for (let index = from; index < to; index++) {
            gapHash ^= source.charCodeAt(index);
            gapHash = Math.imul(gapHash, 0x01000193);
        }
        gapLength += Math.max(0, to - from);
    };

    for (const range of covered) {
        if (range.start > cursor) {
            addGap(cursor, range.start);
        }
        cursor = Math.max(cursor, range.end);
    }
    addGap(cursor, source.length);

    units.unshift({
        id: "topLevel:module",
        kind: "topLevel",
        name: "",
        start: 0,
        end: source.length,
        hash: `${(gapHash >>> 0).toString(36)}.${gapLength}`
    });

    return units;
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
    next: readonly IRslDocumentUnit[]
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

        if (old.hash !== unit.hash) {
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

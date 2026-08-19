import { CompletionItem, CompletionItemKind } from "vscode-languageserver";

import {
    findFastClass,
    getFastCompletionIndex,
    lookupFastName,
    visibleFastItems,
    type IFastClassInfo,
    type IFastCompletionIndex
} from "./fastCompletionIndex";
import type { IFastDocumentSnapshot } from "../services/fastDocumentSnapshot";
import { normalizeIdentifier, type IRslToken } from "../lexer";
import { rankCompletionItemsForPrefix } from "./completionRanking";

/**
 * Объявления файла без ожидания полной модели.
 *
 * Нужны там, где ждать нечем: пользователь нажал Ctrl+Space или точку, а модель
 * этой версии ещё строится. Прежде в таком случае возвращался пустой список —
 * то есть подсказка выглядела так, будто в файле ничего нет.
 *
 * Это заведомо неполный ответ, и он таким и помечается: состав взят из
 * компактного индекса версии, без вывода типов по выражениям. Зато область
 * видимости соблюдается — предлагаются имена верхнего уровня, классы,
 * процедуры и собственные имена объемлющих Macro и Class.
 */
export function buildRslFastCompletions(
    snapshot: IFastDocumentSnapshot,
    offset: number,
    /* Готовый индекс, если вызывающий уже его взял: за запрос — один раз. */
    known?: IFastCompletionIndex
): CompletionItem[] {
    return visibleFastItems(
        known || getFastCompletionIndex(snapshot),
        offset
    );
}

/**
 * Члены объекта до готовности модели: MessageText. сразу после правки.
 *
 * Тип получателя берётся из ближайшего ВИДИМОГО объявления — написанного типа
 * или присваивания класса. Если объявление найдено, но тип по нему неизвестен,
 * подсказка не выдаётся вовсе: внешнее одноимённое имя в этой точке затенено, и
 * его члены здесь не при чём.
 *
 * Возвращает undefined, если это не обращение к члену или тип не опознан: тогда
 * вызывающий отдаёт обычный приблизительный список, а не пустой.
 */
export function buildRslFastMemberCompletions(
    snapshot: IFastDocumentSnapshot,
    offset: number,
    findClassMembers: (className: string) => CompletionItem[] | undefined,
    known?: IFastCompletionIndex
): CompletionItem[] | undefined {
    const receiver = findReceiverBeforeDot(snapshot.lex.tokens, offset);

    if (!receiver) {
        return undefined;
    }

    const index = known || getFastCompletionIndex(snapshot);
    const found = lookupFastName(index, receiver.name, offset);

    if (!found.typeName) {
        return undefined;
    }

    const members = findClassMembers(found.typeName);

    /*
     * Порядок — по набранной части имени, но состав полный: список отдаётся
     * клиенту как полный, и дальше фильтрует он. Отбрось здесь лишнее — и
     * после Backspace редактор отфильтрует уже урезанный набор.
     */
    return members && receiver.prefix
        ? rankCompletionItemsForPrefix(members, receiver.prefix)
        : members;
}

/** Члены класса, объявленного в этом же файле; undefined, если его здесь нет. */
export function buildRslFastOwnClassMembers(
    index: IFastCompletionIndex,
    className: string,
    offset: number
): CompletionItem[] | undefined {
    const own = findFastClass(index, className, offset);

    if (!own) {
        return undefined;
    }

    return ownClassItems(own, offset);
}

function ownClassItems(
    own: IFastClassInfo,
    offset: number
): CompletionItem[] {
    /*
     * Приватный член виден только внутри своего класса — в том числе когда
     * класс объявлен в этом же файле.
     */
    const insideOwnClass = offset >= own.start && offset <= own.end;

    return own.members
        .filter(member => insideOwnClass || !member.isPrivate)
        .map(member => ({
            label: member.name,
            kind: member.kind === "macro"
                ? CompletionItemKind.Method
                : CompletionItemKind.Field,
            detail: member.typeName || undefined
        }));
}

/** Последний токен, начинающийся не позже смещения; поток упорядочен. */
function tokenIndexBefore(
    tokens: readonly IRslToken[],
    offset: number
): number {
    let low = 0;
    let high = tokens.length;

    while (low < high) {
        const middle = (low + high) >>> 1;

        if (tokens[middle].start < offset) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    return low - 1;
}

/**
 * Получатель перед точкой и уже набранная часть имени члена.
 *
 * Курсор может стоять и сразу после точки, и после нескольких набранных
 * букв: obj. и obj.set — одно и то же обращение к члену. Прежде учитывался
 * только первый случай, и на obj.set быстрый путь отказывался от объектного
 * ответа: пользователь получал общий список и ждал полного разбора — ровно
 * та задержка, которую видно по Ctrl+Space.
 *
 * Получатель нужен и ключу сеанса Completion: состав списка зависит от
 * него, поэтому он входит в ключ.
 */
export function findReceiverBeforeDot(
    tokens: readonly IRslToken[],
    offset: number
): { name: string; prefix: string } | undefined {
    /*
     * Позиция ищется двоичным поиском, а не перебором с конца потока: на файле
     * 1 МБ обращение в его начале обходилось в несколько миллисекунд только на
     * то, чтобы дойти до нужного токена.
     */
    let index = tokenIndexBefore(tokens, offset);
    let prefix = "";

    /*
     * Токены после курсора к обращению не относятся, а перевод строки его
     * заканчивает: в
     *
     *     Field7.
     *     |
     *
     * точка осталась на прошлой строке, и члены Field7 здесь уже не при чём.
     * Прежде перевод строки просто пропускался — с пробелами на новой строке
     * ошибка не проявлялась, потому что до него доходил другой цикл.
     */
    while (index >= 0 && !endsAtOrBefore(tokens[index], offset)) {
        if (tokens[index].kind === "newline" && tokens[index].end <= offset) {
            return undefined;
        }

        index--;
    }

    if (index < 0) {
        return undefined;
    }

    /* Набранная часть имени члена: она примыкает к курсору без пробела. */
    if (tokens[index].kind === "identifier" && tokens[index].end === offset) {
        prefix = tokens[index].value;
        index--;
    }

    /*
     * Пробелы вокруг точки допустимы, а перевод строки — нет: он значит, что
     * обращение относится к другой строке.
     */
    while (index >= 0 && tokens[index].kind === "whitespace") {
        index--;
    }

    if (
        index < 0 ||
        tokens[index].kind !== "symbol" ||
        tokens[index].raw !== "."
    ) {
        return undefined;
    }
    index--;

    while (index >= 0 && tokens[index].kind === "whitespace") {
        index--;
    }

    return index >= 0 && tokens[index].kind === "identifier"
        ? { name: normalizeIdentifier(tokens[index].value), prefix }
        : undefined;
}

/** Токен закончился не позже курсора: всё, что правее, ещё не набрано. */
function endsAtOrBefore(token: IRslToken, offset: number): boolean {
    return token.kind !== "newline" && token.end <= offset;
}

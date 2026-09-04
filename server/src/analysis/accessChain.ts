import type { IRslToken } from "../lexer";

/**
 * Цепочка обращений слева от точки.
 *
 * `command.Execute().MoveNext` — это не одно имя и не два, а три звена, и тип
 * последнего известен только после того, как разобраны предыдущие. Прежде
 * типизировался лишь простой получатель-идентификатор: у всего, что сложнее,
 * тип не определялся вовсе, и подсказка после точки молчала.
 *
 * Разбор идёт от точки НАЗАД по токенам — так дешевле всего: цепочка обычно в
 * несколько звеньев, а файл бывает в семьсот килобайт, и разбирать его целиком
 * ради одной позиции незачем. Скобки пропускаются как единое целое, поэтому
 * аргументы любой сложности звену не мешают.
 */

export interface IRslAccessSegment {
    /** Имя звена. */
    name: string;
    /** Звено вызывается: `Execute()`, а не `Execute`. */
    call: boolean;
    /** Смещение имени: по нему звено разрешается. */
    start: number;
    end: number;
    /**
     * Смещение ВНУТРИ скобок вызова; пусто у звена без вызова.
     *
     * Разрешение вызова спрашивает именно такое место: по имени и по
     * закрывающей скобке оно вызова не видит.
     */
    insideCall?: number;
}

const OPENING = new Set(["(", "[", "{"]);
const CLOSING = new Set([")", "]", "}"]);

/**
 * Звенья цепочки, кончающейся точкой перед этим смещением.
 *
 * Пусто, если слева от точки не цепочка обращений, а что-то другое — конец
 * строки, литерал, оператор. Первое звено идёт первым: разрешать их надо
 * слева направо, как читает человек.
 */
export function readRslAccessChain(
    tokens: readonly IRslToken[],
    dotIndex: number
): IRslAccessSegment[] {
    const segments: IRslAccessSegment[] = [];
    let at = dotIndex - 1;

    for (;;) {
        /* Вызов: пропускаем скобки целиком, аргументы звену не важны. */
        let call = false;
        let insideCall: number | undefined;

        if (isSymbol(tokens[at], ")")) {
            const open = matchBackwards(tokens, at);

            if (open < 0) {
                return [];
            }

            call = true;
            insideCall = tokens[open].end;
            at = open - 1;
        }

        const token = tokens[at];

        if (!token || token.kind !== "identifier") {
            return [];
        }

        segments.unshift({
            name: token.value,
            call,
            start: token.start,
            end: token.end,
            insideCall
        });

        /*
         * Слева ещё точка — значит цепочка продолжается. Но только в
         * пределах строки: незаконченное `obj.` в конце строки — обычное
         * состояние текста при наборе, и предыдущая строка к этому
         * обращению отношения не имеет. Без этого правила цепочка
         * склеивалась через перевод строки и приводила к чужому классу.
         */
        const dot = tokens[at - 1];

        if (
            !isSymbol(dot, ".") ||
            dot.line !== token.line
        ) {
            return segments;
        }

        at -= 2;
    }
}

/** Индекс токена «точка», к которому относится позиция; -1, если её нет. */
export function findRslChainDot(
    tokens: readonly IRslToken[],
    offset: number
): number {
    for (let at = tokens.length - 1; at >= 0; at--) {
        const token = tokens[at];

        if (token.start >= offset) {
            continue;
        }

        /*
         * Между точкой и позицией допускается уже набранная часть имени —
         * и ничего больше: `rs.mo` это обращение к члену, `rs.mo + 1` нет.
         */
        if (token.kind === "identifier" && token.end <= offset) {
            return isSymbol(tokens[at - 1], ".") ? at - 1 : -1;
        }

        return isSymbol(token, ".") ? at : -1;
    }

    return -1;
}

function isSymbol(token: IRslToken | undefined, raw: string): boolean {
    return token !== undefined && token.kind === "symbol" && token.raw === raw;
}

/** Открывающая скобка для закрывающей на этом месте; -1, если её нет. */
function matchBackwards(
    tokens: readonly IRslToken[],
    closingIndex: number
): number {
    let depth = 0;

    for (let at = closingIndex; at >= 0; at--) {
        const token = tokens[at];

        if (token.kind !== "symbol") {
            continue;
        }

        if (CLOSING.has(token.raw)) {
            depth++;
        } else if (OPENING.has(token.raw)) {
            depth--;

            if (depth === 0) {
                return at;
            }
        }
    }

    return -1;
}

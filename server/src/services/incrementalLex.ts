import {
    lexRsl,
    type IRslLexResult,
    type IRslToken,
    type RslTokenKind
} from "../lexer";

/** Ниже этого размера полный lexRsl уже быстрее правки и её проверок. */
export const INCREMENTAL_LEX_MIN_CHARS = 50_000;

/*
 * comment/square/newline/bom могут менять состояние lexer за пределами
 * одного токена (многострочные конструкции), поэтому правка внутри них
 * всегда уходит на полный relex.
 */
const SAFE_KINDS = new Set<RslTokenKind>([
    "identifier", "number", "string", "symbol", "whitespace"
]);

/**
 * Пытается пересчитать lex только для локально изменённого токена вместо
 * полного повторного прохода по документу.
 *
 * Применяется только к большим файлам и только когда правка целиком
 * помещается внутри одного однострочного токена безопасного вида. Любое
 * сомнение (правка задевает границу токена, результат неоднозначен,
 * получившийся токен многострочный или их несколько) возвращает undefined —
 * вызывающий код в этом случае делает обычный полный lexRsl, поэтому
 * некорректный результат здесь невозможен: можно только не ускориться.
 */
export function tryIncrementalRelex(
    previousText: string,
    previousLex: IRslLexResult,
    nextText: string
): IRslLexResult | undefined {
    if (previousText.length < INCREMENTAL_LEX_MIN_CHARS) {
        return undefined;
    }

    if (previousText === nextText) {
        return previousLex;
    }

    const prefix = commonPrefixLength(previousText, nextText);
    const maxSuffix = Math.min(
        previousText.length - prefix,
        nextText.length - prefix
    );
    const suffix = commonSuffixLength(previousText, nextText, maxSuffix);

    const oldStart = prefix;
    const oldEnd = previousText.length - suffix;
    const newEnd = nextText.length - suffix;

    if (oldEnd < oldStart || newEnd < prefix) {
        return undefined;
    }

    const tokenIndex = findContainingTokenIndex(
        previousLex.tokens,
        oldStart,
        oldEnd
    );

    if (tokenIndex === undefined) {
        return undefined;
    }

    const token = previousLex.tokens[tokenIndex];

    if (!SAFE_KINDS.has(token.kind) || token.line !== token.endLine) {
        return undefined;
    }

    const delta = nextText.length - previousText.length;
    const sliceEnd = token.end + delta;

    if (sliceEnd < token.start) {
        return undefined;
    }

    const slice = nextText.slice(token.start, sliceEnd);
    const relexed = lexRsl(slice);

    if (relexed.tokens.length !== 1) {
        return undefined;
    }

    const replacement = relexed.tokens[0];

    if (
        !SAFE_KINDS.has(replacement.kind) ||
        replacement.line !== replacement.endLine ||
        replacement.start !== 0 ||
        replacement.end !== slice.length
    ) {
        return undefined;
    }

    const patchedToken: IRslToken = {
        ...replacement,
        start: token.start + replacement.start,
        end: token.start + replacement.end,
        line: token.line,
        endLine: token.line,
        character: token.character + replacement.character,
        endCharacter: token.character + replacement.endCharacter
    };

    const tokens = previousLex.tokens.slice();
    tokens[tokenIndex] = patchedToken;

    for (let index = tokenIndex + 1; index < tokens.length; index++) {
        const original = tokens[index];
        tokens[index] = {
            ...original,
            start: original.start + delta,
            end: original.end + delta,
            character: original.line === token.line
                ? original.character + delta
                : original.character,
            endCharacter: original.endLine === token.line
                ? original.endCharacter + delta
                : original.endCharacter
        };
    }

    const lineStarts = previousLex.lineStarts.map((offset, index) =>
        index > token.line ? offset + delta : offset
    );

    return {
        tokens,
        eol: previousLex.eol,
        hasFinalEol: previousLex.hasFinalEol,
        hasBom: previousLex.hasBom,
        lineStarts
    };
}

function commonPrefixLength(left: string, right: string): number {
    const max = Math.min(left.length, right.length);
    let index = 0;

    while (index < max && left.charCodeAt(index) === right.charCodeAt(index)) {
        index++;
    }

    return index;
}

function commonSuffixLength(left: string, right: string, max: number): number {
    let index = 0;

    while (
        index < max &&
        left.charCodeAt(left.length - 1 - index) ===
            right.charCodeAt(right.length - 1 - index)
    ) {
        index++;
    }

    return index;
}

/** Токены отсортированы по start; ищет единственный, содержащий [start, end). */
function findContainingTokenIndex(
    tokens: readonly IRslToken[],
    start: number,
    end: number
): number | undefined {
    let low = 0;
    let high = tokens.length - 1;
    let candidate = -1;

    while (low <= high) {
        const middle = (low + high) >>> 1;

        if (tokens[middle].start <= start) {
            candidate = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }

    if (candidate < 0) {
        return undefined;
    }

    const token = tokens[candidate];
    return token.start <= start && end <= token.end ? candidate : undefined;
}

/**
 * Общий лексер RSL.
 *
 * Он не пытается полностью разобрать грамматику языка. Его задача — один раз
 * одинаково отделить код от строк, комментариев и квадратных SQL/текстовых
 * блоков. Эти токены затем используют parser, formatter, folding, diagnostics
 * и навигация.
 */

export type RslTokenKind =
    | "identifier"
    | "number"
    | "string"
    | "comment"
    | "square"
    | "symbol"
    | "whitespace"
    | "newline"
    | "bom";

export interface IRslToken {
    kind: RslTokenKind;
    raw: string;
    value: string;
    start: number;
    end: number;
    line: number;
    character: number;
    endLine: number;
    endCharacter: number;
}

export interface IRslLexOptions {
    /** Не сохранять пробелы, переводы строк и BOM для фоновых модулей. */
    includeTrivia?: boolean;
}

export interface IRslLexResult {
    tokens: IRslToken[];
    eol: "\r\n" | "\n" | "\r";
    hasFinalEol: boolean;
    hasBom: boolean;
    lineStarts: number[];
}

interface IPosition {
    index: number;
    line: number;
    character: number;
}

export function lexRsl(
    source: string,
    options?: IRslLexOptions
): IRslLexResult {
    const text = source || "";
    const includeTrivia = options?.includeTrivia !== false;
    const tokens: IRslToken[] = [];
    const lineStarts: number[] = [0];
    const position: IPosition = {
        index: 0,
        line: 0,
        character: 0
    };

    const eol = detectEol(text);
    const hasFinalEol = /(?:\r\n|\n|\r)$/.test(text);
    const hasBom = text.charCodeAt(0) === 0xFEFF;

    if (hasBom) {
        if (includeTrivia) {
            pushToken(tokens, text, position, "bom", 1, lineStarts);
        } else {
            advanceWithLine(text, position, lineStarts);
        }
    }

    while (position.index < text.length) {
        const current = text.charAt(position.index);

        if (current === "\r" || current === "\n") {
            const start = snapshot(position);
            advanceWithLine(text, position, lineStarts);
            if (includeTrivia) {
                pushSnapshotToken(tokens, text, "newline", start, position);
            }
            continue;
        }

        if (current === " " || current === "\t") {
            const start = position.index;

            while (
                position.index < text.length &&
                (
                    text.charAt(position.index) === " " ||
                    text.charAt(position.index) === "\t"
                )
            ) {
                position.index++;
                position.character++;
            }

            if (includeTrivia) {
                pushExistingToken(tokens, text, "whitespace", start, position);
            }
            continue;
        }

        if (startsWithAt(text, "//", position.index)) {
            const start = snapshot(position);
            advanceCharacter(position, "/");
            advanceCharacter(position, "/");

            while (
                position.index < text.length &&
                text.charAt(position.index) !== "\r" &&
                text.charAt(position.index) !== "\n"
            ) {
                position.index++;
                position.character++;
            }

            pushSnapshotToken(tokens, text, "comment", start, position);
            continue;
        }

        if (startsWithAt(text, "/*", position.index)) {
            const start = snapshot(position);
            advanceCharacter(position, "/");
            advanceCharacter(position, "*");

            while (position.index < text.length) {
                if (startsWithAt(text, "*/", position.index)) {
                    advanceCharacter(position, "*");
                    advanceCharacter(position, "/");
                    break;
                }

                advanceWithLine(text, position, lineStarts);
            }

            pushSnapshotToken(tokens, text, "comment", start, position);
            continue;
        }

        if (current === "[") {
            /*
             * В RSL квадратные скобки используются и для SQL/текстовых
             * capture-блоков, и для индексирования массивов.
             *
             * После выражения на той же строке это индекс:
             *     accounts[i]
             *     BlockSum [BlockSum.Size]
             *
             * В остальных случаях сохраняем защищённый square-токен, чтобы
             * SQL внутри [ ... ] не участвовал в разборе RSL.
             */
            if (isArrayIndexStart(tokens, position)) {
                pushToken(tokens, text, position, "symbol", 1, lineStarts);
            } else {
                const start = snapshot(position);
                skipSquareBlock(text, position, lineStarts);
                pushSnapshotToken(tokens, text, "square", start, position);
            }

            continue;
        }

        if (current === "\"" || current === "'") {
            const start = snapshot(position);
            skipRslString(text, position, current, lineStarts);
            pushSnapshotToken(tokens, text, "string", start, position);
            continue;
        }

        if (isIdentifierStart(current)) {
            const start = snapshot(position);

            while (
                position.index < text.length &&
                isIdentifierPart(text.charAt(position.index))
            ) {
                position.index++;
                position.character++;
            }

            pushSnapshotToken(tokens, text, "identifier", start, position);
            continue;
        }

        if (isDigit(current)) {
            const start = snapshot(position);

            while (
                position.index < text.length &&
                isNumberPart(text.charAt(position.index))
            ) {
                position.index++;
                position.character++;
            }

            pushSnapshotToken(tokens, text, "number", start, position);
            continue;
        }

        pushToken(tokens, text, position, "symbol", 1, lineStarts);
    }

    return {
        tokens,
        eol,
        hasFinalEol,
        hasBom,
        lineStarts
    };
}

export function significantTokens(tokens: IRslToken[]): IRslToken[] {
    return tokens.filter(token =>
        token.kind !== "whitespace" &&
        token.kind !== "newline" &&
        token.kind !== "comment" &&
        token.kind !== "square" &&
        token.kind !== "bom"
    );
}

export function codeTokens(tokens: IRslToken[]): IRslToken[] {
    return tokens.filter(token =>
        token.kind === "identifier" ||
        token.kind === "number" ||
        token.kind === "symbol"
    );
}

export function tokenAtOffset(
    tokens: IRslToken[],
    offset: number,
    includeRightBoundary: boolean = true
): IRslToken | undefined {
    let left = 0;
    let right = tokens.length - 1;
    let candidate = -1;

    while (left <= right) {
        const middle = Math.floor((left + right) / 2);
        const token = tokens[middle];

        if (token.start <= offset) {
            candidate = middle;
            left = middle + 1;
        } else {
            right = middle - 1;
        }
    }

    if (candidate < 0) {
        return undefined;
    }

    const token = tokens[candidate];

    if (
        includeRightBoundary &&
        token.kind === "symbol" &&
        token.start === offset &&
        candidate > 0 &&
        tokens[candidate - 1].end === offset &&
        (
            tokens[candidate - 1].kind === "identifier" ||
            tokens[candidate - 1].kind === "number" ||
            tokens[candidate - 1].kind === "string"
        )
    ) {
        return tokens[candidate - 1];
    }

    const inside = includeRightBoundary
        ? offset <= token.end
        : offset < token.end;

    return inside ? token : undefined;
}

export function getTokensOnLine(
    tokens: IRslToken[],
    line: number
): IRslToken[] {
    return tokens.filter(token =>
        token.line <= line && token.endLine >= line
    );
}

export function isFullLineComment(
    source: string,
    token: IRslToken
): boolean {
    if (token.kind !== "comment" || !token.raw.startsWith("//")) {
        return false;
    }

    const lineStart = source.lastIndexOf("\n", token.start - 1) + 1;
    const prefix = source.substring(lineStart, token.start)
        .replace(/\r/g, "");

    return /^[ \t]*$/.test(prefix);
}

export function normalizeIdentifier(value: string): string {
    return (value || "").toLowerCase();
}

export function isIdentifierStart(value: string): boolean {
    if (!value) {
        return false;
    }

    const code = value.charCodeAt(0);
    return code === 64 || // @
        code === 95 || // _
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 0x0410 && code <= 0x044F) ||
        code === 0x0401 ||
        code === 0x0451;
}

export function isIdentifierPart(value: string): boolean {
    return isIdentifierStart(value) || isDigit(value);
}

function isDigit(value: string): boolean {
    if (!value) {
        return false;
    }

    const code = value.charCodeAt(0);
    return code >= 48 && code <= 57;
}

function isNumberPart(value: string): boolean {
    if (!value) {
        return false;
    }

    const code = value.charCodeAt(0);
    return isDigit(value) ||
        code === 46 || // .
        code === 95 || // _
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122);
}

function detectEol(text: string): "\r\n" | "\n" | "\r" {
    const crlf = text.indexOf("\r\n");
    const lf = text.indexOf("\n");
    const cr = text.indexOf("\r");

    if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
        return "\r\n";
    }

    if (lf >= 0) {
        return "\n";
    }

    if (cr >= 0) {
        return "\r";
    }

    return "\n";
}


function isArrayIndexStart(
    tokens: IRslToken[],
    position: IPosition
): boolean {
    for (let index = tokens.length - 1; index >= 0; index--) {
        const token = tokens[index];

        if (token.kind === "whitespace" || token.kind === "bom") {
            continue;
        }

        /* Индекс не начинается после перевода строки или комментария. */
        if (
            token.kind === "newline" ||
            token.kind === "comment" ||
            token.endLine !== position.line
        ) {
            return false;
        }

        if (
            token.kind === "identifier" ||
            token.kind === "number" ||
            token.kind === "string"
        ) {
            return true;
        }

        return token.kind === "symbol" &&
            (token.raw === ")" || token.raw === "]");
    }

    return false;
}

function skipRslString(
    source: string,
    position: IPosition,
    quote: string,
    lineStarts: number[]
): void {
    advanceCharacter(position, quote);

    while (position.index < source.length) {
        const current = source.charAt(position.index);

        if (
            current === quote &&
            !isEscapedByBackslashes(source, position.index)
        ) {
            advanceCharacter(position, current);
            return;
        }

        advanceWithLine(source, position, lineStarts);
    }
}

function skipSqlString(
    source: string,
    position: IPosition,
    quote: string,
    lineStarts: number[]
): void {
    advanceCharacter(position, quote);

    while (position.index < source.length) {
        const current = source.charAt(position.index);

        if (current !== quote) {
            advanceWithLine(source, position, lineStarts);
            continue;
        }

        if (source.charAt(position.index + 1) === quote) {
            advanceCharacter(position, quote);
            advanceCharacter(position, quote);
            continue;
        }

        advanceCharacter(position, quote);
        return;
    }
}

function skipSquareBlock(
    source: string,
    position: IPosition,
    lineStarts: number[]
): void {
    let depth = 1;
    advanceCharacter(position, "[");

    while (position.index < source.length && depth > 0) {
        if (startsWithAt(source, "--", position.index) ||
            startsWithAt(source, "//", position.index)) {
            advanceCharacter(position, source.charAt(position.index));
            advanceCharacter(position, source.charAt(position.index));

            while (
                position.index < source.length &&
                source.charAt(position.index) !== "\r" &&
                source.charAt(position.index) !== "\n"
            ) {
                advanceCharacter(position, source.charAt(position.index));
            }

            continue;
        }

        if (startsWithAt(source, "/*", position.index)) {
            advanceCharacter(position, "/");
            advanceCharacter(position, "*");

            while (position.index < source.length) {
                if (startsWithAt(source, "*/", position.index)) {
                    advanceCharacter(position, "*");
                    advanceCharacter(position, "/");
                    break;
                }

                advanceWithLine(source, position, lineStarts);
            }

            continue;
        }

        const current = source.charAt(position.index);

        if (current === "\"" || current === "'") {
            skipSqlString(source, position, current, lineStarts);
            continue;
        }

        if (current === "[") {
            depth++;
            advanceCharacter(position, current);
            continue;
        }

        if (current === "]") {
            depth--;
            advanceCharacter(position, current);
            continue;
        }

        advanceWithLine(source, position, lineStarts);
    }
}

function isEscapedByBackslashes(source: string, index: number): boolean {
    let count = 0;
    let position = index - 1;

    while (position >= 0 && source.charAt(position) === "\\") {
        count++;
        position--;
    }

    return count % 2 === 1;
}

function startsWithAt(
    source: string,
    value: string,
    index: number
): boolean {
    return source.startsWith(value, index);
}

function snapshot(position: IPosition): IPosition {
    return {
        index: position.index,
        line: position.line,
        character: position.character
    };
}

function pushToken(
    tokens: IRslToken[],
    source: string,
    position: IPosition,
    kind: RslTokenKind,
    length: number,
    lineStarts: number[]
): void {
    const start = snapshot(position);

    for (let index = 0; index < length; index++) {
        advanceWithLine(source, position, lineStarts);
    }

    pushSnapshotToken(tokens, source, kind, start, position);
}

function pushExistingToken(
    tokens: IRslToken[],
    source: string,
    kind: RslTokenKind,
    startIndex: number,
    position: IPosition
): void {
    const raw = source.substring(startIndex, position.index);
    tokens.push({
        kind,
        raw,
        value: raw,
        start: startIndex,
        end: position.index,
        line: position.line,
        character: position.character - raw.length,
        endLine: position.line,
        endCharacter: position.character
    });
}

function pushSnapshotToken(
    tokens: IRslToken[],
    source: string,
    kind: RslTokenKind,
    start: IPosition,
    end: IPosition
): void {
    const raw = source.substring(start.index, end.index);
    tokens.push({
        kind,
        raw,
        value: kind === "string" ? decodeRslString(raw) : raw,
        start: start.index,
        end: end.index,
        line: start.line,
        character: start.character,
        endLine: end.line,
        endCharacter: end.character
    });
}

function advanceWithLine(
    source: string,
    position: IPosition,
    lineStarts: number[]
): void {
    const current = source.charAt(position.index);

    if (current === "\r") {
        if (source.charAt(position.index + 1) === "\n") {
            position.index += 2;
        } else {
            position.index++;
        }

        position.line++;
        position.character = 0;
        lineStarts.push(position.index);
        return;
    }

    if (current === "\n") {
        position.index++;
        position.line++;
        position.character = 0;
        lineStarts.push(position.index);
        return;
    }

    advanceCharacter(position, current);
}

function advanceCharacter(position: IPosition, _value: string): void {
    position.index++;
    position.character++;
}

function decodeRslString(raw: string): string {
    if (raw.length < 2) {
        return raw;
    }

    const quote = raw.charAt(0);
    const end = raw.charAt(raw.length - 1) === quote
        ? raw.length - 1
        : raw.length;
    const body = raw.substring(1, end);

    /* Большинство строк не содержит escape-последовательностей. */
    if (body.indexOf("\\") < 0) {
        return body;
    }

    let result = "";

    for (let index = 0; index < body.length; index++) {
        const current = body.charAt(index);

        if (current === "\\" && index + 1 < body.length) {
            result += body.charAt(index + 1);
            index++;
            continue;
        }

        result += current;
    }

    return result;
}

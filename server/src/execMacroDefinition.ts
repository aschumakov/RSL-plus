export type DynamicDefinitionKind =
    "macro" |
    "fileMacro" |
    "file";

export interface IDynamicDefinitionTarget {
    kind: DynamicDefinitionKind;
    macroName?: string;
    moduleName?: string;
}

interface IToken {
    kind: "identifier" | "string" | "symbol";
    raw: string;
    value: string;
    start: number;
    end: number;
}

interface ICallArgument {
    tokens: IToken[];
    stringToken?: IToken;
}

interface ICallInfo {
    name: string;
    arguments: ICallArgument[];
}

const DYNAMIC_CALLS: { [name: string]: boolean } = {
    execmacro: true,
    execmacro2: true,
    execmacrofile: true
};

/**
 * Определяет цель перехода для строковых параметров ExecMacro,
 * ExecMacro2 и ExecMacroFile.
 *
 * Если параметр задан переменной или выражением, специальный переход
 * не создаётся: language server продолжает обычный поиск определения.
 */
export function GetDynamicDefinitionTarget(
    source: string,
    offset: number
): IDynamicDefinitionTarget | undefined {
    const tokens = tokenize(source || "");
    const calls = findDynamicCalls(tokens);

    for (const call of calls) {
        const selectedArgument = findSelectedStringArgument(
            call.arguments,
            offset
        );

        if (selectedArgument < 0) {
            continue;
        }

        if (
            call.name === "execmacro" ||
            call.name === "execmacro2"
        ) {
            if (selectedArgument !== 0) {
                continue;
            }

            const macroName = getStringArgument(
                call.arguments,
                0
            );

            if (macroName.length === 0) {
                return undefined;
            }

            return {
                kind: "macro",
                macroName
            };
        }

        if (call.name === "execmacrofile") {
            if (
                selectedArgument !== 0 &&
                selectedArgument !== 1
            ) {
                continue;
            }

            const moduleName = getStringArgument(
                call.arguments,
                0
            );

            if (moduleName.length === 0) {
                return undefined;
            }

            const macroName = getStringArgument(
                call.arguments,
                1
            );

            if (macroName.length === 0) {
                return {
                    kind: "file",
                    moduleName
                };
            }

            return {
                kind: "fileMacro",
                moduleName,
                macroName
            };
        }
    }

    return undefined;
}

/**
 * Возвращает имена файлов, перечисленные в директивах Import.
 * Комментарии, строки вне Import и квадратные SQL-блоки игнорируются.
 */
export function GetImportedMacroFiles(source: string): string[] {
    const tokens = tokenize(source || "");
    const result: string[] = [];
    const seen: { [name: string]: boolean } = Object.create(null);

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (
            token.kind !== "identifier" ||
            token.value.toLowerCase() !== "import"
        ) {
            continue;
        }

        let segmentStart = token.end;

        for (let cursor = index + 1; cursor < tokens.length; cursor++) {
            const current = tokens[cursor];

            if (
                current.kind === "symbol" &&
                (current.raw === "," || current.raw === ";")
            ) {
                addImportName(
                    source.substring(segmentStart, current.start),
                    result,
                    seen
                );

                segmentStart = current.end;

                if (current.raw === ";") {
                    index = cursor;
                    break;
                }
            }
        }
    }

    return result;
}

function addImportName(
    rawValue: string,
    result: string[],
    seen: { [name: string]: boolean }
): void {
    let value = rawValue.trim();

    if (value.length >= 2) {
        const first = value.charAt(0);
        const last = value.charAt(value.length - 1);

        if (
            (first === "\"" && last === "\"") ||
            (first === "'" && last === "'")
        ) {
            value = decodeString(value);
        }
    }

    if (value.length === 0) {
        return;
    }

    if (!/\.mac$/i.test(value)) {
        value += ".mac";
    }

    const normalized = value
        .replace(/\\/g, "/")
        .toLowerCase();

    if (seen[normalized]) {
        return;
    }

    seen[normalized] = true;
    result.push(value);
}

function findSelectedStringArgument(
    args: ICallArgument[],
    offset: number
): number {
    for (let index = 0; index < args.length; index++) {
        const stringToken = args[index].stringToken;

        if (
            stringToken !== undefined &&
            stringToken.start <= offset &&
            offset <= stringToken.end
        ) {
            return index;
        }
    }

    return -1;
}

function getStringArgument(
    args: ICallArgument[],
    index: number
): string {
    if (
        index < 0 ||
        index >= args.length ||
        args[index].stringToken === undefined
    ) {
        return "";
    }

    return args[index].stringToken!.value.trim();
}

function findDynamicCalls(tokens: IToken[]): ICallInfo[] {
    const result: ICallInfo[] = [];

    for (let index = 0; index < tokens.length - 1; index++) {
        const nameToken = tokens[index];
        const openToken = tokens[index + 1];

        if (
            nameToken.kind !== "identifier" ||
            openToken.kind !== "symbol" ||
            openToken.raw !== "("
        ) {
            continue;
        }

        const name = nameToken.value.toLowerCase();

        if (!DYNAMIC_CALLS[name]) {
            continue;
        }

        const parsed = parseCallArguments(tokens, index + 1);

        if (parsed === undefined) {
            continue;
        }

        result.push({
            name,
            arguments: parsed.arguments
        });

        index = parsed.closeIndex;
    }

    return result;
}

function parseCallArguments(
    tokens: IToken[],
    openIndex: number
): { arguments: ICallArgument[]; closeIndex: number } | undefined {
    const result: ICallArgument[] = [];
    let current: IToken[] = [];
    let depth = 1;

    for (let index = openIndex + 1; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind === "symbol" && token.raw === "(") {
            depth++;
            current.push(token);
            continue;
        }

        if (token.kind === "symbol" && token.raw === ")") {
            depth--;

            if (depth === 0) {
                if (current.length > 0 || result.length > 0) {
                    result.push(createArgument(current));
                }

                return {
                    arguments: result,
                    closeIndex: index
                };
            }

            current.push(token);
            continue;
        }

        if (
            token.kind === "symbol" &&
            token.raw === "," &&
            depth === 1
        ) {
            result.push(createArgument(current));
            current = [];
            continue;
        }

        current.push(token);
    }

    return undefined;
}

function createArgument(tokens: IToken[]): ICallArgument {
    const meaningful = tokens.filter(token =>
        token.kind !== "symbol" ||
        token.raw.trim().length > 0
    );

    return {
        tokens,
        stringToken:
            meaningful.length === 1 &&
            meaningful[0].kind === "string"
                ? meaningful[0]
                : undefined
    };
}

function tokenize(source: string): IToken[] {
    const result: IToken[] = [];
    let index = 0;

    while (index < source.length) {
        const current = source.charAt(index);

        if (/\s/.test(current)) {
            index++;
            continue;
        }

        if (startsWithAt(source, "//", index)) {
            index = skipToLineEnd(source, index + 2);
            continue;
        }

        if (startsWithAt(source, "/*", index)) {
            index = skipBlockComment(source, index + 2);
            continue;
        }

        if (current === "[") {
            index = skipSquareBlock(source, index);
            continue;
        }

        if (current === "\"" || current === "'") {
            const start = index;
            index = skipQuotedString(source, index, current, true);
            const raw = source.substring(start, index);

            result.push({
                kind: "string",
                raw,
                value: decodeString(raw),
                start,
                end: index
            });

            continue;
        }

        if (isIdentifierStart(current)) {
            const start = index;
            index++;

            while (
                index < source.length &&
                isIdentifierPart(source.charAt(index))
            ) {
                index++;
            }

            const raw = source.substring(start, index);

            result.push({
                kind: "identifier",
                raw,
                value: raw,
                start,
                end: index
            });

            continue;
        }

        result.push({
            kind: "symbol",
            raw: current,
            value: current,
            start: index,
            end: index + 1
        });

        index++;
    }

    return result;
}

function decodeString(raw: string): string {
    if (raw.length < 2) {
        return raw;
    }

    const quote = raw.charAt(0);
    const end = raw.charAt(raw.length - 1) === quote
        ? raw.length - 1
        : raw.length;

    let result = "";

    for (let index = 1; index < end; index++) {
        const current = raw.charAt(index);

        if (current === "\\" && index + 1 < end) {
            result += raw.charAt(index + 1);
            index++;
            continue;
        }

        result += current;
    }

    return result;
}

function skipSquareBlock(source: string, start: number): number {
    let index = start + 1;
    let depth = 1;

    while (index < source.length && depth > 0) {
        if (startsWithAt(source, "--", index)) {
            index = skipToLineEnd(source, index + 2);
            continue;
        }

        if (startsWithAt(source, "//", index)) {
            index = skipToLineEnd(source, index + 2);
            continue;
        }

        if (startsWithAt(source, "/*", index)) {
            index = skipBlockComment(source, index + 2);
            continue;
        }

        const current = source.charAt(index);

        if (current === "\"" || current === "'") {
            index = skipQuotedString(source, index, current, false);
            continue;
        }

        if (current === "[") {
            depth++;
        } else if (current === "]") {
            depth--;
        }

        index++;
    }

    return index;
}

function skipQuotedString(
    source: string,
    start: number,
    quote: string,
    backslashEscapes: boolean
): number {
    let index = start + 1;

    while (index < source.length) {
        if (source.charAt(index) !== quote) {
            index++;
            continue;
        }

        if (
            backslashEscapes &&
            isEscapedByBackslashes(source, index)
        ) {
            index++;
            continue;
        }

        if (
            !backslashEscapes &&
            source.charAt(index + 1) === quote
        ) {
            index += 2;
            continue;
        }

        return index + 1;
    }

    return index;
}

function isEscapedByBackslashes(
    source: string,
    position: number
): boolean {
    let count = 0;
    let index = position - 1;

    while (index >= 0 && source.charAt(index) === "\\") {
        count++;
        index--;
    }

    return count % 2 === 1;
}

function skipBlockComment(source: string, start: number): number {
    const close = source.indexOf("*/", start);
    return close < 0 ? source.length : close + 2;
}

function skipToLineEnd(source: string, start: number): number {
    let index = start;

    while (
        index < source.length &&
        source.charAt(index) !== "\r" &&
        source.charAt(index) !== "\n"
    ) {
        index++;
    }

    return index;
}

function startsWithAt(
    source: string,
    value: string,
    position: number
): boolean {
    return source.substr(position, value.length) === value;
}

function isIdentifierStart(value: string): boolean {
    return /^[@A-Za-zА-Яа-яЁё_]$/.test(value);
}

function isIdentifierPart(value: string): boolean {
    return /^[@A-Za-zА-Яа-яЁё0-9_]$/.test(value);
}

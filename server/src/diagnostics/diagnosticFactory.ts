import {
    IImportDefinitionTarget
} from "../execMacroDefinition";
import {
    isRslKeyword,
    isRslSystemConstant,
    isRslType
} from "../language/rslLanguageReference";
import {
    IRslToken,
    normalizeIdentifier,
    type RslSquareKind
} from "../lexer";
import {
    RslSymbol
} from "../symbols/rslSymbol";
import {
    IIndexedModule
} from "../workspaceIndex";
import * as path from "path";
import {
    fileURLToPath
} from "url";
import {
    Diagnostic,
    DiagnosticSeverity,
    DiagnosticTag
} from "vscode-languageserver";

/*
 * Создание LSP-диагностик и общие опоры проверок.
 *
 * Проверка отвечает на вопрос «что не так», а не «как это записать в
 * протокол». Перевод смещений в позиции, объединение одинаковых находок,
 * поиск токена по смещению — всё это одно на всех и живёт здесь.
 */

export interface IDiagnosticData {
    start?: number;
    end?: number;
    name?: string;
    parameter?: boolean;
    moduleName?: string;
    replacement?: string;
}

/**
 * Число символов, а не единиц UTF-16.
 *
 * Считается перебором без создания массива: вызывается на каждом токене, длина
 * которого дошла до предела, а таких в обычном файле нет вовсе.
 */
export function countCharacters(value: string): number {
    let count = 0;

    for (const _character of value) {
        count++;
    }

    return count;
}

export function splitTopLevel(value: string): string[] {
    const result: string[] = [];
    let start = 0;
    let depth = 0;
    for (let index = 0; index < value.length; index++) {
        const char = value.charAt(index);
        if (char === "(" || char === "[" || char === "{") depth++;
        else if (char === ")" || char === "]" || char === "}") depth--;
        else if (char === "," && depth === 0) {
            result.push(value.slice(start, index));
            start = index + 1;
        }
    }
    result.push(value.slice(start));
    return result;
}

export function moduleFileName(uri: string): string {
    try {
        return path.basename(fileURLToPath(uri));
    } catch {
        return path.basename(uri);
    }
}

export function isSpecialName(value: string): boolean {
    return /^\{[^}\r\n]+\}$/u.test(value);
}

export function splitLongStringLiteral(raw: string): string | undefined {
    if (raw.length < 2050 || (raw[0] !== "\"" && raw[0] !== "'")) {
        return undefined;
    }
    const quote = raw[0];
    const body = raw.slice(1, raw.endsWith(quote) ? -1 : undefined);
    const parts: string[] = [];
    let start = 0;
    while (body.length - start > 1800) {
        let end = start + 1800;
        while (end > start && body.charAt(end - 1) === "\\") end--;
        if (end === start) return undefined;
        parts.push(body.slice(start, end));
        start = end;
    }
    parts.push(body.slice(start));
    return parts.map(part => `${quote}${part}${quote}`).join(" +\n");
}

export function tokenIndexAt(tokens: IRslToken[], offset: number): number {
    let low = 0;
    let high = tokens.length - 1;

    while (low <= high) {
        const middle = (low + high) >>> 1;
        const start = tokens[middle].start;

        if (start === offset) {
            return middle;
        }

        if (start < offset) {
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }

    return -1;
}

export function nextCodeTokenIndex(
    tokens: IRslToken[],
    index: number
): number {
    for (let at = index + 1; at < tokens.length; at++) {
        if (isCodeToken(tokens[at])) {
            return at;
        }
    }

    return -1;
}

export function isCodeToken(token: IRslToken): boolean {
    return token.kind !== "whitespace" &&
        token.kind !== "newline" &&
        token.kind !== "comment" &&
        token.kind !== "bom";
}

export function someTokenInRange(
    tokens: IRslToken[],
    start: number,
    end: number,
    predicate: (token: IRslToken) => boolean
): boolean {
    return findTokenInRange(tokens, start, end, predicate) !== undefined;
}

export function findTokenInRange(
    tokens: IRslToken[],
    start: number,
    end: number,
    predicate: (token: IRslToken) => boolean
): IRslToken | undefined {
    for (
        let index = lowerBoundTokenStart(tokens, start);
        index < tokens.length && tokens[index].start < end;
        index++
    ) {
        if (predicate(tokens[index])) {
            return tokens[index];
        }
    }

    return undefined;
}

export function lowerBoundTokenStart(tokens: IRslToken[], start: number): number {
    let low = 0;
    let high = tokens.length;

    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);

        if (tokens[middle].start < start) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    return low;
}

export function isReservedIdentifier(value: string): boolean {
    const normalized = normalizeIdentifier(value);

    if (!normalized) {
        return true;
    }

    return isRslKeyword(normalized) ||
        isRslType(normalized) ||
        isRslSystemConstant(normalized);
}

export function findSignatureRange(
    tokens: IRslToken[],
    scope: RslSymbol
): { start: number; end: number } | undefined {
    let start = -1;
    let depth = 0;
    const firstIndex = lowerBoundByStart(tokens, scope.range.start);

    for (let index = firstIndex; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.start > scope.range.end) {
            break;
        }

        if (token.kind !== "symbol") {
            continue;
        }

        if (token.raw === "(") {
            if (start < 0) {
                start = token.start;
            }

            depth++;
            continue;
        }

        if (token.raw === ")" && start >= 0 && depth > 0) {
            depth--;

            if (depth === 0) {
                return {
                    start,
                    end: token.end
                };
            }
        }
    }

    return undefined;
}

export function walkScopes(root: RslSymbol, action: (scope: RslSymbol) => void): void {
    action(root);

    root.children.forEach(child => {
        if (child.isContainer) {
            walkScopes(child, action);
        }
    });
}

export function collectAllObjectRanges(
    root: RslSymbol
): Array<{ start: number; end: number }> {
    const result: Array<{ start: number; end: number }> = [];

    walkScopes(root, scope => {
        scope.children.forEach(child => {
            result.push(child.range);
        });
    });

    return result;
}

export function collectMemberNameStarts(tokens: IRslToken[]): Set<number> {
    const result = new Set<number>();

    for (let index = 1; index < tokens.length; index++) {
        const previous = tokens[index - 1];
        const token = tokens[index];

        if (
            token.kind === "identifier" &&
            previous.kind === "symbol" &&
            previous.raw === "."
        ) {
            result.add(token.start);
        }
    }

    return result;
}

export function lowerBoundByStart(tokens: IRslToken[], offset: number): number {
    let left = 0;
    let right = tokens.length;

    while (left < right) {
        const middle = Math.floor((left + right) / 2);

        if (tokens[middle].start < offset) {
            left = middle + 1;
        } else {
            right = middle;
        }
    }

    return left;
}

export function offsetRangeKey(start: number, end: number): string {
    return `${start}:${end}`;
}

// "--" — комментарий только внутри SQL-блока (обычное соглашение SQL).
// У самого RSL комментарии — только двойной слэш и парный блочный, поэтому
// в output-form блоке "--" — это просто декоративная рамка шаблона
// (например, "----------------]"), а не начало комментария, и не должна
// прятать от сканера настоящий закрывающий "]" после неё.
export function isClosedSquareBlock(
    raw: string,
    squareKind?: RslSquareKind
): boolean {
    const dashStartsComment = squareKind === "sql";
    let depth = 0;
    let quote = "";

    for (let index = 0; index < raw.length; index++) {
        const char = raw.charAt(index);
        const next = raw.charAt(index + 1);

        if (quote) {
            if (char === quote) {
                if (next === quote) {
                    index++;
                } else {
                    quote = "";
                }
            }
            continue;
        }

        if (char === "'" || char === "\"") {
            quote = char;
            continue;
        }

        if (
            (dashStartsComment && char === "-" && next === "-") ||
            (char === "/" && next === "/")
        ) {
            while (
                index < raw.length &&
                raw.charAt(index) !== "\r" &&
                raw.charAt(index) !== "\n"
            ) {
                index++;
            }
            continue;
        }

        if (char === "/" && next === "*") {
            index += 2;
            while (
                index < raw.length - 1 &&
                !(raw.charAt(index) === "*" && raw.charAt(index + 1) === "/")
            ) {
                index++;
            }
            index++;
            continue;
        }

        if (char === "[") {
            depth++;
        } else if (char === "]") {
            depth--;
            if (depth === 0) {
                return true;
            }
        }
    }

    return false;
}

export function normalizeModuleReference(value: string): string {
    return (value || "")
        .trim()
        .replace(/\\/g, "/")
        .toLowerCase();
}

export function formatModuleName(uri: string): string {
    try {
        return path.basename(fileURLToPath(uri));
    } catch (_error) {
        return path.posix.basename(uri.replace(/\\/g, "/"));
    }
}

export function isClosedString(raw: string): boolean {
    if (raw.length < 2) {
        return false;
    }

    const quote = raw.charAt(0);

    if (raw.charAt(raw.length - 1) !== quote) {
        return false;
    }

    let backslashes = 0;

    for (
        let index = raw.length - 2;
        index >= 0 && raw.charAt(index) === "\\";
        index--
    ) {
        backslashes++;
    }

    return backslashes % 2 === 0;
}

export function findObjectNameRange(
    module: IIndexedModule,
    symbol: RslSymbol
): { start: number; end: number } {
    const normalized = normalizeIdentifier(symbol.name);
    const tokens = module.syntax.tokens;
    const firstIndex = lowerBoundByStart(tokens, symbol.range.start);

    for (let index = firstIndex; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.start > symbol.range.end) {
            break;
        }

        if (
            token.kind === "identifier" &&
            normalizeIdentifier(token.value) === normalized
        ) {
            return { start: token.start, end: token.end };
        }
    }

    return symbol.range;
}

export function createImportDiagnostic(
    module: IIndexedModule,
    reference: IImportDefinitionTarget,
    severity: DiagnosticSeverity,
    message: string,
    code: string,
    unnecessary: boolean = false,
    data?: IDiagnosticData
): Diagnostic {
    return createOffsetDiagnostic(
        module,
        reference.start,
        reference.end,
        severity,
        message,
        code,
        unnecessary,
        data
    );
}

export function createTokenDiagnostic(
    token: IRslToken,
    severity: DiagnosticSeverity,
    message: string,
    code: string,
    unnecessary: boolean = false,
    data?: IDiagnosticData
): Diagnostic {
    const diagnostic: Diagnostic = {
        severity,
        range: {
            start: {
                line: token.line,
                character: token.character
            },
            end: {
                line: token.endLine,
                character: token.endCharacter
            }
        },
        message,
        source: "RSL parser",
        code,
        data
    };

    if (unnecessary) {
        diagnostic.tags = [DiagnosticTag.Unnecessary];
    }

    return diagnostic;
}

export function createOffsetDiagnostic(
    module: IIndexedModule,
    start: number,
    end: number,
    severity: DiagnosticSeverity,
    message: string,
    code: string,
    unnecessary: boolean = false,
    data?: IDiagnosticData
): Diagnostic {
    const diagnostic: Diagnostic = {
        severity,
        range: {
            start: positionAt(module, start),
            end: positionAt(module, Math.max(start + 1, end))
        },
        message,
        source: "RSL parser",
        code,
        data
    };

    if (unnecessary) {
        diagnostic.tags = [DiagnosticTag.Unnecessary];
    }

    return diagnostic;
}

export function positionAt(
    module: IIndexedModule,
    offset: number
): { line: number; character: number } {
    const starts = module.lex.lineStarts;
    let left = 0;
    let right = starts.length - 1;
    let line = 0;

    while (left <= right) {
        const middle = Math.floor((left + right) / 2);

        if (starts[middle] <= offset) {
            line = middle;
            left = middle + 1;
        } else {
            right = middle - 1;
        }
    }

    return {
        line,
        character: Math.max(0, offset - starts[line])
    };
}

export function deduplicateDiagnostics(items: Diagnostic[]): Diagnostic[] {
    const result: Diagnostic[] = [];
    const seen = new Set<string>();

    for (const item of items) {
        const key = [
            item.code,
            item.range.start.line,
            item.range.start.character,
            item.range.end.line,
            item.range.end.character
        ].join(":");

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(item);
    }

    return result;
}

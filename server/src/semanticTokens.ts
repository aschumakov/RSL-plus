import {
    CompletionItemKind,
    SemanticTokens,
    SemanticTokensLegend
} from "vscode-languageserver";

import { RslSymbol } from "./symbols/rslSymbol";
import {
    IRslToken,
    normalizeIdentifier
} from "./lexer";
import { RslScopeResolver } from "./scopeResolver";
import { collectFormatSpecifierTokenStarts } from "./parsing/outputFormParser";
import { IIndexedModule, WorkspaceIndex } from "./workspaceIndex";

const TOKEN_TYPES = [
    "class",
    "method",
    "function",
    "variable",
    "parameter",
    "property",
    "string",
    "regexp",
    "keyword"
];

const TOKEN_MODIFIERS = [
    "declaration",
    "readonly",
    "deprecated"
];

const NON_SYMBOL_IDENTIFIERS = new Set([
    "and", "array", "break", "btr", "class", "const", "continue",
    "dbf", "dialog", "elif", "else", "end", "false", "file", "for",
    "if", "import", "key", "local", "macro", "mem", "not", "null",
    "onerror", "or", "private", "record", "return", "sort", "this",
    "true", "txt", "var", "while", "with", "write", "append"
]);

export const RSL_SEMANTIC_TOKENS_LEGEND: SemanticTokensLegend = {
    tokenTypes: TOKEN_TYPES,
    tokenModifiers: TOKEN_MODIFIERS
};

export interface IRslSemanticTokenRange {
    startLine: number;
    startCharacter?: number;
    endLine: number;
    endCharacter?: number;
}

interface ISemanticEntry {
    token: IRslToken;
    type: number;
    modifiers: number;
    length?: number;
}

interface IObjectInfo {
    symbol: RslSymbol;
    scope: RslSymbol;
    parameter: boolean;
}

/**
 * Семантическая подсветка объявлений и разрешённых ссылок.
 * TextMate остаётся базовым быстрым слоем, semantic tokens уточняют смысл
 * идентификаторов после завершения разбора.
 */
export function buildRslSemanticTokens(
    module: IIndexedModule,
    index: WorkspaceIndex,
    sharedResolver?: RslScopeResolver,
    range?: IRslSemanticTokenRange
): SemanticTokens {
    const resolver = sharedResolver || new RslScopeResolver(index);
    const tokens = module.syntax.tokens;
    const objects = collectObjects(module, tokens);
    const objectInfoByObject = new Map<RslSymbol, IObjectInfo>();
    const declarationByRange = new Map<string, IObjectInfo>();

    objects.forEach(info => {
        objectInfoByObject.set(info.symbol, info);
        const token = findDeclarationToken(tokens, info.symbol);

        if (token) {
            declarationByRange.set(
                rangeKey(token.start, token.end),
                info
            );
        }
    });

    const entries: ISemanticEntry[] = [];
    const formatSpecifierStarts = collectFormatSpecifierTokenStarts(
        module.lex.tokens
    );
    appendOutputFormEntries(module.lex.tokens, entries, range);
    const firstTokenIndex = range
        ? lowerBoundByLine(tokens, Math.max(0, range.startLine))
        : 0;

    for (let tokenIndex = firstTokenIndex; tokenIndex < tokens.length; tokenIndex++) {
        const token = tokens[tokenIndex];

        if (range && isTokenAfterRange(token, range)) {
            break;
        }
        if (range && isTokenBeforeRange(token, range)) {
            continue;
        }
        if (token.kind !== "identifier") {
            continue;
        }

        if (formatSpecifierStarts.has(token.start)) {
            entries.push({
                token,
                type: TOKEN_TYPES.indexOf("keyword"),
                modifiers: 0
            });
            continue;
        }

        if (NON_SYMBOL_IDENTIFIERS.has(normalizeIdentifier(token.value))) {
            continue;
        }

        const declaration = declarationByRange.get(
            rangeKey(token.start, token.end)
        );

        if (declaration) {
            const encoded = encodeObject(declaration.symbol, declaration.parameter);

            if (encoded) {
                entries.push({
                    token,
                    type: encoded.type,
                    modifiers: encoded.modifiers | modifierBit("declaration")
                });
            }
            continue;
        }

        const resolved = resolver.resolveAt(
            module.uri,
            module.symbolTree,
            token.start
        );

        if (!resolved) {
            continue;
        }

        const resolvedInfo = objectInfoByObject.get(resolved.symbol);
        const encoded = encodeObject(
            resolved.symbol,
            !!resolvedInfo?.parameter
        );

        if (!encoded) {
            continue;
        }

        entries.push({
            token,
            type: encoded.type,
            modifiers: encoded.modifiers
        });
    }

    entries.sort((left, right) =>
        left.token.line - right.token.line ||
        left.token.character - right.token.character ||
        (left.length || 0) - (right.length || 0)
    );

    return {
        data: encodeDelta(entries)
    };
}


function appendOutputFormEntries(
    tokens: readonly IRslToken[],
    entries: ISemanticEntry[],
    range?: IRslSemanticTokenRange
): void {
    for (const token of tokens) {
        if (token.kind !== "square" || token.squareKind !== "output") {
            continue;
        }

        const lines = token.raw.split(/\r\n|\n|\r/);
        let absoluteOffset = token.start;

        lines.forEach((rawLine, lineIndex) => {
            const lineNumber = token.line + lineIndex;
            let contentStart = lineIndex === 0 && rawLine.startsWith("[") ? 1 : 0;
            let contentEnd = rawLine.length;
            if (lineIndex === lines.length - 1 && rawLine.endsWith("]")) {
                contentEnd--;
            }

            const content = rawLine.substring(contentStart, contentEnd);
            const baseCharacter = lineIndex === 0
                ? token.character + contentStart
                : contentStart;
            let cursor = 0;
            const placeholders = [...content.matchAll(/#+/g)];

            const appendSegment = (
                start: number,
                end: number,
                typeName: "string" | "regexp"
            ): void => {
                if (end <= start) {
                    return;
                }

                const virtual = createVirtualToken(
                    token,
                    absoluteOffset + contentStart + start,
                    lineNumber,
                    baseCharacter + start,
                    end - start
                );
                if (range && (
                    isTokenBeforeRange(virtual, range) ||
                    isTokenAfterRange(virtual, range)
                )) {
                    return;
                }

                entries.push({
                    token: virtual,
                    type: TOKEN_TYPES.indexOf(typeName),
                    modifiers: 0,
                    length: end - start
                });
            };

            for (const placeholder of placeholders) {
                const start = placeholder.index || 0;
                appendSegment(cursor, start, "string");
                appendSegment(start, start + placeholder[0].length, "regexp");
                cursor = start + placeholder[0].length;
            }
            appendSegment(cursor, content.length, "string");

            absoluteOffset += rawLine.length;
            if (lineIndex < lines.length - 1) {
                const remaining = token.raw.substring(absoluteOffset - token.start);
                absoluteOffset += remaining.startsWith("\r\n") ? 2 : 1;
            }
        });
    }
}

function createVirtualToken(
    source: IRslToken,
    start: number,
    line: number,
    character: number,
    length: number
): IRslToken {
    return {
        kind: "square",
        raw: "",
        value: "",
        start,
        end: start + length,
        line,
        character,
        endLine: line,
        endCharacter: character + length,
        squareKind: source.squareKind
    };
}

function collectObjects(
    module: IIndexedModule,
    code: IRslToken[]
): IObjectInfo[] {
    const result: IObjectInfo[] = [];

    walk(module.symbolTree, scope => {
        const signature = isCallable(scope)
            ? findSignatureRange(code, scope)
            : undefined;

        scope.children.forEach(child => {
            result.push({
                symbol: child,
                scope,
                parameter:
                    !!signature &&
                    signature.start < child.range.start &&
                    child.range.end <= signature.end &&
                    (
                        child.kind === CompletionItemKind.Variable ||
                        child.kind === CompletionItemKind.Constant
                    )
            });
        });
    });

    return result;
}

function encodeObject(
    symbol: RslSymbol,
    parameter: boolean
): { type: number; modifiers: number } | undefined {
    let typeName: string;

    if (parameter) {
        typeName = "parameter";
    } else {
        switch (symbol.kind) {
            case CompletionItemKind.Class:
                typeName = "class";
                break;
            case CompletionItemKind.Method:
                typeName = "method";
                break;
            case CompletionItemKind.Function:
                typeName = "function";
                break;
            case CompletionItemKind.Property:
            case CompletionItemKind.Field:
                typeName = "property";
                break;
            case CompletionItemKind.Variable:
            case CompletionItemKind.Constant:
                typeName = "variable";
                break;
            default:
                return undefined;
        }
    }

    let modifiers = 0;

    if (symbol.kind === CompletionItemKind.Constant) {
        modifiers |= modifierBit("readonly");
    }

    return {
        type: TOKEN_TYPES.indexOf(typeName),
        modifiers
    };
}

function encodeDelta(entries: ISemanticEntry[]): number[] {
    const data: number[] = [];
    let previousLine = 0;
    let previousCharacter = 0;

    for (const entry of entries) {
        const line = entry.token.line;
        const character = entry.token.character;
        const deltaLine = line - previousLine;
        const deltaCharacter = deltaLine === 0
            ? character - previousCharacter
            : character;
        const length = Math.max(1, entry.length ?? (entry.token.end - entry.token.start));

        data.push(
            deltaLine,
            deltaCharacter,
            length,
            entry.type,
            entry.modifiers
        );

        previousLine = line;
        previousCharacter = character;
    }

    return data;
}

function modifierBit(name: string): number {
    const index = TOKEN_MODIFIERS.indexOf(name);
    return index < 0 ? 0 : (1 << index);
}

function walk(root: RslSymbol, action: (scope: RslSymbol) => void): void {
    action(root);

    root.children.forEach(child => {
        if (child.isContainer) {
            walk(child, action);
        }
    });
}

function isCallable(scope: RslSymbol): boolean {
    return scope.kind === CompletionItemKind.Function ||
        scope.kind === CompletionItemKind.Method;
}

function findSignatureRange(
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


function findDeclarationToken(
    tokens: IRslToken[],
    symbol: RslSymbol
): IRslToken | undefined {
    const name = normalizeIdentifier(symbol.name);
    const firstIndex = lowerBoundByStart(tokens, symbol.range.start);

    for (let index = firstIndex; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.start > symbol.range.end) {
            break;
        }

        if (
            token.kind === "identifier" &&
            normalizeIdentifier(token.value) === name
        ) {
            return token;
        }
    }

    return undefined;
}

function lowerBoundByStart(tokens: IRslToken[], offset: number): number {
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


function isTokenBeforeRange(
    token: IRslToken,
    range: IRslSemanticTokenRange
): boolean {
    return token.line < range.startLine ||
        (
            token.line === range.startLine &&
            token.endCharacter <= (range.startCharacter ?? 0)
        );
}

function isTokenAfterRange(
    token: IRslToken,
    range: IRslSemanticTokenRange
): boolean {
    return token.line > range.endLine ||
        (
            token.line === range.endLine &&
            token.character >= (range.endCharacter ?? Number.MAX_SAFE_INTEGER)
        );
}

function lowerBoundByLine(tokens: IRslToken[], line: number): number {
    let left = 0;
    let right = tokens.length;

    while (left < right) {
        const middle = Math.floor((left + right) / 2);
        if (tokens[middle].line < line) {
            left = middle + 1;
        } else {
            right = middle;
        }
    }

    return left;
}

function rangeKey(start: number, end: number): string {
    return `${start}:${end}`;
}

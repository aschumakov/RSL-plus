import {
    DocumentSymbol,
    SymbolKind
} from "vscode-languageserver";
import type { TextDocument } from "vscode-languageserver-textdocument";

import {
    GetFoldingRanges,
    type IRslFoldingRange
} from "../folding";
import { readClassDeclarationHeader } from "../parsing/classDeclarationHeader";
import {
    type IRslLexResult,
    type IRslToken,
    lexRsl,
    normalizeIdentifier
} from "../lexer";

/**
 * Лёгкий versioned snapshot открытого документа.
 *
 * На горячем пути всегда строится только lexer. Folding и Outline вычисляются
 * лениво при первом соответствующем LSP-запросе и затем кэшируются на версию.
 */
export interface IFastDocumentSnapshot {
    uri: string;
    version: number;
    lex: IRslLexResult;
    foldingRanges?: IRslFoldingRange[];
    symbols?: DocumentSymbol[];
}

interface IOpenScope {
    keyword: string;
    symbol?: DocumentSymbol;
}

const BLOCK_START = new Set([
    "macro",
    "class",
    "if",
    "for",
    "while",
    "with"
]);

const DECLARATION_MODIFIERS = new Set([
    "private",
    "local",
    "public"
]);

const STATEMENT_START = new Set([
    "import",
    "var",
    "const",
    "array",
    "file",
    "record",
    "macro",
    "class",
    "if",
    "for",
    "while",
    "with",
    "onerror",
    "return",
    "break",
    "continue",
    "local",
    "private",
    "public"
]);

/** Один lexer-проход; presentation-факты создаются только по запросу. */
export function createFastDocumentSnapshot(
    document: TextDocument
): IFastDocumentSnapshot {
    return {
        uri: document.uri,
        version: document.version,
        lex: lexRsl(document.getText())
    };
}

/** Folding строится лениво и не запускает полный parser. */
export function getFastFoldingRanges(
    document: TextDocument,
    snapshot: IFastDocumentSnapshot
): IRslFoldingRange[] {
    if (!snapshot.foldingRanges) {
        snapshot.foldingRanges = GetFoldingRanges(
            document.getText(),
            snapshot.lex
        );
    }

    return snapshot.foldingRanges;
}

/**
 * Возвращает иерархический Outline без полного CBase.
 * DocumentSymbol.children сохраняет Class → properties/methods и вложенные Macro.
 */
export function getFastDocumentSymbols(
    document: TextDocument,
    snapshot: IFastDocumentSnapshot
): DocumentSymbol[] {
    if (!snapshot.symbols) {
        snapshot.symbols = collectFastDocumentSymbols(
            document,
            snapshot.lex.tokens
        );
    }

    return snapshot.symbols;
}

function collectFastDocumentSymbols(
    document: TextDocument,
    tokens: readonly IRslToken[]
): DocumentSymbol[] {
    const scopes: IOpenScope[] = [];
    const result: DocumentSymbol[] = [];
    let statementStart = true;
    let delimiterDepth = 0;

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (isTrivia(token)) {
            if (token.kind === "newline" && delimiterDepth === 0) {
                statementStart = true;
            }
            continue;
        }

        if (token.kind === "string" || token.kind === "square") {
            statementStart = false;
            continue;
        }

        if (token.kind === "symbol") {
            if (isOpenDelimiter(token.raw)) {
                delimiterDepth++;
            } else if (isCloseDelimiter(token.raw)) {
                delimiterDepth = Math.max(0, delimiterDepth - 1);
            }

            if (token.raw === ";" && delimiterDepth === 0) {
                statementStart = true;
                continue;
            }
        }

        if (token.kind !== "identifier") {
            if (token.kind !== "symbol" || token.raw !== ":") {
                statementStart = false;
            }
            continue;
        }

        const word = normalizeIdentifier(token.value);

        if (word === "end") {
            closeScope(scopes, token);
            statementStart = true;
            continue;
        }

        if (!statementStart) {
            continue;
        }

        if (DECLARATION_MODIFIERS.has(word)) {
            continue;
        }

        statementStart = false;

        if (word === "macro" || word === "class") {
            const classHeader = word === "class"
                ? readClassDeclarationHeader(tokens, index + 1)
                : undefined;
            const nameIndex = word === "class"
                ? classHeader?.nameIndex ?? -1
                : findNextDeclarationNameIndex(tokens, index + 1);
            const nameToken = nameIndex >= 0 ? tokens[nameIndex] : undefined;
            const symbol = nameToken
                ? createScopeSymbol(
                    token,
                    nameToken,
                    word === "class" ? SymbolKind.Class : SymbolKind.Function
                )
                : undefined;

            if (symbol) {
                appendSymbol(result, scopes, symbol);
            }

            scopes.push({ keyword: word, symbol });
            if (nameIndex >= 0) {
                index = nameIndex;
            }
            continue;
        }

        if (BLOCK_START.has(word)) {
            scopes.push({ keyword: word });
            continue;
        }

        if (
            word === "var" ||
            word === "const" ||
            word === "array" ||
            word === "file" ||
            word === "record"
        ) {
            const target = dataSymbolTarget(result, scopes);
            if (!target) {
                continue;
            }

            const kind = word === "const"
                ? SymbolKind.Constant
                : word === "record"
                    ? SymbolKind.Struct
                    : word === "file"
                        ? SymbolKind.Object
                        : SymbolKind.Variable;
            index = collectDataSymbols(
                tokens,
                index + 1,
                token.line,
                kind,
                target,
                index
            );
        }
    }

    const documentEnd = document.positionAt(document.getText().length);
    for (const scope of scopes) {
        if (scope.symbol) {
            scope.symbol.range.end = documentEnd;
        }
    }

    return result;
}

function createScopeSymbol(
    keywordToken: IRslToken,
    nameToken: IRslToken,
    kind: SymbolKind
): DocumentSymbol {
    return {
        name: nameToken.value,
        kind,
        range: {
            start: tokenStart(keywordToken),
            end: tokenEnd(nameToken)
        },
        selectionRange: tokenRange(nameToken),
        children: []
    };
}

function appendSymbol(
    roots: DocumentSymbol[],
    scopes: readonly IOpenScope[],
    symbol: DocumentSymbol
): void {
    for (let index = scopes.length - 1; index >= 0; index--) {
        const parent = scopes[index].symbol;
        if (parent) {
            (parent.children || (parent.children = [])).push(symbol);
            return;
        }
    }

    roots.push(symbol);
}

function dataSymbolTarget(
    roots: DocumentSymbol[],
    scopes: readonly IOpenScope[]
): DocumentSymbol[] | undefined {
    for (let index = scopes.length - 1; index >= 0; index--) {
        const scope = scopes[index];
        if (scope.keyword === "macro") {
            return undefined;
        }
        if (scope.keyword === "class" && scope.symbol) {
            return scope.symbol.children || (scope.symbol.children = []);
        }
    }

    return roots;
}

function collectDataSymbols(
    tokens: readonly IRslToken[],
    start: number,
    startLine: number,
    kind: SymbolKind,
    target: DocumentSymbol[],
    fallbackIndex: number
): number {
    let expectName = true;
    let delimiterDepth = 0;
    let inInitializer = false;
    let current: DocumentSymbol | undefined;
    let typeParts: string[] | undefined;
    let lastIndex = fallbackIndex;

    for (let index = start; index < tokens.length; index++) {
        const token = tokens[index];
        lastIndex = index;

        if (token.kind === "symbol") {
            if (isOpenDelimiter(token.raw)) {
                delimiterDepth++;
            } else if (isCloseDelimiter(token.raw)) {
                delimiterDepth = Math.max(0, delimiterDepth - 1);
            }

            if (delimiterDepth === 0 && token.raw === ";") {
                applyTypeDetail(current, typeParts);
                return index;
            }

            if (delimiterDepth === 0 && token.raw === ",") {
                applyTypeDetail(current, typeParts);
                expectName = true;
                inInitializer = false;
                current = undefined;
                typeParts = undefined;
                continue;
            }

            if (delimiterDepth === 0 && token.raw === "=") {
                applyTypeDetail(current, typeParts);
                inInitializer = true;
                typeParts = undefined;
                continue;
            }

            if (delimiterDepth === 0 && token.raw === ":" && current) {
                typeParts = [];
                continue;
            }
        }

        const word = token.kind === "identifier"
            ? normalizeIdentifier(token.value)
            : "";

        if (
            delimiterDepth === 0 &&
            token.line > startLine &&
            token.kind === "identifier" &&
            STATEMENT_START.has(word)
        ) {
            applyTypeDetail(current, typeParts);
            return Math.max(fallbackIndex, index - 1);
        }

        if (
            expectName &&
            !inInitializer &&
            delimiterDepth === 0 &&
            token.kind === "identifier"
        ) {
            current = {
                name: token.value,
                kind,
                range: tokenRange(token),
                selectionRange: tokenRange(token)
            };
            target.push(current);
            expectName = false;
            continue;
        }

        if (
            typeParts &&
            !inInitializer &&
            delimiterDepth === 0 &&
            !isTrivia(token)
        ) {
            typeParts.push(token.raw);
        }
    }

    applyTypeDetail(current, typeParts);
    return lastIndex;
}

function applyTypeDetail(
    symbol: DocumentSymbol | undefined,
    parts: string[] | undefined
): void {
    if (!symbol || !parts) {
        return;
    }

    const detail = parts.join("").trim();
    if (detail) {
        symbol.detail = detail;
    }
}

function closeScope(scopes: IOpenScope[], endToken: IRslToken): void {
    const scope = scopes.pop();
    if (scope?.symbol) {
        scope.symbol.range.end = tokenEnd(endToken);
    }
}

function findNextDeclarationNameIndex(
    tokens: readonly IRslToken[],
    start: number
): number {
    for (let index = skipTrivia(tokens, start); index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind === "identifier") {
            return index;
        }
        if (token.kind === "symbol" && token.raw === ";") {
            return -1;
        }
    }

    return -1;
}

function skipTrivia(tokens: readonly IRslToken[], start: number): number {
    let index = start;
    while (index < tokens.length && isTrivia(tokens[index])) {
        index++;
    }
    return index;
}

function isTrivia(token: IRslToken): boolean {
    return token.kind === "whitespace" ||
        token.kind === "newline" ||
        token.kind === "comment" ||
        token.kind === "bom";
}

function isOpenDelimiter(value: string): boolean {
    return value === "(" || value === "[" || value === "{";
}

function isCloseDelimiter(value: string): boolean {
    return value === ")" || value === "]" || value === "}";
}

function tokenStart(token: IRslToken): { line: number; character: number } {
    return {
        line: token.line,
        character: token.character
    };
}

function tokenEnd(token: IRslToken): { line: number; character: number } {
    return {
        line: token.endLine,
        character: token.endCharacter
    };
}

function tokenRange(token: IRslToken): {
    start: { line: number; character: number };
    end: { line: number; character: number };
} {
    return {
        start: tokenStart(token),
        end: tokenEnd(token)
    };
}

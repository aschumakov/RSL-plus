import {
    SymbolInformation,
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

export interface IFastDocumentSnapshot {
    uri: string;
    version: number;
    sourceLength: number;
    lex: IRslLexResult;
    imports: string[];
    foldingRanges: IRslFoldingRange[];
    symbols: SymbolInformation[];
    identifiersByName: ReadonlyMap<string, readonly IRslToken[]>;
}

interface IOpenScope {
    keyword: string;
    name?: string;
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
    "continue"
]);

/**
 * Лёгкий versioned snapshot для первого экрана редактора.
 *
 * Он выполняет один lexer-проход и сразу даёт Folding, Outline, Import и
 * индекс идентификаторов. Полный parser позже переиспользует тот же lex.
 */
export function createFastDocumentSnapshot(
    document: TextDocument
): IFastDocumentSnapshot {
    const source = document.getText();
    const lex = lexRsl(source);

    return {
        uri: document.uri,
        version: document.version,
        sourceLength: source.length,
        lex,
        imports: collectFastImports(lex.tokens),
        foldingRanges: GetFoldingRanges(source, lex),
        symbols: collectFastSymbols(document.uri, lex.tokens),
        identifiersByName: collectIdentifiersByName(lex.tokens)
    };
}

function collectIdentifiersByName(
    tokens: readonly IRslToken[]
): ReadonlyMap<string, readonly IRslToken[]> {
    const result = new Map<string, IRslToken[]>();

    for (const token of tokens) {
        if (token.kind !== "identifier") {
            continue;
        }

        const name = normalizeIdentifier(token.value);
        const items = result.get(name) || [];
        items.push(token);
        result.set(name, items);
    }

    return result;
}

function collectFastImports(tokens: readonly IRslToken[]): string[] {
    const code = Array.from(tokens);
    const result: string[] = [];
    let statementStart = true;

    for (let index = 0; index < code.length; index++) {
        const token = code[index];
        const word = token.kind === "identifier"
            ? normalizeIdentifier(token.value)
            : "";

        if (
            token.kind === "whitespace" ||
            token.kind === "comment" ||
            token.kind === "bom"
        ) {
            continue;
        }

        if (token.kind === "newline") {
            statementStart = true;
            continue;
        }

        if (token.kind === "symbol" && token.raw === ";") {
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

        if (word !== "import") {
            continue;
        }

        const items: IRslToken[][] = [[]];
        let depth = 0;

        for (index = index + 1; index < code.length; index++) {
            const current = code[index];
            const currentWord = current.kind === "identifier"
                ? normalizeIdentifier(current.value)
                : "";

            if (current.kind === "symbol") {
                if (current.raw === "(" || current.raw === "[") {
                    depth++;
                } else if (current.raw === ")" || current.raw === "]") {
                    depth = Math.max(0, depth - 1);
                }

                if (depth === 0 && current.raw === ",") {
                    items.push([]);
                    continue;
                }

                if (depth === 0 && current.raw === ";") {
                    statementStart = true;
                    break;
                }
            }

            if (
                depth === 0 &&
                current.line > token.line &&
                current.kind === "identifier" &&
                STATEMENT_START.has(currentWord)
            ) {
                index--;
                statementStart = true;
                break;
            }

            items[items.length - 1].push(current);
        }

        for (const item of items) {
            const name = normalizeImportItem(item);
            if (name && !result.includes(name)) {
                result.push(name);
            }
        }
    }

    return result;
}

function normalizeImportItem(tokens: readonly IRslToken[]): string {
    if (tokens.length === 0) {
        return "";
    }

    if (tokens.length === 1 && tokens[0].kind === "string") {
        return tokens[0].value.trim();
    }

    return tokens
        .filter(token =>
            token.kind !== "whitespace" &&
            token.kind !== "newline" &&
            token.kind !== "comment" &&
            token.kind !== "bom"
        )
        .map(token => token.raw)
        .join("")
        .trim();
}

function collectFastSymbols(
    uri: string,
    tokens: readonly IRslToken[]
): SymbolInformation[] {
    const code = Array.from(tokens);
    const scopes: IOpenScope[] = [];
    const result: SymbolInformation[] = [];
    let statementStart = true;
    let delimiterDepth = 0;

    for (let index = 0; index < code.length; index++) {
        const token = code[index];

        if (
            token.kind === "whitespace" ||
            token.kind === "comment" ||
            token.kind === "bom"
        ) {
            continue;
        }

        if (token.kind === "newline") {
            if (delimiterDepth === 0) {
                statementStart = true;
            }
            continue;
        }

        if (token.kind === "string" || token.kind === "square") {
            statementStart = false;
            continue;
        }

        if (token.kind === "symbol") {
            if (token.raw === "(" || token.raw === "[" || token.raw === "{") {
                delimiterDepth++;
            } else if (
                token.raw === ")" ||
                token.raw === "]" ||
                token.raw === "}"
            ) {
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
            if (scopes.length > 0) {
                scopes.pop();
            }
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
                ? readClassDeclarationHeader(code, index + 1)
                : undefined;
            const nameIndex = word === "class"
                ? classHeader?.nameIndex ?? -1
                : findNextDeclarationNameIndex(code, index + 1);
            const nameToken = nameIndex >= 0 ? code[nameIndex] : undefined;

            if (nameToken) {
                const containerName = currentNamedScope(scopes);
                result.push(symbolInfo(
                    uri,
                    nameToken,
                    word === "class" ? SymbolKind.Class : SymbolKind.Function,
                    containerName
                ));
                scopes.push({ keyword: word, name: nameToken.value });
            } else {
                scopes.push({ keyword: word });
            }
            continue;
        }

        if (BLOCK_START.has(word)) {
            scopes.push({ keyword: word });
            continue;
        }

        if (word === "file" || word === "record") {
            if (shouldShowDataDeclaration(scopes)) {
                const nameToken = nextIdentifier(code, index + 1);
                if (nameToken) {
                    result.push(symbolInfo(
                        uri,
                        nameToken,
                        word === "record" ? SymbolKind.Struct : SymbolKind.Object,
                        currentNamedScope(scopes)
                    ));
                }
            }
            continue;
        }

        if (word === "var" || word === "const" || word === "array") {
            if (shouldShowDataDeclaration(scopes)) {
                collectVariableSymbols(
                    uri,
                    code,
                    index + 1,
                    word === "const" ? SymbolKind.Constant : SymbolKind.Variable,
                    currentNamedScope(scopes),
                    result
                );
            }
        }
    }

    return result;
}

function collectVariableSymbols(
    uri: string,
    tokens: readonly IRslToken[],
    start: number,
    kind: SymbolKind,
    containerName: string | undefined,
    result: SymbolInformation[]
): void {
    let expectName = true;
    let depth = 0;
    let inInitializer = false;

    for (let index = start; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind === "symbol") {
            if (token.raw === "(" || token.raw === "[") {
                depth++;
            } else if (token.raw === ")" || token.raw === "]") {
                depth = Math.max(0, depth - 1);
            }

            if (depth === 0 && token.raw === ";") {
                return;
            }

            if (depth === 0 && token.raw === ",") {
                expectName = true;
                inInitializer = false;
            } else if (depth === 0 && token.raw === "=") {
                inInitializer = true;
            }
            continue;
        }

        if (token.kind !== "identifier") {
            continue;
        }

        if (expectName && !inInitializer) {
            result.push(symbolInfo(uri, token, kind, containerName));
            expectName = false;
        }
    }
}

function shouldShowDataDeclaration(scopes: readonly IOpenScope[]): boolean {
    const named = scopes.filter(scope => !!scope.name);
    return named.length === 0 || named[named.length - 1].keyword === "class";
}

function currentNamedScope(scopes: readonly IOpenScope[]): string | undefined {
    for (let index = scopes.length - 1; index >= 0; index--) {
        if (scopes[index].name) {
            return scopes[index].name;
        }
    }
    return undefined;
}

function findNextDeclarationNameIndex(
    tokens: readonly IRslToken[],
    start: number
): number {
    for (let index = skipTrivia(tokens, start); index < tokens.length; index++) {
        if (tokens[index].kind === "identifier") {
            return index;
        }
        if (tokens[index].kind === "symbol" && tokens[index].raw === ";") {
            return -1;
        }
    }

    return -1;
}


function skipTrivia(
    tokens: readonly IRslToken[],
    start: number
): number {
    let index = start;
    while (
        index < tokens.length &&
        (
            tokens[index].kind === "whitespace" ||
            tokens[index].kind === "newline" ||
            tokens[index].kind === "comment" ||
            tokens[index].kind === "bom"
        )
    ) {
        index++;
    }
    return index;
}

function nextIdentifier(
    tokens: readonly IRslToken[],
    start: number
): IRslToken | undefined {
    for (let index = start; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind === "identifier") {
            return token;
        }
        if (token.kind === "symbol" && token.raw === ";") {
            return undefined;
        }
    }
    return undefined;
}

function symbolInfo(
    uri: string,
    token: IRslToken,
    kind: SymbolKind,
    containerName?: string
): SymbolInformation {
    return {
        name: token.value,
        kind,
        containerName,
        location: {
            uri,
            range: {
                start: {
                    line: token.line,
                    character: token.character
                },
                end: {
                    line: token.endLine,
                    character: token.endCharacter
                }
            }
        }
    };
}

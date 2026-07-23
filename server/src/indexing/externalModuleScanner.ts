import {
    CBase,
    createExternalSymbolTree,
    type IExternalLocationRange,
    type IExternalSymbolDescriptor
} from "../common";
import { lexRsl, normalizeIdentifier, type IRslToken } from "../lexer";

export interface IExternalModuleScanResult {
    imports: string[];
    symbolTree: CBase;
    definitionRanges: Map<CBase, IExternalLocationRange>;
}

interface IBlockFrame {
    keyword: string;
    descriptor?: IExternalSymbolDescriptor;
}

const BLOCK_START = new Set(["macro", "class", "if", "for", "while", "with"]);
const DECLARATION_KEYWORDS = new Set([
    "macro", "class", "var", "const", "file", "record", "array"
]);
const MODIFIERS = new Set(["private", "local", "public"]);

/**
 * Однопроходный scanner для закрытых импортируемых модулей.
 * Не строит statement/expression AST и сохраняет только Import и внешние символы.
 */
export function scanExternalModule(source: string): IExternalModuleScanResult {
    const text = source || "";
    const lex = lexRsl(text, { includeTrivia: false });
    const tokens = lex.tokens.filter(token =>
        token.kind !== "comment" && token.kind !== "square" && token.kind !== "bom"
    );
    const imports: string[] = [];
    const rootSymbols: IExternalSymbolDescriptor[] = [];
    const blocks: IBlockFrame[] = [];
    let canStartStatement = true;
    let currentLine = -1;

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.line !== currentLine) {
            currentLine = token.line;
            canStartStatement = true;
        }

        if (token.kind === "symbol") {
            if (token.raw === ";") {
                canStartStatement = true;
            } else if (token.raw !== ",") {
                canStartStatement = false;
            }
            continue;
        }

        if (token.kind !== "identifier") {
            canStartStatement = false;
            continue;
        }

        const word = normalizeIdentifier(token.value);

        if (word === "end") {
            const closed = blocks.pop();
            if (closed?.descriptor) {
                closed.descriptor.end = token.end;
                closed.descriptor.endLine = token.endLine;
                closed.descriptor.endCharacter = token.endCharacter;
            }
            canStartStatement = false;
            continue;
        }

        if (!canStartStatement) {
            continue;
        }

        let modifier: string | undefined;
        let keywordToken = token;
        let keyword = word;

        if (MODIFIERS.has(keyword)) {
            modifier = keyword;
            const next = nextIdentifier(tokens, index + 1, token.line);
            if (!next) {
                canStartStatement = false;
                continue;
            }
            keywordToken = next.token;
            keyword = normalizeIdentifier(next.token.value);
            index = next.index;
        }

        if (keyword === "import") {
            const parsed = scanImportNames(tokens, index + 1, keywordToken.line);
            parsed.names.forEach(name => {
                if (name && !imports.some(item => normalizeModuleName(item) === normalizeModuleName(name))) {
                    imports.push(name);
                }
            });
            index = Math.max(index, parsed.lastIndex);
            canStartStatement = false;
            continue;
        }

        if (!DECLARATION_KEYWORDS.has(keyword)) {
            if (BLOCK_START.has(keyword)) {
                blocks.push({ keyword });
            }
            canStartStatement = false;
            continue;
        }

        const insideMacro = blocks.some(frame => frame.keyword === "macro");
        const currentClass = findCurrentClass(blocks);
        const privateModifier = modifier === "private" || modifier === "local";
        const isExternal = !privateModifier;

        if (keyword === "macro" || keyword === "class") {
            const nameInfo = nextIdentifier(tokens, index + 1);
            const visibleContainer = !insideMacro &&
                (currentClass === undefined || currentClass.descriptor !== undefined);
            const descriptor = nameInfo && isExternal && visibleContainer
                ? createCallableDescriptor(
                    text,
                    tokens,
                    keyword,
                    keywordToken,
                    nameInfo.token,
                    nameInfo.index,
                    currentClass !== undefined
                )
                : undefined;

            if (descriptor) {
                addDescriptor(rootSymbols, currentClass?.descriptor, descriptor);
            }

            blocks.push({ keyword, descriptor });
            if (nameInfo) {
                index = nameInfo.index;
            }
            canStartStatement = false;
            continue;
        }

        /* Локальные объявления внутри Macro не попадают во внешний summary. */
        if (
            insideMacro ||
            !isExternal ||
            (currentClass !== undefined && currentClass.descriptor === undefined)
        ) {
            canStartStatement = false;
            continue;
        }

        const parsedVariables = scanVariableNames(tokens, index + 1, keywordToken.line);
        for (const nameToken of parsedVariables.names) {
            const descriptor: IExternalSymbolDescriptor = {
                kind: "variable",
                name: nameToken.value,
                privateFlag: false,
                isProperty: currentClass !== undefined,
                isConstant: keyword === "const",
                start: nameToken.start,
                end: nameToken.end,
                startLine: nameToken.line,
                startCharacter: nameToken.character,
                endLine: nameToken.endLine,
                endCharacter: nameToken.endCharacter,
                children: []
            };
            addDescriptor(rootSymbols, currentClass?.descriptor, descriptor);
        }
        index = Math.max(index, parsedVariables.lastIndex);
        canStartStatement = false;
    }

    const built = createExternalSymbolTree(text.length, rootSymbols);
    return {
        imports,
        symbolTree: built.root,
        definitionRanges: built.definitionRanges
    };
}

function createCallableDescriptor(
    source: string,
    tokens: IRslToken[],
    keyword: string,
    keywordToken: IRslToken,
    nameToken: IRslToken,
    nameIndex: number,
    insideClass: boolean
): IExternalSymbolDescriptor {
    const parameterRange = findParameterRange(tokens, nameIndex);
    return {
        kind: keyword === "class" ? "class" : "macro",
        name: nameToken.value,
        privateFlag: false,
        isMethod: keyword === "macro" && insideClass,
        parameterText: parameterRange
            ? source.substring(parameterRange.start, parameterRange.end)
            : "",
        start: keywordToken.start,
        end: nameToken.end,
        startLine: nameToken.line,
        startCharacter: nameToken.character,
        endLine: nameToken.endLine,
        endCharacter: nameToken.endCharacter,
        children: parameterRange && keyword === "macro"
            ? scanParameters(tokens, parameterRange.startIndex, parameterRange.endIndex)
            : []
    };
}

function scanParameters(
    tokens: IRslToken[],
    startIndex: number,
    endIndex: number
): IExternalSymbolDescriptor[] {
    const result: IExternalSymbolDescriptor[] = [];
    let expectName = true;
    let nestedDepth = 0;

    for (let index = startIndex + 1; index < endIndex; index++) {
        const token = tokens[index];

        if (token.kind === "symbol") {
            if (token.raw === "(" || token.raw === "[" || token.raw === "{") {
                nestedDepth++;
                continue;
            }
            if (token.raw === ")" || token.raw === "]" || token.raw === "}") {
                nestedDepth = Math.max(0, nestedDepth - 1);
                continue;
            }
            if (token.raw === "," && nestedDepth === 0) {
                expectName = true;
                continue;
            }
        }

        if (expectName && nestedDepth === 0 && token.kind === "identifier") {
            result.push({
                kind: "variable",
                name: token.value,
                privateFlag: true,
                isProperty: false,
                isConstant: false,
                start: token.start,
                end: token.end,
                startLine: token.line,
                startCharacter: token.character,
                endLine: token.endLine,
                endCharacter: token.endCharacter,
                children: []
            });
            expectName = false;
        }
    }
    return result;
}

function scanImportNames(
    tokens: IRslToken[],
    startIndex: number,
    startLine: number
): { names: string[]; lastIndex: number } {
    const names: string[] = [];
    let current = "";
    let lastIndex = startIndex - 1;

    const flush = (): void => {
        const value = stripQuotes(current.trim());
        if (value) {
            names.push(value);
        }
        current = "";
    };

    for (let index = startIndex; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind === "symbol" && token.raw === ";") {
            flush();
            lastIndex = index;
            break;
        }
        if (
            token.line > startLine &&
            token.kind === "identifier" &&
            isStatementKeyword(token.value)
        ) {
            flush();
            break;
        }
        if (token.kind === "symbol" && token.raw === ",") {
            flush();
        } else if (
            token.kind === "symbol" &&
            (token.raw === "\\" || token.raw === "/" || token.raw === ".")
        ) {
            current += token.raw;
        } else if (token.kind === "identifier" || token.kind === "string") {
            current += token.kind === "string"
                ? stripQuotes(token.value || token.raw)
                : token.value;
        }
        lastIndex = index;
    }

    flush();
    return { names, lastIndex };
}

function scanVariableNames(
    tokens: IRslToken[],
    startIndex: number,
    startLine: number
): { names: IRslToken[]; lastIndex: number } {
    const names: IRslToken[] = [];
    let lastIndex = startIndex - 1;
    let expectName = true;
    let nestedDepth = 0;

    for (let index = startIndex; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind === "symbol") {
            if (token.raw === "(" || token.raw === "[" || token.raw === "{") {
                nestedDepth++;
            } else if (token.raw === ")" || token.raw === "]" || token.raw === "}") {
                nestedDepth = Math.max(0, nestedDepth - 1);
            } else if (token.raw === ";" && nestedDepth === 0) {
                lastIndex = index;
                break;
            } else if (token.raw === "," && nestedDepth === 0) {
                expectName = true;
            }
        }

        if (
            nestedDepth === 0 &&
            token.line > startLine &&
            token.kind === "identifier" &&
            isStatementKeyword(token.value)
        ) {
            break;
        }

        if (expectName && nestedDepth === 0 && token.kind === "identifier") {
            names.push(token);
            expectName = false;
        }
        lastIndex = index;
    }

    return { names, lastIndex };
}

function findParameterRange(
    tokens: IRslToken[],
    nameIndex: number
): {
    start: number;
    end: number;
    startIndex: number;
    endIndex: number;
} | undefined {
    const nameToken = tokens[nameIndex];
    let depth = 0;
    let start = -1;
    let startIndex = -1;

    for (let index = nameIndex + 1; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.line > nameToken.line + 20 && start < 0) {
            return undefined;
        }
        if (token.kind !== "symbol") {
            continue;
        }
        if (token.raw === "(") {
            if (start < 0) {
                start = token.start;
                startIndex = index;
            }
            depth++;
        } else if (token.raw === ")" && depth > 0) {
            depth--;
            if (depth === 0) {
                return {
                    start,
                    end: token.end,
                    startIndex,
                    endIndex: index
                };
            }
        } else if (token.raw === ";" && start < 0) {
            return undefined;
        }
    }
    return undefined;
}

function findCurrentClass(blocks: IBlockFrame[]): IBlockFrame | undefined {
    for (let index = blocks.length - 1; index >= 0; index--) {
        if (blocks[index].keyword === "macro") {
            return undefined;
        }
        if (blocks[index].keyword === "class") {
            return blocks[index];
        }
    }
    return undefined;
}

function addDescriptor(
    roots: IExternalSymbolDescriptor[],
    parent: IExternalSymbolDescriptor | undefined,
    descriptor: IExternalSymbolDescriptor
): void {
    if (parent) {
        parent.children.push(descriptor);
    } else {
        roots.push(descriptor);
    }
}

function nextIdentifier(
    tokens: IRslToken[],
    startIndex: number,
    maxLine?: number
): { token: IRslToken; index: number } | undefined {
    for (let index = startIndex; index < tokens.length; index++) {
        const token = tokens[index];
        if (maxLine !== undefined && token.line > maxLine) {
            return undefined;
        }
        if (token.kind === "identifier") {
            return { token, index };
        }
        if (token.kind === "symbol" && token.raw === ";") {
            return undefined;
        }
    }
    return undefined;
}

function isStatementKeyword(value: string): boolean {
    const word = normalizeIdentifier(value);
    return DECLARATION_KEYWORDS.has(word) || BLOCK_START.has(word) || word === "import" || word === "end";
}

function stripQuotes(value: string): string {
    const text = (value || "").trim();
    if (text.length >= 2) {
        const first = text.charAt(0);
        const last = text.charAt(text.length - 1);
        if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
            return text.substring(1, text.length - 1);
        }
    }
    return text;
}

function normalizeModuleName(value: string): string {
    let result = (value || "").trim().replace(/\\/g, "/").toLowerCase();
    if (!result.endsWith(".mac")) {
        result += ".mac";
    }
    return result;
}

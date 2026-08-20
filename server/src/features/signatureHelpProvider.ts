import {
    CompletionItemKind,
    MarkupKind,
    ParameterInformation,
    SignatureHelp,
    SignatureInformation
} from "vscode-languageserver";

import type { RslSymbol } from "../symbols/rslSymbol";
import type { IRslToken } from "../lexer";
import type { RslScopeResolver } from "../scopeResolver";
import type { IIndexedModule } from "../workspaceIndex";

interface ICallContext {
    callee: IRslToken;
    activeParameter: number;
}

/** Строит подсказку параметров для ближайшего незакрытого вызова. */
export function buildRslSignatureHelp(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    offset: number
): SignatureHelp | null {
    const call = findRslCallContext(module.lex.tokens, offset);

    if (!call) {
        return null;
    }

    const resolved = resolver.resolveAt(
        module.uri,
        module.symbolTree,
        call.callee.start
    );

    if (
        !resolved ||
        (
            resolved.symbol.kind !== CompletionItemKind.Function &&
            resolved.symbol.kind !== CompletionItemKind.Method
        )
    ) {
        return null;
    }

    const signature = createSignatureInformation(resolved.symbol);
    const parameterCount = signature.parameters?.length || 0;

    return {
        signatures: [signature],
        activeSignature: 0,
        activeParameter: parameterCount === 0
            ? 0
            : Math.min(call.activeParameter, parameterCount - 1)
    };
}

export function createSignatureInformation(
    symbol: RslSymbol
): SignatureInformation {
    const parameters = extractParameterLabels(symbol);
    const returnType = symbol.typeName &&
        symbol.typeName.toLowerCase() !== "variant"
        ? `: ${symbol.typeName}`
        : "";
    const label = `${symbol.name}(${parameters.join(", ")})${returnType}`;
    const documentation = symbol.completionItem.documentation;

    return {
        label,
        documentation: documentation
            ? {
                kind: MarkupKind.Markdown,
                value: normalizeDocumentation(documentation)
            }
            : undefined,
        parameters: parameters.map<ParameterInformation>(parameter => ({
            label: parameter
        }))
    };
}

/**
 * Вызов и номер аргумента по потоку токенов.
 *
 * Полной модели для этого не нужно, поэтому подсказка параметров умеет
 * отвечать и до её готовности: см. buildRslFastSignatureHelp.
 */
export function findRslCallContext(
    allTokens: readonly IRslToken[],
    offset: number
): ICallContext | undefined {
    /*
     * Обход идёт от позиции курсора назад, а не по всему файлу.
     *
     * Прежде поток токенов фильтровался целиком и копировался в новый
     * массив: на модуле 700 КБ это сотни тысяч элементов на каждое
     * нажатие «(» или «,». Незакрытая скобка вызова лежит рядом с
     * курсором, поэтому цена теперь зависит от размера вызова.
     */
    let depth = 0;
    let openIndex = -1;

    for (let index = lastTokenBefore(allTokens, offset); index >= 0; index--) {
        const token = allTokens[index];

        if (!isCallToken(token)) {
            continue;
        }

        if (token.kind !== "symbol") {
            continue;
        }

        if (token.raw === ")") {
            depth++;
            continue;
        }

        if (token.raw === "(") {
            if (depth === 0) {
                openIndex = index;
                break;
            }

            depth--;
            continue;
        }

        /* Точка с запятой закрывает оператор: вызова здесь нет. */
        if (token.raw === ";") {
            return undefined;
        }
    }

    if (openIndex <= 0) {
        return undefined;
    }

    const callee = previousCallToken(allTokens, openIndex);

    if (!callee || callee.kind !== "identifier") {
        return undefined;
    }

    return {
        callee,
        activeParameter: countArguments(allTokens, openIndex, offset)
    };
}

/** Индекс последнего токена, начинающегося раньше позиции. */
function lastTokenBefore(
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

/** Токены, из которых состоит вызов: без пробелов, комментариев и блоков. */
function isCallToken(token: IRslToken): boolean {
    return token.kind !== "whitespace" &&
        token.kind !== "newline" &&
        token.kind !== "comment" &&
        token.kind !== "bom" &&
        token.kind !== "square";
}

function previousCallToken(
    tokens: readonly IRslToken[],
    index: number
): IRslToken | undefined {
    for (let at = index - 1; at >= 0; at--) {
        if (isCallToken(tokens[at])) {
            return tokens[at];
        }
    }

    return undefined;
}

/**
 * Номер аргумента, в котором стоит курсор.
 *
 * Считаются запятые своего уровня: вложенные вызовы и индексы к номеру
 * аргумента отношения не имеют.
 */
function countArguments(
    tokens: readonly IRslToken[],
    openIndex: number,
    offset: number
): number {
    let active = 0;
    let parentheses = 0;
    let brackets = 0;

    for (let index = openIndex + 1; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.start >= offset) {
            break;
        }

        if (token.kind !== "symbol") {
            continue;
        }

        if (token.raw === "(") {
            parentheses++;
        } else if (token.raw === ")") {
            if (parentheses === 0) {
                break;
            }

            parentheses--;
        } else if (token.raw === "[") {
            brackets++;
        } else if (token.raw === "]") {
            brackets = Math.max(0, brackets - 1);
        } else if (
            token.raw === "," && parentheses === 0 && brackets === 0
        ) {
            active++;
        }
    }

    return active;
}

function extractParameterLabels(symbol: RslSymbol): string[] {
    const detail = String(symbol.completionItem.detail || "");
    const nameIndex = detail.toLowerCase().indexOf(
        symbol.name.toLowerCase()
    );
    const open = detail.indexOf("(", nameIndex + symbol.name.length);

    if (nameIndex < 0 || open < 0) {
        return [];
    }

    let depth = 0;
    let close = -1;

    for (let index = open; index < detail.length; index++) {
        const character = detail.charAt(index);
        if (character === "(") {
            depth++;
        } else if (character === ")") {
            depth--;
            if (depth === 0) {
                close = index;
                break;
            }
        }
    }

    if (close < 0) {
        return [];
    }

    return splitParameters(detail.substring(open + 1, close));
}

function splitParameters(value: string): string[] {
    const result: string[] = [];
    let current = "";
    let depth = 0;
    let quote = "";

    for (const character of value) {
        if (quote) {
            current += character;
            if (character === quote) {
                quote = "";
            }
            continue;
        }

        if (character === "'" || character === "\"") {
            quote = character;
            current += character;
        } else if (character === "(" || character === "[" || character === "{") {
            depth++;
            current += character;
        } else if (character === ")" || character === "]" || character === "}") {
            depth = Math.max(0, depth - 1);
            current += character;
        } else if (character === "," && depth === 0) {
            if (current.trim()) {
                result.push(current.trim());
            }
            current = "";
        } else {
            current += character;
        }
    }

    if (current.trim()) {
        result.push(current.trim());
    }

    return result;
}

function normalizeDocumentation(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (value && typeof value === "object" && "value" in value) {
        return String((value as { value?: unknown }).value || "");
    }
    return String(value || "");
}

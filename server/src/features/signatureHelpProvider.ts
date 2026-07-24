import {
    CompletionItemKind,
    MarkupKind,
    ParameterInformation,
    SignatureHelp,
    SignatureInformation
} from "vscode-languageserver";

import type { CBase } from "../common";
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
    const call = findCallContext(module.lex.tokens, offset);

    if (!call) {
        return null;
    }

    const resolved = resolver.resolveAt(
        module.uri,
        module.object,
        call.callee.start
    );

    if (
        !resolved ||
        (
            resolved.object.ObjKind !== CompletionItemKind.Function &&
            resolved.object.ObjKind !== CompletionItemKind.Method
        )
    ) {
        return null;
    }

    const signature = createSignatureInformation(resolved.object);
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
    object: CBase
): SignatureInformation {
    const parameters = extractParameterLabels(object);
    const returnType = object.Type &&
        object.Type.toLowerCase() !== "variant"
        ? `: ${object.Type}`
        : "";
    const label = `${object.Name}(${parameters.join(", ")})${returnType}`;
    const documentation = object.CIInfo.documentation;

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

function findCallContext(
    allTokens: readonly IRslToken[],
    offset: number
): ICallContext | undefined {
    const tokens = allTokens.filter(token =>
        token.start < offset &&
        token.kind !== "whitespace" &&
        token.kind !== "newline" &&
        token.kind !== "comment" &&
        token.kind !== "bom" &&
        token.kind !== "square"
    );
    let depth = 0;
    let openIndex = -1;

    for (let index = tokens.length - 1; index >= 0; index--) {
        const token = tokens[index];

        if (token.kind !== "symbol") {
            continue;
        }

        if (token.raw === ")") {
            depth++;
        } else if (token.raw === "(") {
            if (depth === 0) {
                openIndex = index;
                break;
            }
            depth--;
        }
    }

    if (openIndex <= 0) {
        return undefined;
    }

    const callee = tokens[openIndex - 1];
    if (callee.kind !== "identifier") {
        return undefined;
    }

    let activeParameter = 0;
    let nestedParentheses = 0;
    let nestedBrackets = 0;

    for (let index = openIndex + 1; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind !== "symbol") {
            continue;
        }

        if (token.raw === "(") {
            nestedParentheses++;
        } else if (token.raw === ")") {
            nestedParentheses = Math.max(0, nestedParentheses - 1);
        } else if (token.raw === "[" || token.raw === "{") {
            nestedBrackets++;
        } else if (token.raw === "]" || token.raw === "}") {
            nestedBrackets = Math.max(0, nestedBrackets - 1);
        } else if (
            token.raw === "," &&
            nestedParentheses === 0 &&
            nestedBrackets === 0
        ) {
            activeParameter++;
        }
    }

    return { callee, activeParameter };
}

function extractParameterLabels(object: CBase): string[] {
    const detail = String(object.CIInfo.detail || "");
    const nameIndex = detail.toLowerCase().indexOf(
        object.Name.toLowerCase()
    );
    const open = detail.indexOf("(", nameIndex + object.Name.length);

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

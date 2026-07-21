import {
    CompletionItemKind,
    SemanticTokens,
    SemanticTokensLegend
} from "vscode-languageserver";

import { CBase } from "./common";
import {
    IRslToken,
    significantTokens
} from "./lexer";
import { RslScopeResolver } from "./scopeResolver";
import { IIndexedModule, WorkspaceIndex } from "./workspaceIndex";

const TOKEN_TYPES = [
    "class",
    "method",
    "function",
    "variable",
    "parameter",
    "property"
];

const TOKEN_MODIFIERS = [
    "declaration",
    "readonly",
    "deprecated"
];

export const RSL_SEMANTIC_TOKENS_LEGEND: SemanticTokensLegend = {
    tokenTypes: TOKEN_TYPES,
    tokenModifiers: TOKEN_MODIFIERS
};

interface ISemanticEntry {
    token: IRslToken;
    type: number;
    modifiers: number;
}

interface IObjectInfo {
    object: CBase;
    scope: CBase;
    parameter: boolean;
}

/**
 * Семантическая подсветка объявлений и разрешённых ссылок.
 * TextMate остаётся базовым быстрым слоем, semantic tokens уточняют смысл
 * идентификаторов после завершения разбора.
 */
export function buildRslSemanticTokens(
    module: IIndexedModule,
    index: WorkspaceIndex
): SemanticTokens {
    const resolver = new RslScopeResolver(index);
    const objects = collectObjects(module);
    const declarationByRange = new Map<string, IObjectInfo>();

    objects.forEach(info => {
        const token = findDeclarationToken(module, info.object);

        if (token) {
            declarationByRange.set(
                rangeKey(token.start, token.end),
                info
            );
        }
    });

    const entries: ISemanticEntry[] = [];

    for (const token of significantTokens(module.lex.tokens)) {
        if (token.kind !== "identifier") {
            continue;
        }

        const declaration = declarationByRange.get(
            rangeKey(token.start, token.end)
        );

        if (declaration) {
            const encoded = encodeObject(declaration.object, declaration.parameter);

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
            module.object,
            token.start
        );

        if (!resolved) {
            continue;
        }

        const resolvedInfo = objects.find(info =>
            info.object === resolved.object
        );
        const encoded = encodeObject(
            resolved.object,
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
        left.token.character - right.token.character
    );

    return {
        data: encodeDelta(entries)
    };
}

function collectObjects(module: IIndexedModule): IObjectInfo[] {
    const result: IObjectInfo[] = [];
    const code = significantTokens(module.lex.tokens);

    walk(module.object, scope => {
        const signature = isCallable(scope)
            ? findSignatureRange(code, scope)
            : undefined;

        scope.getChilds().forEach(child => {
            result.push({
                object: child,
                scope,
                parameter:
                    !!signature &&
                    signature.start < child.Range.start &&
                    child.Range.end <= signature.end &&
                    (
                        child.ObjKind === CompletionItemKind.Variable ||
                        child.ObjKind === CompletionItemKind.Constant
                    )
            });
        });
    });

    return result;
}

function encodeObject(
    object: CBase,
    parameter: boolean
): { type: number; modifiers: number } | undefined {
    let typeName: string;

    if (parameter) {
        typeName = "parameter";
    } else {
        switch (object.ObjKind) {
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

    if (object.ObjKind === CompletionItemKind.Constant) {
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
        const length = Math.max(1, entry.token.end - entry.token.start);

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

function walk(root: CBase, action: (scope: CBase) => void): void {
    action(root);

    root.getChilds().forEach(child => {
        if (child.isObject()) {
            walk(child, action);
        }
    });
}

function isCallable(scope: CBase): boolean {
    return scope.ObjKind === CompletionItemKind.Function ||
        scope.ObjKind === CompletionItemKind.Method;
}

function findSignatureRange(
    tokens: IRslToken[],
    scope: CBase
): { start: number; end: number } | undefined {
    let start = -1;
    let depth = 0;

    for (const token of tokens) {
        if (token.start < scope.Range.start) {
            continue;
        }

        if (token.start > scope.Range.end) {
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
    module: IIndexedModule,
    object: CBase
): IRslToken | undefined {
    const name = object.Name.toLowerCase();

    return module.lex.tokens.find(token =>
        token.kind === "identifier" &&
        token.start >= object.Range.start &&
        token.end <= object.Range.end &&
        token.value.toLowerCase() === name
    );
}

function rangeKey(start: number, end: number): string {
    return `${start}:${end}`;
}

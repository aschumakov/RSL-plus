import {
    CompletionItem,
    CompletionItemKind,
    TextEdit
} from "vscode-languageserver";

import type { RslSymbol } from "../symbols/rslSymbol";
import { significantTokens, type IRslToken } from "../lexer";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

interface ICallContext {
    name: string;
    argumentIndex: number;
    openIndex: number;
}

const MAX_CONTEXT_COMPLETIONS = 200;

/**
 * Контекстные подсказки, которые должны работать внутри строк и Import.
 * undefined означает, что следует продолжить обычный Completion.
 */
export function buildRslContextCompletions(
    module: IIndexedModule,
    index: WorkspaceIndex,
    offset: number
): CompletionItem[] | undefined {
    const tokens = significantTokens(module.lex.tokens);

    if (isImportContext(tokens, offset)) {
        return buildModuleItems(
            module,
            index,
            false,
            undefined,
            importPrefixAt(module.source, offset)
        );
    }

    const stringIndex = tokens.findIndex(token =>
        token.kind === "string" &&
        token.start < offset &&
        offset < token.end
    );
    if (stringIndex < 0) {
        return undefined;
    }

    const call = findCallContext(tokens, stringIndex);
    if (!call) {
        return undefined;
    }

    const stringToken = tokens[stringIndex];
    const replacement = stringContentRange(module, stringToken);
    const typedPrefix = stringPrefixAt(module.source, stringToken, offset);

    if (
        (call.name === "execmacro" || call.name === "execmacro2") &&
        call.argumentIndex === 0
    ) {
        return buildMacroItems(
            [module, ...index.getImportedModules(module.uri)],
            replacement,
            typedPrefix
        );
    }

    if (call.name !== "execmacrofile") {
        return undefined;
    }

    if (call.argumentIndex === 0) {
        return buildModuleItems(
            module,
            index,
            true,
            replacement,
            typedPrefix
        );
    }

    if (call.argumentIndex === 1) {
        const moduleName = firstStringArgument(
            tokens,
            call.openIndex,
            stringIndex
        );
        const target = moduleName
            ? index.findModuleByName(moduleName)
            : undefined;
        return target
            ? buildMacroItems([target], replacement, typedPrefix)
            : [];
    }

    return [];
}

function buildModuleItems(
    module: IIndexedModule,
    index: WorkspaceIndex,
    includeExtension: boolean,
    replacement?: ReturnType<typeof stringContentRange>,
    typedPrefix = ""
): CompletionItem[] {
    const seen = new Set<string>();
    const candidates: string[] = [];
    const normalizedPrefix = typedPrefix.toLowerCase();

    for (const uri of index.getWorkspaceFileUris()) {
        if (uri === module.uri) {
            continue;
        }

        let name = index.getImportNameForUri(uri);
        if (includeExtension && !/\.mac$/i.test(name)) {
            name += ".mac";
        }
        const key = name.replace(/\\/g, "/").toLowerCase();
        if (
            seen.has(key) ||
            (normalizedPrefix && !key.includes(normalizedPrefix))
        ) {
            continue;
        }

        seen.add(key);
        candidates.push(name);
    }

    candidates.sort((left, right) =>
        completionOrder(left, right, normalizedPrefix)
    );

    return candidates
        .slice(0, MAX_CONTEXT_COMPLETIONS)
        .map(name => ({
            label: name,
            kind: CompletionItemKind.Module,
            detail: includeExtension
                ? "RSL-файл для ExecMacroFile"
                : "Модуль RSL",
            insertText: name,
            ...(replacement
                ? { textEdit: TextEdit.replace(replacement, name) }
                : {})
        }));
}

function buildMacroItems(
    modules: readonly IIndexedModule[],
    replacement: ReturnType<typeof stringContentRange>,
    typedPrefix = ""
): CompletionItem[] {
    const result: CompletionItem[] = [];
    const seen = new Set<string>();
    const normalizedPrefix = typedPrefix.toLowerCase();

    for (const module of modules) {
        for (const symbol of module.symbolTree.children) {
            if (!isCallable(symbol) || symbol.isPrivate) {
                continue;
            }

            const key = symbol.name.toLowerCase();
            if (
                seen.has(key) ||
                (normalizedPrefix && !key.includes(normalizedPrefix))
            ) {
                continue;
            }
            seen.add(key);
            result.push({
                ...symbol.completionItem,
                label: symbol.name,
                insertText: symbol.name,
                textEdit: TextEdit.replace(replacement, symbol.name)
            });
        }
    }

    return result
        .sort((left, right) => completionOrder(
            String(left.label),
            String(right.label),
            normalizedPrefix
        ))
        .slice(0, MAX_CONTEXT_COMPLETIONS);
}

function completionOrder(
    left: string,
    right: string,
    normalizedPrefix: string
): number {
    if (normalizedPrefix) {
        const leftStarts = left.toLowerCase().startsWith(normalizedPrefix);
        const rightStarts = right.toLowerCase().startsWith(normalizedPrefix);
        if (leftStarts !== rightStarts) {
            return leftStarts ? -1 : 1;
        }
    }
    return left.localeCompare(right, "ru");
}

function importPrefixAt(source: string, offset: number): string {
    const statement = source.slice(0, offset).split(/[;,]/).pop() ?? "";
    const match = /(?:^|\s)([^\s]*)$/.exec(statement);
    return match?.[1] ?? "";
}

function stringPrefixAt(
    source: string,
    token: IRslToken,
    offset: number
): string {
    return source.slice(Math.min(token.start + 1, offset), offset);
}

function isCallable(symbol: RslSymbol): boolean {
    return symbol.kind === CompletionItemKind.Function ||
        symbol.kind === CompletionItemKind.Method;
}

function isImportContext(tokens: readonly IRslToken[], offset: number): boolean {
    for (let index = tokens.length - 1; index >= 0; index--) {
        const token = tokens[index];
        if (token.start >= offset) {
            continue;
        }
        if (token.kind === "symbol" && token.raw === ";") {
            return false;
        }
        if (
            token.kind === "identifier" &&
            token.value.toLowerCase() === "import"
        ) {
            return true;
        }
        if (
            token.kind === "identifier" &&
            isStatementKeyword(token.value)
        ) {
            return false;
        }
    }
    return false;
}

function findCallContext(
    tokens: readonly IRslToken[],
    stringIndex: number
): ICallContext | undefined {
    let depth = 0;
    let argumentIndex = 0;

    for (let index = stringIndex - 1; index >= 0; index--) {
        const token = tokens[index];
        if (token.kind !== "symbol") {
            continue;
        }
        if (token.raw === ")") {
            depth++;
            continue;
        }
        if (token.raw === "(") {
            if (depth > 0) {
                depth--;
                continue;
            }

            const nameToken = tokens[index - 1];
            if (!nameToken || nameToken.kind !== "identifier") {
                return undefined;
            }
            return {
                name: nameToken.value.toLowerCase(),
                argumentIndex,
                openIndex: index
            };
        }
        if (token.raw === "," && depth === 0) {
            argumentIndex++;
        }
    }
    return undefined;
}

function firstStringArgument(
    tokens: readonly IRslToken[],
    openIndex: number,
    currentStringIndex: number
): string | undefined {
    for (let index = openIndex + 1; index < currentStringIndex; index++) {
        const token = tokens[index];
        if (token.kind === "string") {
            return token.value.trim();
        }
        if (token.kind === "symbol" && token.raw === ",") {
            break;
        }
    }
    return undefined;
}

function stringContentRange(
    module: IIndexedModule,
    token: IRslToken
) {
    const quoteOffset = token.raw.length >= 2 ? 1 : 0;
    return {
        start: positionAt(module, token.start + quoteOffset),
        end: positionAt(module, Math.max(
            token.start + quoteOffset,
            token.end - quoteOffset
        ))
    };
}

function positionAt(module: IIndexedModule, offset: number) {
    const starts = module.lex.lineStarts;
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1] <= offset) {
        line++;
    }
    return { line, character: Math.max(0, offset - starts[line]) };
}

function isStatementKeyword(value: string): boolean {
    return /^(?:array|class|const|file|for|if|macro|record|return|var|while|with)$/i
        .test(value);
}

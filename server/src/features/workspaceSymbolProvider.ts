import {
    CompletionItemKind,
    SymbolInformation,
    SymbolKind
} from "vscode-languageserver";
import * as path from "path";
import { fileURLToPath } from "url";

import type { RslSymbol } from "../symbols/rslSymbol";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

const MAX_WORKSPACE_SYMBOLS = 200;

/** Лёгкий Ctrl+T по уже индексированным compact summaries. */
export function findRslWorkspaceSymbols(
    index: WorkspaceIndex,
    query: string
): SymbolInformation[] {
    const normalizedQuery = query.trim().toLowerCase();
    const result: SymbolInformation[] = [];

    for (const module of index.getIndexedModules()) {
        for (const symbol of module.symbolTree.children) {
            appendSymbol(result, module, index, symbol, normalizedQuery);
            if (symbol.kind === CompletionItemKind.Class) {
                for (const member of symbol.children) {
                    appendSymbol(
                        result,
                        module,
                        index,
                        member,
                        normalizedQuery,
                        symbol.name
                    );
                }
            }
            if (result.length >= MAX_WORKSPACE_SYMBOLS) {
                return result;
            }
        }
    }
    return result;
}

function appendSymbol(
    result: SymbolInformation[],
    module: IIndexedModule,
    index: WorkspaceIndex,
    symbol: RslSymbol,
    query: string,
    parentName?: string
): void {
    if (query && !symbol.name.toLowerCase().includes(query)) {
        return;
    }

    const externalRange = index.getDefinitionRange(module.uri, symbol);
    const range = externalRange || {
        start: positionAt(module, symbol.range.start),
        end: positionAt(module, Math.max(
            symbol.range.start,
            Math.min(symbol.range.end, symbol.range.start + symbol.name.length)
        ))
    };
    result.push(SymbolInformation.create(
        symbol.name,
        symbolKind(symbol.kind),
        range,
        module.uri,
        parentName || displayModule(module.uri)
    ));
}

function symbolKind(kind: CompletionItemKind): SymbolKind {
    switch (kind) {
        case CompletionItemKind.Class:
            return SymbolKind.Class;
        case CompletionItemKind.Method:
            return SymbolKind.Method;
        case CompletionItemKind.Function:
            return SymbolKind.Function;
        case CompletionItemKind.Property:
            return SymbolKind.Property;
        case CompletionItemKind.Field:
            return SymbolKind.Field;
        case CompletionItemKind.Constant:
            return SymbolKind.Constant;
        case CompletionItemKind.File:
            return SymbolKind.File;
        default:
            return SymbolKind.Variable;
    }
}

function positionAt(module: IIndexedModule, offset: number) {
    const starts = module.lex.lineStarts;
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1] <= offset) {
        line++;
    }
    return { line, character: Math.max(0, offset - starts[line]) };
}

function displayModule(uri: string): string {
    try {
        return path.basename(fileURLToPath(uri));
    } catch (_error) {
        return path.basename(uri);
    }
}

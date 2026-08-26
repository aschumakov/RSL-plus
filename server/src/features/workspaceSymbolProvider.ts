import {
    CompletionItemKind,
    SymbolInformation,
    SymbolKind
} from "vscode-languageserver";
import * as path from "path";
import { fileURLToPath } from "url";

import type { IRslCatalogSymbol } from "../indexing/workspaceCatalog";
import type { WorkspaceIndex } from "../workspaceIndex";

const MAX_WORKSPACE_SYMBOLS = 200;

/**
 * Ctrl+T по постоянному каталогу проекта.
 *
 * Каталог отвечает за две вещи, которых прежде не было. Полнота: записи не
 * исчезают вместе с вытесненной подробной моделью, поэтому в ответ попадают и
 * файлы, которых сейчас нет в памяти. Повторяемость: совпадения сортируются
 * целиком и лишь потом обрезаются лимитом — раньше перебор шёл в порядке Map
 * и останавливался на двухсотом найденном, из-за чего один и тот же запрос
 * после разных запусков давал разные списки.
 */
export function findRslWorkspaceSymbols(
    index: WorkspaceIndex,
    query: string
): SymbolInformation[] {
    return index.catalog
        .find(query, MAX_WORKSPACE_SYMBOLS)
        .map(symbol => toSymbolInformation(symbol));
}

function toSymbolInformation(symbol: IRslCatalogSymbol): SymbolInformation {
    const start = { line: symbol.line, character: symbol.character };
    const end = {
        line: symbol.line,
        character: symbol.character + symbol.name.length
    };

    return SymbolInformation.create(
        symbol.name,
        symbolKind(symbol.kind),
        { start, end },
        symbol.uri,
        symbol.container || displayModule(symbol.uri)
    );
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

function displayModule(uri: string): string {
    try {
        return path.basename(fileURLToPath(uri));
    } catch (_error) {
        return path.basename(uri);
    }
}

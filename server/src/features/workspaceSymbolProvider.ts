import {
    CompletionItemKind,
    SymbolInformation,
    SymbolKind
} from "vscode-languageserver";
import * as path from "path";
import { fileURLToPath } from "url";

import {
    RslProjectIndexView,
    type IRslProjectSymbol
} from "../indexing/projectIndexView";
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
    return new RslProjectIndexView(index)
        .workspaceSymbols(query, MAX_WORKSPACE_SYMBOLS)
        .map(symbol => toSymbolInformation(index, symbol));
}

/**
 * Положение берётся у текущей модели, если она в памяти.
 *
 * Запись каталога помнит положение на момент чтения файла. У открытого
 * документа оно съезжает от каждой правки, и до следующего чтения Ctrl+T
 * приводил в строку, где объявления уже нет.
 */
function toSymbolInformation(
    index: WorkspaceIndex,
    symbol: IRslProjectSymbol
): SymbolInformation {
    const range = index.getDefinitionRangeByRef(symbol.ref) ||
        catalogRange(symbol);

    return SymbolInformation.create(
        symbol.name,
        symbolKind(symbol.kind),
        range,
        symbol.ref.uri,
        symbol.container || displayModule(symbol.ref.uri)
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

/** Положение, которое помнит каталог: строка, где имя стояло при чтении. */
function catalogRange(symbol: IRslProjectSymbol): {
    start: { line: number; character: number };
    end: { line: number; character: number };
} {
    const start = { line: symbol.line, character: symbol.character };

    return {
        start,
        end: {
            line: symbol.line,
            character: symbol.character + symbol.name.length
        }
    };
}

import {
    CompletionItemKind,
    SymbolInformation,
    SymbolKind
} from "vscode-languageserver";
import * as path from "path";
import { fileURLToPath } from "url";

import type { CBase } from "../common";
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
        for (const object of module.object.getChilds()) {
            appendSymbol(result, module, index, object, normalizedQuery);
            if (object.ObjKind === CompletionItemKind.Class) {
                for (const member of object.getChilds()) {
                    appendSymbol(
                        result,
                        module,
                        index,
                        member,
                        normalizedQuery,
                        object.Name
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
    object: CBase,
    query: string,
    parentName?: string
): void {
    if (query && !object.Name.toLowerCase().includes(query)) {
        return;
    }

    const externalRange = index.getDefinitionRange(module.uri, object);
    const range = externalRange || {
        start: positionAt(module, object.Range.start),
        end: positionAt(module, Math.max(
            object.Range.start,
            Math.min(object.Range.end, object.Range.start + object.Name.length)
        ))
    };
    result.push(SymbolInformation.create(
        object.Name,
        symbolKind(object.ObjKind),
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

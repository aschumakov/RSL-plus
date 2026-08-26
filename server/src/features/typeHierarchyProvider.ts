import {
    Location,
    SymbolKind,
    TypeHierarchyItem
} from "vscode-languageserver";
import { CompletionItemKind } from "vscode-languageserver";

import { normalizeIdentifier } from "../lexer";
import type { IRslCatalogSymbol } from "../indexing/workspaceCatalog";
import type { WorkspaceIndex } from "../workspaceIndex";

/**
 * Наследование классов: переход к реализации и иерархия типов.
 *
 * Оба ответа строятся по постоянному каталогу проекта: связь «класс — базовый
 * класс» записана в нём для каждого файла, включая те, чья подробная модель
 * давно вытеснена. Нового обхода проекта на каждый запрос не происходит —
 * именно поэтому эти функции и появились только после каталога.
 *
 * Пока каталог ещё наполняется, ответ честно строится по готовой части:
 * запустить полную индексацию на основном потоке ради одного запроса нельзя.
 */

export interface IRslHierarchyRequest {
    uri: string;
    /** Имя класса под курсором. */
    className: string;
}

/** Классы-наследники: Go to Implementation. */
export function findRslImplementations(
    index: WorkspaceIndex,
    className: string
): Location[] {
    if (!className) {
        return [];
    }

    return index.catalog
        .implementationsOf(className)
        .map(symbol => toLocation(symbol));
}

/** Элемент иерархии для класса под курсором. */
export function prepareRslTypeHierarchy(
    index: WorkspaceIndex,
    className: string
): TypeHierarchyItem[] {
    const wanted = normalizeIdentifier(className);

    return index.catalog
        .findByName(className)
        .filter(symbol =>
            symbol.kind === CompletionItemKind.Class &&
            normalizeIdentifier(symbol.name) === wanted
        )
        .map(symbol => toItem(symbol));
}

/** Родители: у RSL база одна, поэтому цепочка линейная. */
export function rslSupertypes(
    index: WorkspaceIndex,
    item: TypeHierarchyItem
): TypeHierarchyItem[] {
    const current = findClass(index, item);

    if (!current || !current.baseClassName) {
        return [];
    }

    return prepareRslTypeHierarchy(index, current.baseClassName);
}

/** Потомки: те, у кого базовым указан этот класс. */
export function rslSubtypes(
    index: WorkspaceIndex,
    item: TypeHierarchyItem
): TypeHierarchyItem[] {
    return index.catalog
        .implementationsOf(item.name)
        .map(symbol => toItem(symbol));
}

function findClass(
    index: WorkspaceIndex,
    item: TypeHierarchyItem
): IRslCatalogSymbol | undefined {
    const wanted = normalizeIdentifier(item.name);

    return index.catalog.findByName(item.name).find(symbol =>
        symbol.kind === CompletionItemKind.Class &&
        symbol.uri === item.uri &&
        normalizeIdentifier(symbol.name) === wanted
    );
}

function toLocation(symbol: IRslCatalogSymbol): Location {
    return Location.create(symbol.uri, symbolRange(symbol));
}

function toItem(symbol: IRslCatalogSymbol): TypeHierarchyItem {
    const range = symbolRange(symbol);

    return {
        name: symbol.name,
        kind: SymbolKind.Class,
        uri: symbol.uri,
        range,
        selectionRange: range,
        detail: symbol.baseClassName
            ? `наследник ${symbol.baseClassName}`
            : undefined
    };
}

function symbolRange(symbol: IRslCatalogSymbol) {
    return {
        start: { line: symbol.line, character: symbol.character },
        end: {
            line: symbol.line,
            character: symbol.character + symbol.name.length
        }
    };
}

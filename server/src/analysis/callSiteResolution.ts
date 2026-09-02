import { CompletionItemKind } from "vscode-languageserver";

import type { IRslCallSite } from "./callSiteFacts";
import { normalizeIdentifier } from "../lexer";
import { normalizeModuleName } from "../core/language/moduleName";
import type { RslSymbol } from "../symbols/rslSymbol";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

/** Куда ведёт место вызова. */
export interface IRslCallTarget {
    uri: string;
    symbol: RslSymbol;
}

/**
 * Разрешение места вызова, записанного строкой.
 *
 * Обычный вызов `Foo()` разрешает resolver по смещению идентификатора — там
 * работают области видимости, и подменять его здесь нечем. А у строковых форм
 * идентификатора нет вовсе: `ExecMacro("Foo")` — это строка, и resolver про
 * неё ничего не скажет. Имя ищется среди процедур своего модуля и подключённых,
 * а `ExecMacroFile("lib.mac", "Foo")` — в названном файле.
 *
 * Ничего не угадывается: если имя не нашлось однозначно, ответа нет.
 */
export function resolveRslStringCallSite(
    index: WorkspaceIndex,
    module: IIndexedModule,
    site: IRslCallSite
): IRslCallTarget | undefined {
    if (!site.staticallyResolvable || !site.targetName) {
        return undefined;
    }

    const wanted = normalizeIdentifier(site.targetName);

    if (!wanted) {
        return undefined;
    }

    /*
     * Названный файл или модуль имеет преимущество: там имя искали явно.
     */
    if (site.moduleName) {
        const named = index.findModuleByName(normalizeModuleName(site.moduleName));
        const found = named && findCallable(named, wanted);

        return found ? { uri: named.uri, symbol: found } : undefined;
    }

    const own = findCallable(module, wanted);

    if (own) {
        return { uri: module.uri, symbol: own };
    }

    const imported = index.findImportedSymbols(module.uri, wanted)
        .filter(item => isCallableKind(item.symbol.kind));

    /*
     * Неоднозначное имя — не ответ. Показать один из двух одноимённых модулей
     * значило бы утверждать то, чего мы не знаем.
     */
    return imported.length === 1
        ? { uri: imported[0].uri, symbol: imported[0].symbol }
        : undefined;
}

/** Публичная процедура модуля с этим именем. */
function findCallable(
    module: IIndexedModule,
    wanted: string
): RslSymbol | undefined {
    for (const symbol of module.symbolTree.children) {
        if (
            isCallableKind(symbol.kind) &&
            normalizeIdentifier(symbol.name) === wanted
        ) {
            return symbol;
        }
    }

    return undefined;
}

function isCallableKind(kind: CompletionItemKind): boolean {
    return kind === CompletionItemKind.Function ||
        kind === CompletionItemKind.Method;
}

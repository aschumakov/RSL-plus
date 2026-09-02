import { CompletionItemKind } from "vscode-languageserver";

import type { IIndexedModule } from "../workspaceIndex";
import type { RslSymbol } from "../symbols/rslSymbol";

/**
 * Заглушка внешнего модуля по его внешнему интерфейсу.
 *
 * Библиотеки и платформенные компоненты приходят без исходников, и сервер о
 * них не знает ничего: ни подписей, ни классов, ни констант. Заглушка — это
 * обычный модуль RSL, где объявления есть, а тел нет; всё остальное —
 * подсказка, Hover, подпись, переход, вывод типа — работает по нему само,
 * потому что для сервера это такой же файл проекта.
 *
 * Берётся ровно то, что видно снаружи: тела процедур в заглушку не попадают,
 * приватные объявления тоже. Это тот же состав, что и у отпечатка интерфейса,
 * и другого источника у заглушки быть не должно — иначе они разойдутся.
 */
export function buildRslModuleStub(module: IIndexedModule): string {
    const lines: string[] = [
        "/*",
        " * Заглушка модуля " + moduleName(module.uri) + ".",
        " *",
        " * Создана командой RSL: Generate Stub From File по внешнему интерфейсу",
        " * модуля: объявления без тел. Тела здесь не нужны — заглушка отвечает",
        " * на вопросы о подписях, типах и составе, а не выполняется.",
        " */",
        ""
    ];

    if (module.imports.length > 0) {
        lines.push("Import " + module.imports.join(", ") + ";", "");
    }

    for (const symbol of module.symbolTree.children) {
        if (symbol.isPrivate) {
            continue;
        }

        appendSymbol(lines, symbol, 0);
    }

    return lines.join("\n") + "\n";
}

function appendSymbol(
    lines: string[],
    symbol: RslSymbol,
    depth: number
): void {
    const indent = "  ".repeat(depth);

    if (symbol.kind === CompletionItemKind.Class) {
        lines.push(
            indent + "Class " +
            (symbol.baseClassName ? "(" + symbol.baseClassName + ") " : "") +
            symbol.name
        );

        for (const child of symbol.children) {
            if (!child.isPrivate) {
                appendSymbol(lines, child, depth + 1);
            }
        }

        lines.push(indent + "End;", "");

        return;
    }

    if (isCallable(symbol.kind)) {
        lines.push(
            indent + "Macro " + symbol.name +
            (symbol.parameterText || "()") +
            (symbol.typeName && symbol.typeName !== "variant"
                ? ": " + symbol.typeName
                : ""),
            indent + "End;",
            ""
        );

        return;
    }

    if (symbol.kind === CompletionItemKind.Constant) {
        lines.push(
            indent + "Const " + symbol.name +
            (symbol.value ? " = " + symbol.value : " = 0") + ";"
        );

        return;
    }

    lines.push(
        indent + "Var " + symbol.name +
        (symbol.typeName && symbol.typeName !== "variant"
            ? ": " + symbol.typeName
            : "") + ";"
    );
}

function isCallable(kind: CompletionItemKind): boolean {
    return kind === CompletionItemKind.Function ||
        kind === CompletionItemKind.Method;
}

function moduleName(uri: string): string {
    const slash = uri.lastIndexOf("/");

    return slash < 0 ? uri : uri.slice(slash + 1);
}

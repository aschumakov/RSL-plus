import { CompletionItemKind } from "vscode-languageserver";

import { normalizeIdentifier } from "../lexer";
import type { IIndexedModule } from "../workspaceIndex";
import type { RslSymbol } from "../symbols/rslSymbol";

/**
 * Сколько классов с таким именем объявлено в файле.
 *
 * Нужно ровно для одного вывода: если больше одного — о каком из них речь,
 * неизвестно, и состав такого имени недоказуем. Проверка «такого члена нет»
 * обязана в этом случае молчать, а подсказка не имеет права выдавать состав
 * одного класса за состав другого.
 *
 * Живёт отдельно, потому что спрашивают это все: прежде счёт вёлся только у
 * проверки состава, и остальные о неоднозначности просто не знали.
 */
export function countRslOwnClasses(
    module: IIndexedModule | undefined,
    className: string
): number {
    if (!module) {
        return 0;
    }

    const wanted = normalizeIdentifier(className);
    let count = 0;

    const visit = (symbol: RslSymbol): void => {
        if (
            symbol.kind === CompletionItemKind.Class &&
            normalizeIdentifier(symbol.name) === wanted
        ) {
            count++;
        }

        for (const child of symbol.children) {
            visit(child);
        }
    };

    visit(module.symbolTree);

    return count;
}

import { CompletionItemKind } from "vscode-languageserver";

import { tokenAtOffset } from "../lexer";
import type { WorkspaceIndex } from "../workspaceIndex";

/**
 * Имя класса под курсором.
 *
 * Нужно переходу к реализации и иерархии типов, и вопрос у них один: на каком
 * классе стоит курсор. Ответ берётся по имени токена и подтверждается
 * каталогом — так работает и объявление `Class(Base) Child`, и упоминание
 * класса в типе переменной, и сам конструктор.
 *
 * Модель файла здесь не строится: имя — это текст токена, а знание о том,
 * класс ли это, лежит в каталоге проекта.
 */
export function classNameAt(
    index: WorkspaceIndex,
    uri: string,
    offset: number
): string {
    const module = index.getModule(uri);

    if (!module) {
        return "";
    }

    const token = tokenAtOffset(module.lex.tokens, offset, true);

    if (!token || token.kind !== "identifier") {
        return "";
    }

    const known = index.catalog.findByName(token.value)
        .some(symbol => symbol.kind === CompletionItemKind.Class);

    return known ? token.value : "";
}

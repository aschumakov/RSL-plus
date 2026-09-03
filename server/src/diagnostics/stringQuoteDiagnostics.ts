import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver";

import { createTokenDiagnostic } from "./diagnosticFactory";
import type { IRslToken } from "../lexer";
import type { IIndexedModule } from "../workspaceIndex";

/**
 * Строка в апострофах: RSL таких не принимает.
 *
 * В RSL строковый литерал заключается только в двойные кавычки. Лексер
 * апострофы разбирает — иначе он спотыкался бы на каждой такой строке и портил
 * разбор всего файла, — но компилятор на `var z = 'sss';` выдаёт ошибку. То
 * есть плагин считал корректным код, который не собирается.
 *
 * Проверка текстовая: смотрится сам литерал и ничего больше. Ни областей
 * видимости, ни импортов ей не нужно.
 */

/** Сообщение одно на все случаи: подсказывать тут нечего. */
const MESSAGE = "Строковый литерал RSL должен быть заключён в двойные кавычки";

export const RSL_SINGLE_QUOTED_STRING_CODE = "single-quoted-string";

export function buildRslStringQuoteDiagnostics(
    module: IIndexedModule,
    limit = Number.MAX_SAFE_INTEGER
): Diagnostic[] {
    const result: Diagnostic[] = [];

    for (const token of module.lex.tokens) {
        if (result.length >= limit) {
            break;
        }

        if (!isSingleQuoted(token)) {
            continue;
        }

        result.push(createTokenDiagnostic(
            token,
            DiagnosticSeverity.Error,
            MESSAGE,
            RSL_SINGLE_QUOTED_STRING_CODE,
            false,
            /*
             * Готовая замена кладётся в данные сообщения.
             *
             * Считать её умеет только тот, кто видит сам литерал: решение
             * «однозначно ли преобразование» зависит от его содержимого.
             * Быстрое исправление предлагается лишь тогда, когда замена есть.
             */
            { replacement: doubleQuoted(token.raw) }
        ));
    }

    return result;
}

/** Литерал в апострофах; незакрытый — забота другой проверки. */
function isSingleQuoted(token: IRslToken): boolean {
    return token.kind === "string" &&
        token.raw.length >= 2 &&
        token.raw.charAt(0) === "'" &&
        token.raw.charAt(token.raw.length - 1) === "'";
}

/**
 * Тот же текст в двойных кавычках — или пусто, если преобразование не
 * однозначно.
 *
 * Однозначно оно тогда, когда содержимое литерала можно перенести дословно.
 * Мешают два случая:
 *
 *   двойная кавычка внутри — `'он сказал "да"'`. В двойных кавычках её надо
 *   удваивать, а удвоение в RSL и есть способ записать кавычку внутри строки;
 *   доверять этому переносу без проверки самим компилятором нельзя;
 *
 *   обратная косая перед кавычкой или перед собой — от смены обрамления
 *   меняется то, что escape-последовательность означает.
 *
 * В обоих случаях исправления не предлагается вовсе: молча изменить
 * содержимое строки хуже, чем оставить ошибку на виду.
 */
export function doubleQuoted(raw: string): string {
    const body = raw.slice(1, -1);

    if (body.includes("\"") || body.includes("\\")) {
        return "";
    }

    return "\"" + body + "\"";
}

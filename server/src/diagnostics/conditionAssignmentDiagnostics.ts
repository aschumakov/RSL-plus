import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver";

import { createTokenDiagnostic } from "./diagnosticFactory";
import type { IRslToken } from "../lexer";
import type { IRslSyntaxNode } from "../syntaxParser";
import type { IIndexedModule } from "../workspaceIndex";

/**
 * Присваивание в условии `if` и `elif`.
 *
 * `if (i = 0)` — обычная описка: вместо сравнения написано присваивание, и
 * условие получает не тот ответ, который имел в виду автор. Поймать это по
 * тексту нельзя, а по разбору можно точно: лексер различает `=`, `==`, `!=`,
 * `>=` и `<=` отдельными токенами, а разбор говорит, где начинается оператор
 * и где кончается его условие.
 *
 * Дерево выражения для этого не строится: на рабочем пути оно выключено ради
 * скорости (см. buildExpressionTree), и заводить его ради одной проверки
 * значило бы платить за неё на каждом файле. Берутся токены условия — те же
 * самые, что разбор уже собрал для этого оператора.
 *
 * Быстрого исправления у проверки нет намеренно. `=` вместо `==` бывает и
 * задуманным — присваивание внутри условия язык допускает, — и переписать за
 * автора значит поменять смысл программы там, где он, возможно, прав.
 */

export const RSL_CONDITION_ASSIGNMENT_CODE = "condition-assignment";

const MESSAGE = "Присваивание внутри условия. Возможно, требуется `==`.";

/** Операторы, начинающие условие: у обоих оно в скобках следом за словом. */
const CONDITION_OWNERS = new Set(["IfStatement", "ElseIfClause"]);

export function buildRslConditionAssignmentDiagnostics(
    module: IIndexedModule,
    limit: number
): Diagnostic[] {
    if (limit <= 0) {
        return [];
    }

    const tokens = module.syntax.tokens;

    if (tokens.length === 0) {
        return [];
    }

    const result: Diagnostic[] = [];

    visit(module.syntax.root, node => {
        if (result.length >= limit || !CONDITION_OWNERS.has(node.kind)) {
            return;
        }

        for (const token of conditionTokens(tokens, node)) {
            if (result.length >= limit) {
                return;
            }

            if (token.kind === "symbol" && token.raw === "=") {
                result.push(createTokenDiagnostic(
                    token,
                    DiagnosticSeverity.Warning,
                    MESSAGE,
                    RSL_CONDITION_ASSIGNMENT_CODE
                ));
            }
        }
    });

    return result;
}

function visit(
    node: IRslSyntaxNode,
    action: (node: IRslSyntaxNode) => void
): void {
    action(node);

    for (const child of node.children || []) {
        visit(child, action);
    }
}

/**
 * Токены условия: всё внутри первых скобок оператора, на любой глубине.
 *
 * Глубина важна: `if ((x = Func()) > 0)` — присваивание там во вложенных
 * скобках, и остановиться на верхнем уровне значило бы его не заметить.
 *
 * Границы берутся у самого оператора: у `IfStatement` его span включает и
 * ветви `elif`, поэтому считается ПЕРВАЯ сбалансированная группа после
 * ключевого слова, а не всё подряд до конца узла.
 */
function conditionTokens(
    tokens: readonly IRslToken[],
    node: IRslSyntaxNode
): IRslToken[] {
    const inside: IRslToken[] = [];
    let depth = 0;

    for (let at = firstTokenAt(tokens, node.start); at < tokens.length; at++) {
        const token = tokens[at];

        if (token.start >= node.end) {
            break;
        }

        if (token.kind !== "symbol") {
            if (depth > 0) {
                inside.push(token);
            }

            continue;
        }

        if (token.raw === "(") {
            depth++;

            if (depth > 1) {
                inside.push(token);
            }

            continue;
        }

        if (token.raw === ")") {
            depth--;

            if (depth === 0) {
                /* Условие закрылось: дальше тело оператора, оно не наше. */
                break;
            }

            inside.push(token);

            continue;
        }

        if (depth > 0) {
            inside.push(token);
        }
    }

    return inside;
}

/** Первый токен, начинающийся не раньше смещения. */
function firstTokenAt(tokens: readonly IRslToken[], offset: number): number {
    let low = 0;
    let high = tokens.length;

    while (low < high) {
        const middle = (low + high) >> 1;

        if (tokens[middle].start < offset) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    return low;
}

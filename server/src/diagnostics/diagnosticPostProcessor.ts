import {
    Diagnostic,
    DiagnosticSeverity
} from "vscode-languageserver";

import { isStandardHandler } from "../features/standardHandlers";
import type { IRslSyntaxNode } from "../syntaxParser";
import type { IIndexedModule } from "../workspaceIndex";

interface IDiagnosticData {
    start?: number;
    end?: number;
    name?: string;
    parameter?: boolean;
}

/**
 * Правила, зависящие от особенностей RS-Bank, но не от общей грамматики RSL.
 */
export function applyProjectDiagnosticRules(
    module: IIndexedModule,
    diagnostics: Diagnostic[]
): Diagnostic[] {
    const suppressedParameterDiagnostics =
        collectSuppressedStandardHandlerParameters(module, diagnostics);

    return diagnostics
        .filter(diagnostic =>
            !suppressedParameterDiagnostics.has(diagnostic)
        )
        .map(diagnostic => {
            if (String(diagnostic.code || "") !== "duplicate-import") {
                return diagnostic;
            }

            /* Повторный Import — предупреждение, а не информационная подсказка. */
            const { tags: _tags, ...warning } = diagnostic;

            return {
                ...warning,
                severity: DiagnosticSeverity.Warning
            };
        });
}

/**
 * Ядро может передать стандартному обработчику больше аргументов, чем нужно
 * конкретной реализации. Поэтому для такого Macro предупреждаем только о
 * неиспользуемом хвосте сигнатуры:
 *
 *     Macro Handler(a, b, c, d, e)
 *
 * Если c используется, а d и e нет — предупреждаем только о d и e.
 * Параметры a и b не проверяем: разработчик обязан сохранить позицию c.
 * Если последний параметр используется, предупреждений по параметрам нет.
 * Если не используется ни один параметр, предупреждаем обо всех.
 */
function collectSuppressedStandardHandlerParameters(
    module: IIndexedModule,
    diagnostics: Diagnostic[]
): Set<Diagnostic> {
    const result = new Set<Diagnostic>();
    const unusedByStart = new Map<number, Diagnostic>();

    diagnostics.forEach(diagnostic => {
        if (String(diagnostic.code || "") !== "unused-declaration") {
            return;
        }

        const data = diagnostic.data as IDiagnosticData | undefined;

        if (data?.parameter && typeof data.start === "number") {
            unusedByStart.set(data.start, diagnostic);
        }
    });

    if (unusedByStart.size === 0) {
        return result;
    }

    walkSyntax(module.syntax.root, node => {
        if (
            node.kind !== "MacroDeclaration" ||
            !isStandardHandler(node.name)
        ) {
            return;
        }

        const parameters = node.children.filter(child =>
            child.kind === "Parameter"
        );
        let firstUsedFromEnd = -1;

        for (let index = parameters.length - 1; index >= 0; index--) {
            const parameter = parameters[index];
            const unusedDiagnostic = unusedByStart.get(parameter.start);

            if (!unusedDiagnostic) {
                firstUsedFromEnd = index;
                break;
            }
        }

        /*
         * Всё до первого используемого параметра слева подавляется.
         * Хвост после него остаётся в Problems. Если использованных параметров
         * нет, firstUsedFromEnd остаётся -1 и предупреждаются все параметры.
         */
        for (let index = 0; index < firstUsedFromEnd; index++) {
            const diagnostic = unusedByStart.get(parameters[index].start);

            if (diagnostic) {
                result.add(diagnostic);
            }
        }
    });

    return result;
}

function walkSyntax(
    node: IRslSyntaxNode,
    action: (node: IRslSyntaxNode) => void
): void {
    action(node);
    node.children.forEach(child => walkSyntax(child, action));
}

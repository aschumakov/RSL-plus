import {
    Diagnostic,
    DiagnosticSeverity
} from "vscode-languageserver";

import { isStandardHandler } from "../features/standardHandlers";
import { GetPositionalHandlerNamesFromTokens } from "../execMacroDefinition";
import { normalizeIdentifier, type IRslToken } from "../lexer";
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
    const unusedParameters = collectUnusedParameters(diagnostics);
    const suppressedParameterDiagnostics = new Set([
        ...collectSuppressedStandardHandlerParameters(
            module,
            unusedParameters
        ),
        ...collectSetParmParameters(module, unusedParameters)
    ]);

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
/** Неиспользуемые параметры по началу объявления. */
function collectUnusedParameters(
    diagnostics: Diagnostic[]
): Map<number, Diagnostic> {
    const result = new Map<number, Diagnostic>();

    for (const diagnostic of diagnostics) {
        if (String(diagnostic.code || "") !== "unused-declaration") {
            continue;
        }

        const data = diagnostic.data as IDiagnosticData | undefined;

        if (data?.parameter && typeof data.start === "number") {
            result.set(data.start, diagnostic);
        }
    }

    return result;
}

function collectSuppressedStandardHandlerParameters(
    module: IIndexedModule,
    unusedByStart: Map<number, Diagnostic>
): Set<Diagnostic> {
    const result = new Set<Diagnostic>();

    if (unusedByStart.size === 0) {
        return result;
    }

    const callbackHandlers = GetPositionalHandlerNamesFromTokens(
        module.lex.tokens
    );

    walkSyntax(module.syntax.root, node => {
        if (
            node.kind !== "MacroDeclaration" ||
            (
                !isStandardHandler(node.name) &&
                !callbackHandlers.has(normalizeName(node.name))
            )
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

/**
 * Параметры, которые процедура отдаёт наружу через SetParm.
 *
 * `SetParm(2, res)` записывает значение в третий параметр вызова: имя
 * параметра в тексте при этом не встречается, но параметр — часть
 * выходного контракта, и «не используется» о нём неверно.
 *
 * Разбор идёт по токенам и только тогда, когда есть что подавлять:
 * лишнего прохода по файлу в обычном случае не появляется.
 */
function collectSetParmParameters(
    module: IIndexedModule,
    unusedByStart: Map<number, Diagnostic>
): Set<Diagnostic> {
    const result = new Set<Diagnostic>();

    if (unusedByStart.size === 0 || hasOwnSetParm(module)) {
        return result;
    }

    const macros = collectMacroParameters(module);

    if (macros.length === 0) {
        return result;
    }

    const tokens = module.lex.tokens;

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (
            token.kind !== "identifier" ||
            normalizeIdentifier(token.value) !== "setparm"
        ) {
            continue;
        }

        const previous = previousCode(tokens, index);

        /* Член объекта с тем же именем к параметрам отношения не имеет. */
        if (previous?.kind === "symbol" && previous.raw === ".") {
            continue;
        }

        const openIndex = nextCodeIndex(tokens, index);
        const open = openIndex >= 0 ? tokens[openIndex] : undefined;

        if (!open || open.kind !== "symbol" || open.raw !== "(") {
            continue;
        }

        const owner = innermostMacroAt(macros, token.start);

        if (!owner) {
            continue;
        }

        const firstIndex = nextCodeIndex(tokens, openIndex);
        const first = firstIndex >= 0 ? tokens[firstIndex] : undefined;
        const position = first && first.kind === "number"
            ? Number(first.value)
            : Number.NaN;

        if (!Number.isInteger(position) || position < 0) {
            /*
             * Номер параметра посчитан во время исполнения: какой именно
             * заполняется — неизвестно, поэтому по параметрам этой
             * процедуры не предупреждаем вовсе.
             */
            suppressAll(result, unusedByStart, owner);
            continue;
        }

        const parameter = owner.parameters[position];
        const diagnostic = parameter
            ? unusedByStart.get(parameter.start)
            : undefined;

        if (diagnostic) {
            result.add(diagnostic);
        }
    }

    return result;
}

function suppressAll(
    result: Set<Diagnostic>,
    unusedByStart: Map<number, Diagnostic>,
    owner: IMacroParameters
): void {
    for (const parameter of owner.parameters) {
        const diagnostic = unusedByStart.get(parameter.start);

        if (diagnostic) {
            result.add(diagnostic);
        }
    }
}

interface IMacroParameters {
    start: number;
    end: number;
    parameters: readonly { start: number }[];
}

/** Процедуры файла со списком параметров по позициям. */
function collectMacroParameters(
    module: IIndexedModule
): readonly IMacroParameters[] {
    const result: IMacroParameters[] = [];

    walkSyntax(module.syntax.root, node => {
        if (node.kind !== "MacroDeclaration") {
            return;
        }

        result.push({
            start: node.start,
            end: node.end,
            parameters: node.children
                .filter(child => child.kind === "Parameter")
                .map(child => ({ start: child.start }))
        });
    });

    return result;
}

/**
 * Ближайшая объемлющая процедура.
 *
 * Именно ближайшая: SetParm во вложенной процедуре заполняет её параметр,
 * а не параметр внешней.
 */
function innermostMacroAt(
    macros: readonly IMacroParameters[],
    offset: number
): IMacroParameters | undefined {
    let found: IMacroParameters | undefined;

    for (const macro of macros) {
        if (macro.start > offset || offset > macro.end) {
            continue;
        }

        if (!found || macro.start > found.start) {
            found = macro;
        }
    }

    return found;
}

/** Своя процедура с именем SetParm: встроенная тогда не при делах. */
function hasOwnSetParm(module: IIndexedModule): boolean {
    return module.symbolTree.children.some(child =>
        normalizeIdentifier(child.name) === "setparm"
    );
}

function previousCode(
    tokens: readonly IRslToken[],
    index: number
): IRslToken | undefined {
    for (let at = index - 1; at >= 0; at--) {
        if (isCode(tokens[at])) {
            return tokens[at];
        }
    }

    return undefined;
}

function nextCodeIndex(
    tokens: readonly IRslToken[],
    index: number
): number {
    for (let at = index + 1; at < tokens.length; at++) {
        if (isCode(tokens[at])) {
            return at;
        }
    }

    return -1;
}

function isCode(token: IRslToken): boolean {
    return token.kind !== "whitespace" &&
        token.kind !== "newline" &&
        token.kind !== "comment" &&
        token.kind !== "bom";
}

function normalizeName(value: string | undefined): string {
    return (value || "").trim().toLowerCase();
}

function walkSyntax(
    node: IRslSyntaxNode,
    action: (node: IRslSyntaxNode) => void
): void {
    action(node);
    node.children.forEach(child => walkSyntax(child, action));
}

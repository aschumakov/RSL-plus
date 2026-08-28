import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver";

/**
 * Уровень каждого правила задаётся настройкой.
 *
 * Прежде уровень был вшит в саму проверку: сомнительное присваивание всегда
 * предупреждение, а неиспользуемый параметр всегда предупреждение же. В
 * проекте с полутора сотнями находок на файл это лишает список смысла — там
 * важно поднять одно и приглушить другое, а не спорить с автором проверки.
 *
 * Уровень применяется после расчёта и до сортировки: чем считать диагностику,
 * от него не зависит, а порядок вывода и предел публикации зависят.
 */

/** Что можно назначить правилу. */
export type RslRuleSeverity =
    "none" | "hint" | "information" | "warning" | "error";

export type RslRuleSeverityMap = Record<string, RslRuleSeverity>;

const BY_NAME = new Map<RslRuleSeverity, DiagnosticSeverity | undefined>([
    ["none", undefined],
    ["hint", DiagnosticSeverity.Hint],
    ["information", DiagnosticSeverity.Information],
    ["warning", DiagnosticSeverity.Warning],
    ["error", DiagnosticSeverity.Error]
]);

/**
 * Коды, которые сервер умеет выдавать.
 *
 * Нужны, чтобы сказать о настройке с опечаткой. Молчать нельзя: правило,
 * названное с ошибкой, просто не применяется, и понять это по поведению
 * невозможно — выглядит как «настройка не работает».
 */
export const RSL_KNOWN_DIAGNOSTIC_CODES: readonly string[] = [
    "ambiguous-import",
    "argument-count",
    "ambiguous-reference",
    "assignment-to-constant",
    "branch-without-if",
    "constant-condition",
    "cyclic-import",
    "deprecated-declaration",
    "duplicate-branch-condition",
    "duplicate-declaration",
    "duplicate-else",
    "duplicate-import",
    "duplicate-import-basename",
    "duplicate-onerror",
    "elif-after-else",
    "extra-closing-bracket",
    "extra-end",
    "identifier-too-long",
    "import-inside-macro",
    "import-resolution",
    "incompatible-override",
    "incomplete-context",
    "invalid-money-constant",
    "invalid-onerror-context",
    "local-visibility-violation",
    "member-on-scalar-type",
    "missing-closing-bracket",
    "missing-end",
    "missing-reference-argument",
    "no-declaration",
    "overwritten-value",
    "redundant-import",
    "self-assignment",
    "self-comparison",
    "self-import",
    "string-literal-too-long",
    "unclosed-comment",
    "unclosed-square-block",
    "unclosed-string",
    "undeclared-variable",
    "unknown-member",
    "unknown-special-variable",
    "unknown-variable",
    "unreachable-code",
    "unused-declaration",
    "unused-expression",
    "unused-import",
    "use-before-declaration"
];

const KNOWN = new Set(RSL_KNOWN_DIAGNOSTIC_CODES);

/**
 * Приводит настройку к виду, в котором её можно применять.
 *
 * Неизвестный код и неизвестный уровень не применяются, а называются: тихо
 * проигнорированная настройка выглядит как поломка сервера.
 */
export function normalizeRslRuleSeverity(
    rules: Readonly<Record<string, unknown>> | undefined,
    onProblem?: (message: string) => void
): RslRuleSeverityMap | undefined {
    if (!rules) {
        return undefined;
    }

    const result: RslRuleSeverityMap = {};
    let count = 0;

    for (const [code, value] of Object.entries(rules)) {
        if (typeof value !== "string" || !BY_NAME.has(value as RslRuleSeverity)) {
            onProblem?.(
                "Правило «" + code + "»: неизвестный уровень " +
                JSON.stringify(value) + "; допустимы none, hint, information, " +
                "warning, error"
            );

            continue;
        }

        if (!KNOWN.has(code)) {
            onProblem?.(
                "Правило «" + code + "»: такого кода диагностики нет"
            );

            continue;
        }

        result[code] = value as RslRuleSeverity;
        count++;
    }

    return count > 0 ? result : undefined;
}

/**
 * Применяет настроенные уровни.
 *
 * Правило со значением `none` не публикуется вовсе — и не попадает в
 * счётчики: «выключено» должно означать «нет», а не «есть, но тихо».
 */
export function applyRslRuleSeverity(
    diagnostics: readonly Diagnostic[],
    rules: RslRuleSeverityMap | undefined
): Diagnostic[] {
    if (!rules) {
        return [...diagnostics];
    }

    const result: Diagnostic[] = [];

    for (const diagnostic of diagnostics) {
        const configured = rules[String(diagnostic.code ?? "")];

        if (configured === undefined) {
            result.push(diagnostic);

            continue;
        }

        const severity = BY_NAME.get(configured);

        if (severity === undefined) {
            /* none: правило выключено. */
            continue;
        }

        result.push(
            diagnostic.severity === severity
                ? diagnostic
                : { ...diagnostic, severity }
        );
    }

    return result;
}

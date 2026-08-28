import type { Diagnostic } from "vscode-languageserver";
import { DiagnosticSeverity } from "vscode-languageserver";

import type { IRslToken } from "../lexer";
import { RSL_KNOWN_DIAGNOSTIC_CODES } from "./ruleSeverity";

/**
 * Подавление сообщений комментариями в самом коде.
 *
 * Настройка выключает правило во всём проекте, а нужно бывает в одном месте:
 * автор посмотрел на находку, увидел, что здесь так и задумано, и хочет
 * сказать это рядом с кодом, а не в общем файле настроек, где через месяц
 * никто не поймёт, к чему относилось исключение.
 *
 * Директивы:
 *
 *   // rsl-disable-next-line код[, код...]   — только следующая строка
 *   // rsl-disable код[, код...]             — от этой строки и ниже
 *   // rsl-enable код[, код...]              — снова включить
 *   // rsl-disable-file код[, код...]        — весь файл
 *
 * Подавить синтаксическую ошибку, из-за которой не строится модель, нельзя:
 * без модели остальные проверки всё равно недостоверны, и молчание о причине
 * этого сделало бы файл необъяснимо «чистым».
 */

/** Коды, которые подавлять нельзя ни при каких директивах. */
const NEVER_SUPPRESSED = new Set([
    "missing-end",
    "extra-end",
    "missing-closing-bracket",
    "extra-closing-bracket",
    "unclosed-string",
    "unclosed-comment",
    "unclosed-square-block",
    "branch-without-if",
    "elif-after-else"
]);

const KNOWN = new Set(RSL_KNOWN_DIAGNOSTIC_CODES);

/** Разобранная директива подавления. */
interface IRslSuppressionDirective {
    kind: "next-line" | "disable" | "enable" | "file";
    codes: string[];
    line: number;
    /** Диапазон самой директивы: по нему сообщается о неизвестном коде. */
    token: IRslToken;
}

export interface IRslSuppressionResult {
    diagnostics: Diagnostic[];
    /** Сообщения о самих директивах: неизвестный код и тому подобное. */
    notices: Diagnostic[];
}

const DIRECTIVE = /^\s*(?:\/\/|\/\*)\s*rsl-(disable-next-line|disable-file|disable|enable)\b([^*\n]*)/u;

/** Разбирает директивы из комментариев потока токенов. */
function collectDirectives(
    tokens: readonly IRslToken[]
): IRslSuppressionDirective[] {
    const result: IRslSuppressionDirective[] = [];

    for (const token of tokens) {
        if (token.kind !== "comment") {
            continue;
        }

        const match = DIRECTIVE.exec(token.raw);

        if (!match) {
            continue;
        }

        const codes = match[2]
            .split(",")
            .map(item => item.trim().toLowerCase())
            .filter(Boolean);

        if (codes.length === 0) {
            continue;
        }

        const kind = match[1] === "disable-next-line"
            ? "next-line"
            : (match[1] === "disable-file"
                ? "file"
                : (match[1] as "disable" | "enable"));

        result.push({ kind, codes, line: token.line, token });
    }

    return result;
}

/**
 * Применяет директивы к найденным сообщениям.
 *
 * Подавленное сообщение исчезает совсем, а не прячется: оно не попадает ни в
 * список, ни в счётчики. «Выключено» должно означать «нет».
 */
export function applyRslSuppression(
    diagnostics: readonly Diagnostic[],
    tokens: readonly IRslToken[]
): IRslSuppressionResult {
    const directives = collectDirectives(tokens);

    if (directives.length === 0) {
        return { diagnostics: [...diagnostics], notices: [] };
    }

    const notices: Diagnostic[] = [];
    const forFile = new Set<string>();
    const forLine = new Map<number, Set<string>>();
    /* Код -> строки, с которых он выключен и снова включён. */
    const ranges = new Map<string, Array<{ from: number; to: number }>>();
    const open = new Map<string, number>();

    for (const directive of directives) {
        for (const code of directive.codes) {
            if (!KNOWN.has(code)) {
                notices.push(unknownCodeNotice(directive, code));

                continue;
            }

            if (directive.kind === "file") {
                forFile.add(code);

                continue;
            }

            if (directive.kind === "next-line") {
                const line = directive.line + 1;
                const known = forLine.get(line) || new Set<string>();

                known.add(code);
                forLine.set(line, known);

                continue;
            }

            if (directive.kind === "disable") {
                if (!open.has(code)) {
                    open.set(code, directive.line);
                }

                continue;
            }

            const from = open.get(code);

            if (from !== undefined) {
                addRange(ranges, code, from, directive.line);
                open.delete(code);
            }
        }
    }

    /* Незакрытый rsl-disable действует до конца файла. */
    for (const [code, from] of open) {
        addRange(ranges, code, from, Number.MAX_SAFE_INTEGER);
    }

    const kept: Diagnostic[] = [];

    for (const diagnostic of diagnostics) {
        const code = String(diagnostic.code ?? "").toLowerCase();

        if (NEVER_SUPPRESSED.has(code)) {
            kept.push(diagnostic);

            continue;
        }

        const line = diagnostic.range.start.line;

        if (
            forFile.has(code) ||
            forLine.get(line)?.has(code) ||
            (ranges.get(code) || []).some(range =>
                line >= range.from && line <= range.to)
        ) {
            continue;
        }

        kept.push(diagnostic);
    }

    return { diagnostics: kept, notices };
}

function addRange(
    ranges: Map<string, Array<{ from: number; to: number }>>,
    code: string,
    from: number,
    to: number
): void {
    const known = ranges.get(code) || [];

    known.push({ from, to });
    ranges.set(code, known);
}

function unknownCodeNotice(
    directive: IRslSuppressionDirective,
    code: string
): Diagnostic {
    return {
        code: "unknown-suppression-code",
        severity: DiagnosticSeverity.Information,
        message: "Правило «" + code + "» не существует: подавлять нечего",
        range: {
            start: {
                line: directive.token.line,
                character: directive.token.character
            },
            end: {
                line: directive.token.endLine,
                character: directive.token.endCharacter
            }
        },
        source: "rsl"
    };
}

import * as fs from "fs";
import * as path from "path";

import type { Diagnostic } from "vscode-languageserver";

import {
    isInsideContext,
    relativeRslPath,
    RslProjectAnalysis,
    RslUnreadableFileError,
    type IRslAnalyzedFile
} from "../analysis/projectAnalysis";
import {
    normalizeRslRuleSeverity
} from "../diagnostics/ruleSeverity";
import type { IRslDiagnosticSettings } from "../interfaces";

/**
 * Команда `rsl-plus check`: анализ выбранных файлов вне редактора.
 *
 * Отвечает только за анализ и вывод. Ни Git, ни история, ни сравнение ревизий,
 * ни решение о судьбе merge request сюда не входят: этим занимается тот, кто
 * вызывает команду, и ему нужен разбираемый ответ, а не готовый вердикт.
 *
 * Поэтому и коды возврата не зависят от находок: ошибка в проверяемом файле —
 * это результат работы, а не сбой. Ненулевым завершается только то, что
 * помешало работе: неверные аргументы, нечитаемый файл, внутренний сбой.
 */

/** Код завершения: см. заголовок. */
export const RSL_CHECK_EXIT = {
    ok: 0,
    badArguments: 2,
    unreadableFile: 3,
    internalFailure: 4
} as const;

export interface IRslCheckOutput {
    /** Результат выбранного формата: только он и ничего больше. */
    stdout(line: string): void;
    /** Прогресс, предупреждения и описания сбоев. */
    stderr(line: string): void;
}

export interface IRslCheckArguments {
    contextRoot: string;
    files: string[];
    format: "text" | "jsonl";
    summary: boolean;
    configPath?: string;
}

/** Разбор аргументов; строка вместо результата — это отказ с причиной. */
export function parseRslCheckArguments(
    argv: readonly string[],
    cwd: string
): IRslCheckArguments | string {
    let contextRoot: string | undefined;
    let format: "text" | "jsonl" = "text";
    let summary = false;
    let configPath: string | undefined;
    const files: string[] = [];

    for (let at = 0; at < argv.length; at++) {
        const argument = argv[at];

        switch (argument) {
            case "--context":
                contextRoot = argv[++at];

                if (!contextRoot) {
                    return "у --context нет значения";
                }

                break;
            case "--format": {
                const value = argv[++at];

                if (value !== "text" && value !== "jsonl") {
                    return "неизвестный формат: " + String(value);
                }

                format = value;
                break;
            }
            case "--summary":
                summary = true;
                break;
            case "--config":
                configPath = argv[++at];

                if (!configPath) {
                    return "у --config нет значения";
                }

                break;
            default:
                if (argument.startsWith("--")) {
                    return "неизвестный параметр: " + argument;
                }

                files.push(argument);
        }
    }

    if (!contextRoot) {
        return "нужен --context <корень проекта>";
    }

    if (files.length === 0) {
        /*
         * Пустой список — это не «проверить весь проект». Проверка всего
         * проекта стоит минуты, и запускать её по недосмотру нельзя.
         */
        return "нужен хотя бы один проверяемый файл";
    }

    if (summary && format === "jsonl") {
        /*
         * У машинного протокола не может быть двух разных смыслов: либо
         * записи о диагностиках, либо их отсутствие.
         */
        return "--summary несовместим с --format jsonl";
    }

    const root = path.resolve(cwd, contextRoot);

    if (!isDirectory(root)) {
        return "каталог контекста не найден: " + contextRoot;
    }

    for (const file of files) {
        const resolved = path.resolve(root, file);

        if (!isInsideContext(root, resolved)) {
            return "файл вне контекста: " + file;
        }
    }

    return { contextRoot: root, files, format, summary, configPath };
}

/**
 * Настройки диагностик для запуска.
 *
 * Настройки редактора из профиля пользователя не читаются намеренно: результат
 * команды не должен зависеть от того, кто и как настроил свой VS Code.
 */
/**
 * Итог чтения настроек.
 *
 * Отдельный признак неудачи нужен потому, что «настроек нет» и «настройки
 * задали, а прочитать их не вышло» — разные события. Первое нормально:
 * проверки идут со значениями по умолчанию. Второе обязано останавливать
 * работу: молча пойти с умолчаниями значит незаметно включить или выключить
 * правила в CI, и увидеть это будет негде.
 */
export type RslCheckSettingsResult =
    | { ok: true; settings?: IRslDiagnosticSettings }
    | { ok: false };

export function loadRslCheckSettings(
    args: IRslCheckArguments,
    output: IRslCheckOutput
): RslCheckSettingsResult {
    const explicit = !!args.configPath;
    const candidate = explicit
        ? path.resolve(args.contextRoot, args.configPath as string)
        : path.join(args.contextRoot, "rsl-plus.json");

    if (!fs.existsSync(candidate)) {
        if (explicit) {
            output.stderr("Файл настроек не найден: " + candidate);

            return { ok: false };
        }

        return { ok: true };
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
    } catch (error) {
        output.stderr(
            "Файл настроек не прочитан: " + candidate + ": " + String(error)
        );

        return { ok: false };
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        output.stderr(
            "Файл настроек " + candidate + ": ожидается объект"
        );

        return { ok: false };
    }

    const diagnostics = (parsed as { diagnostics?: unknown }).diagnostics;

    if (
        diagnostics !== undefined &&
        (!diagnostics ||
            typeof diagnostics !== "object" ||
            Array.isArray(diagnostics))
    ) {
        output.stderr(
            "Файл настроек " + candidate + ": diagnostics обязан быть объектом"
        );

        return { ok: false };
    }

    const settings = diagnostics as IRslDiagnosticSettings | undefined;
    let broken = false;

    /*
     * Настройка с опечаткой называется вслух и останавливает работу. Молча
     * пропущенная, она выглядит как «уровень правила не работает», и
     * разобраться в этом по поведению нельзя.
     */
    normalizeRslRuleSeverity(settings?.rules, message => {
        output.stderr("Настройки: " + message);
        broken = true;
    });

    return broken ? { ok: false } : { ok: true, settings };
}

export function runRslCheck(
    argv: readonly string[],
    cwd: string,
    output: IRslCheckOutput
): number {
    const args = parseRslCheckArguments(argv, cwd);

    if (typeof args === "string") {
        output.stderr("rsl-plus check: " + args);
        output.stderr(USAGE);

        return RSL_CHECK_EXIT.badArguments;
    }

    const loaded = loadRslCheckSettings(args, output);

    if (!loaded.ok) {
        output.stderr("rsl-plus check: настройки непригодны, анализ не начат");

        return RSL_CHECK_EXIT.badArguments;
    }

    const settings = loaded.settings;
    let analyzed: IRslAnalyzedFile[];
    let analysis: RslProjectAnalysis;

    try {
        analysis = new RslProjectAnalysis({
            contextRoot: args.contextRoot,
            settings,
            log: message => output.stderr(message)
        });
        analysis.prepare();
        output.stderr(
            "Контекст: " + args.contextRoot + ", файлов проекта " +
            analysis.projectFileCount
        );
        analyzed = analysis.analyze(args.files);
    } catch (error) {
        if (error instanceof RslUnreadableFileError) {
            output.stderr("rsl-plus check: " + error.message);

            return RSL_CHECK_EXIT.unreadableFile;
        }

        output.stderr(
            "rsl-plus check: внутренний сбой анализатора: " +
            (error instanceof Error ? error.stack || error.message : String(error))
        );

        return RSL_CHECK_EXIT.internalFailure;
    }

    output.stderr(
        "Загружено зависимостей: " + analysis.loadedDependencies
    );

    if (args.format === "jsonl") {
        writeJsonl(args, analyzed, output);
    } else {
        writeText(args, analyzed, output);
    }

    return RSL_CHECK_EXIT.ok;
}

const USAGE = [
    "Использование:",
    "  rsl-plus check --context <корень проекта> <файл.mac> [ещё файлы]",
    "",
    "Параметры:",
    "  --context <путь>     корень проекта: по нему разрешаются Import",
    "  --format text|jsonl  формат вывода, по умолчанию text",
    "  --summary            только счётчики по файлам (несовместим с jsonl)",
    "  --config <путь>      файл настроек диагностик"
].join("\n");

/* ─────────────────────────── человекочитаемый ──────────────────────────── */

const SEVERITY_LETTER = ["E", "W", "I", "H"];
const SEVERITY_NAME = ["error", "warning", "information", "hint"];

function severityIndex(diagnostic: Diagnostic): number {
    const value = diagnostic.severity ?? 1;

    return Math.min(3, Math.max(0, value - 1));
}

/** Счётчики по важности: E, W, I, H. */
function countBySeverity(diagnostics: readonly Diagnostic[]): number[] {
    const counts = [0, 0, 0, 0];

    for (const diagnostic of diagnostics) {
        counts[severityIndex(diagnostic)]++;
    }

    return counts;
}

function formatCounts(counts: readonly number[]): string {
    return SEVERITY_LETTER
        .map((letter, at) => letter + ":" + counts[at])
        .join(" ");
}

/** Сообщение в одну строку: переводы строк заменяются пробелами. */
function oneLine(message: string): string {
    return message.replace(/\s*[\r\n]+\s*/gu, " ").trim();
}

function writeText(
    args: IRslCheckArguments,
    analyzed: readonly IRslAnalyzedFile[],
    output: IRslCheckOutput
): void {
    const total = [0, 0, 0, 0];
    let incomplete = 0;
    let messages = 0;

    for (const file of analyzed) {
        const counts = countBySeverity(file.diagnostics);

        for (let at = 0; at < total.length; at++) {
            total[at] += counts[at];
        }

        messages += file.diagnostics.length;

        if (file.status === "incomplete") {
            incomplete++;
        }

        if (args.summary) {
            output.stdout(file.file + " — " + formatCounts(counts));

            continue;
        }

        if (file.diagnostics.length === 0 && file.status === "complete") {
            /* Чистый файл с полным контекстом сказать нечего. */
            continue;
        }

        output.stdout(
            file.status === "incomplete"
                ? file.file + " (" + file.diagnostics.length + ", " +
                    describeIssues(file) + ")"
                : file.file + " (" + file.diagnostics.length + ")"
        );

        for (const diagnostic of file.diagnostics) {
            output.stdout(
                "  " + (diagnostic.range.start.line + 1) + ":" +
                (diagnostic.range.start.character + 1) + "-" +
                (diagnostic.range.end.line + 1) + ":" +
                (diagnostic.range.end.character + 1) + " " +
                SEVERITY_LETTER[severityIndex(diagnostic)] + " " +
                String(diagnostic.code ?? "") + " — " +
                oneLine(diagnostic.message)
            );
        }
    }

    output.stdout(
        "Итого: файлов " + analyzed.length + ", сообщений " + messages +
        " — " + formatCounts(total) + ", неполный контекст: " + incomplete
    );
}

function describeIssues(file: IRslAnalyzedFile): string {
    const missing = file.issues
        .filter(issue => issue.code === "unresolved-import")
        .map(issue => issue.module);
    const ambiguous = file.issues
        .filter(issue => issue.code === "ambiguous-import")
        .map(issue => issue.module);
    const parts: string[] = [];

    if (missing.length > 0) {
        parts.push("не найден " + missing.join(", "));
    }

    if (ambiguous.length > 0) {
        parts.push("неоднозначен " + ambiguous.join(", "));
    }

    return "контекст неполный: " +
        (parts.length > 0 ? parts.join("; ") : "причина не установлена");
}

/* ───────────────────────────────── JSONL ───────────────────────────────── */

const SCHEMA_VERSION = 1;

function writeJsonl(
    args: IRslCheckArguments,
    analyzed: readonly IRslAnalyzedFile[],
    output: IRslCheckOutput
): void {
    output.stdout(JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        record: "run",
        context: args.contextRoot.split(path.sep).join("/"),
        requestedFiles: analyzed.length
    }));

    let errors = 0;
    let warnings = 0;
    let information = 0;
    let hints = 0;
    let completeFiles = 0;
    let incompleteFiles = 0;

    for (const file of analyzed) {
        if (file.status === "complete") {
            completeFiles++;
            output.stdout(JSON.stringify({
                schemaVersion: SCHEMA_VERSION,
                record: "file",
                file: file.file,
                status: "complete"
            }));
        } else {
            incompleteFiles++;
            output.stdout(JSON.stringify({
                schemaVersion: SCHEMA_VERSION,
                record: "file",
                file: file.file,
                status: "incomplete",
                issues: file.issues
            }));
        }

        for (const diagnostic of file.diagnostics) {
            const at = severityIndex(diagnostic);

            if (at === 0) {
                errors++;
            } else if (at === 1) {
                warnings++;
            } else if (at === 2) {
                information++;
            } else {
                hints++;
            }

            output.stdout(JSON.stringify({
                schemaVersion: SCHEMA_VERSION,
                record: "diagnostic",
                file: file.file,
                severity: SEVERITY_NAME[at],
                code: String(diagnostic.code ?? ""),
                start: {
                    line: diagnostic.range.start.line,
                    column: diagnostic.range.start.character
                },
                end: {
                    line: diagnostic.range.end.line,
                    column: diagnostic.range.end.character
                },
                message: diagnostic.message
            }));
        }
    }

    output.stdout(JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        record: "summary",
        files: analyzed.length,
        completeFiles,
        incompleteFiles,
        errors,
        warnings,
        information,
        hints
    }));
}

function isDirectory(target: string): boolean {
    try {
        return fs.statSync(target).isDirectory();
    } catch {
        return false;
    }
}

/** Путь относительно контекста: экспортируется для тестов и стенда. */
export { relativeRslPath };

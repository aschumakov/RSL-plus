import * as fs from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

import type { Diagnostic } from "vscode-languageserver";

import { decodeRslSourceText } from "../core/textDecoding";
import { extractCompactDeclarations } from "./declarationExtractor";
import { RslDiagnosticEngine } from "../diagnostics/diagnosticEngine";
import type { IRslDiagnosticSettings } from "../interfaces";
import { RslScopeResolver } from "../scopeResolver";
import { WorkspaceIndex } from "../workspaceIndex";

/**
 * Анализ выбранных файлов в контексте проекта.
 *
 * Одно ядро на редактор и на командную строку. Редактор держит его открытым и
 * докладывает в него правки, командная строка создаёт на один запуск — но путь
 * от текста до диагностики у них один и тот же, иначе CLI отвечал бы не то,
 * что показывает редактор, и сверить их было бы нечем.
 *
 * Проверяются только те файлы, о которых попросили. Остальной проект — это
 * контекст: по нему разрешаются имена модулей и подгружаются зависимости, но
 * ни разбирать несвязанные файлы, ни публиковать их ошибки ядро не станет.
 */

/** Почему контекст файла неполон. */
export interface IRslContextIssue {
    /** `unresolved-import` или `ambiguous-import`. */
    code: string;
    /** Имя модуля, из-за которого контекст неполон. */
    module: string;
}

export interface IRslAnalyzedFile {
    /** Путь относительно корня контекста, всегда через прямую косую черту. */
    file: string;
    uri: string;
    /** Полон ли контекст: неполный делает часть выводов недостоверными. */
    status: "complete" | "incomplete";
    issues: IRslContextIssue[];
    diagnostics: Diagnostic[];
}

export interface IRslProjectAnalysisOptions {
    /** Корень проекта: по нему разрешаются Import и считаются пути. */
    contextRoot: string;
    settings?: IRslDiagnosticSettings;
    log?(message: string): void;
    isCancelled?(): boolean;
}

/** Не удалось прочитать явно запрошенный файл. */
export class RslUnreadableFileError extends Error {
    constructor(public readonly file: string, public readonly reason: string) {
        super("Не удалось прочитать " + file + ": " + reason);
        this.name = "RslUnreadableFileError";
    }
}

/** Путь в виде, в каком его печатают: относительный, через прямую черту. */
export function relativeRslPath(contextRoot: string, target: string): string {
    return path
        .relative(path.resolve(contextRoot), path.resolve(target))
        .split(path.sep)
        .join("/");
}

/** Лежит ли файл внутри корня контекста. */
export function isInsideContext(contextRoot: string, target: string): boolean {
    const relative = relativeRslPath(contextRoot, target);

    return relative.length > 0 &&
        !relative.startsWith("../") &&
        !path.isAbsolute(relative);
}

export class RslProjectAnalysis {
    private readonly index = new WorkspaceIndex();
    private readonly engine = new RslDiagnosticEngine();
    private readonly resolver: RslScopeResolver;
    private readonly contextRoot: string;
    /** Файлы проекта: только имена, без содержимого. */
    private projectFiles: string[] = [];
    /** Уже загруженные зависимости: общая для нескольких файлов грузится раз. */
    private readonly loaded = new Set<string>();

    constructor(private readonly options: IRslProjectAnalysisOptions) {
        this.contextRoot = path.resolve(options.contextRoot);
        this.resolver = new RslScopeResolver(this.index);
    }

    /** Сколько зависимостей загружено: для отчёта о работе. */
    get loadedDependencies(): number {
        return this.loaded.size;
    }

    /** Сколько файлов нашлось в контексте. */
    get projectFileCount(): number {
        return this.projectFiles.length;
    }

    /**
     * Составляет список файлов проекта.
     *
     * Читается только перечень имён: он нужен, чтобы разрешать Import. Ни один
     * файл при этом не открывается — содержимое читается только у тех, кого
     * попросили проверить, и у их зависимостей.
     */
    prepare(): void {
        this.projectFiles = collectMacFiles(this.contextRoot);
        this.index.registerWorkspaceFiles(
            this.projectFiles.map(file => pathToFileURL(file).toString())
        );
    }

    /**
     * Проверяет заданные файлы.
     *
     * Порядок ответа не зависит от порядка запроса: файлы упорядочены по
     * нормализованному пути, диагностики — по положению.
     */
    analyze(files: readonly string[]): IRslAnalyzedFile[] {
        const unique = new Map<string, string>();

        for (const file of files) {
            const resolved = path.resolve(this.contextRoot, file);

            unique.set(relativeRslPath(this.contextRoot, resolved), resolved);
        }

        const requested = [...unique.entries()]
            .sort((left, right) => compare(left[0], right[0]));
        const result: IRslAnalyzedFile[] = [];

        /*
         * Сначала открываются все запрошенные файлы, потом грузятся
         * зависимости. Иначе файл, импортирующий другой запрошенный, увидел бы
         * его компактную сводку вместо подробной модели.
         */
        for (const [, absolute] of requested) {
            this.openRequested(absolute);
        }

        for (const [, absolute] of requested) {
            this.loadDependencies(pathToFileURL(absolute).toString());
        }

        for (const [file, absolute] of requested) {
            if (this.options.isCancelled?.()) {
                break;
            }

            result.push(this.diagnose(file, absolute));
        }

        return result;
    }

    /** Читает и разбирает запрошенный файл. */
    private openRequested(absolute: string): void {
        const uri = pathToFileURL(absolute).toString();

        let source: string;

        try {
            source = decodeRslSourceText(fs.readFileSync(absolute));
        } catch (error) {
            throw new RslUnreadableFileError(
                relativeRslPath(this.contextRoot, absolute),
                error instanceof Error ? error.message : String(error)
            );
        }

        this.index.updateOpenModule(uri, source, 1);
        this.loaded.add(uri);
    }

    /**
     * Грузит прямые и транзитивные зависимости.
     *
     * Зависимость читается компактным разбором: подробная модель нужна только
     * проверяемым файлам, а объявлений хватает, чтобы разрешать имена. Общая
     * зависимость нескольких файлов грузится один раз за запуск.
     */
    private loadDependencies(uri: string): void {
        const queue = [uri];

        for (let at = 0; at < queue.length; at++) {
            const current = this.index.getModule(queue[at]);

            if (!current) {
                continue;
            }

            for (const name of current.imports) {
                const resolution = this.index.resolveWorkspaceFile(name);

                if (resolution.kind !== "resolved") {
                    /* Нет файла или их несколько: это состояние контекста. */
                    continue;
                }

                if (this.loaded.has(resolution.value)) {
                    continue;
                }

                this.loaded.add(resolution.value);

                if (this.loadDependency(resolution.value)) {
                    queue.push(resolution.value);
                }
            }
        }
    }

    /** Компактная сводка зависимости; false — прочитать не удалось. */
    private loadDependency(uri: string): boolean {
        let source: string;

        try {
            source = decodeRslSourceText(
                fs.readFileSync(rslPathFromUri(uri))
            );
        } catch (error) {
            /*
             * Нечитаемая зависимость не обрывает анализ: проверяемый файл
             * получит неполный контекст, а не техническую ошибку.
             */
            this.options.log?.(
                "Зависимость не прочитана: " + uri + ": " + String(error)
            );

            return false;
        }

        const compact = extractCompactDeclarations(source);

        this.index.updateExternalModuleFromDeclarations(
            uri,
            source.length,
            compact,
            1
        );

        return true;
    }

    /** Диагностики одного проверяемого файла вместе с состоянием контекста. */
    private diagnose(file: string, absolute: string): IRslAnalyzedFile {
        const uri = pathToFileURL(absolute).toString();
        const module = this.index.getModule(uri);

        if (!module) {
            return {
                file,
                uri,
                status: "incomplete",
                issues: [{ code: "unreadable-file", module: file }],
                diagnostics: []
            };
        }

        const state = this.resolver.getImportContextState(uri);
        /*
         * Что делает контекст неполным.
         *
         * Неоднозначное имя — файл есть, но их несколько, и какой из них имел
         * в виду автор, неизвестно. Ненайденное имя — файла в проекте нет
         * вовсе: так выглядит и опечатка, и Import встроенного модуля
         * платформы, каталог которого командной строке не передан. Различить
         * их отсюда нечем, поэтому оба помечают анализ неполным — но не
         * ошибкой: сообщения проверяемого файла публикуются как обычно, а
         * решение, важна ли эта неполнота, принимает тот, кто вызвал команду.
         */
        const issues: IRslContextIssue[] = [
            ...state.ambiguous.map(module_ => ({
                code: "ambiguous-import",
                module: module_
            })),
            ...[...state.pending, ...state.opaque].map(module_ => ({
                code: "unresolved-import",
                module: module_
            }))
        ];
        const isCancelled = this.options.isCancelled;
        const local = this.engine.buildLocal(
            module,
            this.index,
            this.options.settings,
            isCancelled,
            this.resolver
        );
        const workspace = this.engine.buildWorkspace(
            module,
            this.index,
            this.options.settings,
            isCancelled,
            this.resolver
        );

        return {
            file,
            uri,
            status: issues.length > 0 ? "incomplete" : "complete",
            issues,
            diagnostics: sortDiagnostics(dedupe([...local, ...workspace]))
        };
    }
}

/**
 * Путь к файлу по его URI.
 *
 * Стандартной функцией, а не разбором строки. Ручное срезание `file:///`
 * уносило вместе с ним корень пути: `file:///tmp/lib.mac` превращался в
 * `tmp/lib.mac`, и на Linux зависимость читалась относительно текущего
 * каталога, то есть не читалась вовсе. На Windows та же ошибка не видна —
 * `file:///d:/lib.mac` даёт `d:/lib.mac`, и путь остаётся годным.
 */
export function rslPathFromUri(uri: string): string {
    return fileURLToPath(uri);
}

function compare(left: string, right: string): number {
    return left < right ? -1 : (left > right ? 1 : 0);
}

function dedupe(diagnostics: readonly Diagnostic[]): Diagnostic[] {
    const seen = new Set<string>();
    const result: Diagnostic[] = [];

    for (const item of diagnostics) {
        const key = [
            item.code,
            item.range.start.line,
            item.range.start.character,
            item.range.end.line,
            item.range.end.character,
            item.message
        ].join("\0");

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(item);
    }

    return result;
}

/**
 * Порядок диагностик: положение, потом важность, код и сообщение.
 *
 * Он обязан быть полным: одинаковый вход должен давать побайтно одинаковый
 * вывод, а внешняя автоматизация сравнивает результаты разных запусков.
 */
function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
    return diagnostics.sort((left, right) =>
        left.range.start.line - right.range.start.line ||
        left.range.start.character - right.range.start.character ||
        left.range.end.line - right.range.end.line ||
        left.range.end.character - right.range.end.character ||
        (left.severity ?? 1) - (right.severity ?? 1) ||
        compare(String(left.code ?? ""), String(right.code ?? "")) ||
        compare(left.message, right.message));
}

/** Все .mac в контексте: только имена, без чтения содержимого. */
function collectMacFiles(root: string): string[] {
    const result: string[] = [];
    const stack = [root];

    while (stack.length > 0) {
        const current = stack.pop() as string;
        let entries: fs.Dirent[];

        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const full = path.join(current, entry.name);

            if (entry.isDirectory()) {
                if (entry.name !== ".git" && entry.name !== "node_modules") {
                    stack.push(full);
                }

                continue;
            }

            if (/\.mac$/iu.test(entry.name)) {
                result.push(full);
            }
        }
    }

    return result.sort();
}

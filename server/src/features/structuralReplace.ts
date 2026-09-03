import type { TextEdit, WorkspaceEdit } from "vscode-languageserver";

import { contentFingerprint } from "../analysis/contentFingerprint";
import { lexRsl } from "../lexer";
import { rangeInModule } from "../core/documentPosition";
import {
    parseRslStructuralPattern,
    type IRslStructuralMatch
} from "./structuralSearch";
import {
    walkRslStructuralCandidates,
    type IRslStructuralSearchEnvironment
} from "./structuralSearchService";

/**
 * Замена по структуре кода.
 *
 * Продолжение структурного поиска: образец описывает форму вызова, шаблон —
 * во что его переписать. То, что попало в заполнители, переносится ДОСЛОВНО:
 *
 *   образец  ExecMacroFile($file, $args...)
 *   шаблон   ExecMacro2($file, $args...)
 *
 * Почему замена не «поиск плюс правка текста». Правка по найденным диапазонам
 * опасна ровно тем, что диапазоны устаревают: между поиском и применением файл
 * могли поправить — руками, другой правкой, переключением ветки, — и старый
 * диапазон указывает уже не туда. Поэтому применение отделено от подготовки, а
 * между ними содержимое каждого файла сверяется: у открытого документа по
 * версии, у закрытого по отпечатку содержимого. Сверка отпечатка НЕ требует
 * второго разбора файла — только чтения.
 *
 * BOM, CRLF и CP866 сохраняются сами. Правки отдаются диапазонами, а не новым
 * текстом файла целиком: кодировку, признак BOM и вид перевода строки решает
 * тот, кто пишет файл, и переписывать их нам незачем. Текст замены переводов
 * строки не вносит: всё, что в нём есть, — либо написанное пользователем, либо
 * дословно перенесённое из этого же файла.
 */

/** Разобранный шаблон замены: куски текста и заполнители по порядку. */
export interface IRslReplacementTemplate {
    parts: readonly IRslReplacementPart[];
    /** Имена заполнителей, встречающихся в шаблоне. */
    placeholders: readonly string[];
}

export interface IRslReplacementPart {
    /** Буквальный текст; пусто у заполнителя. */
    text?: string;
    /** Имя заполнителя без `$`. */
    placeholder?: string;
}

export interface IRslReplacementTemplateResult {
    template?: IRslReplacementTemplate;
    problem?: string;
}

export interface IRslStructuralReplaceRequest {
    pattern: string;
    replacement: string;
    /** Сколько замен готовить; остальное не ищется. */
    limit?: number;
}

/** Одна замена: что было и что станет. */
export interface IRslStructuralReplacePreview {
    uri: string;
    range: ReturnType<typeof rangeInModule>;
    before: string;
    after: string;
}

/** Состояние файла на момент подготовки: по нему сверяется применение. */
export interface IRslStructuralReplaceSource {
    uri: string;
    /** Версия открытого документа; отсутствует у закрытого файла. */
    version?: number;
    /** Отпечаток содержимого: единственная опора для закрытого файла. */
    fingerprint: string;
    edits: TextEdit[];
}

export interface IRslStructuralReplaceAnswer {
    previews: IRslStructuralReplacePreview[];
    /** Состояние файлов: нужно применению, наружу не показывается. */
    sources: IRslStructuralReplaceSource[];
    files: number;
    replacements: number;
    scannedFiles: number;
    skippedFiles: number;
    problem?: string;
    cancelled?: boolean;
    truncated?: boolean;
    /** Совпадения, вложенные в другие: заменять их нельзя. */
    overlapping: number;
}

export interface IRslStructuralApplyAnswer {
    edit?: WorkspaceEdit;
    files: number;
    replacements: number;
    /** Файлы, изменившиеся после подготовки: их правки отброшены. */
    staleFiles: string[];
    problem?: string;
}

const DEFAULT_LIMIT = 500;

/**
 * Подготовленная замена в ожидании подтверждения.
 *
 * Одна: пользователь работает с одной заменой за раз, и копить их
 * незачем. Но у неё есть НОМЕР, и применение обязано его назвать.
 *
 * Без номера получалась подмена. Подготовка `Foo -> Bar` показывает
 * предпросмотр; пользователь его читает; в это время запускается вторая
 * подготовка `Old -> New` и вытесняет первую; пользователь нажимает
 * «Применить» в ПЕРВОМ окне — и применяется вторая замена. Сверка
 * отпечатков этого не ловит и поймать не может: файлы второй замены не
 * менялись, отпечатки верны, диапазоны верны. Неверно то, что
 * пользователь подтверждал не это.
 */
export class RslStructuralReplaceSession {
    private pending: {
        id: string;
        sources: readonly IRslStructuralReplaceSource[];
    } | undefined;
    private counter = 0;

    /**
     * Запомнить подготовленное и выдать номер.
     *
     * Прежняя подготовка вытесняется — это и раньше было так. Разница в
     * том, что применить её теперь нельзя: номер у неё был другой.
     */
    remember(sources: readonly IRslStructuralReplaceSource[]): string {
        const id = "replace-" + ++this.counter;

        this.pending = { id, sources };

        return id;
    }

    /**
     * Забрать подготовленное по номеру.
     *
     * Пусто означает «это не та замена или её уже применили». Забирается
     * один раз: предпросмотр применяют однажды, а второе применение того
     * же номера — это повторная правка уже правленых файлов.
     */
    take(id: string): readonly IRslStructuralReplaceSource[] | undefined {
        if (!this.pending || !id || this.pending.id !== id) {
            return undefined;
        }

        const sources = this.pending.sources;

        this.pending = undefined;

        return sources;
    }

    /** Есть ли что применять; для проверок. */
    get hasPending(): boolean {
        return this.pending !== undefined;
    }
}

/**
 * Разбирает шаблон замены.
 *
 * Лексер здесь не нужен и был бы вреден: шаблон — это текст, а не код. `$$`
 * означает сам знак доллара: в RSL он начинает литерал, и написать его в
 * замене должно быть можно.
 */
export function parseRslReplacementTemplate(
    text: string
): IRslReplacementTemplateResult {
    const value = String(text ?? "");

    if (!value.trim()) {
        return { problem: "Шаблон замены пуст" };
    }

    const parts: IRslReplacementPart[] = [];
    const placeholders: string[] = [];
    let literal = "";

    for (let at = 0; at < value.length; at++) {
        if (value.charAt(at) !== "$") {
            literal += value.charAt(at);
            continue;
        }

        if (value.charAt(at + 1) === "$") {
            literal += "$";
            at++;
            continue;
        }

        const name = placeholderNameAt(value, at + 1);

        if (!name) {
            return {
                problem: "После $ ожидается имя заполнителя; сам знак — $$"
            };
        }

        if (literal) {
            parts.push({ text: literal });
            literal = "";
        }

        parts.push({ placeholder: name });

        if (!placeholders.includes(name)) {
            placeholders.push(name);
        }

        /* `$args...` и `$args` в шаблоне значат одно: подставить связанное. */
        at += name.length;

        if (value.startsWith("...", at + 1)) {
            at += 3;
        }
    }

    if (literal) {
        parts.push({ text: literal });
    }

    return { template: { parts, placeholders } };
}

/** Текст замены для одного совпадения. */
export function applyRslReplacementTemplate(
    template: IRslReplacementTemplate,
    bindings: Record<string, string>
): string {
    let result = "";

    for (const part of template.parts) {
        result += part.placeholder !== undefined
            ? bindings[part.placeholder] ?? ""
            : part.text ?? "";
    }

    return result;
}

/**
 * Готовит замену: находит совпадения и складывает правки по файлам.
 *
 * Ничего не применяет. Применение — отдельный шаг, и между ними содержимое
 * файлов сверяется заново: см. applyRslStructuralReplace.
 */
export async function prepareRslStructuralReplace(
    environment: IRslStructuralSearchEnvironment,
    request: IRslStructuralReplaceRequest,
    isCancelled: () => boolean = () => false
): Promise<IRslStructuralReplaceAnswer> {
    const parsed = parseRslStructuralPattern(
        request.pattern,
        source => lexRsl(source).tokens
    );

    if (!parsed.pattern) {
        return empty(parsed.problem || "Образец не разобран");
    }

    const template = parseRslReplacementTemplate(request.replacement);

    if (!template.template) {
        return empty(template.problem || "Шаблон не разобран");
    }

    /*
     * Заполнитель, которого в образце нет, связать нечем.
     *
     * Молча подставить пустоту нельзя: это тихо испортило бы код во всех
     * найденных файлах сразу.
     */
    const known = new Set(
        parsed.pattern.arguments
            .map(item => item.placeholder)
            .filter((name): name is string => !!name)
    );
    const unknown = template.template.placeholders.filter(
        name => !known.has(name)
    );

    if (unknown.length > 0) {
        return empty(
            "В образце нет заполнителей: " + unknown.map(n => "$" + n).join(", ")
        );
    }

    const limit = Math.max(1, request.limit ?? DEFAULT_LIMIT);
    const previews: IRslStructuralReplacePreview[] = [];
    const sources: IRslStructuralReplaceSource[] = [];
    let replacements = 0;
    let overlapping = 0;

    const walked = await walkRslStructuralCandidates(
        environment,
        parsed.pattern,
        isCancelled,
        file => {
            if (file.matches.length === 0) {
                return true;
            }

            const usable = withoutOverlaps(file.matches);

            overlapping += file.matches.length - usable.length;

            const edits: TextEdit[] = [];

            for (const match of usable) {
                if (replacements >= limit) {
                    break;
                }

                const after = applyRslReplacementTemplate(
                    template.template!,
                    match.bindings
                );
                const before = file.source.slice(match.start, match.end);

                if (after === before) {
                    /* Замена ничего не меняет: правки для неё не нужно. */
                    continue;
                }

                const range = rangeInModule(
                    { lex: { lineStarts: file.lex.lineStarts } } as never,
                    match.start,
                    match.end
                );

                edits.push({ range, newText: after });
                previews.push({ uri: file.uri, range, before, after });
                replacements++;
            }

            if (edits.length > 0) {
                sources.push({
                    uri: file.uri,
                    version: environment.documentVersion?.(file.uri),
                    fingerprint: contentFingerprint(file.source),
                    edits
                });
            }

            return replacements < limit;
        }
    );

    return {
        previews,
        sources,
        files: sources.length,
        replacements,
        scannedFiles: walked.scannedFiles,
        skippedFiles: Math.max(0, walked.totalFiles - walked.scannedFiles),
        cancelled: walked.cancelled || undefined,
        truncated: walked.stopped || undefined,
        overlapping
    };
}

/**
 * Собирает правку из подготовленной — сверив, что файлы не изменились.
 *
 * Между подготовкой и применением пользователь читает предпросмотр, и за это
 * время файл могли поправить. Применять старые диапазоны нельзя: они указывают
 * уже не туда, и правка испортила бы код молча.
 *
 * У открытого документа опора — его версия: она входит в саму правку, и
 * несовпадение отклонит уже редактор. У закрытого — отпечаток содержимого;
 * файл для этого перечитывается, но НЕ разбирается заново.
 */
export async function applyRslStructuralReplace(
    environment: IRslStructuralSearchEnvironment,
    sources: readonly IRslStructuralReplaceSource[],
    isCancelled: () => boolean = () => false
): Promise<IRslStructuralApplyAnswer> {
    const documentChanges: WorkspaceEdit["documentChanges"] = [];
    const staleFiles: string[] = [];
    let replacements = 0;

    for (const source of sources) {
        if (isCancelled()) {
            return {
                files: 0,
                replacements: 0,
                staleFiles,
                problem: "Замена отменена"
            };
        }

        const current = await environment.readSource(source.uri);

        if (
            current === undefined ||
            contentFingerprint(current) !== source.fingerprint
        ) {
            staleFiles.push(source.uri);
            continue;
        }

        documentChanges.push({
            textDocument: {
                uri: source.uri,
                /*
                 * Версия открытого документа входит в правку: если он
                 * изменился, её отклонит редактор, а не мы. У закрытого файла
                 * версии нет, и его защищает сверенный отпечаток.
                 */
                version: source.version ?? null
            },
            edits: source.edits
        });
        replacements += source.edits.length;
    }

    return {
        edit: documentChanges.length > 0 ? { documentChanges } : undefined,
        files: documentChanges.length,
        replacements,
        staleFiles
    };
}

/**
 * Совпадения без вложенных друг в друга.
 *
 * `Foo(Foo(x))` даёт два совпадения: внешнее и внутреннее. Заменить оба —
 * значит наложить одну правку на другую, а редактор такую правку отклонит
 * целиком, вместе с остальными в этом файле. Остаётся внешнее: оно ближе к
 * тому, что пользователь написал в образце, и внутреннее попадёт в него
 * дословно вместе со связанным аргументом.
 */
export function withoutOverlaps(
    matches: readonly IRslStructuralMatch[]
): IRslStructuralMatch[] {
    const ordered = [...matches].sort((left, right) =>
        left.start - right.start || right.end - left.end);
    const result: IRslStructuralMatch[] = [];
    let boundary = -1;

    for (const match of ordered) {
        if (match.start < boundary) {
            continue;
        }

        result.push(match);
        boundary = match.end;
    }

    return result;
}

/** Имя заполнителя, начинающееся в этой позиции; пусто, если его нет. */
function placeholderNameAt(value: string, from: number): string {
    let at = from;

    while (at < value.length && isNamePart(value.charCodeAt(at))) {
        at++;
    }

    return value.slice(from, at);
}

function isNamePart(code: number): boolean {
    return (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        code === 95 ||
        /* Кириллица: имена в RSL пишут и по-русски. */
        (code >= 0x0410 && code <= 0x044f) ||
        code === 0x0401 ||
        code === 0x0451;
}

function empty(problem: string): IRslStructuralReplaceAnswer {
    return {
        previews: [],
        sources: [],
        files: 0,
        replacements: 0,
        scannedFiles: 0,
        skippedFiles: 0,
        problem,
        overlapping: 0
    };
}

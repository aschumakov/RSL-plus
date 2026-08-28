import type {
    CancellationToken,
    CodeAction,
    Position,
    Range,
    TextEdit,
    WorkspaceEdit
} from "vscode-languageserver";

import { positionAtOffset } from "../core/documentPosition";
import { applyRslKeywordCase } from "./formatOptions";
import type { IIndexedModule } from "../workspaceIndex";
import type { WorkspaceIndex } from "../workspaceIndex";

/**
 * Реестр рефакторингов.
 *
 * Действие живёт в двух шагах. Первый — applies: он отвечает на вопрос
 * «предлагать ли», обязан быть дешёвым и не строит ни одной правки. Второй —
 * resolve: он считает правку и вызывается только тогда, когда пользователь
 * действие выбрал.
 *
 * Разделение здесь не украшение. Редактор спрашивает действия на каждое
 * движение курсора, а рефакторинг вроде Extract Macro обходит область
 * видимости и собирает текст. Считать это ради лампочки, которую в девяти
 * случаях из десяти никто не нажмёт, — то же самое, что считать диагностики
 * на каждую букву.
 *
 * Диспетчеризация идёт по идентификатору, а не общим switch: новое действие
 * добавляется своим файлом и одной строкой регистрации.
 */

/** Настройки, влияющие на вставляемый текст. */
export interface IRslRefactorOptions {
    /** Регистр дописываемых ключевых слов: см. rslPlus.format.keywordCase. */
    keywordCase?: string;
    /** Отступ одного уровня; берётся из настроек форматирования. */
    indent?: string;
}

/** Что видит рефакторинг: документ, выделение и окружение. */
export interface IRslRefactorContext {
    module: IIndexedModule;
    index: WorkspaceIndex;
    /** Выделение в смещениях: границы уже приведены к тексту документа. */
    start: number;
    end: number;
    options: IRslRefactorOptions;
    isCancelled(): boolean;
}

/**
 * Предложение действия.
 *
 * `data` переживает поездку к редактору и обратно, поэтому обязано быть
 * простым JSON: сюда кладут то немногое, что первый шаг уже выяснил и что
 * второму пришлось бы искать заново.
 */
export interface IRslRefactorCandidate {
    title: string;
    data?: Record<string, unknown>;
    /** Действие по умолчанию для своего kind: редактор выделяет его. */
    preferred?: boolean;
}

export interface IRslRefactor {
    /** Идентификатор в data; менять его — ломать уже показанные действия. */
    id: string;
    /** Вид действия LSP: refactor.extract, refactor.inline, source.*. */
    kind: string;
    /**
     * Что предложить для этого выделения.
     *
     * Быстрая проверка: без обхода проекта, без сборки текста, без правок.
     * Пустой список — действие не предлагается.
     */
    applies(context: IRslRefactorContext): IRslRefactorCandidate[];
    /**
     * Посчитать правку.
     *
     * Возвращает undefined, если за время между показом и выбором действие
     * перестало быть применимым: документ изменился, имя стало занятым,
     * работу отменили.
     */
    resolve(
        context: IRslRefactorContext,
        candidate: IRslRefactorCandidate
    ): WorkspaceEdit | undefined;
}

/** Метка, по которой resolve узнаёт своё действие. */
interface IRslRefactorActionData extends Record<string, unknown> {
    rslRefactor: string;
    uri: string;
    /**
     * Версия документа на момент показа.
     *
     * Правка задана диапазонами исходного текста. Если документ успели
     * изменить, те же диапазоны указывают уже не туда, и применить их значит
     * испортить файл молча.
     */
    version: number;
    start: number;
    end: number;
    candidate: IRslRefactorCandidate;
}

export class RslRefactorRegistry {
    private readonly refactors = new Map<string, IRslRefactor>();

    register(refactor: IRslRefactor): void {
        this.refactors.set(refactor.id, refactor);
    }

    /** Зарегистрированные действия в порядке регистрации. */
    list(): readonly IRslRefactor[] {
        return [...this.refactors.values()];
    }

    /**
     * Действия для выделения — без правок.
     *
     * `only` из запроса редактора фильтрует по виду до вызова applies: считать
     * применимость действия, которое всё равно не покажут, незачем.
     */
    build(
        context: IRslRefactorContext,
        only?: readonly string[]
    ): CodeAction[] {
        const result: CodeAction[] = [];

        for (const refactor of this.refactors.values()) {
            if (!wanted(refactor.kind, only)) {
                continue;
            }

            if (context.isCancelled()) {
                return [];
            }

            for (const candidate of refactor.applies(context)) {
                const data: IRslRefactorActionData = {
                    rslRefactor: refactor.id,
                    uri: context.module.uri,
                    version: context.module.version,
                    start: context.start,
                    end: context.end,
                    candidate
                };

                result.push({
                    title: candidate.title,
                    kind: refactor.kind,
                    isPreferred: candidate.preferred,
                    data
                });
            }
        }

        return result;
    }

    /**
     * Досчитать выбранное действие.
     *
     * Действие без нашей метки возвращается как есть: в ответе редактора
     * лежат и чужие действия, и повторно решать за них нечего.
     */
    resolve(
        action: CodeAction,
        current: (uri: string) => IIndexedModule | undefined,
        index: WorkspaceIndex,
        options: IRslRefactorOptions,
        cancellation?: CancellationToken
    ): CodeAction {
        const data = action.data as IRslRefactorActionData | undefined;

        if (!data || typeof data.rslRefactor !== "string") {
            return action;
        }

        const refactor = this.refactors.get(data.rslRefactor);
        const module = current(data.uri);

        if (!refactor || !module || module.version !== data.version) {
            /* Документ ушёл вперёд: правки нет, редактор ничего не применит. */
            return action;
        }

        const edit = refactor.resolve(
            {
                module,
                index,
                start: data.start,
                end: data.end,
                options,
                isCancelled: () =>
                    cancellation?.isCancellationRequested === true
            },
            data.candidate
        );

        return edit ? { ...action, edit } : action;
    }
}

/**
 * Реестр со всеми действиями плагина.
 *
 * Одна точка сборки: добавить рефакторинг — значит дописать сюда строку, а не
 * найти и расширить чужой switch.
 */
export function createRslRefactorRegistry(
    refactors: readonly IRslRefactor[]
): RslRefactorRegistry {
    const registry = new RslRefactorRegistry();

    for (const refactor of refactors) {
        registry.register(refactor);
    }

    return registry;
}

/** Просит ли редактор действия этого вида. */
function wanted(kind: string, only?: readonly string[]): boolean {
    if (!only || only.length === 0) {
        return true;
    }

    return only.some(requested => {
        const value = String(requested);

        return kind === value || kind.startsWith(value + ".");
    });
}

/* ── Общее для рефакторингов ────────────────────────────────────────────── */

/** Правка одного файла: рефакторинги правят тот файл, где стоит курсор. */
export function singleFileEdit(
    module: IIndexedModule,
    edits: readonly TextEdit[]
): WorkspaceEdit {
    return { changes: { [module.uri]: [...edits] } };
}

export function offsetPosition(
    module: IIndexedModule,
    offset: number
): Position {
    return positionAtOffset(module.lex.lineStarts, offset);
}

export function offsetRange(
    module: IIndexedModule,
    start: number,
    end: number
): Range {
    return {
        start: offsetPosition(module, start),
        end: offsetPosition(module, end)
    };
}

/**
 * Имя, которого в этом файле ещё нет.
 *
 * Занятые имена берутся у вызывающего: у каждого рефакторинга своя область, и
 * решать за него, где смотреть, реестр не должен.
 */
export function freeRslName(
    base: string,
    taken: ReadonlySet<string>
): string {
    if (!taken.has(base.toLowerCase())) {
        return base;
    }

    for (let suffix = 2; suffix < 1000; suffix++) {
        const candidate = base + suffix;

        if (!taken.has(candidate.toLowerCase())) {
            return candidate;
        }
    }

    return base + "_";
}

/** Отступ строки, в которой лежит смещение. */
export function lineIndent(module: IIndexedModule, offset: number): string {
    const source = module.source;
    const lineStart = Math.max(0, source.lastIndexOf("\n", offset - 1) + 1);
    let end = lineStart;

    while (
        end < source.length &&
        (source.charAt(end) === " " || source.charAt(end) === "\t")
    ) {
        end++;
    }

    return source.slice(lineStart, end);
}

/**
 * Ключевое слово в регистре проекта.
 *
 * Рефакторинг дописывает код за пользователя, и регистр этого кода — свойство
 * проекта, а не действия.
 */
export function keyword(word: string, options: IRslRefactorOptions): string {
    return applyRslKeywordCase(word, options.keywordCase);
}

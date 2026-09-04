import type { CompletionItem } from "vscode-languageserver";



/**
 * Единый источник кандидатов Completion.
 *
 * Подсказки собираются двумя путями: из компактного индекса версии, пока полная
 * модель считается, и из модели, когда она готова. Пользователь этой разницы
 * знать не должен, поэтому решают не пути, а правила, собранные здесь: что
 * предлагать после точки, когда добавлять общие имена и когда искать по всему
 * проекту. Путь отвечает только на вопрос «какие факты есть», а не «что
 * показать».
 *
 * Расхождение, из-за которого правила и вынесены: полный путь добавлял после
 * точки встроенные имена и спецпеременные, а быстрый — нет. Один и тот же
 * `Field7.` давал разный список до и после готовности модели.
 */
export interface IRslCompletionFacts {
    /** Чем отвечает этот источник — для журнала производительности. */
    readonly name: string;

    /**
     * Особый список для позиции: имя модуля в Import, путь в строке.
     *
     * undefined — позиция обычная. Такой список самодостаточен: ни общие имена,
     * ни поиск по проекту к нему не добавляются.
     */
    contextCandidates(): readonly CompletionItem[] | undefined;

    /**
     * Позиция, где имён языка не предлагают: строка, комментарий, блок в
     * квадратных скобках.
     *
     * Спрашивается ПОСЛЕ контекстного списка, а не до него: строка — это не
     * всегда «не код». В `ExecMacro("Имя")` и `ExecMacroFile("файл")` внутри
     * строки предлагаются имена процедур и модулей, и блокировка, стоявшая
     * первой, эти подсказки отключала целиком.
     */
    blockedPosition(): boolean;

    /**
     * Что известно про обращение к члену в этой точке.
     *
     * Три состояния, а не два. «Обращения к члену здесь нет» и «оно есть,
     * но тип получателя пока не определён» — разные ответы, и путать их
     * нельзя: во втором случае общие имена после точки показывать
     * запрещено, а в первом они и есть весь ответ.
     */
    memberCandidates(): IRslMemberCompletionState;

    /** Имена, видимые в этой точке: переменные, параметры, процедуры, классы. */
    visibleCandidates(): readonly CompletionItem[];

    /** Встроенные имена и символы прочитанных Import. */
    ambientCandidates(): readonly CompletionItem[];

    /**
     * Поиск по всему проекту: неподключённые символы для Auto Import.
     *
     * Единственный источник, который имеет право быть неполным: число
     * кандидатов ничем не ограничено, поэтому он ведётся по префиксу и с
     * пределом.
     */
    searchCandidates(): {
        items: readonly CompletionItem[];
        truncated: boolean;
    };

    /**
     * Ответ на заблокированной позиции приблизителен: этому источнику для
     * контекстного списка не хватает модели.
     */
    readonly blockedNeedsModel?: boolean;
}

/**
 * Обращение к члену: есть ли оно и что о нём известно.
 *
 *   not-member-access        — точки перед позицией нет, вопрос обычный;
 *   resolved-members         — класс получателя известен, вот его состав;
 *   unresolved-member-access — точка есть, а тип получателя пока нет.
 *
 * Последнее состояние обязано давать пустой ответ, а не общий список:
 * лучше не показать ничего, чем показать заведомо неуместное.
 */
export type IRslMemberCompletionState =
    | { kind: "not-member-access" }
    | { kind: "resolved-members"; items: readonly CompletionItem[] }
    | { kind: "unresolved-member-access" };

/** Готовые состояния: узнаются по ссылке и не плодят объектов. */
export const RSL_NOT_MEMBER_ACCESS: IRslMemberCompletionState =
    Object.freeze({ kind: "not-member-access" as const });
export const RSL_UNRESOLVED_MEMBER_ACCESS: IRslMemberCompletionState =
    Object.freeze({ kind: "unresolved-member-access" as const });

export interface IRslCompletionCandidates {
    /** Что именно ответило: обычный список, члены, контекст. */
    source: string;
    candidates: readonly CompletionItem[];
    /** Список неполон: часть кандидатов поиска по проекту не поместилась. */
    incomplete: boolean;
    /**
     * Ответ приблизительный: этой позиции нужна модель, а её ещё нет.
     *
     * Такой ответ не запоминается сеансом: он и должен улучшиться, как только
     * модель достроится, — в отличие от полного ответа, который обязан
     * оставаться прежним, пока не изменился текст.
     */
    provisional: boolean;
}

/**
 * Кандидаты для одной позиции по общим правилам.
 *
 * Ни отбора по набранному, ни сортировки здесь нет: состав не зависит от
 * префикса — иначе повторный запрос нельзя было бы взять из готового сеанса, а
 * редактор фильтровал бы уже урезанный набор.
 */
export function collectRslCompletionCandidates(
    facts: IRslCompletionFacts
): IRslCompletionCandidates {
    const contextual = facts.contextCandidates();

    if (contextual !== undefined) {
        return {
            source: facts.name + ":context",
            candidates: contextual,
            incomplete: false,
            provisional: false
        };
    }

    /*
     * Контекстного списка нет — только теперь имеет смысл спросить, код ли
     * это вообще.
     */
    if (facts.blockedPosition()) {
        return {
            source: facts.name + ":blocked",
            candidates: [],
            incomplete: false,
            /*
             * Быстрый путь не умеет строить контекстные списки внутри строк:
             * им нужны объявления самого файла. Пустой ответ здесь —
             * приблизительный, и запоминать его нельзя.
             */
            provisional: facts.blockedNeedsModel === true
        };
    }

    const members = facts.memberCandidates();

    if (members.kind === "resolved-members") {
        return {
            source: facts.name + ":members",
            candidates: deduplicateCompletionItems(members.items),
            incomplete: false,
            provisional: false
        };
    }

    /*
     * Тип получателя пока неизвестен.
     *
     * Ответ пустой и приблизительный: общие имена после точки не
     * предлагаются никогда, а как только тип станет известен, спросят
     * заново — приблизительный ответ сеанс не запоминает.
     */
    if (members.kind === "unresolved-member-access") {
        return {
            source: facts.name + ":members-pending",
            candidates: [],
            incomplete: false,
            provisional: true
        };
    }

    const search = facts.searchCandidates();

    return {
        source: facts.name + ":names",
        candidates: deduplicateCompletionItems(
            facts.visibleCandidates(),
            facts.ambientCandidates(),
            search.items
        ),
        incomplete: search.truncated,
        provisional: false
    };
}

/**
 * Дедупликация по имени.
 *
 * Порядок групп задаёт приоритет: имя из области видимости побеждает
 * одноимённое встроенное, а оно — кандидата Auto Import. Кандидаты Auto
 * Import из разных модулей остаются оба: они и различаются модулем.
 */
export function deduplicateCompletionItems(
    ...groups: readonly (readonly CompletionItem[])[]
): CompletionItem[] {
    const result: CompletionItem[] = [];
    const seen = new Set<string>();

    for (const items of groups) {
        for (const item of items) {
            const autoImportUri = (
                item.data as { rslAutoImportUri?: unknown } | undefined
            )?.rslAutoImportUri;
            const key = autoImportUri
                ? `${String(item.label).toLowerCase()}:${autoImportUri}`
                : String(item.label).toLowerCase();

            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            result.push(item);
        }
    }

    return result;
}

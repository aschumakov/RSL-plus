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
     * Члены получателя перед точкой.
     *
     * undefined — либо обращения к члену здесь нет, либо тип получателя
     * неизвестен. Второе не то же самое, что «членов нет»: показать вместо них
     * общие имена значило бы предложить то, чего после точки не бывает.
     */
    memberCandidates(): readonly CompletionItem[] | undefined;

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
}

export interface IRslCompletionCandidates {
    /** Что именно ответило: обычный список, члены, контекст. */
    source: string;
    candidates: readonly CompletionItem[];
    /** Список неполон: часть кандидатов поиска по проекту не поместилась. */
    incomplete: boolean;
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
            incomplete: false
        };
    }

    const members = facts.memberCandidates();

    if (members !== undefined) {
        return {
            source: facts.name + ":members",
            candidates: deduplicateCompletionItems(members),
            incomplete: false
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
        incomplete: search.truncated
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

import type { CompletionItem } from "vscode-languageserver/node";

import { normalizeIdentifier } from "../lexer";

/** Возвращает вводимое имя непосредственно перед курсором. */
export function completionPrefixAt(source: string, offset: number): string {
    const safeOffset = Math.max(0, Math.min(offset, source.length));
    const fragment = source.substring(
        Math.max(0, safeOffset - 160),
        safeOffset
    );
    return fragment.match(/[\p{L}\p{N}_{}-]+$/u)?.[0] || "";
}

export interface IRslCompletionRankingOptions {
    /**
     * Отбрасывать нерелевантные элементы.
     *
     * Полный список, помеченный `isIncomplete: false`, отбрасывать нельзя:
     * дальше фильтрует редактор, и после Backspace он фильтровал бы уже
     * урезанный набор. Отбор нужен только там, где список заведомо
     * ограничен — например при поиске по всему проекту.
     */
    dropIrrelevant?: boolean;
}

/**
 * Ранжирование в стиле language server-ов общего назначения: сначала точный
 * prefix, затем substring и fuzzy subsequence.
 *
 * Порядок задаётся до конца, без опоры на порядок сборки: приоритет, имя,
 * вид элемента и модуль. Одинаковый снимок документа обязан давать не только
 * тот же состав, но и тот же порядок.
 */
export function rankCompletionItemsForPrefix(
    items: readonly CompletionItem[],
    prefix: string,
    options: IRslCompletionRankingOptions = {}
): CompletionItem[] {
    const normalizedPrefix = normalizeIdentifier(prefix);
    const filterIrrelevant = options.dropIrrelevant === true &&
        normalizedPrefix.length >= 2;
    const ranked: CompletionItem[] = [];

    for (const item of items) {
        const label = String(item.label);
        const score = completionMatchScore(label, normalizedPrefix);
        if (filterIrrelevant && score >= 9) {
            continue;
        }
        ranked.push({
            ...item,
            filterText: item.filterText || label,
            sortText: stableSortText(item, score, label)
        });
    }

    if (normalizedPrefix) {
        let preferred: CompletionItem | undefined;
        for (const item of ranked) {
            if (!preferred ||
                String(item.sortText) < String(preferred.sortText)) {
                preferred = item;
            }
        }
        if (preferred) {
            preferred.preselect = true;
        }
    }

    return ranked;
}

export function completionLabelMatchesPrefix(
    label: string,
    prefix: string
): boolean {
    const normalizedPrefix = normalizeIdentifier(prefix);
    return normalizedPrefix.length < 2 ||
        completionMatchScore(label, normalizedPrefix) < 9;
}

function completionMatchScore(
    label: string,
    normalizedPrefix: string
): number {
    if (!normalizedPrefix) {
        return 3;
    }

    const normalizedLabel = normalizeIdentifier(label);
    if (normalizedLabel === normalizedPrefix) {
        return 0;
    }
    if (normalizedLabel.startsWith(normalizedPrefix)) {
        return 1;
    }
    if (normalizedLabel.includes(normalizedPrefix)) {
        return 2;
    }
    return isSubsequence(normalizedPrefix, normalizedLabel) ? 3 : 9;
}

function isSubsequence(needle: string, haystack: string): boolean {
    let needleIndex = 0;
    for (
        let index = 0;
        index < haystack.length && needleIndex < needle.length;
        index++
    ) {
        if (haystack.charAt(index) === needle.charAt(needleIndex)) {
            needleIndex++;
        }
    }
    return needleIndex === needle.length;
}

/**
 * Окончательный ключ сортировки: приоритет, собственный порядок элемента,
 * имя, вид и модуль.
 *
 * Последние части нужны для устойчивости: без них два одноимённых члена из
 * разных модулей вставали в список в том порядке, в каком их успели собрать.
 */
function stableSortText(
    item: CompletionItem,
    score: number,
    label: string
): string {
    const own = item.sortText || "7";
    const detail = typeof item.detail === "string" ? item.detail : "";

    return [
        score,
        own,
        normalizeIdentifier(label),
        item.kind ?? 0,
        normalizeIdentifier(detail).slice(0, 40)
    ].join("_");
}
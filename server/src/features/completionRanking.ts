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

/**
 * Фильтрация и ранжирование в стиле language server-ов общего назначения:
 * сначала точный prefix, затем substring и fuzzy subsequence. При двух и
 * более введённых символах нерелевантные элементы не передаются клиенту.
 */
export function rankCompletionItemsForPrefix(
    items: readonly CompletionItem[],
    prefix: string
): CompletionItem[] {
    const normalizedPrefix = normalizeIdentifier(prefix);
    const filterIrrelevant = normalizedPrefix.length >= 2;
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
            sortText: `${score}_${item.sortText ||
                `7_${normalizeIdentifier(label)}`}`
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

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
     * Тип, уместный в этом месте.
     *
     * Это ВЕС, а не фильтр: подходящие по типу поднимаются выше
     * равных им по совпадению имени, но никто не пропадает. Тип
     * выводится не всегда и не обязан быть верным во всех случаях —
     * отбрасывать по нему кандидатов значило бы прятать нужное имя
     * из-за неточного вывода.
     *
     * Пусто, если тип неизвестен: тогда порядок прежний.
     */
    expectedType?: string;
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
    const expectedType = normalizeIdentifier(options.expectedType || "");
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
            sortText: stableSortText(item, score, label, expectedType)
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

/**
 * Происхождение кандидата: файл и символ, если они известны.
 *
 * Заполнено не у всех — у встроенных имён и локальных переменных источника
 * нет, — но у одноимённых кандидатов из разных модулей заполнено всегда:
 * именно их и нужно упорядочить между собой.
 */
function completionOrigin(item: CompletionItem): string {
    const data = item.data && typeof item.data === "object"
        ? item.data as Record<string, unknown>
        : {};
    const uri = typeof data.uri === "string"
        ? data.uri
        : typeof data.rslAutoImportUri === "string"
            ? data.rslAutoImportUri
            : "";
    const symbolId = typeof data.symbolId === "string" ? data.symbolId : "";

    return uri + (symbolId ? "#" + symbolId : "");
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
 * имя, вид, модуль и происхождение.
 *
 * Последние части нужны для устойчивости: без них два одноимённых члена из
 * разных модулей вставали в список в том порядке, в каком их успели собрать.
 * Отображаемого модуля для этого мало — два файла с одним именем в разных
 * каталогах показываются одинаково, и порядок между ними зависел от того, что
 * успела прочитать фоновая индексация. Поэтому в конце ключа стоит то, что
 * различает их всегда: путь файла и идентификатор символа.
 */
function stableSortText(
    item: CompletionItem,
    score: number,
    label: string,
    expectedType: string
): string {
    const own = item.sortText || "7";
    const detail = typeof item.detail === "string" ? item.detail : "";

    return [
        score,
        typeRank(item, expectedType),
        own,
        normalizeIdentifier(label),
        item.kind ?? 0,
        normalizeIdentifier(detail).slice(0, 40),
        completionOrigin(item)
    ].join("_");
}

/**
 * Подходит ли кандидат по типу: 0 — да, 1 — неизвестно или нет.
 *
 * Стоит сразу после совпадения имени и перед всем остальным: среди
 * одинаково совпавших по имени первым идёт тот, чей тип уместен здесь.
 */
function typeRank(item: CompletionItem, expectedType: string): number {
    if (!expectedType) {
        return 0;
    }

    const data = item.data as { rslType?: string } | undefined;

    return data?.rslType && data.rslType === expectedType ? 0 : 1;
}
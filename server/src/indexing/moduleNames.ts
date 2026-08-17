import * as path from "path";
import { fileURLToPath } from "url";

import type { ModuleResolution } from "./indexTypes";

export function resolveByModuleName<T>(
    moduleName: string,
    index: ReadonlyMap<string, ReadonlySet<string>>,
    getValue: (uri: string) => T | undefined
): ModuleResolution<T> {
    const target = normalizeModuleName(moduleName);
    const uris = index.get(path.posix.basename(target));

    if (!uris || uris.size === 0) {
        return { kind: "missing" };
    }

    const exact: T[] = [];
    const fallback: T[] = [];

    for (const uri of uris) {
        const value = getValue(uri);

        if (value === undefined) {
            continue;
        }

        const normalizedPath = normalizeUriPath(uri);

        (
            normalizedPath === target ||
            normalizedPath.endsWith("/" + target)
                ? exact
                : fallback
        ).push(value);
    }

    const candidates = exact.length > 0 ? exact : fallback;

    if (candidates.length === 0) {
        return { kind: "missing" };
    }

    return candidates.length === 1
        ? { kind: "resolved", value: candidates[0] }
        : { kind: "ambiguous", candidates };
}

/**
 * Детерминированный выбор кандидата при неоднозначном разрешении Import.
 *
 * Сортировка по нормализованному пути не зависит от порядка обхода Map/Set,
 * поэтому повторные вызовы для одного и того же набора кандидатов всегда
 * выбирают один и тот же файл.
 */
export function pickDeterministicCandidate<T>(
    candidates: readonly T[],
    getUri: (value: T) => string
): T {
    return candidates
        .slice()
        .sort((left, right) => {
            const leftPath = normalizeUriPath(getUri(left));
            const rightPath = normalizeUriPath(getUri(right));

            return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
        })[0];
}

export function addUriAlias(
    index: Map<string, Set<string>>,
    uri: string
): void {
    const key = path.posix.basename(normalizeUriPath(uri));
    const values = index.get(key) || new Set<string>();

    values.add(uri);
    index.set(key, values);
}

export function removeUriAlias(
    index: Map<string, Set<string>>,
    uri: string
): void {
    const key = path.posix.basename(normalizeUriPath(uri));
    const values = index.get(key);

    if (!values) {
        return;
    }

    values.delete(uri);

    if (values.size === 0) {
        index.delete(key);
    }
}

export function normalizeModuleName(value: string): string {
    let result = (value || "")
        .trim()
        .replace(/\\/g, "/")
        .toLowerCase();

    while (result.startsWith("./")) {
        result = result.substring(2);
    }

    return result.endsWith(".mac")
        ? result
        : result + ".mac";
}

/**
 * Возвращает ключ физической идентичности ресурса.
 *
 * На Windows файловая система обычно регистронезависима, поэтому URI,
 * отличающиеся только регистром пути, считаются одним файлом.
 *
 * Исходный URI при этом не изменяется и продолжает использоваться
 * для переходов и отображения пользователю.
 */
/**
 * Файловый ли это URI.
 *
 * Проверка схемы стоит до вызова fileURLToPath намеренно. На не-файловом URI —
 * а таковы все встроенные символы и untitled-документы — он бросает исключение,
 * и хотя оно тут же ловится, конструирование ошибки со стеком в V8 недёшево.
 * На горячем пути это заметно: в профиле семантической подсветки файла 379 КБ
 * создание NodeError занимало 5,9 секунды из всего профиля — больше, чем весь
 * разбор и разрешение имён вместе взятые. Идентичность ресурса спрашивают на
 * каждый разрешённый символ, а встроенных среди них большинство.
 */
function isFileUri(uri: string): boolean {
    return uri.length > 5 &&
        (uri.charCodeAt(0) === 102 || uri.charCodeAt(0) === 70) &&
        uri.slice(0, 5).toLowerCase() === "file:";
}

/*
 * Ответ запоминается: это чистая функция от строки, а спрашивают её на каждый
 * разрешённый символ. В профиле семантической подсветки файла 379 КБ разбор
 * URI — fileURLToPath, path.normalize, конструктор URL — занимал около 120 мс
 * на прогон при том, что различных URI в файле единицы.
 *
 * Предел нужен на случай проекта с тысячами файлов: карта живёт всю сессию.
 */
const IDENTITY_LIMIT = 4096;
const identityByUri = new Map<string, string>();

export function getUriIdentity(uri: string): string {
    const known = identityByUri.get(uri);

    if (known !== undefined) {
        return known;
    }

    const identity = computeUriIdentity(uri);

    if (identityByUri.size >= IDENTITY_LIMIT) {
        identityByUri.clear();
    }
    identityByUri.set(uri, identity);
    return identity;
}

function computeUriIdentity(uri: string): string {
    /* Не-файловые URI, например untitled: или встроенные, не нормализуем. */
    if (!isFileUri(uri)) {
        return uri;
    }

    try {
        const filePath = path.normalize(fileURLToPath(uri));

        return process.platform === "win32"
            ? filePath.toLowerCase()
            : filePath;
    } catch (_error) {
        return uri;
    }
}

export function normalizeUriPath(uri: string): string {
    if (isFileUri(uri)) {
        try {
            return fileURLToPath(uri)
                .replace(/\\/g, "/")
                .toLowerCase();
        } catch (_error) {
            /* Испорченный file:-URI: ниже он приводится как обычная строка. */
        }
    }

    return uri
        .replace(/\\/g, "/")
        .toLowerCase();
}
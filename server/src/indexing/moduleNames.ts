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
export function getUriIdentity(uri: string): string {
    try {
        const filePath = path.normalize(fileURLToPath(uri));

        return process.platform === "win32"
            ? filePath.toLowerCase()
            : filePath;
    } catch (_error) {
        // Не-файловые URI, например untitled:, не нормализуем.
        return uri;
    }
}

export function normalizeUriPath(uri: string): string {
    try {
        return fileURLToPath(uri)
            .replace(/\\/g, "/")
            .toLowerCase();
    } catch (_error) {
        return uri
            .replace(/\\/g, "/")
            .toLowerCase();
    }
}
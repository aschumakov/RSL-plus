import * as path from "path";

import type { ModuleResolution } from "./indexTypes";
import { normalizeModuleName } from "../core/language/moduleName";
import { uriPathKey as normalizeUriPath } from "../core/identity/uriKey";

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
    /*
     * Порядок кандидатов не зависит от порядка обхода проекта.
     *
     * Множество URI перебирается в порядке добавления, а он у обхода диска и у
     * восстановленного каталога разный. Список неоднозначных назначений от
     * этого менялся местами между запусками — на одном и том же проекте.
     */
    const ordered = [...uris].sort((left, right) => {
        const leftPath = normalizeUriPath(left);
        const rightPath = normalizeUriPath(right);

        return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
    });

    for (const uri of ordered) {
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

/*
 * Разбор написания имени модуля переехал в core/language/moduleName: там он
 * доступен и извлекателям Import, которые про индекс проекта ничего не знают.
 * Здесь остаётся разрешение имени в файл — то, ради чего нужен каталог.
 */
export {
    decodeRslModulePath,
    moduleReferenceKey,
    normalizeModuleName,
    rslModuleItemName,
    stripQuotes
} from "../core/language/moduleName";

/*
 * Идентичность файла и путь URI живут в core/identity/uriKey: их спрашивают
 * не только индексы, но и сканер ссылок с деревом зависимостей, и правило
 * платформы обязано быть одно. Здесь они переэкспортированы под прежними
 * именами: потребителей у них два десятка, и переименование ради
 * переименования ничего не добавляет.
 */
export {
    filePathKey,
    moduleIdOf,
    moduleIdOfUri,
    sameModuleId,
    samePath,
    sameUri,
    uriKey as getUriIdentity,
    uriPathKey as normalizeUriPath,
    type ModuleId,
    type UriKey
} from "../core/identity/uriKey";



import * as path from "path";
import { fileURLToPath } from "url";

import {
    normalizeReferenceImports,
    normalizeReferenceModuleName
} from "./referenceSourceFacts";

export interface IReferenceImportModule {
    uri: string;
    imports: readonly string[];
}

/** Строит транзитивную область поиска по полному лёгкому Import-графу. */
export function buildReferenceCandidateUris(
    declarationUri: string,
    indexedModules: readonly IReferenceImportModule[],
    workspaceUris: readonly string[],
    loadedModules: readonly IReferenceImportModule[]
): string[] {
    const byBaseName = new Map<string, string[]>();
    for (const uri of workspaceUris) {
        const base = path.posix.basename(normalizeUriPath(uri));
        const values = byBaseName.get(base) || [];
        values.push(uri);
        byBaseName.set(base, values);
    }

    const importsByUri = new Map<string, readonly string[]>();
    for (const module of indexedModules) {
        importsByUri.set(module.uri, module.imports);
    }
    for (const module of loadedModules) {
        importsByUri.set(
            module.uri,
            normalizeReferenceImports(module.imports)
        );
    }

    const reverseImports = new Map<string, Set<string>>();
    for (const [importerUri, imports] of importsByUri) {
        for (const importName of imports) {
            for (const importedUri of resolveImportedUris(
                importName,
                byBaseName
            )) {
                const dependents = reverseImports.get(importedUri) ||
                    new Set<string>();
                dependents.add(importerUri);
                reverseImports.set(importedUri, dependents);
            }
        }
    }

    const result = new Set<string>([declarationUri]);
    const queue = [declarationUri];
    let position = 0;

    while (position < queue.length) {
        const current = queue[position++];
        for (const dependent of reverseImports.get(current) || []) {
            if (!result.has(dependent)) {
                result.add(dependent);
                queue.push(dependent);
            }
        }
    }

    return Array.from(result);
}

function resolveImportedUris(
    importName: string,
    byBaseName: ReadonlyMap<string, string[]>
): string[] {
    const target = normalizeReferenceModuleName(importName);
    const base = path.posix.basename(target);
    const candidates = byBaseName.get(base) || [];
    const exact = candidates.filter(uri => {
        const normalized = normalizeUriPath(uri);
        return normalized === target || normalized.endsWith("/" + target);
    });
    return exact.length > 0 ? exact : candidates.slice();
}

function normalizeUriPath(uri: string): string {
    try {
        return fileURLToPath(uri).replace(/\\/g, "/").toLowerCase();
    } catch (_error) {
        return uri.replace(/\\/g, "/").toLowerCase();
    }
}

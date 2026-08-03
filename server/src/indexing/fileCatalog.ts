import * as path from "path";

import type { ModuleResolution } from "./indexTypes";
import {
    addUriAlias,
    normalizeUriPath,
    removeUriAlias,
    resolveByModuleName
} from "./moduleNames";

/** Каталог имён файлов не читает и не индексирует содержимое. */
export class FileCatalog {
    private files = new Set<string>();
    private byBaseName = new Map<string, Set<string>>();
    private initialized = false;

    registerAll(uris: readonly string[]): void {
        this.initialized = true;
        uris.forEach(uri => this.register(uri));
    }

    register(uri: string): void {
        if (!uri || this.files.has(uri)) return;
        this.files.add(uri);
        addUriAlias(this.byBaseName, uri);
    }

    unregister(uri: string): void {
        if (this.files.delete(uri)) removeUriAlias(this.byBaseName, uri);
    }

    clear(): void {
        this.files.clear();
        this.byBaseName.clear();
        this.initialized = false;
    }

    values(): string[] { return Array.from(this.files); }

    resolve(moduleName: string): ModuleResolution<string> {
        return resolveByModuleName(moduleName, this.byBaseName, uri => uri);
    }

    importName(uri: string): string {
        const normalized = normalizeUriPath(uri);
        const segments = normalized.split("/").filter(Boolean);
        const fileName = segments[segments.length - 1] || normalized;
        const baseName = fileName.replace(/\.mac$/i, "");
        const aliases = this.byBaseName.get(fileName.toLowerCase());
        if (!aliases || aliases.size <= 1) return baseName;

        for (let count = 2; count <= segments.length; count++) {
            const suffix = segments.slice(-count).join("/");
            const matches = Array.from(aliases).filter(candidate =>
                normalizeUriPath(candidate).endsWith("/" + suffix)
            );
            if (matches.length === 1) return suffix.replace(/\.mac$/i, "");
        }
        return path.posix.basename(baseName);
    }

    get ready(): boolean { return this.initialized; }
}

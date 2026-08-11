import * as path from "path";

import type { ModuleResolution } from "./indexTypes";

import {
    addUriAlias,
    getUriIdentity,
    normalizeUriPath,
    removeUriAlias,
    resolveByModuleName
} from "./moduleNames";

/** Каталог имён файлов не читает и не индексирует содержимое. */
export class FileCatalog {
    /**
     * key   — нормализованная идентичность физического файла;
     * value — исходный URI для отображения и LSP.
     */
    private files = new Map<string, string>();
    private byBaseName = new Map<string, Set<string>>();
    private initialized = false;

    registerAll(uris: readonly string[]): void {
        this.initialized = true;
        uris.forEach(uri => this.register(uri));
    }

    register(uri: string): void {
        if (!uri) {
            return;
        }

        const key = getUriIdentity(uri);
        const previous = this.files.get(key);

        if (previous === uri) {
            return;
        }

        /*
         * Файл уже мог быть зарегистрирован с другим регистром пути.
         * Заменяем представление URI, не создавая второй файл.
         */
        if (previous) {
            removeUriAlias(this.byBaseName, previous);
        }

        this.files.set(key, uri);
        addUriAlias(this.byBaseName, uri);
    }

    unregister(uri: string): void {
        const key = getUriIdentity(uri);
        const storedUri = this.files.get(key);

        if (!storedUri) {
            return;
        }

        this.files.delete(key);
        removeUriAlias(this.byBaseName, storedUri);
    }

    clear(): void {
        this.files.clear();
        this.byBaseName.clear();
        this.initialized = false;
    }

    values(): string[] {
        return Array.from(this.files.values());
    }

    /** Входит ли файл в проект; сравнение по идентичности, а не по строке. */
    has(uri: string): boolean {
        return !!uri && this.files.has(getUriIdentity(uri));
    }

    resolve(moduleName: string): ModuleResolution<string> {
        return resolveByModuleName(
            moduleName,
            this.byBaseName,
            uri => this.files.get(getUriIdentity(uri))
        );
    }

    importName(uri: string): string {
        const normalized = normalizeUriPath(uri);
        const segments = normalized.split("/").filter(Boolean);
        const fileName = segments[segments.length - 1] || normalized;
        const baseName = fileName.replace(/\.mac$/i, "");
        const aliases = this.byBaseName.get(fileName.toLowerCase());

        if (!aliases || aliases.size <= 1) {
            return baseName;
        }

        for (let count = 2; count <= segments.length; count++) {
            const suffix = segments.slice(-count).join("/");
            const matches = Array.from(aliases).filter(candidate =>
                normalizeUriPath(candidate).endsWith("/" + suffix)
            );

            if (matches.length === 1) {
                return suffix.replace(/\.mac$/i, "");
            }
        }

        return path.posix.basename(baseName);
    }

    get ready(): boolean {
        return this.initialized;
    }
}
import * as path from "path";
import { fileURLToPath } from "url";

import { CompletionItem } from "vscode-languageserver";

import { CBase } from "./common";
import { LruCache } from "./core/lruCache";
import { IFAStruct } from "./interfaces";
import {
    compactOpenModuleModel,
    createExternalModuleSummary,
    createOpenModuleModel,
    createRslModuleModel,
    IRslModuleModel
} from "./moduleModel";

export interface IIndexedModule extends IFAStruct, IRslModuleModel {
    object: CBase;
    version: number;
    isOpen: boolean;
}

export type ModuleResolution<T> =
    | { kind: "resolved"; value: T }
    | { kind: "ambiguous"; candidates: T[] }
    | { kind: "missing" };

export interface IIndexedSymbol {
    uri: string;
    object: CBase;
}

export interface IWorkspaceIndexOptions {
    /** Кэши Import нужны только нескольким активным документам. */
    importCacheEntries?: number;
}

/** Индекс лёгких summary и полных моделей только для открытых документов. */
export class WorkspaceIndex {
    private modules = new Map<string, IIndexedModule>();
    private symbolsByName = new Map<string, IIndexedSymbol[]>();
    private reverseImports = new Map<string, Set<string>>();
    private workspaceFiles = new Set<string>();
    private workspaceFilesByBaseName = new Map<string, Set<string>>();
    private modulesByBaseName = new Map<string, Set<string>>();
    private importedModulesCache: LruCache<string, IIndexedModule[]>;
    private importedCompletionCache: LruCache<string, CompletionItem[]>;
    private importedSymbolsByNameCache:
        LruCache<string, Map<string, IIndexedSymbol[]>>;
    private workspaceFilesInitialized = false;
    private importsEnabled = true;
    private revisionValue = 0;

    constructor(options: IWorkspaceIndexOptions = {}) {
        const cacheEntries = options.importCacheEntries ?? 32;
        this.importedModulesCache = new LruCache(cacheEntries);
        this.importedCompletionCache = new LruCache(cacheEntries);
        this.importedSymbolsByNameCache = new LruCache(cacheEntries);
    }

    /** Совместимый API: false теперь создаёт настоящий compact summary. */
    updateModule(
        uri: string,
        source: string,
        object: CBase,
        version: number,
        isOpen: boolean = true
    ): IIndexedModule {
        const model = createRslModuleModel(source, object, isOpen);
        return this.replacePersistentModule(uri, model, version, isOpen);
    }

    updateOpenModule(
        uri: string,
        source: string,
        object: CBase,
        version: number
    ): IIndexedModule {
        return this.replacePersistentModule(
            uri,
            createOpenModuleModel(source, object),
            version,
            true
        );
    }

    updateExternalModule(
        uri: string,
        source: string,
        version: number
    ): IIndexedModule {
        return this.replacePersistentModule(
            uri,
            createExternalModuleSummary(source),
            version,
            false
        );
    }

    /** Освобождает source, lexer, AST и локальные объявления закрытого файла. */
    compactModule(uri: string): IIndexedModule | undefined {
        const current = this.modules.get(uri);

        if (!current) {
            return undefined;
        }

        if (current.kind === "external") {
            current.isOpen = false;
            return current;
        }

        return this.replacePersistentModule(
            uri,
            compactOpenModuleModel(current),
            current.version,
            false
        );
    }

    markClosed(uri: string): void {
        const module = this.modules.get(uri);

        if (module) {
            module.isOpen = false;
        }
    }

    markOpen(uri: string): void {
        const module = this.modules.get(uri);

        if (module) {
            module.isOpen = true;
        }
    }

    removeModule(uri: string): void {
        const affected = this.collectAffectedUris(uri);
        this.removeModuleFromIndexes(uri);
        this.modules.delete(uri);
        affected.add(uri);
        this.invalidateImportCaches(affected);
        this.revisionValue++;
    }

    clear(): void {
        this.modules.clear();
        this.symbolsByName.clear();
        this.reverseImports.clear();
        this.workspaceFiles.clear();
        this.workspaceFilesByBaseName.clear();
        this.modulesByBaseName.clear();
        this.invalidateImportCaches();
        this.workspaceFilesInitialized = false;
        this.revisionValue++;
    }

    registerWorkspaceFiles(uris: readonly string[]): void {
        this.workspaceFilesInitialized = true;
        uris.forEach(uri => this.registerWorkspaceFile(uri));
    }

    registerWorkspaceFile(uri: string): void {
        if (!uri || this.workspaceFiles.has(uri)) {
            return;
        }

        this.workspaceFiles.add(uri);
        addUriAlias(this.workspaceFilesByBaseName, uri);
    }

    unregisterWorkspaceFile(uri: string): void {
        if (!this.workspaceFiles.delete(uri)) {
            return;
        }

        removeUriAlias(this.workspaceFilesByBaseName, uri);
    }

    getWorkspaceFileUris(): string[] {
        return Array.from(this.workspaceFiles);
    }

    resolveWorkspaceFile(moduleName: string): ModuleResolution<string> {
        return resolveByModuleName(
            moduleName,
            this.workspaceFilesByBaseName,
            uri => uri
        );
    }

    findWorkspaceFileUri(moduleName: string): string | undefined {
        const resolution = this.resolveWorkspaceFile(moduleName);
        return resolution.kind === "resolved"
            ? resolution.value
            : undefined;
    }

    getModule(uri: string): IIndexedModule | undefined {
        return this.modules.get(uri);
    }

    getModules(): IFAStruct[] {
        return Array.from(this.modules.values()).map(module => ({
            uri: module.uri,
            object: module.object
        }));
    }

    getIndexedModules(): IIndexedModule[] {
        return Array.from(this.modules.values());
    }

    getOpenModules(): IIndexedModule[] {
        return Array.from(this.modules.values()).filter(module => module.isOpen);
    }

    getImportNames(uri: string): string[] {
        const module = this.modules.get(uri);
        return module ? module.imports.slice() : [];
    }

    getImportedModules(uri: string): IIndexedModule[] {
        if (!this.importsEnabled) {
            return [];
        }

        const useCache = this.modules.get(uri)?.isOpen === true;
        const cached = useCache ? this.importedModulesCache.get(uri) : undefined;

        if (cached) {
            return cached.slice();
        }

        const result: IIndexedModule[] = [];
        const visited = new Set<string>([uri]);
        const queue: string[] = [uri];
        let position = 0;

        while (position < queue.length) {
            const current = this.modules.get(queue[position++]);

            if (!current) {
                continue;
            }

            for (const importName of current.imports) {
                const imported = this.findModuleByName(importName);

                if (!imported || visited.has(imported.uri)) {
                    continue;
                }

                visited.add(imported.uri);
                result.push(imported);
                queue.push(imported.uri);
            }
        }

        if (useCache) {
            this.importedModulesCache.set(uri, result.slice());
        }

        return result;
    }

    resolveModule(moduleName: string): ModuleResolution<IIndexedModule> {
        return resolveByModuleName(
            moduleName,
            this.modulesByBaseName,
            uri => this.modules.get(uri)
        );
    }

    findModuleByName(moduleName: string): IIndexedModule | undefined {
        const resolution = this.resolveModule(moduleName);
        return resolution.kind === "resolved"
            ? resolution.value
            : undefined;
    }

    findSymbols(name: string): IIndexedSymbol[] {
        return (this.symbolsByName.get(normalizeName(name)) || []).slice();
    }

    findImportedSymbols(fromUri: string, name: string): IIndexedSymbol[] {
        const byName = this.getImportedSymbolsByName(fromUri);
        return (byName.get(normalizeName(name)) || []).slice();
    }

    getImportedCompletionItems(fromUri: string): CompletionItem[] {
        const useCache = this.modules.get(fromUri)?.isOpen === true;
        const cached = useCache
            ? this.importedCompletionCache.get(fromUri)
            : undefined;

        if (cached) {
            return cached.slice();
        }

        const result: CompletionItem[] = [];
        const seen = new Set<string>();

        for (const module of this.getImportedModules(fromUri)) {
            for (const child of module.object.getChilds()) {
                if (child.Private) {
                    continue;
                }

                const key = normalizeName(child.Name);

                if (seen.has(key)) {
                    continue;
                }

                seen.add(key);
                result.push(child.CIInfo);
            }
        }

        if (useCache) {
            this.importedCompletionCache.set(fromUri, result.slice());
        }

        return result;
    }

    getDependents(uri: string): string[] {
        const result = new Set<string>();

        for (const name of moduleAliases(uri)) {
            this.reverseImports.get(name)?.forEach(value => result.add(value));
        }

        result.delete(uri);
        return Array.from(result);
    }

    setImportsEnabled(enabled: boolean): void {
        if (this.importsEnabled === enabled) {
            return;
        }

        this.importsEnabled = enabled;
        this.invalidateImportCaches();
        this.revisionValue++;
    }

    /**
     * Временно подменяет summary полной моделью для References. После callback
     * полная модель становится недостижимой и может быть собрана GC.
     */
    withTransientOpenModule<T>(
        uri: string,
        source: string,
        action: (module: IIndexedModule) => T
    ): T {
        const previous = this.modules.get(uri);
        const affectedBefore = this.collectAffectedUris(uri);
        this.removeModuleFromIndexes(uri);

        const model = createOpenModuleModel(source, new CBase(source, 0));
        const transient: IIndexedModule = {
            uri,
            ...model,
            object: model.symbolTree,
            version: previous?.version ?? 0,
            isOpen: true
        };

        this.modules.set(uri, transient);
        this.addModuleToIndexes(transient);
        this.invalidateImportCaches(affectedBefore);

        try {
            return action(transient);
        } finally {
            const affectedAfter = this.collectAffectedUris(uri);
            this.removeModuleFromIndexes(uri);

            if (previous) {
                this.modules.set(uri, previous);
                this.addModuleToIndexes(previous);
            } else {
                this.modules.delete(uri);
            }

            affectedBefore.forEach(value => affectedAfter.add(value));
            affectedAfter.add(uri);
            this.invalidateImportCaches(affectedAfter);
        }
    }

    get areImportsEnabled(): boolean {
        return this.importsEnabled;
    }

    get workspaceFilesReady(): boolean {
        return this.workspaceFilesInitialized;
    }

    get size(): number {
        return this.modules.size;
    }

    get revision(): number {
        return this.revisionValue;
    }

    get importCacheSize(): number {
        return this.importedModulesCache.size +
            this.importedCompletionCache.size +
            this.importedSymbolsByNameCache.size;
    }

    private replacePersistentModule(
        uri: string,
        model: IRslModuleModel,
        version: number,
        isOpen: boolean
    ): IIndexedModule {
        const affected = this.collectAffectedUris(uri);
        this.removeModuleFromIndexes(uri);

        const module: IIndexedModule = {
            uri,
            ...model,
            object: model.symbolTree,
            version,
            isOpen
        };

        this.modules.set(uri, module);
        this.registerWorkspaceFile(uri);
        this.addModuleToIndexes(module);
        this.collectAffectedUris(uri).forEach(value => affected.add(value));
        affected.add(uri);
        this.invalidateImportCaches(affected);
        this.revisionValue++;
        return module;
    }

    private getImportedSymbolsByName(
        fromUri: string
    ): Map<string, IIndexedSymbol[]> {
        const useCache = this.modules.get(fromUri)?.isOpen === true;
        const cached = useCache
            ? this.importedSymbolsByNameCache.get(fromUri)
            : undefined;

        if (cached) {
            return cached;
        }

        const result = new Map<string, IIndexedSymbol[]>();

        for (const module of this.getImportedModules(fromUri)) {
            for (const child of module.object.getChilds()) {
                if (child.Private) {
                    continue;
                }

                const key = normalizeName(child.Name);
                const symbols = result.get(key) || [];
                symbols.push({ uri: module.uri, object: child });
                result.set(key, symbols);
            }
        }

        if (useCache) {
            this.importedSymbolsByNameCache.set(fromUri, result);
        }

        return result;
    }

    private collectAffectedUris(uri: string): Set<string> {
        const result = new Set<string>([uri]);
        const queue = [uri];
        let position = 0;

        while (position < queue.length) {
            const current = queue[position++];

            for (const dependent of this.getDependents(current)) {
                if (result.has(dependent)) {
                    continue;
                }

                result.add(dependent);
                queue.push(dependent);
            }
        }

        return result;
    }

    private invalidateImportCaches(uris?: Iterable<string>): void {
        if (!uris) {
            this.importedModulesCache.clear();
            this.importedCompletionCache.clear();
            this.importedSymbolsByNameCache.clear();
            return;
        }

        for (const uri of uris) {
            this.importedModulesCache.delete(uri);
            this.importedCompletionCache.delete(uri);
            this.importedSymbolsByNameCache.delete(uri);
        }
    }

    private addModuleToIndexes(module: IIndexedModule): void {
        addUriAlias(this.modulesByBaseName, module.uri);

        for (const child of module.object.getChilds()) {
            const name = normalizeName(child.Name);

            if (!name) {
                continue;
            }

            const symbols = this.symbolsByName.get(name) || [];
            symbols.push({ uri: module.uri, object: child });
            this.symbolsByName.set(name, symbols);
        }

        for (const importName of module.imports) {
            const normalized = normalizeModuleName(importName);
            const aliases = new Set<string>([
                normalized,
                path.posix.basename(normalized)
            ]);

            aliases.forEach(alias => {
                const dependents = this.reverseImports.get(alias) || new Set();
                dependents.add(module.uri);
                this.reverseImports.set(alias, dependents);
            });
        }
    }

    private removeModuleFromIndexes(uri: string): void {
        const previous = this.modules.get(uri);

        if (!previous) {
            return;
        }

        removeUriAlias(this.modulesByBaseName, uri);

        for (const child of previous.object.getChilds()) {
            const name = normalizeName(child.Name);
            const symbols = this.symbolsByName.get(name);

            if (!symbols) {
                continue;
            }

            const filtered = symbols.filter(symbol => symbol.uri !== uri);

            if (filtered.length === 0) {
                this.symbolsByName.delete(name);
            } else {
                this.symbolsByName.set(name, filtered);
            }
        }

        for (const importName of previous.imports) {
            const normalized = normalizeModuleName(importName);
            const aliases = [normalized, path.posix.basename(normalized)];

            aliases.forEach(alias => {
                const dependents = this.reverseImports.get(alias);

                if (!dependents) {
                    return;
                }

                dependents.delete(uri);

                if (dependents.size === 0) {
                    this.reverseImports.delete(alias);
                }
            });
        }
    }
}

function resolveByModuleName<T>(
    moduleName: string,
    index: Map<string, Set<string>>,
    getValue: (uri: string) => T | undefined
): ModuleResolution<T> {
    const target = normalizeModuleName(moduleName);
    const targetBase = path.posix.basename(target);
    const uris = index.get(targetBase);

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

        if (normalizedPath === target || normalizedPath.endsWith("/" + target)) {
            exact.push(value);
        } else {
            fallback.push(value);
        }
    }

    const candidates = exact.length > 0 ? exact : fallback;

    if (candidates.length === 0) {
        return { kind: "missing" };
    }

    if (candidates.length === 1) {
        return { kind: "resolved", value: candidates[0] };
    }

    return { kind: "ambiguous", candidates };
}

function addUriAlias(index: Map<string, Set<string>>, uri: string): void {
    const baseName = path.posix.basename(normalizeUriPath(uri));
    const values = index.get(baseName) || new Set<string>();
    values.add(uri);
    index.set(baseName, values);
}

function removeUriAlias(index: Map<string, Set<string>>, uri: string): void {
    const baseName = path.posix.basename(normalizeUriPath(uri));
    const values = index.get(baseName);

    if (!values) {
        return;
    }

    values.delete(uri);

    if (values.size === 0) {
        index.delete(baseName);
    }
}

function normalizeName(value: string): string {
    return (value || "").toLowerCase();
}

function normalizeModuleName(value: string): string {
    let result = (value || "").trim().replace(/\\/g, "/").toLowerCase();

    while (result.startsWith("./")) {
        result = result.substring(2);
    }

    if (!result.endsWith(".mac")) {
        result += ".mac";
    }

    return result;
}

function normalizeUriPath(uri: string): string {
    try {
        return fileURLToPath(uri).replace(/\\/g, "/").toLowerCase();
    } catch (_error) {
        return uri.replace(/\\/g, "/").toLowerCase();
    }
}

function moduleAliases(uri: string): string[] {
    const normalized = normalizeUriPath(uri);
    return [normalized, path.posix.basename(normalized)];
}

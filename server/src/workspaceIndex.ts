import * as path from "path";
import { fileURLToPath } from "url";

import { CompletionItem } from "vscode-languageserver";

import { CBase, type IExternalLocationRange } from "./common";
import { LruCache } from "./core/lruCache";
import { IFAStruct } from "./interfaces";
import type { IRslParseResult } from "./syntaxParser";
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
    /** Контексты нужны только нескольким открытым/недавно активным документам. */
    importCacheEntries?: number;
}

interface IImportContext {
    modules: IIndexedModule[];
    symbolsByName: Map<string, IIndexedSymbol[]>;
    completionItems?: CompletionItem[];
    closureKey: string;
}

/** Индекс лёгких summary и полных моделей только для открытых документов. */
export class WorkspaceIndex {
    private modules = new Map<string, IIndexedModule>();
    private symbolsByName = new Map<string, IIndexedSymbol[]>();
    private reverseImports = new Map<string, Set<string>>();
    private workspaceFiles = new Set<string>();
    private workspaceFilesByBaseName = new Map<string, Set<string>>();
    private modulesByBaseName = new Map<string, Set<string>>();
    private importContextCache: LruCache<string, IImportContext>;
    private workspaceFilesInitialized = false;
    private importsEnabled = true;
    private revisionValue = 0;

    constructor(options: IWorkspaceIndexOptions = {}) {
        this.importContextCache = new LruCache(
            Math.max(1, options.importCacheEntries ?? 8)
        );
    }

    /** Совместимый API: false создаёт compact summary. */
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
        version: number,
        parsedSyntax?: IRslParseResult
    ): IIndexedModule {
        return this.replacePersistentModule(
            uri,
            createOpenModuleModel(source, object, parsedSyntax),
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
        this.invalidateImportContexts(affected);
        this.revisionValue++;
    }

    clear(): void {
        this.modules.clear();
        this.symbolsByName.clear();
        this.reverseImports.clear();
        this.workspaceFiles.clear();
        this.workspaceFilesByBaseName.clear();
        this.modulesByBaseName.clear();
        this.importContextCache.clear();
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
        if (this.workspaceFiles.delete(uri)) {
            removeUriAlias(this.workspaceFilesByBaseName, uri);
        }
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
        return resolution.kind === "resolved" ? resolution.value : undefined;
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
        return this.modules.get(uri)?.imports.slice() || [];
    }

    getImportedModules(uri: string): IIndexedModule[] {
        return this.importsEnabled
            ? this.getImportContext(uri).modules.slice()
            : [];
    }

    /** Ключ меняется только при изменении активного Import-графа. */
    getImportClosureKey(uri: string): string {
        if (!this.importsEnabled) {
            return "imports-disabled";
        }
        return this.getImportContext(uri).closureKey;
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
        return resolution.kind === "resolved" ? resolution.value : undefined;
    }

    findSymbols(name: string): IIndexedSymbol[] {
        return (this.symbolsByName.get(normalizeName(name)) || []).slice();
    }

    findImportedSymbols(fromUri: string, name: string): IIndexedSymbol[] {
        const byName = this.getImportContext(fromUri).symbolsByName;
        return (byName.get(normalizeName(name)) || []).slice();
    }

    getImportedCompletionItems(fromUri: string): CompletionItem[] {
        if (!this.importsEnabled) {
            return [];
        }

        const context = this.getImportContext(fromUri);
        if (context.completionItems) {
            return context.completionItems.slice();
        }

        const result: CompletionItem[] = [];
        const seen = new Set<string>();

        for (const module of context.modules) {
            for (const child of module.object.getChilds()) {
                if (child.Private) {
                    continue;
                }
                const key = normalizeName(child.Name);
                if (!seen.has(key)) {
                    seen.add(key);
                    result.push(child.CIInfo);
                }
            }
        }

        context.completionItems = result;
        return result.slice();
    }

    getDefinitionRange(
        uri: string,
        object: CBase
    ): IExternalLocationRange | undefined {
        return this.modules.get(uri)?.definitionRanges?.get(object);
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
        this.importContextCache.clear();
        this.revisionValue++;
    }

    /**
     * Временно подменяет только запись modules для точного References-разбора.
     * Глобальные symbol/import индексы не перестраиваются и не создают GC-пик.
     */
    withTransientOpenModule<T>(
        uri: string,
        source: string,
        action: (module: IIndexedModule) => T
    ): T {
        const previous = this.modules.get(uri);
        const model = createOpenModuleModel(source, new CBase(source, 0));
        const transient: IIndexedModule = {
            uri,
            ...model,
            object: model.symbolTree,
            version: previous?.version ?? 0,
            isOpen: true
        };
        const cachedContext = this.importContextCache.get(uri);
        this.importContextCache.delete(uri);
        this.modules.set(uri, transient);

        try {
            return action(transient);
        } finally {
            if (previous) {
                this.modules.set(uri, previous);
            } else {
                this.modules.delete(uri);
            }
            this.importContextCache.delete(uri);
            if (cachedContext) {
                this.importContextCache.set(uri, cachedContext);
            }
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
        return this.importContextCache.size;
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
        this.invalidateImportContexts(affected);
        this.revisionValue++;
        return module;
    }

    private getImportContext(uri: string): IImportContext {
        const useCache = this.modules.get(uri)?.isOpen === true;
        const cached = useCache ? this.importContextCache.get(uri) : undefined;
        if (cached) {
            return cached;
        }

        const modules: IIndexedModule[] = [];
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
                modules.push(imported);
                queue.push(imported.uri);
            }
        }

        const symbolsByName = new Map<string, IIndexedSymbol[]>();
        for (const module of modules) {
            for (const child of module.object.getChilds()) {
                if (child.Private) {
                    continue;
                }
                const key = normalizeName(child.Name);
                const symbols = symbolsByName.get(key) || [];
                symbols.push({ uri: module.uri, object: child });
                symbolsByName.set(key, symbols);
            }
        }

        const root = this.modules.get(uri);
        const closureKey = [root, ...modules]
            .filter((item): item is IIndexedModule => !!item)
            .map(item => `${item.uri}@${item.version}`)
            .sort()
            .join("|");
        const context: IImportContext = {
            modules,
            symbolsByName,
            closureKey
        };

        if (useCache) {
            this.importContextCache.set(uri, context);
        }
        return context;
    }

    private collectAffectedUris(uri: string): Set<string> {
        const result = new Set<string>([uri]);
        const queue = [uri];
        let position = 0;

        while (position < queue.length) {
            const current = queue[position++];
            for (const dependent of this.getDependents(current)) {
                if (!result.has(dependent)) {
                    result.add(dependent);
                    queue.push(dependent);
                }
            }
        }
        return result;
    }

    private invalidateImportContexts(uris?: Iterable<string>): void {
        if (!uris) {
            this.importContextCache.clear();
            return;
        }
        for (const uri of uris) {
            this.importContextCache.delete(uri);
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
    return candidates.length === 1
        ? { kind: "resolved", value: candidates[0] }
        : { kind: "ambiguous", candidates };
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

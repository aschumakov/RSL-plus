import { CompletionItem } from "vscode-languageserver";

import { LruCache } from "./core/lruCache";
import {
    compactOpenModuleModel,
    createExternalModuleSummary,
    createExternalModuleSummaryFromDeclarations,
    createOpenModuleModel,
    type IRslModuleModel
} from "./moduleModel";
import type { IRslParseResult } from "./syntaxParser";
import type {
    IExternalLocationRange,
    IRslDeclarationSnapshot
} from "./analysis/declarationExtractor";
import type { RslSymbol } from "./symbols/rslSymbol";
import { FileCatalog } from "./indexing/fileCatalog";
import { ImportGraph } from "./indexing/importGraph";
import { ModuleStore } from "./indexing/moduleStore";
import { SymbolIndex } from "./indexing/symbolIndex";
import type {
    IIndexedModule,
    IIndexedSymbol,
    ModuleResolution
} from "./indexing/indexTypes";

export type { IIndexedModule, IIndexedSymbol, ModuleResolution } from
    "./indexing/indexTypes";

export interface IWorkspaceIndexOptions {
    importCacheEntries?: number;
}

interface IImportContext {
    modules: IIndexedModule[];
    symbolsByName: Map<string, IIndexedSymbol[]>;
    completionItems?: CompletionItem[];
    closureKey: string;
}

/**
 * Координатор независимых индексов. Он не хранит собственные копии каталогов,
 * символов или Import-рёбер и отвечает только за атомарное обновление модели.
 */
export class WorkspaceIndex {
    private readonly files = new FileCatalog();
    private readonly modules = new ModuleStore();
    private readonly symbols = new SymbolIndex();
    private readonly imports = new ImportGraph();
    private readonly importContexts: LruCache<string, IImportContext>;
    private importsEnabled = true;
    private revisionValue = 0;

    constructor(options: IWorkspaceIndexOptions = {}) {
        this.importContexts = new LruCache(
            Math.max(1, options.importCacheEntries ?? 8)
        );
    }

    updateOpenModule(
        uri: string,
        source: string,
        version: number,
        parsedSyntax?: IRslParseResult
    ): IIndexedModule {
        return this.replace(
            uri,
            createOpenModuleModel(source, parsedSyntax),
            version,
            true
        );
    }

    updateExternalModule(
        uri: string,
        source: string,
        version: number
    ): IIndexedModule {
        return this.replace(
            uri,
            createExternalModuleSummary(source),
            version,
            false
        );
    }

    updateExternalModuleFromDeclarations(
        uri: string,
        sourceLength: number,
        declarations: IRslDeclarationSnapshot,
        version: number
    ): IIndexedModule {
        return this.replace(
            uri,
            createExternalModuleSummaryFromDeclarations(
                sourceLength,
                declarations
            ),
            version,
            false
        );
    }

    compactModule(uri: string): IIndexedModule | undefined {
        const current = this.modules.get(uri);
        if (!current) return undefined;
        if (current.kind === "external") {
            current.isOpen = false;
            return current;
        }
        return this.replace(
            uri,
            compactOpenModuleModel(current),
            current.version,
            false
        );
    }

    markClosed(uri: string): void {
        const module = this.modules.get(uri);
        if (module) module.isOpen = false;
    }

    markOpen(uri: string): void {
        const module = this.modules.get(uri);
        if (module) module.isOpen = true;
    }

    removeModule(uri: string): void {
        const affected = this.collectAffectedUris(uri);
        const previous = this.modules.delete(uri);
        if (previous) {
            this.symbols.remove(previous);
            this.imports.remove(previous);
        }
        affected.add(uri);
        this.invalidateImportContexts(affected);
        this.revisionValue++;
    }

    clear(): void {
        this.modules.clear();
        this.symbols.clear();
        this.imports.clear();
        this.files.clear();
        this.importContexts.clear();
        this.revisionValue++;
    }

    registerWorkspaceFiles(uris: readonly string[]): void {
        this.files.registerAll(uris);
    }
    registerWorkspaceFile(uri: string): void { this.files.register(uri); }
    unregisterWorkspaceFile(uri: string): void { this.files.unregister(uri); }
    getWorkspaceFileUris(): string[] { return this.files.values(); }
    resolveWorkspaceFile(name: string): ModuleResolution<string> {
        return this.files.resolve(name);
    }
    findWorkspaceFileUri(name: string): string | undefined {
        const result = this.files.resolve(name);
        return result.kind === "resolved" ? result.value : undefined;
    }

    getModule(uri: string): IIndexedModule | undefined {
        return this.modules.get(uri);
    }
    getModules(): IIndexedModule[] { return this.modules.values(); }
    getIndexedModules(): IIndexedModule[] { return this.modules.values(); }
    getOpenModules(): IIndexedModule[] {
        return this.modules.values().filter(module => module.isOpen);
    }
    getImportNames(uri: string): string[] {
        return this.modules.get(uri)?.imports.slice() || [];
    }
    getImportedModules(uri: string): IIndexedModule[] {
        return this.importsEnabled ? this.getImportContext(uri).modules.slice() : [];
    }
    getImportClosureKey(uri: string): string {
        return this.importsEnabled
            ? this.getImportContext(uri).closureKey
            : "imports-disabled";
    }
    resolveModule(name: string): ModuleResolution<IIndexedModule> {
        return this.modules.resolve(name);
    }
    findModuleByName(name: string): IIndexedModule | undefined {
        const result = this.modules.resolve(name);
        return result.kind === "resolved" ? result.value : undefined;
    }

    findSymbols(name: string): IIndexedSymbol[] { return this.symbols.find(name); }
    findImportedSymbols(uri: string, name: string): IIndexedSymbol[] {
        return (this.getImportContext(uri).symbolsByName.get(
            normalizeName(name)
        ) || []).slice();
    }
    findUnimportedSymbols(uri: string, name?: string): IIndexedSymbol[] {
        const imported = new Set(this.getImportedModules(uri).map(item => item.uri));
        imported.add(uri);
        const candidates = name ? this.symbols.find(name) : this.symbols.all();
        return candidates.filter(item =>
            !item.symbol.isPrivate && !imported.has(item.uri)
        );
    }

    getImportedCompletionItems(uri: string): CompletionItem[] {
        if (!this.importsEnabled) return [];
        const context = this.getImportContext(uri);
        if (context.completionItems) return context.completionItems.slice();
        const result: CompletionItem[] = [];
        const seen = new Set<string>();
        for (const module of context.modules) {
            for (const symbol of module.symbolTree.children) {
                if (symbol.isPrivate) continue;
                const key = normalizeName(symbol.name);
                if (seen.has(key)) continue;
                seen.add(key);
                const item = symbol.completionItem;
                result.push({
                    ...item,
                    detail: [
                        item.detail || "",
                        `Import: ${this.files.importName(module.uri)}`
                    ].filter(Boolean).join("\n"),
                    sortText: `5_${key}`,
                    data: {
                        ...(item.data as object || {}),
                        uri: module.uri,
                        symbolId: symbol.id
                    }
                });
            }
        }
        context.completionItems = result;
        return result.slice();
    }

    getDefinitionRange(
        uri: string,
        symbol: RslSymbol
    ): IExternalLocationRange | undefined {
        return this.modules.get(uri)?.definitionRanges?.get(symbol);
    }
    getDependents(uri: string): string[] { return this.imports.dependents(uri); }
    getImportNameForUri(uri: string): string { return this.files.importName(uri); }

    setImportsEnabled(enabled: boolean): void {
        if (this.importsEnabled === enabled) return;
        this.importsEnabled = enabled;
        this.importContexts.clear();
        this.revisionValue++;
    }

    withTransientOpenModule<T>(
        uri: string,
        source: string,
        action: (module: IIndexedModule) => T
    ): T {
        const previous = this.modules.get(uri);
        const model = createOpenModuleModel(source);
        const transient: IIndexedModule = {
            uri,
            ...model,
            version: previous?.version ?? 0,
            isOpen: true
        };
        const cached = this.importContexts.get(uri);
        this.importContexts.delete(uri);
        this.modules.set(transient);
        try {
            return action(transient);
        } finally {
            if (previous) this.modules.set(previous);
            else this.modules.delete(uri);
            this.importContexts.delete(uri);
            if (cached) this.importContexts.set(uri, cached);
        }
    }

    get areImportsEnabled(): boolean { return this.importsEnabled; }
    get workspaceFilesReady(): boolean { return this.files.ready; }
    get size(): number { return this.modules.size; }
    get revision(): number { return this.revisionValue; }
    get importCacheSize(): number { return this.importContexts.size; }

    private replace(
        uri: string,
        model: IRslModuleModel,
        version: number,
        isOpen: boolean
    ): IIndexedModule {
        const affected = this.collectAffectedUris(uri);
        const previous = this.modules.delete(uri);
        if (previous) {
            this.symbols.remove(previous);
            this.imports.remove(previous);
        }
        const module: IIndexedModule = { uri, ...model, version, isOpen };
        this.modules.set(module);
        this.files.register(uri);
        this.symbols.add(module);
        this.imports.add(module);
        this.collectAffectedUris(uri).forEach(value => affected.add(value));
        affected.add(uri);
        this.invalidateImportContexts(affected);
        this.revisionValue++;
        return module;
    }

    private getImportContext(uri: string): IImportContext {
        const cacheable = this.modules.get(uri)?.isOpen === true;
        const cached = cacheable ? this.importContexts.get(uri) : undefined;
        if (cached) return cached;

        const modules: IIndexedModule[] = [];
        const visited = new Set<string>([uri]);
        const queue = [uri];
        for (let position = 0; position < queue.length; position++) {
            const current = this.modules.get(queue[position]);
            if (!current) continue;
            for (const name of current.imports) {
                const imported = this.findModuleByName(name);
                if (!imported || visited.has(imported.uri)) continue;
                visited.add(imported.uri);
                modules.push(imported);
                queue.push(imported.uri);
            }
        }

        const symbolsByName = new Map<string, IIndexedSymbol[]>();
        for (const module of modules) {
            for (const symbol of module.symbolTree.children) {
                if (symbol.isPrivate) continue;
                const key = normalizeName(symbol.name);
                const values = symbolsByName.get(key) || [];
                values.push({ uri: module.uri, symbolId: symbol.id, symbol });
                symbolsByName.set(key, values);
            }
        }
        const root = this.modules.get(uri);
        const closureKey = [root, ...modules]
            .filter((item): item is IIndexedModule => !!item)
            .map(item => `${item.uri}@${item.version}`)
            .sort()
            .join("|");
        const context = { modules, symbolsByName, closureKey };
        if (cacheable) this.importContexts.set(uri, context);
        return context;
    }

    private collectAffectedUris(uri: string): Set<string> {
        const result = new Set<string>([uri]);
        const queue = [uri];
        for (let position = 0; position < queue.length; position++) {
            for (const dependent of this.imports.dependents(queue[position])) {
                if (!result.has(dependent)) {
                    result.add(dependent);
                    queue.push(dependent);
                }
            }
        }
        return result;
    }

    private invalidateImportContexts(uris: Iterable<string>): void {
        for (const uri of uris) this.importContexts.delete(uri);
    }
}

function normalizeName(value: string): string {
    return (value || "").toLowerCase();
}

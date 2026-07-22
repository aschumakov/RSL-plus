import * as path from "path";
import { fileURLToPath } from "url";

import { CompletionItem } from "vscode-languageserver";

import { CBase } from "./common";
import { IFAStruct } from "./interfaces";
import { createRslModuleModel, IRslModuleModel } from "./moduleModel";

export interface IIndexedModule extends IFAStruct, IRslModuleModel {
    /** Compatibility alias while provider-ы переходят с CBase на syntax model. */
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

/**
 * Индекс загруженных RSL-модулей и их зависимостей.
 *
 * Индекс не читает файлы сам: сервер передаёт ему уже разобранный документ.
 * Благодаря этому parser остаётся чистым, а управление I/O сосредоточено в
 * language server / definition provider.
 */
export class WorkspaceIndex {
    private modules: Map<string, IIndexedModule> =
        new Map<string, IIndexedModule>();

    private symbolsByName: Map<string, IIndexedSymbol[]> =
        new Map<string, IIndexedSymbol[]>();

    private reverseImports: Map<string, Set<string>> =
        new Map<string, Set<string>>();

    private workspaceFiles: Set<string> = new Set<string>();
    private workspaceFilesByBaseName: Map<string, Set<string>> =
        new Map<string, Set<string>>();
    private modulesByBaseName: Map<string, Set<string>> =
        new Map<string, Set<string>>();
    private importedModulesCache: Map<string, IIndexedModule[]> =
        new Map<string, IIndexedModule[]>();
    private importedCompletionCache: Map<string, CompletionItem[]> =
        new Map<string, CompletionItem[]>();
    private importedSymbolsByNameCache:
        Map<string, Map<string, IIndexedSymbol[]>> =
            new Map<string, Map<string, IIndexedSymbol[]>>();
    private workspaceFilesInitialized: boolean = false;
    private importsEnabled: boolean = true;

    updateModule(
        uri: string,
        source: string,
        object: CBase,
        version: number,
        isOpen: boolean = true
    ): IIndexedModule {
        this.removeModuleFromIndexes(uri);

        const model = createRslModuleModel(source, object, isOpen);
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
        this.invalidateImportCaches();
        return module;
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
        this.removeModuleFromIndexes(uri);
        this.modules.delete(uri);
        this.invalidateImportCaches();
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
    }

    registerWorkspaceFiles(uris: string[]): void {
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

    getImportNames(uri: string): string[] {
        const module = this.modules.get(uri);
        return module ? module.imports.slice() : [];
    }

    getImportedModules(uri: string): IIndexedModule[] {
        if (!this.importsEnabled) {
            return [];
        }

        const cached = this.importedModulesCache.get(uri);

        if (cached) {
            return cached.slice();
        }

        const result: IIndexedModule[] = [];
        const visited = new Set<string>();
        const queue: string[] = [uri];
        visited.add(uri);

        while (queue.length > 0) {
            const currentUri = queue.shift()!;
            const current = this.modules.get(currentUri);

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

        this.importedModulesCache.set(uri, result.slice());
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

    findImportedSymbols(
        fromUri: string,
        name: string
    ): IIndexedSymbol[] {
        const byName = this.getImportedSymbolsByName(fromUri);
        return (byName.get(normalizeName(name)) || []).slice();
    }

    private getImportedSymbolsByName(
        fromUri: string
    ): Map<string, IIndexedSymbol[]> {
        const cached = this.importedSymbolsByNameCache.get(fromUri);

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
                let symbols = result.get(key);

                if (!symbols) {
                    symbols = [];
                    result.set(key, symbols);
                }

                symbols.push({
                    uri: module.uri,
                    object: child
                });
            }
        }

        this.importedSymbolsByNameCache.set(fromUri, result);
        return result;
    }

    getImportedCompletionItems(fromUri: string): CompletionItem[] {
        const cached = this.importedCompletionCache.get(fromUri);

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

        this.importedCompletionCache.set(fromUri, result.slice());
        return result;
    }

    getDependents(uri: string): string[] {
        const moduleNames = moduleAliases(uri);
        const result = new Set<string>();

        for (const name of moduleNames) {
            const dependents = this.reverseImports.get(name);

            if (!dependents) {
                continue;
            }

            dependents.forEach(value => result.add(value));
        }

        result.delete(uri);
        return Array.from(result.values());
    }

    setImportsEnabled(enabled: boolean): void {
        if (this.importsEnabled === enabled) {
            return;
        }

        this.importsEnabled = enabled;
        this.invalidateImportCaches();
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

    private addModuleToIndexes(module: IIndexedModule): void {
        addUriAlias(this.modulesByBaseName, module.uri);

        for (const child of module.object.getChilds()) {
            const name = normalizeName(child.Name);

            if (!name) {
                continue;
            }

            let symbols = this.symbolsByName.get(name);

            if (!symbols) {
                symbols = [];
                this.symbolsByName.set(name, symbols);
            }

            symbols.push({
                uri: module.uri,
                object: child
            });
        }

        for (const importName of module.imports) {
            const normalized = normalizeModuleName(importName);
            const aliases = new Set<string>([
                normalized,
                path.posix.basename(normalized)
            ]);

            aliases.forEach(alias => {
                let dependents = this.reverseImports.get(alias);

                if (!dependents) {
                    dependents = new Set<string>();
                    this.reverseImports.set(alias, dependents);
                }

                dependents.add(module.uri);
            });
        }
    }

    private invalidateImportCaches(): void {
        this.importedModulesCache.clear();
        this.importedCompletionCache.clear();
        this.importedSymbolsByNameCache.clear();
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
            const aliases = [
                normalized,
                path.posix.basename(normalized)
            ];

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

        if (
            normalizedPath === target ||
            normalizedPath.endsWith("/" + target)
        ) {
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

function addUriAlias(
    index: Map<string, Set<string>>,
    uri: string
): void {
    const baseName = path.posix.basename(normalizeUriPath(uri));
    let values = index.get(baseName);

    if (!values) {
        values = new Set<string>();
        index.set(baseName, values);
    }

    values.add(uri);
}

function removeUriAlias(
    index: Map<string, Set<string>>,
    uri: string
): void {
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
    let result = (value || "")
        .trim()
        .replace(/\\/g, "/")
        .toLowerCase();

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
        return fileURLToPath(uri)
            .replace(/\\/g, "/")
            .toLowerCase();
    } catch (_error) {
        return uri.replace(/\\/g, "/").toLowerCase();
    }
}

function moduleAliases(uri: string): string[] {
    const normalized = normalizeUriPath(uri);
    return [
        normalized,
        path.posix.basename(normalized)
    ];
}

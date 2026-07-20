import * as path from "path";
import { fileURLToPath } from "url";

import { CompletionItem } from "vscode-languageserver";

import { CBase } from "./common";
import { IFAStruct } from "./interfaces";
import { GetImportedMacroFilesFromTokens } from "./execMacroDefinition";
import { IRslLexResult, lexRsl } from "./lexer";

export interface IIndexedModule extends IFAStruct {
    source: string;
    version: number;
    imports: string[];
    isOpen: boolean;
    lex: IRslLexResult;
}

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
    private workspaceFilesInitialized: boolean = false;

    updateModule(
        uri: string,
        source: string,
        object: CBase,
        version: number,
        isOpen: boolean = true
    ): IIndexedModule {
        this.removeModuleFromIndexes(uri);

        const lex = lexRsl(source);
        const module: IIndexedModule = {
            uri,
            source,
            object,
            version,
            imports: GetImportedMacroFilesFromTokens(lex.tokens),
            isOpen,
            lex
        };

        this.modules.set(uri, module);
        this.workspaceFiles.add(uri);
        this.addModuleToIndexes(module);
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
    }

    clear(): void {
        this.modules.clear();
        this.symbolsByName.clear();
        this.reverseImports.clear();
        this.workspaceFiles.clear();
        this.workspaceFilesInitialized = false;
    }

    registerWorkspaceFiles(uris: string[]): void {
        this.workspaceFilesInitialized = true;
        uris.forEach(uri => {
            if (uri) {
                this.workspaceFiles.add(uri);
            }
        });
    }

    registerWorkspaceFile(uri: string): void {
        if (uri) {
            this.workspaceFiles.add(uri);
        }
    }

    unregisterWorkspaceFile(uri: string): void {
        this.workspaceFiles.delete(uri);
    }

    findWorkspaceFileUri(moduleName: string): string | undefined {
        const target = normalizeModuleName(moduleName);
        const targetBase = path.posix.basename(target);
        let baseMatch: string | undefined;

        for (const uri of this.workspaceFiles) {
            const normalizedPath = normalizeUriPath(uri);

            if (
                normalizedPath === target ||
                normalizedPath.endsWith("/" + target)
            ) {
                return uri;
            }

            if (
                !baseMatch &&
                path.posix.basename(normalizedPath) === targetBase
            ) {
                baseMatch = uri;
            }
        }

        return baseMatch;
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

        return result;
    }

    findModuleByName(moduleName: string): IIndexedModule | undefined {
        const target = normalizeModuleName(moduleName);
        const targetBase = path.posix.basename(target);
        let baseMatch: IIndexedModule | undefined;

        for (const module of this.modules.values()) {
            const modulePath = normalizeUriPath(module.uri);

            if (
                modulePath === target ||
                modulePath.endsWith("/" + target)
            ) {
                return module;
            }

            if (
                !baseMatch &&
                path.posix.basename(modulePath) === targetBase
            ) {
                baseMatch = module;
            }
        }

        return baseMatch;
    }

    findSymbols(name: string): IIndexedSymbol[] {
        return (this.symbolsByName.get(normalizeName(name)) || []).slice();
    }

    findImportedSymbols(
        fromUri: string,
        name: string
    ): IIndexedSymbol[] {
        const normalized = normalizeName(name);
        const result: IIndexedSymbol[] = [];

        for (const module of this.getImportedModules(fromUri)) {
            for (const child of module.object.getChilds()) {
                if (
                    !child.Private &&
                    normalizeName(child.Name) === normalized
                ) {
                    result.push({
                        uri: module.uri,
                        object: child
                    });
                }
            }
        }

        return result;
    }

    getImportedCompletionItems(fromUri: string): CompletionItem[] {
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

    get workspaceFilesReady(): boolean {
        return this.workspaceFilesInitialized;
    }

    get size(): number {
        return this.modules.size;
    }

    private addModuleToIndexes(module: IIndexedModule): void {
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

    private removeModuleFromIndexes(uri: string): void {
        const previous = this.modules.get(uri);

        if (!previous) {
            return;
        }

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

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

import {
    CompletionItemKind,
    InitializeParams,
    Location
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";

import { RslSymbol } from "../symbols/rslSymbol";
import { createExternalModuleSummary } from "../moduleModel";
import type { IIndexedModule, ModuleResolution } from "../workspaceIndex";
import { IRslToken } from "../lexer";
import {
    GetDynamicDefinitionTargetFromTokens,
    GetImportDefinitionTargetFromTokens
} from "../execMacroDefinition";

export interface IRslDefinitionContext {
    document: TextDocument;
    tree: RslSymbol;
    offset: number;
    tokens: IRslToken[];
}

export interface IDefinitionEnvironment {
    getOpenDocument(uri: string): TextDocument | undefined;
    ensureDocumentParsed(
        document: TextDocument
    ): Promise<RslSymbol | undefined>;
    getLoadedModules(): IIndexedModule[];
    getImportedModules(uri: string): IIndexedModule[];
    findWorkspaceFileUri(moduleName: string): string | undefined;
    resolveWorkspaceFileUri?(moduleName: string): ModuleResolution<string>;
    ensureModuleByName?(moduleName: string): Promise<IIndexedModule | undefined>;
    getDefinitionRange?(
        uri: string,
        symbol: RslSymbol
    ): {
        start: { line: number; character: number };
        end: { line: number; character: number };
    } | undefined;
    log(message: string): void;
}

interface IDefinitionModule {
    uri: string;
    symbol: RslSymbol;
}

/**
 * Разрешает переходы к определениям, которые нельзя восстановить
 * по обычному токену: ExecMacro, ExecMacro2 и ExecMacroFile.
 */
export class RslDefinitionProvider {
    private workspaceRoots: string[] = [];

    private workspaceFileCache:
        Map<string, string | null> =
            new Map<string, string | null>();

    constructor(
        private environment: IDefinitionEnvironment
    ) {}

    configureWorkspace(params: InitializeParams): void {
        this.workspaceRoots = getWorkspaceRoots(params);
        this.clearCaches();
    }

    clearCaches(): void {
        this.workspaceFileCache.clear();
    }

    invalidateUri(_uri: string): void {
        /*
         * Отрицательный/положительный поиск мог зависеть от созданного,
         * удалённого или переименованного файла. Размер кэша небольшой,
         * поэтому безопаснее сбросить только path cache целиком.
         */
        this.workspaceFileCache.clear();
    }

    /**
     * Переходит к файлу, указанному в директиве Import.
     * Целью является начало подключаемого макромодуля.
     */
    async findImportDefinition(
        context: IRslDefinitionContext
    ): Promise<Location | null> {
        const target = GetImportDefinitionTargetFromTokens(
            context.tokens,
            context.offset
        );

        if (!target) {
            return null;
        }

        const filePath = await this.findWorkspaceFile(
            target.moduleName
        );

        if (!filePath) {
            return null;
        }

        return Location.create(
            pathToFileURL(filePath).toString(),
            {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 }
            }
        );
    }

    async findDynamicDefinition(
        context: IRslDefinitionContext
    ): Promise<Location | null> {
        const target = GetDynamicDefinitionTargetFromTokens(
            context.tokens,
            context.offset
        );

        if (!target) {
            return null;
        }

        if (target.kind === "macro" && target.macroName) {
            const localObject = findTopLevelMacro(
                context.tree,
                target.macroName,
                true
            );

            if (localObject) {
                return this.createObjectLocation(
                    context.document,
                    localObject
                );
            }

            for (const imported of this.environment
                .getImportedModules(context.document.uri)) {
                const symbol = findTopLevelMacro(
                    imported.symbolTree,
                    target.macroName,
                    false
                );

                if (!symbol) {
                    continue;
                }

                return this.createObjectLocationByUri(
                    imported.uri,
                    symbol
                );
            }

            return null;
        }

        if (!target.moduleName) {
            return null;
        }

        const module = await this.getModuleByName(
            target.moduleName
        );

        if (!module) {
            return null;
        }

        if (target.kind === "file") {
            return Location.create(module.uri, {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 }
            });
        }

        if (
            target.kind === "fileMacro" &&
            target.macroName
        ) {
            const symbol = findTopLevelMacro(
                module.symbol,
                target.macroName,
                true
            );

            return symbol
                ? this.createObjectLocationByUri(module.uri, symbol)
                : null;
        }

        return null;
    }

    /**
     * Строит Location именно по имени объявления.
     *
     * Range макроса и класса начинается с ключевого слова Macro/Class,
     * поэтому прежний переход выделял часть ключевого слова вместо имени.
     */
    async createObjectLocationByUri(
        uri: string,
        symbol: RslSymbol
    ): Promise<Location | null> {
        const openedDocument =
            this.environment.getOpenDocument(uri);

        if (openedDocument) {
            return this.createObjectLocation(
                openedDocument,
                symbol
            );
        }

        const indexedRange = this.environment.getDefinitionRange?.(uri, symbol);

        if (indexedRange) {
            return Location.create(uri, indexedRange);
        }

        const filePath = uriToFilePath(uri);

        if (filePath.length === 0) {
            return null;
        }

        try {
            const text = await fs.promises.readFile(
                filePath,
                "utf8"
            );
            const document = TextDocument.create(
                uri,
                "rsl",
                0,
                text
            );

            return this.createObjectLocation(
                document,
                symbol
            );
        } catch (error) {
            this.environment.log(
                `Definition document read failed: ${filePath}\n` +
                errorToString(error)
            );

            return null;
        }
    }

    createObjectLocation(
        document: TextDocument,
        symbol: RslSymbol
    ): Location {
        const offsets = findObjectNameOffsets(
            document,
            symbol
        );

        return Location.create(document.uri, {
            start: document.positionAt(offsets.start),
            end: document.positionAt(offsets.end)
        });
    }

    private async getModuleByName(
        moduleName: string
    ): Promise<IDefinitionModule | undefined> {
        const loaded = this.environment
            .getLoadedModules()
            .find(item => moduleMatchesUri(item.uri, moduleName));

        if (loaded) {
            const openedDocument = this.environment.getOpenDocument(loaded.uri);

            if (openedDocument) {
                const parsedTree = await this.environment.ensureDocumentParsed(
                    openedDocument
                );

                if (parsedTree) {
                    return { uri: loaded.uri, symbol: parsedTree };
                }
            }

            return { uri: loaded.uri, symbol: loaded.symbolTree };
        }

        /* Единственным владельцем external summary остаётся WorkspaceIndex. */
        const ensured = await this.environment.ensureModuleByName?.(moduleName);

        if (ensured) {
            return { uri: ensured.uri, symbol: ensured.symbolTree };
        }

        /* Fallback для unit-тестов/клиентов без WorkspaceModuleLoader: без кэша. */
        const filePath = await this.findWorkspaceFile(moduleName);

        if (!filePath) {
            return undefined;
        }

        try {
            const uri = pathToFileURL(filePath).toString();
            const text = await fs.promises.readFile(filePath, "utf8");
            return {
                uri,
                symbol: createExternalModuleSummary(text).symbolTree
            };
        } catch (error) {
            this.environment.log(
                `Definition module read failed: ${filePath}\n` +
                errorToString(error)
            );
            return undefined;
        }
    }

    private async findWorkspaceFile(
        moduleName: string
    ): Promise<string | undefined> {
        const indexedResolution = this.environment.resolveWorkspaceFileUri
            ? this.environment.resolveWorkspaceFileUri(moduleName)
            : undefined;

        if (indexedResolution?.kind === "ambiguous") {
            this.environment.log(
                `Ambiguous Import ${moduleName}: ` +
                indexedResolution.candidates.join(", ")
            );
            return undefined;
        }

        const indexedUri = indexedResolution?.kind === "resolved"
            ? indexedResolution.value
            : this.environment.findWorkspaceFileUri(moduleName);

        if (indexedUri) {
            const indexedPath = uriToFilePath(indexedUri);

            if (indexedPath && await isFile(indexedPath)) {
                return indexedPath;
            }
        }

        const target = normalizeModuleName(moduleName);
        const cached = this.workspaceFileCache.get(target);

        if (cached !== undefined) {
            return cached || undefined;
        }

        for (const root of this.workspaceRoots) {
            const directPath = path.resolve(
                root,
                target.replace(/\//g, path.sep)
            );

            if (
                isPathInsideRoot(root, directPath) &&
                await isFile(directPath)
            ) {
                this.workspaceFileCache.set(target, directPath);
                return directPath;
            }
        }

        for (const root of this.workspaceRoots) {
            const found = await findFileRecursively(
                root,
                target,
                root
            );

            if (found) {
                this.workspaceFileCache.set(target, found);
                return found;
            }
        }

        this.workspaceFileCache.set(target, null);
        return undefined;
    }
}

function getWorkspaceRoots(params: InitializeParams): string[] {
    const result: string[] = [];

    if (params.workspaceFolders) {
        params.workspaceFolders.forEach(folder => {
            const folderPath = uriToFilePath(folder.uri);

            if (folderPath.length > 0) {
                result.push(folderPath);
            }
        });
    }

    if (result.length === 0 && params.rootUri) {
        const rootPath = uriToFilePath(params.rootUri);

        if (rootPath.length > 0) {
            result.push(rootPath);
        }
    }

    if (result.length === 0 && params.rootPath) {
        result.push(path.resolve(params.rootPath));
    }

    return uniquePaths(result);
}

function uniquePaths(values: string[]): string[] {
    const result: string[] = [];
    const seen: { [value: string]: boolean } = Object.create(null);

    values.forEach(value => {
        const resolved = path.resolve(value);
        const normalized = process.platform === "win32"
            ? resolved.toLowerCase()
            : resolved;

        if (!seen[normalized]) {
            seen[normalized] = true;
            result.push(resolved);
        }
    });

    return result;
}

function uriToFilePath(uri: string): string {
    if (!uri) {
        return "";
    }

    try {
        return fileURLToPath(uri);
    } catch (_error) {
        return uri.indexOf("file:") === 0
            ? ""
            : path.resolve(uri);
    }
}

function normalizeModuleName(value: string): string {
    let result = (value || "")
        .trim()
        .replace(/\\/g, "/");

    while (result.indexOf("./") === 0) {
        result = result.substring(2);
    }

    if (!/\.mac$/i.test(result)) {
        result += ".mac";
    }

    return result.toLowerCase();
}

function moduleMatchesUri(
    uri: string,
    moduleName: string
): boolean {
    const target = normalizeModuleName(moduleName);
    const filePath = uriToFilePath(uri);

    if (filePath.length === 0) {
        return false;
    }

    const normalizedPath = filePath
        .replace(/\\/g, "/")
        .toLowerCase();

    return (
        normalizedPath === target ||
        normalizedPath.endsWith("/" + target) ||
        path.basename(normalizedPath) === path.basename(target)
    );
}

function findTopLevelMacro(
    tree: RslSymbol,
    macroName: string,
    includePrivate: boolean
): RslSymbol | undefined {
    return tree.children.find(child =>
        namesEqual(child.name, macroName) &&
        (
            child.kind === CompletionItemKind.Function ||
            child.kind === CompletionItemKind.Method
        ) &&
        (includePrivate || !child.isPrivate)
    );
}

function findObjectNameOffsets(
    document: TextDocument,
    symbol: RslSymbol
): { start: number; end: number } {
    const source = document.getText();
    const range = symbol.range;
    const name = symbol.name;

    if (
        source.substr(range.start, name.length)
            .toLowerCase() === name.toLowerCase()
    ) {
        return {
            start: range.start,
            end: range.start + name.length
        };
    }

    const lineEndIndex = source.indexOf("\n", range.start);
    const searchEnd = Math.min(
        range.end,
        lineEndIndex < 0 ? range.end : lineEndIndex
    );
    const header = source.substring(range.start, searchEnd);
    const identifierPattern =
        /[@A-Za-zА-Яа-яЁё_][@A-Za-zА-Яа-яЁё0-9_]*/g;

    let match: RegExpExecArray | null;

    while ((match = identifierPattern.exec(header)) !== null) {
        if (namesEqual(match[0], name)) {
            const start = range.start + match.index;

            return {
                start,
                end: start + match[0].length
            };
        }
    }

    return {
        start: range.start,
        end: range.start + name.length
    };
}

function isPathInsideRoot(
    root: string,
    candidate: string
): boolean {
    const relative = path.relative(
        path.resolve(root),
        path.resolve(candidate)
    );

    return (
        relative.length === 0 ||
        (
            relative !== ".." &&
            !relative.startsWith(".." + path.sep) &&
            relative.charAt(0) !== path.sep &&
            !/^[A-Za-z]:[\\/]/.test(relative)
        )
    );
}

async function isFile(filePath: string): Promise<boolean> {
    try {
        return (await fs.promises.stat(filePath)).isFile();
    } catch (_error) {
        return false;
    }
}

async function findFileRecursively(
    directory: string,
    target: string,
    root: string
): Promise<string | undefined> {
    let entries: fs.Dirent[];

    try {
        entries = await fs.promises.readdir(directory, {
            withFileTypes: true
        });
    } catch (_error) {
        return undefined;
    }

    entries.sort((left, right) =>
        left.name.localeCompare(right.name)
    );

    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }

        const candidate = path.join(directory, entry.name);
        const relative = path.relative(root, candidate)
            .replace(/\\/g, "/")
            .toLowerCase();

        if (
            relative === target ||
            relative.endsWith("/" + target) ||
            entry.name.toLowerCase() === path.basename(target)
        ) {
            return candidate;
        }
    }

    for (const entry of entries) {
        if (
            !entry.isDirectory() ||
            shouldSkipDirectory(entry.name)
        ) {
            continue;
        }

        const found = await findFileRecursively(
            path.join(directory, entry.name),
            target,
            root
        );

        if (found) {
            return found;
        }
    }

    return undefined;
}

function shouldSkipDirectory(name: string): boolean {
    const normalized = name.toLowerCase();

    return (
        normalized === ".git" ||
        normalized === "node_modules" ||
        normalized === "out" ||
        normalized === ".vscode-test"
    );
}

function namesEqual(left: string, right: string): boolean {
    return (left || "").toLowerCase() ===
        (right || "").toLowerCase();
}

function errorToString(error: any): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}\n${error.stack || ""}`;
    }

    return String(error);
}

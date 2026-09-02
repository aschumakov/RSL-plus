import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

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
    GetImportDefinitionTargetFromTokens,
    GetProcedureReferenceTargetFromTokens
} from "../execMacroDefinition";
import { getScopeChain } from "../scopeResolver";
import { decodeRslSourceText } from "../core/textDecoding";
import { normalizeModuleName } from "../indexing/moduleNames";

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
    /**
     * Единственный путь от имени модуля к файлу проекта.
     *
     * Отвечает WorkspaceModuleResolver: каталог проекта, а до его готовности —
     * адресный обход с теми же исключениями, который найденное в каталог и
     * складывает. URI возвращается зарегистрированный, а не собранный заново
     * из пути: у собранного не совпадает регистр, и он не равен байт в байт
     * тому, которым тот же файл зовёт редактор.
     */
    resolveModuleFile?(moduleName: string): Promise<ModuleResolution<string>>;
    /** Забыть найденное и ненайденное: файл создан, удалён или переименован. */
    invalidateModuleFiles?(): void;
    ensureModuleByName?(moduleName: string): Promise<IIndexedModule | undefined>;
    ensureImportedSymbol?(
        uri: string,
        symbolName: string
    ): Promise<boolean>;
    getDefinitionRange?(
        uri: string,
        symbol: RslSymbol
    ): {
        start: { line: number; character: number };
        end: { line: number; character: number };
    } | undefined;
    /**
     * Актуальный объект того же объявления в текущей модели файла.
     *
     * Символ мог быть запомнен кэшем соседнего документа до того, как
     * тело этого файла правили. Все его поля, кроме положений, к
     * идентичности объявления и относятся — а положения съезжают от
     * любой правки выше по файлу, и переход уходил на строку, где
     * этого объявления уже нет.
     */
    liveSymbol?(uri: string, symbol: RslSymbol): RslSymbol;
    resolveMethodReference?(
        uri: string,
        tree: RslSymbol,
        receiverOffset: number,
        methodName: string
    ): { uri: string; symbol: RslSymbol } | undefined;
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
    constructor(
        private environment: IDefinitionEnvironment
    ) {}

    configureWorkspace(_params: InitializeParams): void {
        /*
         * Корни проекта здесь больше не нужны.
         *
         * Имя модуля разрешает WorkspaceModuleResolver — он же знает корни,
         * исключаемые каталоги и правило неоднозначности. Прежде провайдер
         * держал своё: свой список корней, свой обход диска и свой кэш, и они
         * расходились с каталогом проекта.
         */
        this.clearCaches();
    }

    clearCaches(): void {
        this.environment.invalidateModuleFiles?.();
    }

    invalidateUri(_uri: string): void {
        /*
         * Созданный, удалённый или переименованный файл отменяет и найденное,
         * и ненайденное: имя, которого не было, теперь может разрешиться.
         */
        this.environment.invalidateModuleFiles?.();
    }

    /**
     * Переходит к файлу, указанному в директиве Import.
     * Целью является начало подключаемого макромодуля.
     */
    async findImportDefinition(
        context: IRslDefinitionContext
    ): Promise<Location | Location[] | null> {
        const target = GetImportDefinitionTargetFromTokens(
            context.tokens,
            context.offset
        );

        if (!target) {
            return null;
        }

        const resolution = await this.resolveModule(target.moduleName);

        /*
         * Неоднозначность — список назначений, а не молчание.
         *
         * Прежде здесь она превращалась в null, и два одноимённых файла до
         * построения каталога не давали перехода вовсе, а после — давали оба.
         * Ответ обязан быть одним и тем же.
         */
        if (resolution.kind === "ambiguous") {
            return [...resolution.candidates].sort().map(fileStart);
        }

        /* URI из каталога проекта, без пересборки из пути: см. resolveModuleFile. */
        return resolution.kind === "resolved"
            ? fileStart(resolution.value)
            : null;
    }

    async findDynamicDefinition(
        context: IRslDefinitionContext
    ): Promise<Location | null> {
        const target = GetDynamicDefinitionTargetFromTokens(
            context.tokens,
            context.offset
        );

        if (!target) {
            return this.findProcedureDefinition(context);
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

            const imported = await this.findImportedMacroDefinition(
                context.document.uri,
                target.macroName
            );
            if (imported) {
                return imported;
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

    /** Переход по callback, переданному строкой или через R2M. */
    private async findProcedureDefinition(
        context: IRslDefinitionContext
    ): Promise<Location | null> {
        const target = GetProcedureReferenceTargetFromTokens(
            context.tokens,
            context.offset
        );
        if (!target) {
            return null;
        }

        if (
            target.kind === "method" &&
            typeof target.receiverOffset === "number"
        ) {
            const resolved = this.environment.resolveMethodReference?.(
                context.document.uri,
                context.tree,
                target.receiverOffset,
                target.name
            );
            return resolved
                ? this.createObjectLocationByUri(
                    resolved.uri,
                    resolved.symbol
                )
                : null;
        }

        const local = findVisibleMacro(
            context.tree,
            target.name,
            context.offset
        );
        if (local) {
            return this.createObjectLocation(context.document, local);
        }

        const imported = await this.findImportedMacroDefinition(
            context.document.uri,
            target.name
        );
        if (imported) {
            return imported;
        }

        return null;
    }

    private async findImportedMacroDefinition(
        fromUri: string,
        macroName: string
    ): Promise<Location | null> {
        const findKnown = async (): Promise<Location | null> => {
            for (const imported of this.environment.getImportedModules(fromUri)) {
                const symbol = findTopLevelMacro(
                    imported.symbolTree,
                    macroName,
                    false
                );
                if (symbol) {
                    return this.createObjectLocationByUri(imported.uri, symbol);
                }
            }
            return null;
        };

        const known = await findKnown();
        if (known) return known;

        if (await this.environment.ensureImportedSymbol?.(fromUri, macroName)) {
            return findKnown();
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
        given: RslSymbol
    ): Promise<Location | null> {
        /* Положение спрашивается у актуального объекта. */
        const symbol = this.environment.liveSymbol?.(uri, given) ||
            given;
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
            const text = decodeRslSourceText(
                await fs.promises.readFile(filePath)
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
        const uri = await this.findWorkspaceFileUri(moduleName);
        const filePath = uri ? uriToFilePath(uri) : "";

        if (!filePath) {
            return undefined;
        }

        try {
            const text = decodeRslSourceText(
                await fs.promises.readFile(filePath)
            );
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

    /**
     * URI файла проекта по имени модуля.
     *
     * Неоднозначность не разрешается выбором наугад ни на одном пути: два
     * одноимённых файла — это вопрос к человеку, а не повод увести в первый
     * попавшийся. Прежде так и было до готовности каталога.
     */
    private async findWorkspaceFileUri(
        moduleName: string
    ): Promise<string | undefined> {
        const resolution = await this.resolveModule(moduleName);

        if (resolution.kind === "ambiguous") {
            this.environment.log(
                `Ambiguous Import ${moduleName}: ` +
                resolution.candidates.join(", ")
            );

            return undefined;
        }

        return resolution.kind === "resolved" ? resolution.value : undefined;
    }

    private async resolveModule(
        moduleName: string
    ): Promise<ModuleResolution<string>> {
        if (this.environment.resolveModuleFile) {
            return this.environment.resolveModuleFile(moduleName);
        }

        /* Клиент без resolver: отвечает только каталог, обхода диска нет. */
        const known = this.environment.resolveWorkspaceFileUri?.(moduleName);

        if (known) {
            return known;
        }

        const uri = this.environment.findWorkspaceFileUri(moduleName);

        return uri ? { kind: "resolved", value: uri } : { kind: "missing" };
    }
}

/** Начало файла: у макромодуля нет объявления, к которому можно было бы вести. */
function fileStart(uri: string): Location {
    return Location.create(uri, {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 }
    });
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

function findVisibleMacro(
    tree: RslSymbol,
    macroName: string,
    offset: number
): RslSymbol | undefined {
    for (const scope of getScopeChain(tree, offset).reverse()) {
        const found = scope.children.find(child =>
            namesEqual(child.name, macroName) &&
            (
                child.kind === CompletionItemKind.Function ||
                child.kind === CompletionItemKind.Method
            )
        );
        if (found) {
            return found;
        }
    }
    return undefined;
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

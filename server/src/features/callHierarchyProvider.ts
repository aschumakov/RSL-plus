import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { collectRslCallSites } from "../analysis/callSiteFacts";
import {
    resolveRslStringCallSite
} from "../analysis/callSiteResolution";

import {
    CallHierarchyIncomingCall,
    CallHierarchyItem,
    CallHierarchyOutgoingCall,
    CompletionItemKind,
    Location,
    Range,
    SymbolKind
} from "vscode-languageserver";

import type { RslSymbol } from "../symbols/rslSymbol";
import {
    findRslReferencesForSymbol
} from "../analysis/references";
import type { ReferenceIndex } from "../analysis/referenceIndex";
import type {
    RslReferenceShardStore
} from "../analysis/referenceShards";
import { normalizeIdentifier , lowerBoundTokenIndex, tokenIndexAtOffset } from "../lexer";
import type { RslScopeResolver } from "../scopeResolver";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";
import { decodeRslSourceText } from "../core/textDecoding";
import {
    offsetInModule
} from "../core/documentPosition";
import {
    positionInModule
} from "../core/documentPosition";

interface ICallHierarchyData {
    uri: string;
    name: string;
    start: number;
    end: number;
    declarationOffset: number;
}

export interface ICallHierarchyEnvironment {
    index: WorkspaceIndex;
    resolver: RslScopeResolver;
    referenceIndex: ReferenceIndex;
    /** Постоянные записи о ссылках, если сервер их ведёт. */
    referenceShards?: RslReferenceShardStore;
}

export class RslCallHierarchyProvider {
    constructor(private environment: ICallHierarchyEnvironment) {}

    prepare(uri: string, offset: number): CallHierarchyItem[] {
        const module = this.environment.index.getModule(uri);
        if (!module) {
            return [];
        }

        const resolved = this.environment.resolver.resolveAt(
            uri,
            module.symbolTree,
            offset
        );
        if (!resolved || !isCallable(resolved.symbol)) {
            return [];
        }

        const targetModule = this.environment.index.getModule(resolved.uri);
        if (!targetModule) {
            return [];
        }

        return [createCallHierarchyItem(
            this.environment.index,
            targetModule,
            resolved.symbol
        )];
    }

    async incoming(
        item: CallHierarchyItem,
        isCancelled: () => boolean = () => false
    ): Promise<CallHierarchyIncomingCall[]> {
        const data = getData(item);
        if (!data || isCancelled()) {
            return [];
        }

        const targetModule = this.environment.index.getModule(data.uri);
        const targetObject = targetModule
            ? findObjectByData(targetModule.symbolTree, data)
            : undefined;
        if (!targetObject) {
            return [];
        }

        const references = await findRslReferencesForSymbol(
            this.environment.index,
            this.environment.resolver,
            this.environment.referenceIndex,
            data.uri,
            targetObject,
            false,
            isCancelled,
            this.environment.referenceShards
        );
        const byUri = groupLocationsByUri(references);
        const grouped = new Map<string, CallHierarchyIncomingCall>();

        for (const [uri, locations] of byUri) {
            if (isCancelled()) {
                return [];
            }

            await this.withFullModule(uri, module => {
                /*
                 * Места вызова файла разбираются один раз на все находки.
                 *
                 * Проверки «идентификатор и открывающая скобка» мало: вызов
                 * может быть записан строкой, и тогда в этом месте стоит
                 * строковый литерал, а не имя.
                 */
                const callStarts = new Set(
                    collectRslCallSites(module.syntax.tokens)
                        .map(site => site.start)
                );

                for (const location of locations) {
                    const offset = offsetInModule(module, location.range.start);
                    const tokenIndex = findTokenIndexAt(module, offset);
                    const isCall = callStarts.has(offset) ||
                        (tokenIndex >= 0 && isCallToken(module, tokenIndex));

                    if (!isCall) {
                        continue;
                    }

                    const caller = findEnclosingCallable(
                        module.symbolTree,
                        offset
                    );
                    const callerItem = caller
                        ? createCallHierarchyItem(
                            this.environment.index,
                            module,
                            caller
                        )
                        : createFileCallHierarchyItem(module);
                    const callerData = getData(callerItem);
                    const key = callerData
                        ? `${callerData.uri}:${callerData.start}:${callerData.end}`
                        : `${callerItem.uri}:${callerItem.name}`;
                    const existing = grouped.get(key);

                    if (existing) {
                        existing.fromRanges.push(location.range);
                    } else {
                        grouped.set(key, {
                            from: callerItem,
                            fromRanges: [location.range]
                        });
                    }
                }
            });
        }

        return Array.from(grouped.values()).sort((left, right) =>
            left.from.name.localeCompare(right.from.name)
        );
    }

    async outgoing(
        item: CallHierarchyItem,
        isCancelled: () => boolean = () => false
    ): Promise<CallHierarchyOutgoingCall[]> {
        const data = getData(item);
        if (!data || isCancelled()) {
            return [];
        }

        const result = new Map<string, CallHierarchyOutgoingCall>();

        await this.withFullModule(data.uri, module => {
            /*
             * Места вызова разбирает общий механизм.
             *
             * Прежде вызовом считался «идентификатор и открывающая
             * скобка», и строковые формы — ExecMacro, ExecMacroFile,
             * R2M, обработчики — не попадали в ответ вовсе. Для RSL это
             * не редкость, а обычный способ вызвать процедуру.
             */
            for (const site of collectRslCallSites(module.syntax.tokens)) {
                if (isCancelled()) {
                    return;
                }

                if (
                    site.start < data.start ||
                    site.end > data.end ||
                    site.start === data.declarationOffset
                ) {
                    continue;
                }

                /*
                 * Обычный вызов по-прежнему разрешает resolver по
                 * смещению: там работают области видимости. У строковой
                 * формы идентификатора нет, и имя ищется по модулям.
                 */
                const resolved = site.kind === "call" ||
                    site.kind === "method"
                    ? this.environment.resolver.resolveAt(
                        module.uri,
                        module.symbolTree,
                        site.start
                    )
                    : resolveRslStringCallSite(
                        this.environment.index,
                        module,
                        site
                    );

                if (!resolved || !isCallable(resolved.symbol)) {
                    continue;
                }

                const targetModule = this.environment.index.getModule(
                    resolved.uri
                );
                if (!targetModule) {
                    continue;
                }

                const targetItem = createCallHierarchyItem(
                    this.environment.index,
                    targetModule,
                    resolved.symbol
                );
                const targetData = getData(targetItem);
                const key = targetData
                    ? `${targetData.uri}:${targetData.start}:${targetData.end}`
                    : `${targetItem.uri}:${targetItem.name}`;
                const range = offsetRange(module, site.start, site.end);
                const existing = result.get(key);

                if (existing) {
                    existing.fromRanges.push(range);
                } else {
                    result.set(key, {
                        to: targetItem,
                        fromRanges: [range]
                    });
                }
            }
        });

        return Array.from(result.values()).sort((left, right) =>
            left.to.name.localeCompare(right.to.name)
        );
    }

    private async withFullModule<T>(
        uri: string,
        action: (module: IIndexedModule) => T
    ): Promise<T | undefined> {
        const existing = this.environment.index.getModule(uri);

        if (existing?.kind === "open") {
            return action(existing);
        }

        let filePath: string;
        try {
            filePath = fileURLToPath(uri);
        } catch (_error) {
            return undefined;
        }

        try {
            const source = decodeRslSourceText(
                await fs.promises.readFile(filePath)
            );
            let value: T | undefined;

            this.environment.index.withTransientOpenModule(
                uri,
                source,
                module => {
                    value = action(module);
                }
            );

            return value;
        } catch (_error) {
            return undefined;
        }
    }
}

function createCallHierarchyItem(
    index: WorkspaceIndex,
    module: IIndexedModule,
    given: RslSymbol
): CallHierarchyItem {
    /*
     * Положения берутся у объекта из ТЕКУЩЕЙ модели этого файла.
     *
     * Символ мог прийти из кэша разрешения имён соседнего документа,
     * собранного до правки тела этого файла: имя, вид и подпись у него
     * те же, а диапазоны съехали.
     */
    const symbol = index.liveSymbol(module.uri, given);
    const selectionRange = findNameRange(index, module, symbol);
    const range = module.kind === "open"
        ? offsetRange(module, symbol.range.start, symbol.range.end)
        : selectionRange;
    const data: ICallHierarchyData = {
        uri: module.uri,
        name: symbol.name,
        start: symbol.range.start,
        end: symbol.range.end,
        declarationOffset: nameOffset(module, symbol)
    };

    return {
        name: symbol.name,
        kind: symbol.kind === CompletionItemKind.Method
            ? SymbolKind.Method
            : SymbolKind.Function,
        detail: displayFile(module.uri),
        uri: module.uri,
        range,
        selectionRange,
        data
    };
}

function createFileCallHierarchyItem(
    module: IIndexedModule
): CallHierarchyItem {
    const range = offsetRange(module, 0, module.source.length);
    const data: ICallHierarchyData = {
        uri: module.uri,
        name: displayFile(module.uri),
        start: 0,
        end: module.source.length,
        declarationOffset: 0
    };

    return {
        name: displayFile(module.uri),
        kind: SymbolKind.File,
        uri: module.uri,
        range,
        selectionRange: {
            start: range.start,
            end: range.start
        },
        data
    };
}

function findEnclosingCallable(
    root: RslSymbol,
    offset: number
): RslSymbol | undefined {
    let result: RslSymbol | undefined;

    const visit = (node: RslSymbol): void => {
        for (const child of node.children) {
            if (
                child.range.start <= offset &&
                offset <= child.range.end
            ) {
                if (isCallable(child)) {
                    result = child;
                }
                if (child.isContainer) {
                    visit(child);
                }
            }
        }
    };

    visit(root);
    return result;
}

function findObjectByData(
    root: RslSymbol,
    data: ICallHierarchyData
): RslSymbol | undefined {
    const normalizedName = normalizeIdentifier(data.name);
    const queue = [root];

    for (let position = 0; position < queue.length; position++) {
        const current = queue[position];

        for (const child of current.children) {
            if (
                isCallable(child) &&
                normalizeIdentifier(child.name) === normalizedName &&
                child.range.start === data.start &&
                child.range.end === data.end
            ) {
                return child;
            }

            if (child.isContainer) {
                queue.push(child);
            }
        }
    }

    return undefined;
}

function findNameRange(
    index: WorkspaceIndex,
    module: IIndexedModule,
    symbol: RslSymbol
): Range {
    const external = index.getDefinitionRange(module.uri, symbol);
    if (external) {
        return external;
    }

    const offset = nameOffset(module, symbol);
    const tokens = module.syntax.tokens;
    const at = lowerBoundTokenIndex(tokens, offset);
    const token = at < tokens.length && tokens[at].start === offset
        ? tokens[at]
        : undefined;

    return token
        ? tokenRange(token)
        : offsetRange(module, symbol.range.start, symbol.range.start);
}

function nameOffset(module: IIndexedModule, symbol: RslSymbol): number {
    const normalized = normalizeIdentifier(symbol.name);
    /* Имя ищется внутри объявления, а не по всему файлу. */
    const tokens = module.syntax.tokens;

    for (
        let at = lowerBoundTokenIndex(tokens, symbol.range.start);
        at < tokens.length && tokens[at].start <= symbol.range.end;
        at++
    ) {
        const candidate = tokens[at];

        if (
            candidate.kind === "identifier" &&
            candidate.end <= symbol.range.end &&
            normalizeIdentifier(candidate.value) === normalized
        ) {
            return candidate.start;
        }
    }

    return symbol.range.start;
}

function findTokenIndexAt(
    module: IIndexedModule,
    offset: number
): number {
    return tokenIndexAtOffset(module.syntax.tokens, offset);
}

function isCallToken(
    module: IIndexedModule,
    tokenIndex: number
): boolean {
    const token = module.syntax.tokens[tokenIndex];
    const next = module.syntax.tokens[tokenIndex + 1];

    return token?.kind === "identifier" &&
        next?.kind === "symbol" &&
        next.raw === "(";
}

function isCallable(symbol: RslSymbol): boolean {
    return symbol.kind === CompletionItemKind.Function ||
        symbol.kind === CompletionItemKind.Method;
}

function groupLocationsByUri(
    locations: readonly Location[]
): Map<string, Location[]> {
    const result = new Map<string, Location[]>();

    for (const location of locations) {
        const values = result.get(location.uri) || [];
        values.push(location);
        result.set(location.uri, values);
    }

    return result;
}

function getData(item: CallHierarchyItem): ICallHierarchyData | undefined {
    const data = item.data as Partial<ICallHierarchyData> | undefined;

    return data &&
        typeof data.uri === "string" &&
        typeof data.start === "number" &&
        typeof data.end === "number" &&
        typeof data.declarationOffset === "number"
        ? data as ICallHierarchyData
        : undefined;
}

function tokenRange(token: {
    line: number;
    character: number;
    endLine: number;
    endCharacter: number;
}): Range {
    return {
        start: {
            line: token.line,
            character: token.character
        },
        end: {
            line: token.endLine,
            character: token.endCharacter
        }
    };
}

function offsetRange(
    module: IIndexedModule,
    start: number,
    end: number
): Range {
    return {
        start: positionInModule(module, start),
        end: positionInModule(module, end)
    };
}



function displayFile(uri: string): string {
    try {
        return path.basename(fileURLToPath(uri));
    } catch (_error) {
        return path.basename(uri);
    }
}

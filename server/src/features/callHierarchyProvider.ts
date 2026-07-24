import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import {
    CallHierarchyIncomingCall,
    CallHierarchyItem,
    CallHierarchyOutgoingCall,
    CompletionItemKind,
    Location,
    Range,
    SymbolKind
} from "vscode-languageserver";

import type { CBase } from "../common";
import {
    findRslReferencesForSymbol
} from "../analysis/references";
import type { ReferenceIndex } from "../analysis/referenceIndex";
import { normalizeIdentifier } from "../lexer";
import type { RslScopeResolver } from "../scopeResolver";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

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
            module.object,
            offset
        );
        if (!resolved || !isCallable(resolved.object)) {
            return [];
        }

        const targetModule = this.environment.index.getModule(resolved.uri);
        if (!targetModule) {
            return [];
        }

        return [createCallHierarchyItem(
            this.environment.index,
            targetModule,
            resolved.object
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
            ? findObjectByData(targetModule.object, data)
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
            isCancelled
        );
        const byUri = groupLocationsByUri(references);
        const grouped = new Map<string, CallHierarchyIncomingCall>();

        for (const [uri, locations] of byUri) {
            if (isCancelled()) {
                return [];
            }

            await this.withFullModule(uri, module => {
                for (const location of locations) {
                    const offset = offsetAt(module, location.range.start);
                    const tokenIndex = findTokenIndexAt(module, offset);

                    if (
                        tokenIndex < 0 ||
                        !isCallToken(module, tokenIndex)
                    ) {
                        continue;
                    }

                    const caller = findEnclosingCallable(
                        module.object,
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
            const tokens = module.syntax.tokens;

            for (let index = 0; index < tokens.length; index++) {
                if (isCancelled()) {
                    return;
                }

                const token = tokens[index];
                if (
                    token.start < data.start ||
                    token.end > data.end ||
                    token.kind !== "identifier" ||
                    !isCallToken(module, index) ||
                    token.start === data.declarationOffset
                ) {
                    continue;
                }

                const resolved = this.environment.resolver.resolveAt(
                    module.uri,
                    module.object,
                    token.start
                );

                if (!resolved || !isCallable(resolved.object)) {
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
                    resolved.object
                );
                const targetData = getData(targetItem);
                const key = targetData
                    ? `${targetData.uri}:${targetData.start}:${targetData.end}`
                    : `${targetItem.uri}:${targetItem.name}`;
                const range = tokenRange(token);
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
            const source = await fs.promises.readFile(filePath, "utf8");
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
    object: CBase
): CallHierarchyItem {
    const selectionRange = findNameRange(index, module, object);
    const range = module.kind === "open"
        ? offsetRange(module, object.Range.start, object.Range.end)
        : selectionRange;
    const data: ICallHierarchyData = {
        uri: module.uri,
        name: object.Name,
        start: object.Range.start,
        end: object.Range.end,
        declarationOffset: nameOffset(module, object)
    };

    return {
        name: object.Name,
        kind: object.ObjKind === CompletionItemKind.Method
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
    root: CBase,
    offset: number
): CBase | undefined {
    let result: CBase | undefined;

    const visit = (node: CBase): void => {
        for (const child of node.getChilds()) {
            if (
                child.Range.start <= offset &&
                offset <= child.Range.end
            ) {
                if (isCallable(child)) {
                    result = child;
                }
                if (child.isObject()) {
                    visit(child);
                }
            }
        }
    };

    visit(root);
    return result;
}

function findObjectByData(
    root: CBase,
    data: ICallHierarchyData
): CBase | undefined {
    const normalizedName = normalizeIdentifier(data.name);
    const queue = [root];

    for (let position = 0; position < queue.length; position++) {
        const current = queue[position];

        for (const child of current.getChilds()) {
            if (
                isCallable(child) &&
                normalizeIdentifier(child.Name) === normalizedName &&
                child.Range.start === data.start &&
                child.Range.end === data.end
            ) {
                return child;
            }

            if (child.isObject()) {
                queue.push(child);
            }
        }
    }

    return undefined;
}

function findNameRange(
    index: WorkspaceIndex,
    module: IIndexedModule,
    object: CBase
): Range {
    const external = index.getDefinitionRange(module.uri, object);
    if (external) {
        return external;
    }

    const offset = nameOffset(module, object);
    const token = module.syntax.tokens.find(candidate =>
        candidate.start === offset
    );

    return token
        ? tokenRange(token)
        : offsetRange(module, object.Range.start, object.Range.start);
}

function nameOffset(module: IIndexedModule, object: CBase): number {
    const normalized = normalizeIdentifier(object.Name);
    const token = module.syntax.tokens.find(candidate =>
        candidate.kind === "identifier" &&
        object.Range.start <= candidate.start &&
        candidate.end <= object.Range.end &&
        normalizeIdentifier(candidate.value) === normalized
    );

    return token?.start ?? object.Range.start;
}

function findTokenIndexAt(
    module: IIndexedModule,
    offset: number
): number {
    return module.syntax.tokens.findIndex(token =>
        token.start <= offset && offset <= token.end
    );
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

function isCallable(object: CBase): boolean {
    return object.ObjKind === CompletionItemKind.Function ||
        object.ObjKind === CompletionItemKind.Method;
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
        start: positionAt(module, start),
        end: positionAt(module, end)
    };
}

function positionAt(
    module: IIndexedModule,
    offset: number
): { line: number; character: number } {
    const starts = module.lex.lineStarts;
    let left = 0;
    let right = starts.length - 1;
    let line = 0;

    while (left <= right) {
        const middle = (left + right) >>> 1;
        if (starts[middle] <= offset) {
            line = middle;
            left = middle + 1;
        } else {
            right = middle - 1;
        }
    }

    return {
        line,
        character: Math.max(0, offset - starts[line])
    };
}

function offsetAt(
    module: IIndexedModule,
    position: { line: number; character: number }
): number {
    const line = Math.max(
        0,
        Math.min(position.line, module.lex.lineStarts.length - 1)
    );
    return Math.min(
        module.source.length,
        module.lex.lineStarts[line] + Math.max(0, position.character)
    );
}

function displayFile(uri: string): string {
    try {
        return path.basename(fileURLToPath(uri));
    } catch (_error) {
        return path.basename(uri);
    }
}

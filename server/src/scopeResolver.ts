import {
    CompletionItem,
    CompletionItemKind
} from "vscode-languageserver";

import { CBase } from "./common";
import {
    IRslToken,
    tokenAtOffset,
    normalizeIdentifier
} from "./lexer";
import {
    IIndexedModule,
    IIndexedSymbol,
    WorkspaceIndex
} from "./workspaceIndex";

export interface IResolvedSymbol {
    uri: string;
    object: CBase;
    token: IRslToken;
}

/*
 * CBase после построения syntax tree фактически неизменяем. Кэши WeakMap
 * не удерживают старые деревья после обновления документа.
 */
const objectChildrenCache = new WeakMap<CBase, CBase[]>();
const childrenByNameCache = new WeakMap<CBase, Map<string, CBase[]>>();

/**
 * Разрешает имена с учётом областей видимости RSL.
 *
 * Горячий путь используется semantic tokens для каждого идентификатора,
 * поэтому здесь нельзя заново фильтровать весь token stream или линейно
 * перебирать все объявления scope при каждом вызове.
 */
export class RslScopeResolver {
    private tokensByModule = new WeakMap<IIndexedModule, IRslToken[]>();

    constructor(private index: WorkspaceIndex) {}

    resolveAt(
        uri: string,
        tree: CBase,
        offset: number
    ): IResolvedSymbol | undefined {
        const module = this.index.getModule(uri);

        if (!module) {
            return undefined;
        }

        const tokens = this.getTokens(module);
        const token = tokenAtOffset(tokens, offset, true);

        if (!token || token.kind !== "identifier") {
            return undefined;
        }

        const tokenIndex = findTokenIndex(tokens, token);
        const receiver = this.getReceiverToken(tokens, tokenIndex);

        if (receiver) {
            const member = this.resolveMember(
                uri,
                tree,
                offset,
                receiver,
                token.value
            );

            if (member) {
                return {
                    uri: member.uri,
                    object: member.object,
                    token
                };
            }
        }

        const local = this.resolveInScopeChain(
            tree,
            token.value,
            offset
        );

        if (local) {
            return { uri, object: local, token };
        }

        const imported = this.index.findImportedSymbols(
            uri,
            token.value
        )[0];

        return imported
            ? {
                uri: imported.uri,
                object: imported.object,
                token
            }
            : undefined;
    }

    getCompletions(
        uri: string,
        tree: CBase,
        offset: number
    ): CompletionItem[] {
        const module = this.index.getModule(uri);

        if (!module) {
            return [];
        }

        const tokens = this.getTokens(module);
        const dotIndex = this.getDotIndexBeforeOffset(tokens, offset);

        if (dotIndex >= 0) {
            const receiver = this.getPreviousIdentifier(tokens, dotIndex);

            if (receiver) {
                const classObject = this.resolveReceiverClass(
                    uri,
                    tree,
                    offset,
                    receiver
                );

                if (classObject) {
                    const allowPrivate = this.canAccessPrivateMembers(
                        uri,
                        tree,
                        offset,
                        classObject
                    );

                    return deduplicateCompletionItems(
                        classObject.object
                            .getChilds()
                            .filter(child =>
                                allowPrivate || !child.Private
                            )
                            .map(child => child.CIInfo)
                    );
                }
            }
        }

        const result: CompletionItem[] = [];
        const scopes = getScopeChain(tree, offset).reverse();

        for (const scope of scopes) {
            for (const child of scope.getChilds()) {
                if (child.Private && scope === tree) {
                    continue;
                }

                if (!isVisibleAt(child, offset)) {
                    continue;
                }

                result.push(child.CIInfo);
            }
        }

        result.push(...this.index.getImportedCompletionItems(uri));
        return deduplicateCompletionItems(result);
    }

    resolveInScopeChain(
        tree: CBase,
        name: string,
        offset: number
    ): CBase | undefined {
        const normalized = normalizeIdentifier(name);
        const scopes = getScopeChain(tree, offset).reverse();

        for (const scope of scopes) {
            const candidates = getChildrenByName(scope).get(normalized);

            if (!candidates || candidates.length === 0) {
                continue;
            }

            const selected = selectBestVisibleCandidate(candidates, offset);

            if (selected) {
                return selected;
            }
        }

        return undefined;
    }

    private getTokens(module: IIndexedModule): IRslToken[] {
        let result = this.tokensByModule.get(module);

        if (!result) {
            /* syntax.tokens уже не содержит trivia/comments. */
            result = module.syntax.tokens.filter(token =>
                token.kind !== "square"
            );
            this.tokensByModule.set(module, result);
        }

        return result;
    }

    private resolveMember(
        uri: string,
        tree: CBase,
        offset: number,
        receiver: IRslToken,
        memberName: string
    ): IIndexedSymbol | undefined {
        const classSymbol = this.resolveReceiverClass(
            uri,
            tree,
            offset,
            receiver
        );

        if (!classSymbol) {
            return undefined;
        }

        const allowPrivate = this.canAccessPrivateMembers(
            uri,
            tree,
            offset,
            classSymbol
        );
        const candidates = getChildrenByName(classSymbol.object).get(
            normalizeIdentifier(memberName)
        );
        const member = candidates
            ? candidates.find(child => allowPrivate || !child.Private)
            : undefined;

        return member
            ? { uri: classSymbol.uri, object: member }
            : undefined;
    }

    private resolveReceiverClass(
        uri: string,
        tree: CBase,
        offset: number,
        receiver: IRslToken
    ): IIndexedSymbol | undefined {
        const receiverName = normalizeIdentifier(receiver.value);

        if (receiverName === "this") {
            const currentClass = getScopeChain(tree, offset)
                .reverse()
                .find(scope =>
                    scope.ObjKind === CompletionItemKind.Class
                );

            return currentClass
                ? { uri, object: currentClass }
                : undefined;
        }

        const receiverObject = this.resolveInScopeChain(
            tree,
            receiver.value,
            offset
        );

        if (!receiverObject) {
            return undefined;
        }

        let typeName = normalizeIdentifier(receiverObject.Type);

        if (!typeName || typeName === "variant") {
            const module = this.index.getModule(uri);
            typeName = module
                ? inferDeclaredType(this.getTokens(module), receiverObject)
                : "";
        }

        if (!typeName || typeName === "variant") {
            return undefined;
        }

        const localClass = (getChildrenByName(tree).get(typeName) || [])
            .find(child =>
                child.ObjKind === CompletionItemKind.Class
            );

        if (localClass) {
            return { uri, object: localClass };
        }

        const imported = this.index.findImportedSymbols(uri, typeName)
            .find(symbol =>
                symbol.object.ObjKind === CompletionItemKind.Class
            );

        if (imported) {
            return imported;
        }

        return this.index.findSymbols(typeName)
            .find(symbol =>
                symbol.object.ObjKind === CompletionItemKind.Class
            );
    }

    private canAccessPrivateMembers(
        uri: string,
        tree: CBase,
        offset: number,
        classSymbol: IIndexedSymbol
    ): boolean {
        if (classSymbol.uri !== uri) {
            return false;
        }

        const currentClass = getScopeChain(tree, offset)
            .reverse()
            .find(scope =>
                scope.ObjKind === CompletionItemKind.Class
            );

        return currentClass === classSymbol.object;
    }

    private getReceiverToken(
        tokens: IRslToken[],
        tokenIndex: number
    ): IRslToken | undefined {
        if (tokenIndex < 2) {
            return undefined;
        }

        const dot = tokens[tokenIndex - 1];
        const receiver = tokens[tokenIndex - 2];

        return dot.kind === "symbol" &&
            dot.raw === "." &&
            receiver.kind === "identifier"
                ? receiver
                : undefined;
    }

    private getDotIndexBeforeOffset(
        tokens: IRslToken[],
        offset: number
    ): number {
        let candidateIndex = upperBoundByStart(tokens, offset) - 1;

        if (candidateIndex < 0) {
            return -1;
        }

        const candidate = tokens[candidateIndex];

        if (candidate.kind === "symbol" && candidate.raw === ".") {
            return candidateIndex;
        }

        if (candidate.kind === "identifier" && candidateIndex > 0) {
            const previous = tokens[candidateIndex - 1];

            if (previous.kind === "symbol" && previous.raw === ".") {
                return candidateIndex - 1;
            }
        }

        return -1;
    }

    private getPreviousIdentifier(
        tokens: IRslToken[],
        tokenIndex: number
    ): IRslToken | undefined {
        if (tokenIndex <= 0) {
            return undefined;
        }

        const previous = tokens[tokenIndex - 1];
        return previous.kind === "identifier"
            ? previous
            : undefined;
    }
}

export function getScopeChain(
    root: CBase,
    offset: number
): CBase[] {
    const result: CBase[] = [root];
    let current = root;

    while (true) {
        const nested = findContainingObject(
            getObjectChildren(current),
            offset
        );

        if (!nested) {
            break;
        }

        result.push(nested);
        current = nested;
    }

    return result;
}

function getObjectChildren(scope: CBase): CBase[] {
    let result = objectChildrenCache.get(scope);

    if (!result) {
        result = scope.getChilds()
            .filter(child => child.isObject())
            .sort((left, right) =>
                left.Range.start - right.Range.start
            );
        objectChildrenCache.set(scope, result);
    }

    return result;
}


function findContainingObject(
    objects: CBase[],
    offset: number
): CBase | undefined {
    let left = 0;
    let right = objects.length - 1;
    let candidate = -1;

    while (left <= right) {
        const middle = (left + right) >>> 1;

        if (objects[middle].Range.start <= offset) {
            candidate = middle;
            left = middle + 1;
        } else {
            right = middle - 1;
        }
    }

    if (candidate < 0) {
        return undefined;
    }

    const object = objects[candidate];
    return offset <= object.Range.end ? object : undefined;
}

function getChildrenByName(scope: CBase): Map<string, CBase[]> {
    let result = childrenByNameCache.get(scope);

    if (!result) {
        result = new Map<string, CBase[]>();

        for (const child of scope.getChilds()) {
            const name = normalizeIdentifier(child.Name);
            let values = result.get(name);

            if (!values) {
                values = [];
                result.set(name, values);
            }

            values.push(child);
        }

        childrenByNameCache.set(scope, result);
    }

    return result;
}

function inferDeclaredType(
    tokens: IRslToken[],
    object: CBase
): string {
    const nameIndex = lowerBoundByStart(tokens, object.Range.start);

    if (
        nameIndex >= tokens.length ||
        tokens[nameIndex].start !== object.Range.start
    ) {
        return "";
    }

    let depth = 0;

    for (let index = nameIndex + 1; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind !== "symbol") {
            continue;
        }

        if (token.raw === "(") {
            depth++;
            continue;
        }

        if (token.raw === ")" && depth > 0) {
            depth--;
            continue;
        }

        if (depth === 0 && (token.raw === ";" || token.raw === ",")) {
            break;
        }

        if (depth === 0 && (token.raw === ":" || token.raw === "=")) {
            const typeToken = tokens[index + 1];
            return typeToken && typeToken.kind === "identifier"
                ? normalizeIdentifier(typeToken.value)
                : "";
        }
    }

    return "";
}

function isVisibleAt(object: CBase, offset: number): boolean {
    if (
        object.ObjKind === CompletionItemKind.Variable ||
        object.ObjKind === CompletionItemKind.Constant ||
        object.ObjKind === CompletionItemKind.Property ||
        object.ObjKind === CompletionItemKind.Field
    ) {
        return object.Range.start <= offset;
    }

    return true;
}

function selectBestVisibleCandidate(
    candidates: CBase[],
    offset: number
): CBase | undefined {
    let firstVisible: CBase | undefined;
    let nearestPreceding: CBase | undefined;

    for (const candidate of candidates) {
        if (!isVisibleAt(candidate, offset)) {
            continue;
        }

        if (!firstVisible) {
            firstVisible = candidate;
        }

        if (
            candidate.Range.start <= offset &&
            (
                !nearestPreceding ||
                candidate.Range.start > nearestPreceding.Range.start
            )
        ) {
            nearestPreceding = candidate;
        }
    }

    return nearestPreceding || firstVisible;
}

function findTokenIndex(
    tokens: IRslToken[],
    token: IRslToken
): number {
    const index = lowerBoundByStart(tokens, token.start);

    for (let current = index; current < tokens.length; current++) {
        const candidate = tokens[current];

        if (candidate.start !== token.start) {
            break;
        }

        if (candidate === token || candidate.end === token.end) {
            return current;
        }
    }

    return -1;
}

function lowerBoundByStart(tokens: IRslToken[], start: number): number {
    let left = 0;
    let right = tokens.length;

    while (left < right) {
        const middle = (left + right) >>> 1;

        if (tokens[middle].start < start) {
            left = middle + 1;
        } else {
            right = middle;
        }
    }

    return left;
}

function upperBoundByStart(tokens: IRslToken[], start: number): number {
    let left = 0;
    let right = tokens.length;

    while (left < right) {
        const middle = (left + right) >>> 1;

        if (tokens[middle].start <= start) {
            left = middle + 1;
        } else {
            right = middle;
        }
    }

    return left;
}

function deduplicateCompletionItems(
    items: CompletionItem[]
): CompletionItem[] {
    const result: CompletionItem[] = [];
    const seen = new Set<string>();

    for (const item of items) {
        const key = normalizeIdentifier(String(item.label));

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(item);
    }

    return result;
}

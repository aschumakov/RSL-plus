import {
    CompletionItem,
    CompletionItemKind
} from "vscode-languageserver";

import { CBase } from "./common";
import {
    IRslToken,
    significantTokens,
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

/**
 * Разрешает имена с учётом областей видимости RSL.
 *
 * Порядок поиска:
 * 1. локальные объявления текущего macro/method;
 * 2. члены текущего class;
 * 3. глобальные объявления текущего модуля;
 * 4. публичные объявления прямых и транзитивных Import.
 */
export class RslScopeResolver {
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

        const tokens = significantTokens(module.lex.tokens);
        const token = tokenAtOffset(tokens, offset, true);

        if (!token || token.kind !== "identifier") {
            return undefined;
        }

        const receiver = this.getReceiverToken(tokens, token);

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
            return {
                uri,
                object: local,
                token
            };
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

        const tokens = significantTokens(module.lex.tokens);
        const dot = this.getDotBeforeOffset(tokens, offset);

        if (dot) {
            const receiver = this.getPreviousIdentifier(tokens, dot);

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
                if (
                    child.Private &&
                    scope === tree
                ) {
                    continue;
                }

                if (!isVisibleAt(child, offset, scope === tree)) {
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
            const candidates = scope
                .getChilds()
                .filter(child =>
                    normalizeIdentifier(child.Name) === normalized &&
                    isVisibleAt(child, offset, scope === tree)
                );

            const selected = selectBestCandidate(candidates, offset);

            if (selected) {
                return selected;
            }
        }

        return undefined;
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

        const normalized = normalizeIdentifier(memberName);
        const allowPrivate = this.canAccessPrivateMembers(
            uri,
            tree,
            offset,
            classSymbol
        );
        const member = classSymbol.object
            .getChilds()
            .find(child =>
                normalizeIdentifier(child.Name) === normalized &&
                (allowPrivate || !child.Private)
            );

        return member
            ? {
                uri: classSymbol.uri,
                object: member
            }
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
                ? {
                    uri,
                    object: currentClass
                }
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
                ? inferDeclaredType(
                    significantTokens(module.lex.tokens),
                    receiverObject
                )
                : "";
        }

        if (!typeName || typeName === "variant") {
            return undefined;
        }

        const localClass = tree.getChilds().find(child =>
            child.ObjKind === CompletionItemKind.Class &&
            normalizeIdentifier(child.Name) === typeName
        );

        if (localClass) {
            return {
                uri,
                object: localClass
            };
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
        token: IRslToken
    ): IRslToken | undefined {
        const tokenIndex = tokens.indexOf(token);

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

    private getDotBeforeOffset(
        tokens: IRslToken[],
        offset: number
    ): IRslToken | undefined {
        let candidateIndex = -1;

        for (let index = 0; index < tokens.length; index++) {
            if (tokens[index].start > offset) {
                break;
            }

            candidateIndex = index;
        }

        if (candidateIndex < 0) {
            return undefined;
        }

        const candidate = tokens[candidateIndex];

        if (candidate.kind === "symbol" && candidate.raw === ".") {
            return candidate;
        }

        if (
            candidate.kind === "identifier" &&
            candidateIndex > 0
        ) {
            const previous = tokens[candidateIndex - 1];

            if (previous.kind === "symbol" && previous.raw === ".") {
                return previous;
            }
        }

        return undefined;
    }

    private getPreviousIdentifier(
        tokens: IRslToken[],
        token: IRslToken
    ): IRslToken | undefined {
        const index = tokens.indexOf(token);

        if (index <= 0) {
            return undefined;
        }

        const previous = tokens[index - 1];
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
        const nested = current.getChilds().find(child =>
            child.isObject() &&
            child.Range.start <= offset &&
            offset <= child.Range.end
        );

        if (!nested) {
            break;
        }

        result.push(nested);
        current = nested;
    }

    return result;
}


function inferDeclaredType(
    tokens: IRslToken[],
    object: CBase
): string {
    const nameIndex = tokens.findIndex(token =>
        token.kind === "identifier" &&
        token.start === object.Range.start
    );

    if (nameIndex < 0) {
        return "";
    }

    let depth = 0;

    for (let index = nameIndex + 1; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind === "symbol") {
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
    }

    return "";
}

function isVisibleAt(
    object: CBase,
    offset: number,
    _isModuleScope: boolean
): boolean {
    if (
        object.ObjKind === CompletionItemKind.Variable ||
        object.ObjKind === CompletionItemKind.Constant ||
        object.ObjKind === CompletionItemKind.Property ||
        object.ObjKind === CompletionItemKind.Field
    ) {
        return object.Range.start <= offset;
    }

    /* Macro/Class/Method разрешаются независимо от порядка объявления. */
    return true;
}

function selectBestCandidate(
    candidates: CBase[],
    offset: number
): CBase | undefined {
    if (candidates.length === 0) {
        return undefined;
    }

    const preceding = candidates
        .filter(candidate => candidate.Range.start <= offset)
        .sort((left, right) =>
            right.Range.start - left.Range.start
        );

    return preceding[0] || candidates[0];
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

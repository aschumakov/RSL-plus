import { performance } from "perf_hooks";

import {
    CompletionItemKind,
    Location,
    Position,
    Range
} from "vscode-languageserver";

import { RslSymbol } from "../symbols/rslSymbol";
import {
    normalizeIdentifier,
    normalizeReferenceIdentifier
} from "../lexer";
import { RslScopeResolver } from "../scopeResolver";
import { ReferenceIndex } from "./referenceIndex";
import { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

const REFERENCE_CPU_SLICE_MS = 8;

/** Совместимый быстрый поиск только по уже открытым полным моделям. */
export function findRslReferences(
    index: WorkspaceIndex,
    resolver: RslScopeResolver,
    uri: string,
    offset: number,
    includeDeclaration: boolean,
    isCancelled: () => boolean = () => false
): Location[] {
    const sourceModule = index.getModule(uri);

    if (!sourceModule || isCancelled()) {
        return [];
    }

    const target = resolver.resolveAt(uri, sourceModule.symbolTree, offset);

    if (!target || isCancelled()) {
        return [];
    }

    const targetName = normalizeIdentifier(target.symbol.name);
    const targetKey = symbolKey(target.uri, target.symbol);
    const result: Location[] = [];
    const seen = new Set<string>();

    for (const module of index.getOpenModules()) {
        collectModuleReferences(
            module,
            resolver,
            targetKey,
            targetName,
            includeDeclaration,
            result,
            seen,
            isCancelled
        );
    }

    return result.sort(compareLocations);
}

/**
 * Workspace References с точным file-index и ограничением по Import-графу.
 * Локальные переменные и параметры никогда не запускают workspace scan.
 */
export async function findRslReferencesInWorkspace(
    index: WorkspaceIndex,
    resolver: RslScopeResolver,
    referenceIndex: ReferenceIndex,
    uri: string,
    offset: number,
    includeDeclaration: boolean,
    isCancelled: () => boolean = () => false
): Promise<Location[]> {
    const sourceModule = index.getModule(uri);

    if (!sourceModule || isCancelled()) {
        return [];
    }

    const target = resolver.resolveAt(uri, sourceModule.symbolTree, offset);

    if (!target || isCancelled()) {
        return [];
    }

    return findRslReferencesForSymbol(
        index,
        resolver,
        referenceIndex,
        target.uri,
        target.symbol,
        includeDeclaration,
        isCancelled
    );
}

/**
 * Вариант workspace References для уже разрешённого символа.
 * Нужен Call Hierarchy, где дочерний элемент может быть compact external
 * summary без полного token stream объявления.
 */
export async function findRslReferencesForSymbol(
    index: WorkspaceIndex,
    resolver: RslScopeResolver,
    referenceIndex: ReferenceIndex,
    targetUri: string,
    targetObject: RslSymbol,
    includeDeclaration: boolean,
    isCancelled: () => boolean = () => false
): Promise<Location[]> {
    const sourceModule = index.getModule(targetUri);

    if (!sourceModule || isCancelled()) {
        return [];
    }

    const targetName = normalizeIdentifier(targetObject.name);
    const targetKey = symbolKey(targetUri, targetObject);
    const result: Location[] = [];
    const seen = new Set<string>();

    if (isLocalReferenceTarget(sourceModule.symbolTree, targetObject)) {
        collectModuleReferences(
            sourceModule,
            resolver,
            targetKey,
            targetName,
            includeDeclaration,
            result,
            seen,
            isCancelled
        );
        return result.sort(compareLocations);
    }

    const openUris = new Set<string>();
    for (const module of index.getOpenModules()) {
        openUris.add(module.uri);
        collectModuleReferences(
            module,
            resolver,
            targetKey,
            targetName,
            includeDeclaration,
            result,
            seen,
            isCancelled
        );
    }

    if (isCancelled()) {
        return [];
    }

    const candidateUniverse = await referenceIndex.getCandidateUris(
        targetUri,
        index.getWorkspaceFileUris(),
        index.getIndexedModules().map(module => ({
            uri: module.uri,
            imports: module.imports
        })),
        isCancelled
    );
    const externalUris = candidateUniverse.filter(candidateUri =>
        !openUris.has(candidateUri)
    );
    const candidates = await referenceIndex.findCandidates(
        targetName,
        externalUris,
        isCancelled
    );

    let sliceStarted = performance.now();

    for (const candidate of candidates) {
        if (isCancelled()) {
            return [];
        }

        index.withTransientOpenModule(candidate.uri, candidate.source, module => {
            collectModuleReferences(
                module,
                resolver,
                targetKey,
                targetName,
                includeDeclaration,
                result,
                seen,
                isCancelled
            );
        });

        if (performance.now() - sliceStarted >= REFERENCE_CPU_SLICE_MS) {
            await yieldToInteractiveRequests();
            sliceStarted = performance.now();
        }
    }

    return result.sort(compareLocations);
}

function collectModuleReferences(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    targetKey: string,
    targetName: string,
    includeDeclaration: boolean,
    result: Location[],
    seen: Set<string>,
    isCancelled: () => boolean
): void {
    const declarationToken = findDeclarationTokenByKey(
        module,
        targetName,
        targetKey
    );

    for (const token of module.syntax.tokens) {
        if (isCancelled()) {
            return;
        }

        if (
            token.kind !== "identifier" ||
            normalizeReferenceIdentifier(token.value) !== targetName
        ) {
            continue;
        }

        const resolved = resolver.resolveAt(
            module.uri,
            module.symbolTree,
            token.start
        );

        if (!resolved || symbolKey(resolved.uri, resolved.symbol) !== targetKey) {
            continue;
        }

        const declaration = !!declarationToken &&
            declarationToken.start === token.start &&
            declarationToken.end === token.end;

        if (declaration && !includeDeclaration) {
            continue;
        }

        const range: Range = {
            start: { line: token.line, character: token.character },
            end: { line: token.endLine, character: token.endCharacter }
        };
        const key = [
            module.uri,
            range.start.line,
            range.start.character,
            range.end.line,
            range.end.character
        ].join(":");

        if (!seen.has(key)) {
            seen.add(key);
            result.push({ uri: module.uri, range });
        }
    }
}

function findDeclarationTokenByKey(
    module: IIndexedModule,
    normalizedName: string,
    targetKey: string
): { start: number; end: number } | undefined {
    const objects = findObjectsByName(module.symbolTree, normalizedName)
        .filter(symbol => symbolKey(module.uri, symbol) === targetKey);

    if (objects.length === 0) {
        return undefined;
    }

    for (const token of module.syntax.tokens) {
        if (
            token.kind !== "identifier" ||
            normalizeReferenceIdentifier(token.value) !== normalizedName
        ) {
            continue;
        }

        if (objects.some(symbol =>
            symbol.range.start <= token.start && token.end <= symbol.range.end
        )) {
            return token;
        }
    }

    return undefined;
}

function findObjectsByName(root: RslSymbol, name: string): RslSymbol[] {
    const result: RslSymbol[] = [];
    const queue: RslSymbol[] = [root];
    let position = 0;

    while (position < queue.length) {
        const current = queue[position++];

        for (const child of getReferenceTreeChildren(current)) {
            if (normalizeIdentifier(child.name) === name) {
                result.push(child);
            }

            if (child.isContainer) {
                queue.push(child);
            }
        }
    }

    return result;
}

/** Символ внутри Macro/Method не может иметь использования в другом файле. */
export function isLocalReferenceTarget(root: RslSymbol, target: RslSymbol): boolean {
    if (target.isPrivate) {
        return true;
    }

    const path = findObjectPath(root, target);

    if (!path) {
        return false;
    }

    return path.slice(0, -1).some(symbol =>
        symbol.kind === CompletionItemKind.Function ||
        symbol.kind === CompletionItemKind.Method
    );
}

function findObjectPath(
    current: RslSymbol,
    target: RslSymbol,
    path: RslSymbol[] = []
): RslSymbol[] | undefined {
    const currentPath = [...path, current];

    if (current === target) {
        return currentPath;
    }

    for (const child of getReferenceTreeChildren(current)) {
        if (child === target) {
            return [...currentPath, child];
        }

        if (!child.isContainer) {
            continue;
        }

        const found = findObjectPath(child, target, currentPath);
        if (found) {
            return found;
        }
    }

    return undefined;
}

function getReferenceTreeChildren(current: RslSymbol): RslSymbol[] {
    return [...current.children];
}

function symbolKey(uri: string, symbol: RslSymbol): string {
    return [
        uri,
        normalizeIdentifier(symbol.name),
        symbol.kind,
        symbol.range.start,
        symbol.range.end
    ].join(":");
}

function compareLocations(left: Location, right: Location): number {
    const uriComparison = left.uri.localeCompare(right.uri);
    return uriComparison !== 0
        ? uriComparison
        : comparePositions(left.range.start, right.range.start);
}

function comparePositions(left: Position, right: Position): number {
    return left.line !== right.line
        ? left.line - right.line
        : left.character - right.character;
}

function yieldToInteractiveRequests(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

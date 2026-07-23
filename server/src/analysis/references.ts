import { performance } from "perf_hooks";

import {
    CompletionItemKind,
    Location,
    Position,
    Range
} from "vscode-languageserver";

import { CBase } from "../common";
import { normalizeIdentifier } from "../lexer";
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

    const target = resolver.resolveAt(uri, sourceModule.object, offset);

    if (!target || isCancelled()) {
        return [];
    }

    const targetName = normalizeIdentifier(target.object.Name);
    const targetKey = symbolKey(target.uri, target.object);
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

    const target = resolver.resolveAt(uri, sourceModule.object, offset);

    if (!target || isCancelled()) {
        return [];
    }

    const targetName = normalizeIdentifier(target.object.Name);
    const targetKey = symbolKey(target.uri, target.object);
    const result: Location[] = [];
    const seen = new Set<string>();

    if (isLocalReferenceTarget(sourceModule.object, target.object)) {
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
        target.uri,
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
            normalizeIdentifier(token.value) !== targetName
        ) {
            continue;
        }

        const resolved = resolver.resolveAt(
            module.uri,
            module.object,
            token.start
        );

        if (!resolved || symbolKey(resolved.uri, resolved.object) !== targetKey) {
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
    const objects = findObjectsByName(module.object, normalizedName)
        .filter(object => symbolKey(module.uri, object) === targetKey);

    if (objects.length === 0) {
        return undefined;
    }

    for (const token of module.syntax.tokens) {
        if (
            token.kind !== "identifier" ||
            normalizeIdentifier(token.value) !== normalizedName
        ) {
            continue;
        }

        if (objects.some(object =>
            object.Range.start <= token.start && token.end <= object.Range.end
        )) {
            return token;
        }
    }

    return undefined;
}

function findObjectsByName(root: CBase, name: string): CBase[] {
    const result: CBase[] = [];
    const queue: CBase[] = [root];
    let position = 0;

    while (position < queue.length) {
        const current = queue[position++];

        for (const child of getReferenceTreeChildren(current)) {
            if (normalizeIdentifier(child.Name) === name) {
                result.push(child);
            }

            if (child.isObject()) {
                queue.push(child);
            }
        }
    }

    return result;
}

/** Символ внутри Macro/Method не может иметь использования в другом файле. */
export function isLocalReferenceTarget(root: CBase, target: CBase): boolean {
    if (target.Private) {
        return true;
    }

    const path = findObjectPath(root, target);

    if (!path) {
        return false;
    }

    return path.slice(0, -1).some(object =>
        object.ObjKind === CompletionItemKind.Function ||
        object.ObjKind === CompletionItemKind.Method
    );
}

function findObjectPath(
    current: CBase,
    target: CBase,
    path: CBase[] = []
): CBase[] | undefined {
    const currentPath = [...path, current];

    if (current === target) {
        return currentPath;
    }

    for (const child of getReferenceTreeChildren(current)) {
        if (child === target) {
            return [...currentPath, child];
        }

        if (!child.isObject()) {
            continue;
        }

        const found = findObjectPath(child, target, currentPath);
        if (found) {
            return found;
        }
    }

    return undefined;
}

function getReferenceTreeChildren(current: CBase): CBase[] {
    const candidate = current as unknown as {
        getChilds?: () => unknown;
    };

    if (typeof candidate.getChilds !== "function") {
        return [];
    }

    const children = candidate.getChilds.call(current);
    return Array.isArray(children) ? children as CBase[] : [];
}

function symbolKey(uri: string, object: CBase): string {
    return [
        uri,
        normalizeIdentifier(object.Name),
        object.ObjKind,
        object.Range.start,
        object.Range.end
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


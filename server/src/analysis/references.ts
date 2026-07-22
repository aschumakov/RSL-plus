import * as fs from "fs";
import { fileURLToPath } from "url";

import { Location, Position, Range } from "vscode-languageserver";

import { CBase } from "../common";
import { isIdentifierPart, normalizeIdentifier } from "../lexer";
import { RslScopeResolver } from "../scopeResolver";
import { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";


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
 * References больше не требует постоянного AST/lexer всего workspace.
 * Неизвестные файлы сначала проходят дешёвый текстовый prefilter, затем
 * разбираются по одному и сразу освобождаются после проверки.
 */
export async function findRslReferencesInWorkspace(
    index: WorkspaceIndex,
    resolver: RslScopeResolver,
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
    const workspaceUris = index.getWorkspaceFileUris();
    let processedSinceYield = 0;

    /* Открытые документы могли ещё не попасть в исходный workspaceFiles list. */
    for (const module of index.getOpenModules()) {
        if (!workspaceUris.includes(module.uri)) {
            workspaceUris.push(module.uri);
        }
    }

    for (const candidateUri of workspaceUris) {
        if (isCancelled()) {
            return [];
        }

        const loaded = index.getModule(candidateUri);

        if (loaded?.kind === "open") {
            collectModuleReferences(
                loaded,
                resolver,
                targetKey,
                targetName,
                includeDeclaration,
                result,
                seen,
                isCancelled
            );
        } else {
            const source = await readWorkspaceFile(candidateUri);

            if (
                source !== undefined &&
                containsIdentifier(source, targetName) &&
                !isCancelled()
            ) {
                index.withTransientOpenModule(candidateUri, source, module => {
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
            }
        }

        processedSinceYield++;

        if (processedSinceYield >= 8) {
            processedSinceYield = 0;
            await yieldToInteractiveRequests();
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
    for (const token of module.syntax.tokens) {
        if (
            token.kind !== "identifier" ||
            normalizeIdentifier(token.value) !== normalizedName
        ) {
            continue;
        }

        for (const object of findObjectsByName(module.object, normalizedName)) {
            if (
                object.Range.start <= token.start &&
                token.end <= object.Range.end &&
                symbolKey(module.uri, object) === targetKey
            ) {
                return token;
            }
        }
    }

    return undefined;
}

function findObjectsByName(root: CBase, name: string): CBase[] {
    const result: CBase[] = [];
    const queue: CBase[] = [root];

    while (queue.length > 0) {
        const current = queue.shift()!;

        for (const child of current.getChilds()) {
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

function symbolKey(uri: string, object: CBase): string {
    return [
        uri,
        normalizeIdentifier(object.Name),
        object.ObjKind,
        object.Range.start,
        object.Range.end
    ].join(":");
}

async function readWorkspaceFile(uri: string): Promise<string | undefined> {
    try {
        return await fs.promises.readFile(fileURLToPath(uri), "utf8");
    } catch (_error) {
        return undefined;
    }
}

function containsIdentifier(source: string, normalizedName: string): boolean {
    const text = source.toLowerCase();
    let position = text.indexOf(normalizedName);

    while (position >= 0) {
        const before = position > 0 ? text.charAt(position - 1) : "";
        const afterPosition = position + normalizedName.length;
        const after = afterPosition < text.length
            ? text.charAt(afterPosition)
            : "";

        if (!isIdentifierPart(before) && !isIdentifierPart(after)) {
            return true;
        }

        position = text.indexOf(normalizedName, position + 1);
    }

    return false;
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

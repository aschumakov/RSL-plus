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
import type {
    IRslShardReference,
    RslReferenceShardStore
} from "./referenceShards";
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
    isCancelled: () => boolean = () => false,
    /* Постоянные записи о ссылках, если сервер их ведёт. */
    shards?: RslReferenceShardStore
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
        isCancelled,
        shards
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
    isCancelled: () => boolean = () => false,
    /* Постоянные записи о ссылках, если сервер их ведёт. */
    shards?: RslReferenceShardStore
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
    /*
     * Файлы, о которых уже есть запись, не читаются вовсе.
     *
     * На проверенном проекте популярное имя даёт 2533 файла-кандидата на
     * 66 МБ, и один только их разбор стоит 4,2 секунды — при каждом запросе.
     * Запись появилась при первом таком запросе и живёт, пока файл не менялся.
     */
    const unknownUris: string[] = [];

    for (const candidateUri of externalUris) {
        if (isCancelled()) {
            return [];
        }

        const recorded = shards
            ? await shards.lookup(candidateUri, targetName)
            : undefined;

        if (!recorded) {
            unknownUris.push(candidateUri);
            continue;
        }

        for (const reference of recorded) {
            if (reference.targetKey !== targetKey) {
                continue;
            }

            if (reference.isDeclaration && !includeDeclaration) {
                continue;
            }

            addLocation(result, seen, candidateUri, {
                start: {
                    line: reference.startLine,
                    character: reference.startCharacter
                },
                end: {
                    line: reference.endLine,
                    character: reference.endCharacter
                }
            });
        }
    }

    const candidates = await referenceIndex.findCandidates(
        targetName,
        unknownUris,
        isCancelled
    );

    let sliceStarted = performance.now();

    for (const candidate of candidates) {
        if (isCancelled()) {
            return [];
        }

        const collected: IRslShardReference[] = [];

        index.withTransientOpenModule(candidate.uri, candidate.source, module => {
            collectModuleReferences(
                module,
                resolver,
                targetKey,
                targetName,
                includeDeclaration,
                result,
                seen,
                isCancelled,
                collected
            );
        });

        if (shards && !isCancelled()) {
            /*
             * Записывается и пустой ответ: «имя в файле есть, но никуда не
             * ведёт» — тоже знание, без которого файл перечитывался бы каждый
             * раз.
             */
            await shards.record(candidate.uri, targetName, collected);
        }

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
    isCancelled: () => boolean,
    /*
     * Куда записать ВСЕ разрешённые вхождения имени, а не только совпавшие с
     * целью. Разбирая файл ради одного символа, мы уже разрешили каждое
     * вхождение, и следующий вопрос про другой символ с тем же именем
     * ответится по записи, без чтения файла.
     */
    collected?: IRslShardReference[]
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

        const declaration = !!declarationToken &&
            declarationToken.start === token.start &&
            declarationToken.end === token.end;
        const range: Range = {
            start: { line: token.line, character: token.character },
            end: { line: token.endLine, character: token.endCharacter }
        };

        if (resolved && collected) {
            collected.push({
                targetKey: symbolKey(resolved.uri, resolved.symbol),
                startLine: range.start.line,
                startCharacter: range.start.character,
                endLine: range.end.line,
                endCharacter: range.end.character,
                isDeclaration: declaration
            });
        }

        if (!resolved || symbolKey(resolved.uri, resolved.symbol) !== targetKey) {
            continue;
        }

        if (declaration && !includeDeclaration) {
            continue;
        }
        addLocation(result, seen, module.uri, range);
    }
}

/** Кладёт находку, если такой ещё не было. */
function addLocation(
    result: Location[],
    seen: Set<string>,
    uri: string,
    range: Range
): void {
    const key = [
        uri,
        range.start.line,
        range.start.character,
        range.end.line,
        range.end.character
    ].join(":");

    if (seen.has(key)) {
        return;
    }

    seen.add(key);
    result.push({ uri, range });
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

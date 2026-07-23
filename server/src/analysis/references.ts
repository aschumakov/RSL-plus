import * as fs from "fs";
import { fileURLToPath } from "url";

import {
    CompletionItemKind,
    Location,
    Position,
    Range
} from "vscode-languageserver";

import { CBase } from "../common";
import { isIdentifierPart, normalizeIdentifier } from "../lexer";
import { RslScopeResolver } from "../scopeResolver";
import { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

const REFERENCE_READ_BATCH_SIZE = 16;
const REFERENCE_QUERY_CACHE_ENTRIES = 16;
const IDENTIFIER_BLOOM_WORDS = 64;
const IDENTIFIER_BLOOM_BITS = IDENTIFIER_BLOOM_WORDS * 32;

interface IReferenceCandidateSource {
    uri: string;
    source: string;
}

const identifierBloomByUri = new Map<string, Uint32Array>();
const candidateUrisByName = new Map<string, string[]>();
let referenceWorkspaceUris = new Set<string>();

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
 * Быстрый workspace References:
 * - локальные переменные и параметры никогда не обходят workspace;
 * - внешние файлы читаются небольшими параллельными пакетами;
 * - после первого обхода для каждого файла остаётся компактный Bloom-индекс;
 * - повторный поиск того же имени использует LRU-кэш URI-кандидатов.
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

    const workspaceUris = index.getWorkspaceFileUris();
    const workspaceSet = new Set(workspaceUris);

    /* Открытые документы могли ещё не попасть в исходный workspaceFiles list. */
    for (const module of index.getOpenModules()) {
        if (!workspaceSet.has(module.uri)) {
            workspaceSet.add(module.uri);
            workspaceUris.push(module.uri);
        }

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

    const cachedCandidateUris = getCachedCandidateUris(targetName);
    const externalUris = (cachedCandidateUris || workspaceUris).filter(
        candidateUri => index.getModule(candidateUri)?.kind !== "open"
    );
    const discoveredCandidates: string[] = [];

    for (
        let batchStart = 0;
        batchStart < externalUris.length;
        batchStart += REFERENCE_READ_BATCH_SIZE
    ) {
        if (isCancelled()) {
            return [];
        }

        const batchUris = externalUris.slice(
            batchStart,
            batchStart + REFERENCE_READ_BATCH_SIZE
        );
        const candidates = await Promise.all(
            batchUris.map(candidateUri => readCandidateSource(
                candidateUri,
                targetName
            ))
        );

        for (const candidate of candidates) {
            if (!candidate || isCancelled()) {
                continue;
            }

            discoveredCandidates.push(candidate.uri);
            index.withTransientOpenModule(
                candidate.uri,
                candidate.source,
                module => {
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
            );
        }

        await yieldToInteractiveRequests();
    }

    if (!cachedCandidateUris && !isCancelled()) {
        cacheCandidateUris(targetName, discoveredCandidates);
    }

    return result.sort(compareLocations);
}

/** Инвалидируется file watcher-ом при изменении, создании или удалении файла. */
export function invalidateReferenceFileIndex(uri: string): void {
    identifierBloomByUri.delete(uri);
    candidateUrisByName.clear();
}

/** Удаляет summary файлов, которых больше нет в каталоге workspace. */
export function retainReferenceFileIndex(uris: readonly string[]): void {
    const retained = new Set(uris);
    const catalogChanged = retained.size !== referenceWorkspaceUris.size ||
        Array.from(retained).some(uri => !referenceWorkspaceUris.has(uri));

    for (const uri of identifierBloomByUri.keys()) {
        if (!retained.has(uri)) {
            identifierBloomByUri.delete(uri);
        }
    }

    referenceWorkspaceUris = retained;

    if (catalogChanged) {
        candidateUrisByName.clear();
    }
}

export function getReferenceFileIndexStats(): {
    indexedFiles: number;
    cachedQueries: number;
} {
    return {
        indexedFiles: identifierBloomByUri.size,
        cachedQueries: candidateUrisByName.size
    };
}

/**
 * Переиспользует уже прочитанный WorkspaceModuleLoader-ом текст.
 * Дополнительного I/O нет: сохраняется только Bloom-индекс идентификаторов.
 */
export function indexReferenceFileSource(uri: string, source: string): void {
    if (!uri || identifierBloomByUri.has(uri)) {
        return;
    }

    identifierBloomByUri.set(uri, buildIdentifierBloom(source));
    candidateUrisByName.clear();
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
function isLocalReferenceTarget(root: CBase, target: CBase): boolean {
    /* PRIVATE/LOCAL объявления недоступны из других модулей. */
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

        /*
         * CVar и другие листовые элементы наследуют CAbstractBase, но не
         * имеют getChilds(). В старой версии рекурсия заходила в такой узел
         * и падала с TypeError до того, как доходила до искомого объекта.
         */
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

/** Безопасно возвращает дочерние узлы только для контейнеров symbol tree. */
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

async function readCandidateSource(
    uri: string,
    normalizedName: string
): Promise<IReferenceCandidateSource | undefined> {
    const bloom = identifierBloomByUri.get(uri);

    if (bloom && !bloomMightContain(bloom, normalizedName)) {
        return undefined;
    }

    const source = await readWorkspaceFile(uri);

    if (source === undefined) {
        return undefined;
    }

    if (!bloom) {
        /* Первый запрос строит Bloom и проверяет имя одним проходом. */
        const analysis = analyzeIdentifierSource(source, normalizedName);
        identifierBloomByUri.set(uri, analysis.bloom);
        return analysis.containsTarget ? { uri, source } : undefined;
    }

    return containsIdentifier(source, normalizedName)
        ? { uri, source }
        : undefined;
}

async function readWorkspaceFile(uri: string): Promise<string | undefined> {
    try {
        return await fs.promises.readFile(fileURLToPath(uri), "utf8");
    } catch (_error) {
        return undefined;
    }
}

function buildIdentifierBloom(source: string): Uint32Array {
    return analyzeIdentifierSource(source).bloom;
}

function analyzeIdentifierSource(
    source: string,
    normalizedTarget?: string
): { bloom: Uint32Array; containsTarget: boolean } {
    const bloom = new Uint32Array(IDENTIFIER_BLOOM_WORDS);
    let containsTarget = false;
    let position = 0;

    while (position < source.length) {
        if (!isIdentifierPart(source.charAt(position))) {
            position++;
            continue;
        }

        const start = position++;

        while (
            position < source.length &&
            isIdentifierPart(source.charAt(position))
        ) {
            position++;
        }

        const identifier = normalizeIdentifier(source.substring(start, position));

        if (!identifier) {
            continue;
        }

        addIdentifierToBloom(bloom, identifier);

        if (normalizedTarget && identifier === normalizedTarget) {
            containsTarget = true;
        }
    }

    return { bloom, containsTarget };
}

function addIdentifierToBloom(
    bloom: Uint32Array,
    normalizedIdentifier: string
): void {
    const first = hashIdentifier(normalizedIdentifier, 2166136261);
    const second = hashIdentifier(normalizedIdentifier, 2246822519) | 1;

    for (let index = 0; index < 3; index++) {
        const bit = (first + Math.imul(index, second)) >>> 0;
        const normalizedBit = bit % IDENTIFIER_BLOOM_BITS;
        bloom[normalizedBit >>> 5] |= 1 << (normalizedBit & 31);
    }
}

function bloomMightContain(
    bloom: Uint32Array,
    normalizedIdentifier: string
): boolean {
    if (!normalizedIdentifier) {
        return false;
    }

    const first = hashIdentifier(normalizedIdentifier, 2166136261);
    const second = hashIdentifier(normalizedIdentifier, 2246822519) | 1;

    for (let index = 0; index < 3; index++) {
        const bit = (first + Math.imul(index, second)) >>> 0;
        const normalizedBit = bit % IDENTIFIER_BLOOM_BITS;

        if ((bloom[normalizedBit >>> 5] & (1 << (normalizedBit & 31))) === 0) {
            return false;
        }
    }

    return true;
}

function hashIdentifier(value: string, seed: number): number {
    let result = seed >>> 0;

    for (let index = 0; index < value.length; index++) {
        result ^= value.charCodeAt(index);
        result = Math.imul(result, 16777619) >>> 0;
    }

    return result;
}

function getCachedCandidateUris(name: string): string[] | undefined {
    const cached = candidateUrisByName.get(name);

    if (!cached) {
        return undefined;
    }

    candidateUrisByName.delete(name);
    candidateUrisByName.set(name, cached);
    return cached.slice();
}

function cacheCandidateUris(name: string, uris: string[]): void {
    candidateUrisByName.delete(name);
    candidateUrisByName.set(name, uris.slice());

    while (candidateUrisByName.size > REFERENCE_QUERY_CACHE_ENTRIES) {
        const oldest = candidateUrisByName.keys().next().value as
            string | undefined;

        if (oldest === undefined) {
            break;
        }

        candidateUrisByName.delete(oldest);
    }
}

function containsIdentifier(source: string, normalizedName: string): boolean {
    if (!normalizedName || source.length < normalizedName.length) {
        return false;
    }

    let position = 0;

    while (position < source.length) {
        if (!isIdentifierPart(source.charAt(position))) {
            position++;
            continue;
        }

        const start = position++;

        while (
            position < source.length &&
            isIdentifierPart(source.charAt(position))
        ) {
            position++;
        }

        if (
            position - start === normalizedName.length &&
            identifierEqualsIgnoreCase(source, start, position, normalizedName)
        ) {
            return true;
        }
    }

    return false;
}

function identifierEqualsIgnoreCase(
    source: string,
    start: number,
    end: number,
    normalizedName: string
): boolean {
    if (end - start !== normalizedName.length) {
        return false;
    }

    for (let index = 0; index < normalizedName.length; index++) {
        if (
            source.charAt(start + index).toLowerCase() !==
            normalizedName.charAt(index)
        ) {
            return false;
        }
    }

    return true;
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

/** Минимальный test hook без раскрытия внутренних mutable-кэшей. */
export const referenceTesting = {
    buildIdentifierBloom,
    bloomMightContain,
    containsIdentifier,
    isLocalReferenceTarget
};

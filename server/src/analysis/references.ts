import { RslRequestSourceCache } from "./requestSourceCache";
import {
    RslProjectIndexView
} from "../indexing/projectIndexView";
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
import { rangeInModule } from "../core/documentPosition";
import { collectRslCallSites } from "./callSiteFacts";
import {
    resolveRslStringCallSite
} from "./callSiteResolution";
import { RslScopeResolver } from "../scopeResolver";
import { ReferenceIndex } from "./referenceIndex";
import type {
    IRslShardReference,
    RslReferenceShardStore
} from "./referenceShards";
import { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

/*
 * Сколько кандидатов проходит обе фазы за раз и сколько им отведено памяти.
 *
 * Пакет обязан помещаться в свой кэш прочитанного целиком: иначе часть файлов
 * вытесняется до того, как до них дойдёт вторая фаза, и читается второй раз.
 * Отсюда и числа: самый крупный файл проверенного проекта — 770 КБ, тридцать
 * два таких дают 24 МБ, и предел взят с запасом. Обычный файл там 17 КБ, то
 * есть настоящий пакет весит около полумегабайта.
 *
 * Кэш живёт ровно пакет и освобождается вместе с ним.
 */
const REFERENCE_CANDIDATE_BATCH = 32;
const REFERENCE_BATCH_CACHE_BYTES = 32 * 1024 * 1024;

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
            index,
            resolver,
            targetKey,
            targetName,
            target.uri,
            target.symbol.selectionRange,
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
            index,
            resolver,
            targetKey,
            targetName,
            targetUri,
            targetObject.selectionRange,
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
            index,
            resolver,
            targetKey,
            targetName,
            targetUri,
            targetObject.selectionRange,
            includeDeclaration,
            result,
            seen,
            isCancelled
        );
    }

    if (isCancelled()) {
        return [];
    }

    /*
     * Кандидаты спрашиваются у общего входа к сведениям проекта.
     *
     * Сужение — забота индекса идентификаторов; если он не готов или
     * неполон, ответом остаётся весь состав проекта. Здесь важно, что
     * состав и загруженные модули берутся в одном месте, а не
     * складываются заново каждым потребителем.
     */
    const candidateUniverse = await new RslProjectIndexView(index, {
        referenceCandidates: (declarationUri, uris, modules, cancel) =>
            referenceIndex.getCandidateUris(
                declarationUri,
                uris,
                modules.map(module => ({
                    uri: module.uri,
                    imports: module.imports
                })),
                cancel
            )
    }).referencesOf(targetUri, isCancelled);
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
    /*
     * Кандидаты обрабатываются пакетами.
     *
     * Обе фазы — проверка записей о ссылках и добор через индекс —
     * читают одни и те же файлы, и общий кэш прочитанного избавляет от
     * второго чтения. Но кэш ограничен по объёму, а популярное имя даёт
     * на проверенном проекте 2533 файла на 66 МБ: к моменту, когда до
     * файла дойдёт индекс, кэш его уже не держит.
     *
     * Поэтому пакет проходит обе фазы целиком и только потом уступает
     * место следующему. Кэш живёт ровно пакет — расширять общий предел
     * ради этого не нужно.
     */
    for (
        let from = 0;
        from < externalUris.length;
        from += REFERENCE_CANDIDATE_BATCH
    ) {
        const batch = externalUris.slice(
            from,
            from + REFERENCE_CANDIDATE_BATCH
        );
        const sources = new RslRequestSourceCache(
            REFERENCE_BATCH_CACHE_BYTES
        );
        const unknownUris: string[] = [];

        for (const candidateUri of batch) {
            if (isCancelled()) {
                return [];
            }

            const recorded = shards
                ? await shards.lookup(candidateUri, targetName, sources)
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
            isCancelled,
            sources
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
                    index,
                    resolver,
                    targetKey,
                    targetName,
                    targetUri,
                    targetObject.selectionRange,
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
                await shards.record(
                    candidate.uri,
                    targetName,
                    collected,
                    candidate.source
                );
            }

            if (performance.now() - sliceStarted >= REFERENCE_CPU_SLICE_MS) {
                await yieldToInteractiveRequests();
                sliceStarted = performance.now();
            }
        }

    }

    return result.sort(compareLocations);
}

function collectModuleReferences(
    module: IIndexedModule,
    /* Нужен строковым формам вызова: имя ищется по модулям. */
    index: WorkspaceIndex,
    resolver: RslScopeResolver,
    targetKey: string,
    targetName: string,
    /* Где объявлена цель: URI модуля и точный диапазон её имени. */
    targetUri: string,
    targetSelection: { start: number; end: number },
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
    /*
     * Токен объявления не ищется: он уже известен.
     *
     * Прежде перед основным обходом шёл ещё один: он проходил дерево
     * символов, отбирал объект по ключу и снова шёл по всему потоку
     * токенов, чтобы найти тот идентификатор, который дерево уже описало
     * полем selectionRange. Инвариант проверен на всех видах объявлений —
     * см. declaration-selection-range.test.js.
     */
    const declarationHere = module.uri === targetUri;

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

        const declaration = declarationHere &&
            targetSelection.start === token.start &&
            targetSelection.end === token.end;
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

    collectStringCallReferences(
        module,
        index,
        targetKey,
        targetName,
        result,
        seen,
        collected,
        isCancelled
    );
}

/**
 * Вызовы, записанные строкой: ExecMacro, ExecMacroFile, R2M, обработчики.
 *
 * Обход идентификаторов их не видит — там строка, а не имя. Для RSL это не
 * редкость, а обычный способ вызвать процедуру, и «найти использования» без
 * них показывает неполную картину.
 *
 * Разбор общий с иерархией вызовов и переходом: см. callSiteFacts.
 */
function collectStringCallReferences(
    module: IIndexedModule,
    index: WorkspaceIndex,
    targetKey: string,
    targetName: string,
    result: Location[],
    seen: Set<string>,
    collected: IRslShardReference[] | undefined,
    isCancelled: () => boolean
): void {
    for (const site of collectRslCallSites(module.syntax.tokens)) {
        if (isCancelled()) {
            return;
        }

        /*
         * Обычный вызов уже разобран обходом идентификаторов, и делать
         * это второй раз незачем.
         */
        if (site.kind === "call" || site.kind === "method") {
            continue;
        }

        if (normalizeReferenceIdentifier(site.targetName) !== targetName) {
            continue;
        }

        const resolved = resolveRslStringCallSite(index, module, site);

        if (!resolved) {
            continue;
        }

        const range = rangeInModule(module, site.start, site.end);

        if (collected) {
            collected.push({
                targetKey: symbolKey(resolved.uri, resolved.symbol),
                startLine: range.start.line,
                startCharacter: range.start.character,
                endLine: range.end.line,
                endCharacter: range.end.character,
                isDeclaration: false
            });
        }

        if (symbolKey(resolved.uri, resolved.symbol) !== targetKey) {
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

/*
 * Сравнение по устойчивому номеру объявления, а не по ссылке.
 *
 * Дерево здесь из текущей модели файла, а искомый символ мог прийти из
 * кэша, собранного до её пересборки: поля те же, объект другой.
 */
function findObjectPath(
    current: RslSymbol,
    target: RslSymbol,
    path: RslSymbol[] = []
): RslSymbol[] | undefined {
    const currentPath = [...path, current];

    if (current.id === target.id) {
        return currentPath;
    }

    for (const child of getReferenceTreeChildren(current)) {
        if (child.id === target.id) {
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

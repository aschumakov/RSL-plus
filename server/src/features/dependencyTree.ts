import { collectRslImportClosure } from "../indexing/importClosure";
import {
    moduleReferenceKey,
    rslModuleBaseName
} from "../core/language/moduleName";
import {
    GetImportDefinitionTargetsFromTokens
} from "../execMacroDefinition";
import { rangeInModule } from "../core/documentPosition";
import type { Range } from "vscode-languageserver";
import { normalizeIdentifier } from "../lexer";
import type { WorkspaceIndex } from "../workspaceIndex";

/**
 * Дерево зависимостей проекта.
 *
 * Import-граф у сервера был, а пользователю его видно не было: почему имя
 * доступно, чего не хватает и от чего зависит файл, приходилось выяснять
 * чтением кода. Здесь тот же граф отвечает по одному уровню за раз.
 *
 * Отвечает ЛЕНИВО, по узлу. Дерево проекта целиком не строится: на 6166 файлах
 * это тысячи узлов, из которых пользователь раскроет пять.
 */
export type RslDependencyState =
    | "resolved"
    | "unloaded"
    | "missing"
    | "ambiguous"
    | "platform";

export interface IRslDependencyNode {
    /** Имя, как написано в Import. */
    name: string;
    /** Файл, если имя разрешилось однозначно. */
    uri?: string;
    state: RslDependencyState;
    /**
     * Узел уже встречался выше по ветке.
     *
     * Цикл в Import — не ошибка сам по себе, но раскрывать его дальше нечего:
     * дерево ушло бы в бесконечность.
     */
    cycle?: boolean;
    /** Есть ли что раскрывать: считается по одному уровню вперёд. */
    expandable?: boolean;
}

export interface IRslDependencyRequest {
    uri: string;
    /** Куда смотреть: на кого ссылается файл или кто ссылается на него. */
    direction?: "dependencies" | "dependents";
    /** Путь URI от корня: по нему видно цикл. */
    ancestors?: readonly string[];
}

export interface IRslDependencyEnvironment {
    index: WorkspaceIndex;
    /** Знает ли платформа модуль с таким именем. */
    knowsPlatformModule?(name: string): boolean;
}

/** Один уровень дерева. */
export function buildRslDependencyLevel(
    environment: IRslDependencyEnvironment,
    request: IRslDependencyRequest
): IRslDependencyNode[] {
    return request.direction === "dependents"
        ? dependentsOf(environment, request.uri)
        : dependenciesOf(environment, request);
}

function dependenciesOf(
    environment: IRslDependencyEnvironment,
    request: IRslDependencyRequest
): IRslDependencyNode[] {
    const index = environment.index;
    const module = index.getModule(request.uri);

    if (!module) {
        return [];
    }

    const ancestors = new Set(request.ancestors || []);
    const direct = collectRslImportClosure(index, request.uri, {
        directOnly: true
    });
    const byKey = new Map<string, IRslDependencyNode>();

    for (const name of module.imports) {
        const key = moduleReferenceKey(name);

        if (byKey.has(key)) {
            continue;
        }

        byKey.set(key, classify(environment, name, direct, ancestors));
    }

    return [...byKey.values()].sort(byName);
}

/** К какому виду отнести написанное имя. */
function classify(
    environment: IRslDependencyEnvironment,
    name: string,
    direct: ReturnType<typeof collectRslImportClosure>,
    ancestors: ReadonlySet<string>
): IRslDependencyNode {
    const wanted = normalizeIdentifier(itemName(name));

    /*
     * Каталог платформы спрашивается первым: у прикладного модуля RS-Bank
     * преимущество перед файлом проекта с тем же именем, и это правило живёт
     * в одном месте — см. importClosure.
     */
    if (environment.knowsPlatformModule?.(itemName(name))) {
        return { name, state: "platform" };
    }

    if (direct.ambiguous.some(item => normalizeIdentifier(itemName(item)) === wanted)) {
        return { name, state: "ambiguous" };
    }

    if (direct.missing.some(item => normalizeIdentifier(itemName(item)) === wanted)) {
        return { name, state: "missing" };
    }

    if (direct.unloaded.some(item => normalizeIdentifier(itemName(item)) === wanted)) {
        return { name, state: "unloaded" };
    }

    const found = direct.modules.find(item =>
        normalizeIdentifier(moduleNameOfUri(item.uri)) === wanted);

    if (!found) {
        return { name, state: "missing" };
    }

    const cycle = ancestors.has(found.uri);

    return {
        name,
        uri: found.uri,
        state: "resolved",
        cycle: cycle || undefined,
        expandable: !cycle && found.imports.length > 0
    };
}

/**
 * Кто зависит от файла — по всему проекту.
 *
 * Спрашивается каталог, а не граф загруженных модулей. При обычном
 * режиме индексации значительная часть проекта в память не
 * загружена, и ответ по графу зависел бы от того, какие модули
 * случайно оказались прочитаны: тот же вопрос давал бы разные ответы
 * в разные минуты работы. Состав Import каталог знает про все
 * прочитанные файлы, и полные модули ради панели не грузятся.
 */
function dependentsOf(
    environment: IRslDependencyEnvironment,
    uri: string
): IRslDependencyNode[] {
    const index = environment.index;
    const name = moduleNameOfUri(uri);
    const seen = new Set<string>([
        ...index.catalog.modulesImportingModule(name),
        /*
         * Граф загруженных модулей добавляется сверху: открытый
         * документ мог получить новый Import уже после того, как
         * его прочитала достройка каталога.
         */
        ...index.getDependents(uri)
    ]);

    seen.delete(uri);

    return [...seen]
        .map(item => ({
            name: moduleNameOfUri(item),
            uri: item,
            state: "resolved" as const,
            expandable: hasDependents(environment, item)
        }))
        .sort(byName);
}

/** Есть ли у файла свои зависимые: считается тем же способом. */
function hasDependents(
    environment: IRslDependencyEnvironment,
    uri: string
): boolean {
    const name = moduleNameOfUri(uri);

    return environment.index.catalog
        .modulesImportingModule(name)
        .some(item => item !== uri) ||
        environment.index.getDependents(uri).length > 0;
}

/**
 * Точное место, где написан Import этого модуля.
 *
 * Ищет общий разбор директив, а не поиск подстроки: имя модуля
 * запросто встречается в комментарии или в вызове раньше самой
 * директивы, и переход уводил бы не туда. Строковую форму и путь
 * общий разбор понимает сам.
 */
export function findRslImportRange(
    environment: IRslDependencyEnvironment,
    uri: string,
    moduleName: string
): Range | undefined {
    const module = environment.index.getModule(uri);

    if (!module) {
        return undefined;
    }

    const wanted = rslModuleBaseName(moduleName);

    for (const target of GetImportDefinitionTargetsFromTokens(
        module.lex.tokens as never
    )) {
        if (rslModuleBaseName(target.moduleName) !== wanted) {
            continue;
        }

        return rangeInModule(module, target.nameStart, target.nameEnd);
    }

    return undefined;
}

/**
 * Путь от одного модуля к другому по Import.
 *
 * Обход вширь: показывается кратчайший путь — по нему понятнее всего, почему
 * имя вообще видно.
 */
export function findRslDependencyPath(
    index: WorkspaceIndex,
    fromUri: string,
    toUri: string
): string[] {
    if (fromUri === toUri) {
        return [fromUri];
    }

    const previous = new Map<string, string>([[fromUri, ""]]);
    const queue = [fromUri];

    for (let at = 0; at < queue.length; at++) {
        const current = queue[at];
        const direct = collectRslImportClosure(index, current, {
            directOnly: true
        });

        for (const module of direct.modules) {
            if (previous.has(module.uri)) {
                continue;
            }

            previous.set(module.uri, current);

            if (module.uri === toUri) {
                return restore(previous, fromUri, toUri);
            }

            queue.push(module.uri);
        }
    }

    return [];
}

function restore(
    previous: ReadonlyMap<string, string>,
    fromUri: string,
    toUri: string
): string[] {
    const path = [toUri];

    while (path[0] !== fromUri) {
        const step = previous.get(path[0]);

        if (!step) {
            return [];
        }

        path.unshift(step);
    }

    return path;
}

/** Имя элемента Import без пути и расширения. */
function itemName(value: string): string {
    const key = moduleReferenceKey(value);
    const slash = key.lastIndexOf("/");
    const name = slash < 0 ? key : key.slice(slash + 1);

    return name.endsWith(".mac") ? name.slice(0, -4) : name;
}

function moduleNameOfUri(uri: string): string {
    const slash = uri.lastIndexOf("/");
    const name = slash < 0 ? uri : uri.slice(slash + 1);

    return name.toLowerCase().endsWith(".mac") ? name.slice(0, -4) : name;
}

function byName(left: IRslDependencyNode, right: IRslDependencyNode): number {
    return left.name.localeCompare(right.name);
}

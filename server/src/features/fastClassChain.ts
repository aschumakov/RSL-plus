import { CompletionItem } from "vscode-languageserver";

import { normalizeIdentifier } from "../lexer";
import type { IRslFastClass, RslScopeResolver } from "../scopeResolver";
import type { RslSymbol } from "../symbols/rslSymbol";
import {
    findFastClass,
    type IFastClassInfo,
    type IFastCompletionIndex
} from "./fastCompletionIndex";
import { buildRslFastOwnClassMembers } from "./fastCompletionProvider";

/**
 * Один обход цепочки наследования для всех быстрых ответов.
 *
 * Completion, Hover, подсказка параметров и переход к типу спрашивают одно и то
 * же: какие уровни иерархии видны из этой точки и что на них объявлено. Каждый
 * из них раньше обходил цепочку сам, и правила расходились — например ключ
 * защиты от цикла у одного включал источник класса, а у другого нет, и
 * одноимённые символы разных модулей обрывали обход.
 *
 * Уровни выдаются от производного к базовому: первым найденный член и
 * побеждает, как в самом языке.
 */
export type IRslClassLevel =
    | {
        /** Класс объявлен в этом же файле; о нём знает индекс версии. */
        kind: "own";
        className: string;
        info: IFastClassInfo;
    }
    | {
        /** Класс из подключённого модуля или прикладного каталога. */
        kind: "external";
        value: IRslFastClass;
    };

export interface IRslClassChainOptions {
    resolver: RslScopeResolver;
    uri: string;
    /** Import ТЕКУЩЕГО текста: цепочка разрешается по ним. */
    imports: readonly string[];
    /** Индекс версии: по нему находятся классы самого файла. */
    fastIndex?: IFastCompletionIndex;
    /** Позиция запроса: ею разрешается неоднозначность одноимённых классов. */
    offset?: number;
}

/**
 * Ключ уровня для защиты от цикла.
 *
 * Источник обязателен: идентификаторы символов совпадают между модулями, и по
 * одному id обход считал разные классы одним и обрывался на первом же
 * одноимённом.
 */
export function rslClassLevelKey(level: IRslClassLevel): string {
    if (level.kind === "own") {
        return "own:" + normalizeIdentifier(level.className) +
            "#" + level.info.start;
    }

    const value = level.value;

    return (value.moduleUri || value.owner?.moduleKey || "builtin") +
        "#" + value.symbol.id;
}

/** Уровни иерархии класса от производного к базовому. */
export function* walkRslClassChain(
    className: string,
    options: IRslClassChainOptions
): Generator<IRslClassLevel> {
    const visited = new Set<string>();
    let wanted = className;

    /* Пока база объявлена в этом же файле, её даёт индекс версии. */
    while (options.fastIndex) {
        const own = findFastClass(
            options.fastIndex,
            wanted,
            options.offset ?? 0
        );

        if (!own) {
            break;
        }

        const level: IRslClassLevel = {
            kind: "own",
            className: wanted,
            info: own
        };

        if (visited.has(rslClassLevelKey(level))) {
            return;
        }

        visited.add(rslClassLevelKey(level));
        yield level;

        if (!own.baseName) {
            return;
        }

        wanted = own.baseName;
    }

    /*
     * Дальше цепочку ведёт resolver — он же ведёт её для полного пути, и
     * правила видимости не раздваиваются: класс модуля workspace может
     * наследовать класс своего модуля, класс его Import, встроенный или
     * прикладной, а класс прикладного модуля — только через своего владельца.
     */
    let current = options.resolver.findFastClass(
        options.uri,
        wanted,
        options.imports
    );

    while (current) {
        const level: IRslClassLevel = { kind: "external", value: current };
        const key = rslClassLevelKey(level);

        if (visited.has(key)) {
            return;
        }

        visited.add(key);
        yield level;

        current = options.resolver.findFastBaseClass(
            current,
            current.symbol.baseClassName || "",
            options.imports
        );
    }
}

export interface IRslClassMember {
    symbol?: RslSymbol;
    name: string;
    typeName: string;
    /** Файл, где объявлен класс уровня; undefined — прикладной каталог. */
    moduleUri?: string;
}

/**
 * Член класса по имени с учётом наследования.
 *
 * Приватный член чужого класса не отдаётся: снаружи он недоступен, и показать
 * его значило бы предложить то, чего компилятор не примет.
 */
export function findRslClassMember(
    className: string,
    memberName: string,
    options: IRslClassChainOptions
): IRslClassMember | undefined {
    const wanted = normalizeIdentifier(memberName);

    for (const level of walkRslClassChain(className, options)) {
        if (level.kind === "own") {
            const found = level.info.members.find(member =>
                normalizeIdentifier(member.name) === wanted
            );

            if (found) {
                return {
                    name: found.name,
                    typeName: found.typeName,
                    moduleUri: options.uri
                };
            }

            continue;
        }

        const found = level.value.symbol.children.find(child =>
            normalizeIdentifier(child.name) === wanted &&
            child.visibility !== "private"
        );

        if (found) {
            return {
                symbol: found,
                name: found.name,
                typeName: found.typeName,
                moduleUri: level.value.moduleUri
            };
        }
    }

    return undefined;
}

/**
 * Все члены класса с учётом наследования.
 *
 * undefined — класса не нашлось вовсе: это не то же самое, что «членов нет», и
 * вызывающий обязан различать.
 */
export function collectRslClassMembers(
    className: string,
    options: IRslClassChainOptions
): CompletionItem[] | undefined {
    const items: CompletionItem[] = [];
    const taken = new Set<string>();
    let found = false;

    for (const level of walkRslClassChain(className, options)) {
        found = true;

        if (level.kind === "own") {
            addUnique(
                items,
                taken,
                (options.fastIndex && buildRslFastOwnClassMembers(
                    options.fastIndex,
                    level.className,
                    options.offset ?? 0
                )) || []
            );
            continue;
        }

        addUnique(items, taken, publicMembers(level.value.symbol));
    }

    return found ? items : undefined;
}

/** Первое место объявления класса: цель перехода к типу. */
export function findRslClassDeclaration(
    className: string,
    options: IRslClassChainOptions
): { moduleUri: string; symbol?: RslSymbol; start?: number } | undefined {
    for (const level of walkRslClassChain(className, options)) {
        if (level.kind === "own") {
            return { moduleUri: options.uri, start: level.info.start };
        }

        if (level.value.moduleUri) {
            return {
                moduleUri: level.value.moduleUri,
                symbol: level.value.symbol
            };
        }

        /*
         * Класс прикладного каталога — не файл: открывать нечего. Переход к
         * определению встроенного символа сервер по той же причине не отдаёт.
         */
        return undefined;
    }

    return undefined;
}

/** Открытые члены символа класса: приватные чужого модуля недоступны. */
function publicMembers(symbol: RslSymbol): CompletionItem[] {
    return symbol.children
        .filter(member => member.visibility !== "private")
        .map(member => ({
            label: member.name,
            kind: member.kind,
            detail: member.typeName || undefined
        }));
}

/** Добавляет члены, не перекрывая уже добавленные производным классом. */
function addUnique(
    items: CompletionItem[],
    taken: Set<string>,
    members: readonly CompletionItem[]
): void {
    for (const member of members) {
        const key = normalizeIdentifier(String(member.label));

        if (!taken.has(key)) {
            taken.add(key);
            items.push(member);
        }
    }
}

import { CompletionItemKind } from "vscode-languageserver";

import { normalizeIdentifier, type IRslToken } from "../lexer";
import type { RslSymbol } from "../symbols/rslSymbol";
import type { RslScopeResolver } from "../scopeResolver";
import type { IIndexedModule } from "../workspaceIndex";

/**
 * Проверка состава класса: поля и метода, которого у него нет.
 *
 * Утверждать «такого члена нет» можно далеко не всегда. У прикладных классов
 * состав известен из документации, а она неполна; у переменной типа Variant
 * состав вообще определяется во время исполнения. Поэтому проверка требует
 * доказательств и отказывается работать без них:
 *
 * 1. Тип получателя известен — объявлен или выведен моделью.
 * 2. Класс этого типа прочитан из исходного файла: у него есть moduleUri.
 * 3. Вся цепочка базовых классов прочитана до конца: незагруженная база
 *    означает, что часть состава сервер просто не видел.
 * 4. Ни класс, ни его базы не одноимённы: при неоднозначности состав неизвестен.
 *
 * Если хоть одно условие не выполнено, проверка молчит — «не нашли» и «нет» это
 * разные утверждения, и вторым пугать пользователя нельзя.
 */
export interface IRslMemberFinding {
    name: string;
    className: string;
    start: number;
    end: number;
    line: number;
    character: number;
}

export interface IRslMemberCheckerOptions {
    module: IIndexedModule;
    resolver: RslScopeResolver;
    /** Позиция запроса нужна для правил видимости приватных членов. */
    imports: readonly string[];
}

export interface IRslMemberChecker {
    /** Проверяет имя, стоящее сразу за точкой. */
    check(
        tokens: readonly IRslToken[],
        index: number,
        receiver: IRslToken
    ): IRslMemberFinding | undefined;
}

export function createRslMemberChecker(
    options: IRslMemberCheckerOptions
): IRslMemberChecker {
    const { module, resolver } = options;
    /* Состав класса считается один раз на файл: имён после точки много. */
    const membersByClass = new Map<string, Set<string> | undefined>();

    const membersOf = (className: string): Set<string> | undefined => {
        const key = normalizeIdentifier(className);
        const known = membersByClass.get(key);

        if (known !== undefined || membersByClass.has(key)) {
            return known;
        }

        const collected = collectKnownMembers(
            module,
            resolver,
            className,
            options.imports
        );
        membersByClass.set(key, collected);

        return collected;
    };

    return {
        check(tokens, index, receiver) {
            const token = tokens[index];
            const typeName = receiverTypeName(module, resolver, receiver);

            if (!typeName) {
                return undefined;
            }

            const members = membersOf(typeName);

            if (!members || members.has(normalizeIdentifier(token.value))) {
                return undefined;
            }

            return {
                name: token.value,
                className: typeName,
                start: token.start,
                end: token.end,
                line: token.line,
                character: token.character
            };
        }
    };
}

/** Тип получателя: объявленный или выведенный моделью. */
function receiverTypeName(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    receiver: IRslToken
): string {
    const resolved = resolver.resolveAt(
        module.uri,
        module.symbolTree,
        receiver.start
    );

    if (!resolved) {
        return "";
    }

    const typeName = resolver.effectiveTypeName(
        module.uri,
        module.symbolTree,
        resolved.symbol,
        receiver.start
    );

    /*
     * Variant — это «тип неизвестен», а не тип: состав такого объекта
     * определяется во время исполнения.
     */
    return !typeName || normalizeIdentifier(typeName) === "variant"
        ? ""
        : typeName;
}

/**
 * Полный состав класса — или undefined, если он известен не целиком.
 *
 * undefined значит «проверять нельзя»: класса нет, он пришёл из
 * документации, его имя неоднозначно или база не прочитана.
 */
function collectKnownMembers(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    className: string,
    imports: readonly string[]
): Set<string> | undefined {
    const result = new Set<string>();
    const visited = new Set<string>();
    let wanted = className;

    while (wanted) {
        const level = findClassLevel(module, resolver, wanted, imports);

        if (!level) {
            /* Класса нет, он неоднозначен или описан только в справочнике. */
            return undefined;
        }

        const key = level.moduleUri + "#" + level.symbol.id;

        if (visited.has(key)) {
            break;
        }

        visited.add(key);

        for (const child of level.symbol.children) {
            result.add(normalizeIdentifier(child.name));
        }

        wanted = level.symbol.baseClassName || "";
    }

    return result;
}

/**
 * Класс по имени: сначала свой файл, затем подключённые модули.
 *
 * undefined — состав недоказуем: класса нет, одноимённых несколько либо он
 * известен только из документации прикладного модуля.
 */
function findClassLevel(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    className: string,
    imports: readonly string[]
): { moduleUri: string; symbol: RslSymbol } | undefined {
    const wanted = normalizeIdentifier(className);
    const own = module.symbolTree.children.filter(child =>
        child.kind === CompletionItemKind.Class &&
        normalizeIdentifier(child.name) === wanted
    );

    if (own.length > 1) {
        /* Два одноимённых класса в файле: какой из них — неизвестно. */
        return undefined;
    }

    if (own.length === 1) {
        return { moduleUri: module.uri, symbol: own[0] };
    }

    const external = resolver.findFastClass(module.uri, className, imports);

    return external?.moduleUri
        ? { moduleUri: external.moduleUri, symbol: external.symbol }
        : undefined;
}

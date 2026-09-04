import type { CompletionItem } from "vscode-languageserver";

import {
    rslClassLevelKey,
    walkRslClassChain,
    type IRslClassChainOptions,
    type IRslClassLevel,
    type IRslClassMember
} from "../features/fastClassChain";
import { findRslClassMember } from "../features/fastClassChain";
import {
    buildRslFastOwnClassMembers
} from "../features/fastCompletionProvider";
import { normalizeIdentifier } from "../lexer";
import type { RslSymbol } from "../symbols/rslSymbol";

/**
 * Состав класса — один ответ на всех.
 *
 * Подсказка после точки, Hover, переход, подпись, разрешение члена и проверка
 * «такого члена нет» спрашивают одно и то же: что есть у этого класса. Обход
 * иерархии у них уже общий (см. walkRslClassChain), а вот ЗНАНИЕ о полноте
 * ответа не передавалось никак — и обход, дошедший до неразрешимой базы,
 * выглядел ровно как обход класса без базы.
 *
 * Разница между ними решающая. Подсказке всё равно: она покажет, что нашла.
 * Проверке — нет: делать вывод «члена нет» по неполному составу значит
 * ругаться на верный код. Поэтому здесь состав идёт вместе с полнотой, и
 * доказательством отсутствия считается только `complete`.
 *
 *   complete  — вся цепочка разрешена, и у каждого её уровня состав известен
 *               целиком;
 *   partial   — часть уровней известна, часть нет: у класса есть база, о
 *               которой сказать нечего;
 *   pending   — чего-то ещё нет в памяти, но оно придёт: модуль читается;
 *   ambiguous — класс или его база разрешаются в несколько разных;
 *   dynamic   — источник непрозрачен: состав дописывается на ходу или его
 *               полнота никем не заявлена.
 */

export type RslMemberSetCompleteness =
    | "complete"
    | "partial"
    | "pending"
    | "ambiguous"
    | "dynamic";

/** Откуда пришёл класс: по источнику решается, чем доказывать полноту. */
export type RslTypeSource =
    | "workspace"
    | "library"
    | "builtin"
    | "platform"
    | "unknown";

export interface IRslMemberSet {
    /** Имя, как о нём спросили. */
    className: string;
    /** Класс нашёлся хоть на одном уровне. */
    resolved: boolean;
    source: RslTypeSource;
    completeness: RslMemberSetCompleteness;
    /** Уровни иерархии от производного к базовому. */
    levels: readonly IRslClassLevel[];
    /**
     * Почему состав неполон; пусто у `complete`.
     *
     * Не для показа пользователю — для отладки и для проверок, которым важно
     * различать «ещё не прочитано» и «прочитать нечего».
     */
    reason?: string;
}

export interface IRslMemberSetOptions extends IRslClassChainOptions {
    /**
     * Заявлена ли полнота состава у класса прикладного модуля.
     *
     * У прикладных модулей состав берётся из справки, и она бывает неполной:
     * страница класса перечисляет часть членов, остальное описано прозой.
     * Считать отсутствие члена доказанным можно только там, где полнота
     * заявлена явно — см. membersComplete в каталоге.
     */
    platformMembersComplete?(moduleKey: string): boolean;
    /** Файл библиотеки, а не проекта: см. RslTypeSource. */
    isLibraryUri?(uri: string): boolean;
}

/**
 * Состав класса вместе с полнотой.
 *
 * Обход тот же, что и у всех остальных, — здесь к нему добавляется ответ на
 * вопрос «всё ли это». Цепочка обрывается на первой базе, которую разрешить
 * не удалось, и именно этот обрыв делает состав неполным.
 */
export function getRslMemberSet(
    className: string,
    options: IRslMemberSetOptions
): IRslMemberSet {
    const levels: IRslClassLevel[] = [];
    const visited = new Set<string>();
    let source: RslTypeSource = "unknown";
    let completeness: RslMemberSetCompleteness = "complete";
    let reason: string | undefined;

    const weaken = (
        next: RslMemberSetCompleteness,
        why: string
    ): void => {
        if (rank(next) > rank(completeness)) {
            completeness = next;
            reason = why;
        }
    };

    for (const level of walkRslClassChain(className, options)) {
        levels.push(level);
        visited.add(rslClassLevelKey(level));

        if (levels.length === 1) {
            source = sourceOfLevel(level, options);
        }

        const own = ownCompleteness(level, options);

        if (own) {
            weaken(own.completeness, own.reason);
        }
    }

    if (levels.length === 0) {
        return {
            className,
            resolved: false,
            source: "unknown",
            completeness: "dynamic",
            levels,
            reason: "класс не разрешён"
        };
    }

    /*
     * Обход остановился — но почему? База, которую не удалось разрешить,
     * выглядит для него ровно как её отсутствие, а разница решающая.
     */
    const last = levels[levels.length - 1];
    const base = baseNameOf(last);

    if (base) {
        weaken(
            "partial",
            "база «" + base + "» не разрешена"
        );
    }

    return { className, resolved: true, source, completeness, levels, reason };
}

/** Члены набора для подсказки: порядок и перекрытие как в языке. */
export function rslMemberSetCompletions(
    set: IRslMemberSet,
    options: IRslMemberSetOptions
): CompletionItem[] {
    const items: CompletionItem[] = [];
    const taken = new Set<string>();

    for (const level of set.levels) {
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

    return items;
}

/**
 * Есть ли у класса такой член.
 *
 * Отдельно от поиска: проверке нужен не сам член, а ответ «да или нет», и
 * этот ответ имеет смысл только при полном составе.
 */
export function rslMemberSetHas(
    set: IRslMemberSet,
    memberName: string,
    options: IRslMemberSetOptions
): boolean {
    return findRslMemberSetMember(set, memberName, options) !== undefined;
}

/** Член набора по имени — тот же поиск, что и у перехода с Hover. */
export function findRslMemberSetMember(
    set: IRslMemberSet,
    memberName: string,
    options: IRslMemberSetOptions
): IRslClassMember | undefined {
    return set.resolved
        ? findRslClassMember(set.className, memberName, options)
        : undefined;
}

/**
 * Можно ли по этому набору утверждать, что члена НЕТ.
 *
 * Единственный предикат для всех проверок, делающих вывод из отсутствия. Два
 * разных условия для одного вопроса разошлись бы — так уже было с полнотой
 * Import-контекста.
 */
export function isProvenRslMemberSet(set: IRslMemberSet): boolean {
    return set.resolved && set.completeness === "complete";
}

/** Чем хуже, тем больше: слабейшее звено и определяет полноту набора. */
function rank(value: RslMemberSetCompleteness): number {
    switch (value) {
        case "complete":
            return 0;
        case "pending":
            return 1;
        case "partial":
            return 2;
        case "ambiguous":
            return 3;
        default:
            return 4;
    }
}

/**
 * Источник класса.
 *
 * Пустой ключ владельца означает встроенную библиотеку, а не прикладной
 * модуль: так это записано в IRslExternalClass. Разница существенная —
 * состав встроенного класса выверен по руководству, состав прикладного
 * заявляется отдельно.
 */
function sourceOfLevel(
    level: IRslClassLevel,
    options: IRslMemberSetOptions
): RslTypeSource {
    if (level.kind === "own") {
        return "workspace";
    }

    const value = level.value;

    if (value.owner) {
        return value.owner.moduleKey ? "platform" : "builtin";
    }

    if (!value.moduleUri) {
        return "builtin";
    }

    return options.isLibraryUri?.(value.moduleUri)
        ? "library"
        : "workspace";
}

/**
 * Полнота состава одного уровня.
 *
 * У класса файла и у класса встроенной библиотеки состав известен целиком: он
 * прочитан из объявления или выверен по руководству. У прикладного модуля —
 * только если полнота заявлена: справка описывает часть классов прозой, и
 * отсутствие члена там ничего не доказывает.
 */
function ownCompleteness(
    level: IRslClassLevel,
    options: IRslMemberSetOptions
): { completeness: RslMemberSetCompleteness; reason: string } | undefined {
    if (level.kind === "own") {
        return undefined;
    }

    const owner = level.value.owner;

    /* Без владельца и с пустым ключом — встроенный класс: он выверен. */
    if (!owner || !owner.moduleKey) {
        return undefined;
    }

    const complete = options.platformMembersComplete?.(owner.moduleKey);

    return complete
        ? undefined
        : {
            completeness: "dynamic",
            reason: "состав модуля «" + owner.moduleKey +
                "» не заявлен полным"
        };
}

/** Имя базы уровня; пусто, если база не объявлена. */
function baseNameOf(level: IRslClassLevel): string {
    return level.kind === "own"
        ? level.info.baseName || ""
        : level.value.symbol.baseClassName || "";
}

function publicMembers(symbol: RslSymbol): CompletionItem[] {
    return symbol.children
        .filter(child => child.visibility !== "private")
        .map(child => child.completionItem);
}

function addUnique(
    items: CompletionItem[],
    taken: Set<string>,
    source: readonly CompletionItem[]
): void {
    for (const item of source) {
        const key = normalizeIdentifier(String(item.label));

        if (taken.has(key)) {
            continue;
        }

        taken.add(key);
        items.push(item);
    }
}

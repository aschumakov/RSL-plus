import type { RslTypeSource } from "./memberSet";

/**
 * Тип выражения как значение, а не как строка.
 *
 * Строкой тип нёс ровно одно сведение — своё имя, — и всё остальное каждый
 * потребитель добывал сам: класс это или примитив, откуда он взялся, можно ли
 * по нему судить о составе. Отсюда и расхождения: подсказка считала `variant`
 * поводом показать всё, проверка — поводом промолчать, а третий потребитель
 * решал по наличию `moduleUri`, что для встроенных и прикладных классов
 * неверно по построению.
 *
 *   class     — известен класс, и о его составе можно спрашивать;
 *   primitive — Integer, String и прочее: членов у них нет;
 *   variant   — тип не определён и определяться будет во время исполнения;
 *   unknown   — сказать нечего: имя не разрешилось или контекст неполон.
 *
 * Разница между `variant` и `unknown` существенна. Первое — свойство языка, и
 * оно окончательно. Второе — свойство момента: дочитается замыкание, и ответ
 * станет другим.
 */

export type RslResolvedTypeKind =
    | "class"
    | "primitive"
    | "variant"
    | "unknown";

export interface IRslResolvedType {
    kind: RslResolvedTypeKind;
    /** Имя типа как его пишут; пусто у unknown. */
    name: string;
    /** Откуда класс; у не-классов «unknown». */
    source: RslTypeSource;
}

const VARIANT: IRslResolvedType = Object.freeze({
    kind: "variant" as const,
    name: "Variant",
    source: "unknown" as const
});

const UNKNOWN: IRslResolvedType = Object.freeze({
    kind: "unknown" as const,
    name: "",
    source: "unknown" as const
});

export function rslVariantType(): IRslResolvedType {
    return VARIANT;
}

export function rslUnknownType(): IRslResolvedType {
    return UNKNOWN;
}

export function rslClassType(
    name: string,
    source: RslTypeSource
): IRslResolvedType {
    return Object.freeze({ kind: "class" as const, name, source });
}

export function rslPrimitiveType(name: string): IRslResolvedType {
    return Object.freeze({
        kind: "primitive" as const,
        name,
        source: "builtin" as const
    });
}

/**
 * Имена, у которых членов не бывает.
 *
 * Список закрытый и короткий: всё остальное, что разрешилось в класс, класс и
 * есть. Спрашивать состав у Integer незачем, а молчать о нём как о «пока
 * неизвестном» — неправда.
 */
const PRIMITIVES = new Set([
    "integer",
    "string",
    "bool",
    "boolean",
    "double",
    "float",
    "date",
    "time",
    "money",
    "char",
    "byte",
    "word"
]);

/**
 * Разобрать написанное имя типа.
 *
 * Единственное место, где строка превращается в тип: `Variant` здесь означает
 * «неизвестно», а не класс с таким именем, и это правило больше нигде не
 * повторяется.
 */
export function rslTypeFromName(
    name: string,
    source: RslTypeSource = "unknown"
): IRslResolvedType {
    const trimmed = (name || "").trim();

    if (!trimmed) {
        return UNKNOWN;
    }

    const lower = trimmed.toLowerCase();

    if (lower === "variant") {
        return VARIANT;
    }

    return PRIMITIVES.has(lower)
        ? rslPrimitiveType(trimmed)
        : rslClassType(trimmed, source);
}

/** Можно ли спрашивать состав: только у класса. */
export function isRslClassType(value: IRslResolvedType): boolean {
    return value.kind === "class";
}

import {
    cachedSignificantTokens,
    normalizeIdentifier,
    type IRslToken
} from "../lexer";
import {
    getProcedureCallbackSpec,
    isProcedureCallbackArgument
} from "../features/procedureCallbackCatalog";

/**
 * Как записан вызов.
 *
 * В RSL вызов сплошь и рядом записан строкой: имя процедуры приходит первым
 * аргументом ExecMacro, именем метода во втором аргументе R2M, обработчиком в
 * известной позиции. Для пользователя это такой же вызов, как `Foo()`, и
 * «кто это вызывает» обязано их показывать.
 */
export type RslCallSiteKind =
    | "call"
    | "method"
    | "execMacro"
    | "execMacro2"
    | "execMacroFile"
    | "r2m"
    | "callback";

/** Одно место вызова с известным статически именем цели. */
export interface IRslCallSite {
    kind: RslCallSiteKind;
    /** Имя цели как написано: без кавычек и без нормализации. */
    targetName: string;
    /** Диапазон ИМЕНИ цели в тексте: смещения от начала файла. */
    start: number;
    end: number;
    /**
     * Модуль, если он написан рядом.
     *
     * `ExecMacro2("модуль", "Имя")` называет модуль прямо; `ExecMacroFile`
     * называет файл. У обычного вызова модуля нет — его решает Import.
     */
    moduleName?: string;
    /** Смещение получателя: `obj.Method()` и `R2M(obj, "Method")`. */
    receiverOffset?: number;
    /**
     * Имя цели известно статически.
     *
     * Собранное на ходу — `ExecMacro(prefix + name)` — не угадывается: у него
     * значение появляется только во время выполнения, и показать такой вызов
     * как ссылку на конкретную процедуру значило бы соврать.
     */
    staticallyResolvable: boolean;
}

/** Слово вызова -> вид места вызова. */
const DYNAMIC_KINDS: ReadonlyMap<string, RslCallSiteKind> = new Map([
    ["execmacro", "execMacro"],
    ["execmacro2", "execMacro2"],
    ["execmacrofile", "execMacroFile"],
    ["r2m", "r2m"]
] as Array<[string, RslCallSiteKind]>);

/**
 * Все места вызова файла по готовому потоку токенов.
 *
 * Один разбор на всех: переход, поиск использований, иерархия вызовов, строка
 * над объявлением. Прежде каждая функция понимала вызовы по-своему — иерархия
 * считала вызовом «идентификатор и открывающая скобка» и не видела строковых
 * форм вовсе, а переход разбирал их своим кодом.
 *
 * Поток берётся готовый: своего лексирования здесь нет.
 */
export function collectRslCallSites(
    sourceTokens: readonly IRslToken[]
): IRslCallSite[] {
    const tokens = cachedSignificantTokens(sourceTokens as IRslToken[]);
    const result: IRslCallSite[] = [];

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (
            token.kind !== "identifier" ||
            !opensCall(tokens, index) ||
            isDeclarationName(tokens, index)
        ) {
            continue;
        }

        const word = normalizeIdentifier(token.value);
        const dynamic = DYNAMIC_KINDS.get(word);

        if (dynamic) {
            appendDynamicCall(tokens, index, dynamic, result);
            continue;
        }

        const callback = getProcedureCallbackSpec(word);

        if (callback) {
            appendCallbackNames(tokens, index, result);
        }

        const dot = tokens[index - 1];

        if (dot?.kind === "symbol" && dot.raw === ".") {
            result.push({
                kind: "method",
                targetName: token.value,
                start: token.start,
                end: token.end,
                receiverOffset: tokens[index - 2]?.start,
                staticallyResolvable: true
            });
            continue;
        }

        result.push({
            kind: "call",
            targetName: token.value,
            start: token.start,
            end: token.end,
            staticallyResolvable: true
        });
    }

    return result;
}

/**
 * Имя в заголовке объявления, а не вызов.
 *
 * `Macro Run()` — это объявление: имя тоже стоит перед скобкой, но вызовом
 * не является. Модификатор перед словом объявления роли не играет: между ним
 * и именем всё равно стоит `Macro`.
 */
function isDeclarationName(
    tokens: readonly IRslToken[],
    index: number
): boolean {
    const previous = tokens[index - 1];

    if (previous?.kind !== "identifier") {
        return false;
    }

    const word = normalizeIdentifier(previous.value);

    return word === "macro" || word === "class";
}

/** Следом за именем идёт открывающая скобка. */
function opensCall(tokens: readonly IRslToken[], index: number): boolean {
    const next = tokens[index + 1];

    return next?.kind === "symbol" && next.raw === "(";
}

/**
 * Аргументы вызова верхнего уровня: по одному списку токенов на аргумент.
 *
 * Вложенные скобки не разделяют аргументы: `Foo(Bar(a, b), c)` — это два
 * аргумента, а не три.
 */
function readArguments(
    tokens: readonly IRslToken[],
    openIndex: number
): IRslToken[][] {
    const result: IRslToken[][] = [];
    let current: IRslToken[] = [];
    let depth = 0;

    for (let index = openIndex; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind === "symbol") {
            if (token.raw === "(" || token.raw === "[" || token.raw === "{") {
                depth++;

                if (depth === 1) {
                    continue;
                }
            } else if (
                token.raw === ")" || token.raw === "]" || token.raw === "}"
            ) {
                depth--;

                if (depth === 0) {
                    result.push(current);

                    return result;
                }
            } else if (token.raw === ";") {
                /* Незакрытая скобка: дальше уже другое предложение. */
                break;
            } else if (token.raw === "," && depth === 1) {
                result.push(current);
                current = [];
                continue;
            }
        }

        if (depth >= 1) {
            current.push(token);
        }
    }

    if (current.length > 0) {
        result.push(current);
    }

    return result;
}

/** Строковый литерал, если аргумент — ровно он и ничего больше. */
function literalOf(argument: readonly IRslToken[]): IRslToken | undefined {
    /*
     * Ровно один токен, и это строка. `prefix + name` сюда не попадает
     * намеренно: значение такого аргумента известно только во время
     * выполнения.
     */
    return argument.length === 1 && argument[0].kind === "string"
        ? argument[0]
        : undefined;
}

/** Текст строкового литерала без кавычек. */
function literalText(token: IRslToken): string {
    const raw = token.raw;

    return raw.length >= 2 ? raw.slice(1, -1) : raw;
}

function appendDynamicCall(
    tokens: readonly IRslToken[],
    index: number,
    kind: RslCallSiteKind,
    result: IRslCallSite[]
): void {
    const args = readArguments(tokens, index + 1);

    if (args.length === 0) {
        return;
    }

    if (kind === "r2m") {
        /* R2M(object, "Method"): имя метода вторым аргументом. */
        const name = args[1] && literalOf(args[1]);

        if (!name) {
            return;
        }

        result.push({
            kind,
            targetName: literalText(name),
            start: name.start + 1,
            end: name.end - 1,
            receiverOffset: args[0]?.[0]?.start,
            staticallyResolvable: true
        });

        return;
    }

    /*
     * Где имя процедуры.
     *
     * У ExecMacro и ExecMacro2 — первым аргументом; второй у ExecMacro2 это
     * уже параметр вызываемой процедуры, а не модуль. У ExecMacroFile первым
     * идёт файл, а имя вторым, и его может не быть вовсе: тогда это ссылка на
     * файл, а не на процедуру.
     */
    const isFileCall = kind === "execMacroFile";
    const nameIndex = isFileCall ? 1 : 0;
    const name = args[nameIndex] && literalOf(args[nameIndex]);

    if (!name) {
        return;
    }

    const moduleToken = isFileCall ? literalOf(args[0]) : undefined;

    result.push({
        kind,
        targetName: literalText(name),
        start: name.start + 1,
        end: name.end - 1,
        moduleName: moduleToken ? literalText(moduleToken) : undefined,
        staticallyResolvable: true
    });
}

/**
 * Имена обработчиков в известных позициях известных процедур.
 *
 * Состав знает общий справочник: там же, где его читают подсказки и переход.
 */
function appendCallbackNames(
    tokens: readonly IRslToken[],
    index: number,
    result: IRslCallSite[]
): void {
    const word = normalizeIdentifier(tokens[index].value);
    const args = readArguments(tokens, index + 1);

    for (let at = 0; at < args.length; at++) {
        if (!isProcedureCallbackArgument(word, at)) {
            continue;
        }

        const argument = args[at];

        if (argument.length !== 1) {
            /*
             * Собранное на ходу имя не угадывается: значение появляется
             * только во время выполнения.
             */
            continue;
        }

        const token = argument[0];

        if (token.kind === "string") {
            const name = literalText(token).trim();

            if (name) {
                result.push({
                    kind: "callback",
                    targetName: name,
                    start: token.start + 1,
                    end: token.end - 1,
                    staticallyResolvable: true
                });
            }

            continue;
        }

        /*
         * Ссылка на процедуру: `Sort(@Compare, ...)`. Сам идентификатор в
         * скобки не заключён, и обычным вызовом его не увидеть.
         */
        if (token.kind === "identifier" && token.value.trim()) {
            result.push({
                kind: "callback",
                targetName: token.value.trim(),
                start: token.start,
                end: token.end,
                staticallyResolvable: true
            });
        }
    }
}

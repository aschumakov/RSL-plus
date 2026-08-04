import type { IRslToken } from "../lexer";

/**
 * Описания параметров, в которых стандартная библиотека RSL принимает
 * процедуру, ссылку @Proc или MethodRef, созданный через R2M.
 *
 * Один каталог используется навигацией и диагностикой параметров обработчика,
 * чтобы поддержка документированных API не расходилась между подсистемами.
 */
export interface IProcedureCallbackSpec {
    /** Нормализованное имя вызываемой процедуры/метода. */
    callName: string;
    /** Номера callback-параметров, начиная с нуля. */
    argumentIndexes: readonly number[];
    /** Для обработчика действует позиционная семантика параметров. */
    positionalHandler: boolean;
}

const CALLBACK_SPECS: readonly IProcedureCallbackSpec[] = [
    { callName: "rundialog", argumentIndexes: [1], positionalHandler: true },
    { callName: "addscroll", argumentIndexes: [4], positionalHandler: true },
    { callName: "runscroll", argumentIndexes: [4], positionalHandler: true },
    { callName: "runmenu", argumentIndexes: [1], positionalHandler: true },
    { callName: "setouthandler", argumentIndexes: [0], positionalHandler: true },
    { callName: "processtrn", argumentIndexes: [1], positionalHandler: true },
    { callName: "sort", argumentIndexes: [0], positionalHandler: true },
    { callName: "settimer", argumentIndexes: [2], positionalHandler: true },
    { callName: "addhandler", argumentIndexes: [1], positionalHandler: true },
    { callName: "sethandler", argumentIndexes: [1], positionalHandler: true },
    { callName: "execmacro", argumentIndexes: [0], positionalHandler: false },
    { callName: "execmacro2", argumentIndexes: [0], positionalHandler: false },
    { callName: "replaceMacro", argumentIndexes: [0, 1], positionalHandler: false }
].map(spec => ({
    ...spec,
    callName: normalizeCallName(spec.callName)
}));

const CALLBACK_BY_NAME = new Map(
    CALLBACK_SPECS.map(spec => [spec.callName, spec] as const)
);

export function getProcedureCallbackSpec(
    callName: string
): IProcedureCallbackSpec | undefined {
    return CALLBACK_BY_NAME.get(normalizeCallName(callName));
}

export function isProcedureCallbackArgument(
    callName: string,
    argumentIndex: number
): boolean {
    return getProcedureCallbackSpec(callName)
        ?.argumentIndexes.includes(argumentIndex) === true;
}

export function isPositionalHandlerArgument(
    callName: string,
    argumentIndex: number
): boolean {
    const spec = getProcedureCallbackSpec(callName);
    return !!spec && spec.positionalHandler &&
        spec.argumentIndexes.includes(argumentIndex);
}

export function callbackNameFromArgument(
    tokens: readonly IRslToken[]
): string | undefined {
    const meaningful = tokens.filter(token =>
        token.kind !== "whitespace" &&
        token.kind !== "newline" &&
        token.kind !== "comment" &&
        token.kind !== "bom"
    );

    if (meaningful.length === 1) {
        const token = meaningful[0];
        if (token.kind === "string" || token.kind === "identifier") {
            return token.value.trim() || undefined;
        }
    }

    if (
        meaningful.length === 2 &&
        meaningful[0].kind === "symbol" &&
        meaningful[0].raw === "@" &&
        meaningful[1].kind === "identifier"
    ) {
        return meaningful[1].value.trim() || undefined;
    }

    /* R2M(object, "Method") / R2M(object, MethodName). */
    if (
        meaningful.length >= 4 &&
        meaningful[0].kind === "identifier" &&
        normalizeCallName(meaningful[0].value) === "r2m" &&
        meaningful[1].kind === "symbol" &&
        meaningful[1].raw === "("
    ) {
        let depth = 0;
        let commaSeen = false;
        for (let index = 1; index < meaningful.length; index++) {
            const token = meaningful[index];
            if (token.kind === "symbol") {
                if (token.raw === "(") depth++;
                else if (token.raw === ")") depth--;
                else if (token.raw === "," && depth === 1) {
                    commaSeen = true;
                    continue;
                }
            }
            if (
                commaSeen &&
                (token.kind === "string" || token.kind === "identifier")
            ) {
                return token.value.trim() || undefined;
            }
        }
    }

    return undefined;
}

function normalizeCallName(value: string): string {
    return (value || "").trim().toLowerCase();
}

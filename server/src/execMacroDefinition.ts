import {
    IRslToken,
    lexRsl,
    significantTokens
} from "./lexer";

export type DynamicDefinitionKind =
    | "macro"
    | "fileMacro"
    | "file";

export interface IDynamicDefinitionTarget {
    kind: DynamicDefinitionKind;
    macroName?: string;
    moduleName?: string;
}

/**
 * Упоминание подключаемого модуля в директиве Import.
 */
export interface IImportDefinitionTarget {
    moduleName: string;
    start: number;
    end: number;
}

interface ICallArgument {
    tokens: IRslToken[];
    stringToken?: IRslToken;
}

interface IParsedCall {
    name: string;
    arguments: ICallArgument[];
    openIndex: number;
    closeIndex: number;
}

const DYNAMIC_CALLS: { [name: string]: boolean } = {
    execmacro: true,
    execmacro2: true,
    execmacrofile: true
};

/**
 * Определяет цель перехода для строковых параметров ExecMacro,
 * ExecMacro2 и ExecMacroFile.
 */
export function GetDynamicDefinitionTarget(
    source: string,
    offset: number
): IDynamicDefinitionTarget | undefined {
    return GetDynamicDefinitionTargetFromTokens(
        lexRsl(source || "").tokens,
        offset
    );
}

/** Использует уже готовый lexer-поток и не сканирует документ повторно. */
export function GetDynamicDefinitionTargetFromTokens(
    sourceTokens: IRslToken[],
    offset: number
): IDynamicDefinitionTarget | undefined {
    const tokens = significantTokens(sourceTokens);
    const calls = findDynamicCalls(tokens);

    /*
     * Для вложенных вызовов сначала проверяем самый узкий диапазон.
     */
    calls.sort((left, right) =>
        (left.closeIndex - left.openIndex) -
        (right.closeIndex - right.openIndex)
    );

    for (const call of calls) {
        const selectedArgument = findSelectedStringArgument(
            call.arguments,
            offset
        );

        if (selectedArgument < 0) {
            continue;
        }

        if (
            call.name === "execmacro" ||
            call.name === "execmacro2"
        ) {
            if (selectedArgument !== 0) {
                continue;
            }

            const macroName = getStringArgument(call.arguments, 0);

            return macroName
                ? {
                    kind: "macro",
                    macroName
                }
                : undefined;
        }

        if (call.name === "execmacrofile") {
            if (selectedArgument !== 0 && selectedArgument !== 1) {
                continue;
            }

            const moduleName = getStringArgument(call.arguments, 0);

            if (!moduleName) {
                return undefined;
            }

            const macroName = getStringArgument(call.arguments, 1);

            return macroName
                ? {
                    kind: "fileMacro",
                    moduleName,
                    macroName
                }
                : {
                    kind: "file",
                    moduleName
                };
        }
    }

    return undefined;
}

/**
 * Определяет модуль Import, на имени которого находится курсор.
 *
 * Поддерживаются:
 *
 *     Import common, utils;
 *     Import "cards.mac";
 *     Import folder\payments;
 */
export function GetImportDefinitionTarget(
    source: string,
    offset: number
): IImportDefinitionTarget | undefined {
    return GetImportDefinitionTargetFromTokens(
        lexRsl(source || "").tokens,
        offset
    );
}

/** Использует уже готовый lexer-поток и не сканирует документ повторно. */
export function GetImportDefinitionTargetFromTokens(
    sourceTokens: IRslToken[],
    offset: number
): IImportDefinitionTarget | undefined {
    return getImportReferencesFromTokens(sourceTokens).find(reference =>
        reference.start <= offset &&
        offset < reference.end
    );
}

/**
 * Возвращает имена файлов из директив Import.
 */

/**
 * Возвращает строковые имена Macro из ExecMacro/ExecMacro2.
 * Используется диагностикой неиспользуемых Import.
 */
export function GetDynamicMacroReferences(source: string): string[] {
    return GetDynamicMacroReferencesFromTokens(
        lexRsl(source || "").tokens
    );
}

export function GetDynamicMacroReferencesFromTokens(
    sourceTokens: IRslToken[]
): string[] {
    const tokens = significantTokens(sourceTokens);
    const result: string[] = [];

    for (const call of findDynamicCalls(tokens)) {
        if (call.name !== "execmacro" && call.name !== "execmacro2") {
            continue;
        }

        const name = getStringArgument(call.arguments, 0);

        if (name) {
            result.push(name);
        }
    }

    return result;
}

export function GetImportDefinitionTargets(
    source: string
): IImportDefinitionTarget[] {
    return GetImportDefinitionTargetsFromTokens(
        lexRsl(source || "").tokens
    );
}

export function GetImportDefinitionTargetsFromTokens(
    sourceTokens: IRslToken[]
): IImportDefinitionTarget[] {
    return getImportReferencesFromTokens(sourceTokens);
}

/**
 * Возвращает имена файлов из директив Import.
 */
export function GetImportedMacroFiles(source: string): string[] {
    return GetImportedMacroFilesFromTokens(
        lexRsl(source || "").tokens
    );
}

export function GetImportedMacroFilesFromTokens(
    sourceTokens: IRslToken[]
): string[] {
    const result: string[] = [];
    const seen = new Set<string>();

    for (const reference of getImportReferencesFromTokens(sourceTokens)) {
        const normalized = reference.moduleName
            .replace(/\\/g, "/")
            .toLowerCase();

        if (seen.has(normalized)) {
            continue;
        }

        seen.add(normalized);
        result.push(reference.moduleName);
    }

    return result;
}

function getImportReferencesFromTokens(
    sourceTokens: IRslToken[]
): IImportDefinitionTarget[] {
    const tokens = sourceTokens.filter(token =>
        token.kind !== "whitespace" &&
        token.kind !== "newline" &&
        token.kind !== "comment" &&
        token.kind !== "square" &&
        token.kind !== "bom"
    );

    const result: IImportDefinitionTarget[] = [];

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (
            token.kind !== "identifier" ||
            token.value.toLowerCase() !== "import"
        ) {
            continue;
        }

        let current: IRslToken[] = [];
        let directiveFinished = false;

        for (let cursor = index + 1; cursor < tokens.length; cursor++) {
            const part = tokens[cursor];

            if (
                part.kind === "symbol" &&
                (part.raw === "," || part.raw === ";")
            ) {
                addImportReference(current, result);
                current = [];

                if (part.raw === ";") {
                    index = cursor;
                    directiveFinished = true;
                    break;
                }

                continue;
            }

            /*
             * В повреждённом коде без ; не захватываем следующую
             * директиву Import как часть имени предыдущего файла.
             */
            if (
                current.length > 0 &&
                part.kind === "identifier" &&
                part.value.toLowerCase() === "import"
            ) {
                addImportReference(current, result);
                index = cursor - 1;
                directiveFinished = true;
                break;
            }

            current.push(part);
        }

        if (!directiveFinished) {
            addImportReference(current, result);
            break;
        }
    }

    return result;
}

function addImportReference(
    tokens: IRslToken[],
    result: IImportDefinitionTarget[]
): void {
    if (tokens.length === 0) {
        return;
    }

    let value: string;

    if (tokens.length === 1 && tokens[0].kind === "string") {
        value = tokens[0].value.trim();
    } else {
        value = tokens.map(token => token.raw).join("").trim();
    }

    if (!value) {
        return;
    }

    if (!/\.mac$/i.test(value)) {
        value += ".mac";
    }

    result.push({
        moduleName: value,
        start: tokens[0].start,
        end: tokens[tokens.length - 1].end
    });
}

function findDynamicCalls(tokens: IRslToken[]): IParsedCall[] {
    const result: IParsedCall[] = [];

    for (let index = 0; index < tokens.length - 1; index++) {
        const nameToken = tokens[index];
        const openToken = tokens[index + 1];

        if (
            nameToken.kind !== "identifier" ||
            openToken.kind !== "symbol" ||
            openToken.raw !== "("
        ) {
            continue;
        }

        const name = nameToken.value.toLowerCase();

        if (!DYNAMIC_CALLS[name]) {
            continue;
        }

        const parsed = parseCallArguments(tokens, index + 1);

        if (!parsed) {
            continue;
        }

        result.push({
            name,
            arguments: parsed.arguments,
            openIndex: openToken.start,
            closeIndex: tokens[parsed.closeIndex].end
        });
    }

    return result;
}

function parseCallArguments(
    tokens: IRslToken[],
    openIndex: number
): { arguments: ICallArgument[]; closeIndex: number } | undefined {
    const result: ICallArgument[] = [];
    let current: IRslToken[] = [];
    let parenthesisDepth = 1;
    let braceDepth = 0;

    for (let index = openIndex + 1; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind === "symbol") {
            if (token.raw === "(") {
                parenthesisDepth++;
                current.push(token);
                continue;
            }

            if (token.raw === ")") {
                parenthesisDepth--;

                if (parenthesisDepth === 0) {
                    if (current.length > 0 || result.length > 0) {
                        result.push(createArgument(current));
                    }

                    return {
                        arguments: result,
                        closeIndex: index
                    };
                }

                current.push(token);
                continue;
            }

            if (token.raw === "{") {
                braceDepth++;
                current.push(token);
                continue;
            }

            if (token.raw === "}" && braceDepth > 0) {
                braceDepth--;
                current.push(token);
                continue;
            }

            if (
                token.raw === "," &&
                parenthesisDepth === 1 &&
                braceDepth === 0
            ) {
                result.push(createArgument(current));
                current = [];
                continue;
            }
        }

        current.push(token);
    }

    return undefined;
}

function createArgument(tokens: IRslToken[]): ICallArgument {
    return {
        tokens,
        stringToken:
            tokens.length === 1 && tokens[0].kind === "string"
                ? tokens[0]
                : undefined
    };
}

function findSelectedStringArgument(
    argumentsList: ICallArgument[],
    offset: number
): number {
    for (let index = 0; index < argumentsList.length; index++) {
        const token = argumentsList[index].stringToken;

        if (
            token &&
            token.start <= offset &&
            offset <= token.end
        ) {
            return index;
        }
    }

    return -1;
}

function getStringArgument(
    argumentsList: ICallArgument[],
    index: number
): string {
    if (
        index < 0 ||
        index >= argumentsList.length ||
        !argumentsList[index].stringToken
    ) {
        return "";
    }

    return argumentsList[index].stringToken!.value.trim();
}

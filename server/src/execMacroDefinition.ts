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
    const tokens = significantTokens(lexRsl(source || "").tokens);
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
 * Возвращает имена файлов из директив Import.
 */
export function GetImportedMacroFiles(source: string): string[] {
    const tokens = lexRsl(source || "").tokens.filter(token =>
        token.kind !== "whitespace" &&
        token.kind !== "newline" &&
        token.kind !== "comment" &&
        token.kind !== "square" &&
        token.kind !== "bom"
    );

    const result: string[] = [];
    const seen = new Set<string>();

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (
            token.kind !== "identifier" ||
            token.value.toLowerCase() !== "import"
        ) {
            continue;
        }

        let current: IRslToken[] = [];

        for (let cursor = index + 1; cursor < tokens.length; cursor++) {
            const part = tokens[cursor];

            if (
                part.kind === "symbol" &&
                (part.raw === "," || part.raw === ";")
            ) {
                addImportName(current, result, seen);
                current = [];

                if (part.raw === ";") {
                    index = cursor;
                    break;
                }

                continue;
            }

            current.push(part);
        }
    }

    return result;
}

function addImportName(
    tokens: IRslToken[],
    result: string[],
    seen: Set<string>
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

    const normalized = value.replace(/\\/g, "/").toLowerCase();

    if (seen.has(normalized)) {
        return;
    }

    seen.add(normalized);
    result.push(value);
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

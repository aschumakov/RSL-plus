import type { IRslToken } from "../lexer";

export interface IClassDeclarationHeader {
    /** Имя объявляемого класса после необязательной секции наследования. */
    nameToken: IRslToken;
    nameIndex: number;
    /** Первый идентификатор в скобках после CLASS — базовый класс. */
    baseClassToken?: IRslToken;
}

/**
 * Разбирает облегчённый заголовок класса RSL:
 *
 *     CLASS ClassName
 *     CLASS (BaseClass) ClassName
 *
 * Функция используется scanner-ами, которым не нужен полный syntax tree.
 * Базовый класс является ссылкой на тип и никогда не возвращается как имя
 * объявления. При незакрытой секции наследования результат не создаётся —
 * лучше пропустить повреждённое объявление, чем опубликовать ложный символ.
 */
export function readClassDeclarationHeader(
    tokens: readonly IRslToken[],
    startIndex: number
): IClassDeclarationHeader | undefined {
    let index = skipTrivia(tokens, startIndex);
    let baseClassToken: IRslToken | undefined;

    if (isSymbol(tokens[index], "(")) {
        const inherited = skipBalancedParentheses(tokens, index);

        if (!inherited) {
            return undefined;
        }

        baseClassToken = inherited.firstIdentifier;
        index = skipTrivia(tokens, inherited.nextIndex);
    }

    const nameToken = tokens[index];

    return nameToken?.kind === "identifier"
        ? {
            nameToken,
            nameIndex: index,
            baseClassToken
        }
        : undefined;
}

function skipBalancedParentheses(
    tokens: readonly IRslToken[],
    openIndex: number
): {
    nextIndex: number;
    firstIdentifier?: IRslToken;
} | undefined {
    let depth = 0;
    let firstIdentifier: IRslToken | undefined;

    for (let index = openIndex; index < tokens.length; index++) {
        const token = tokens[index];

        if (isSymbol(token, "(")) {
            depth++;
            continue;
        }

        if (isSymbol(token, ")")) {
            depth--;

            if (depth === 0) {
                return {
                    nextIndex: index + 1,
                    firstIdentifier
                };
            }

            continue;
        }

        if (depth === 1 && !firstIdentifier && token.kind === "identifier") {
            firstIdentifier = token;
        }

        if (depth === 0 && isStatementBoundary(token)) {
            return undefined;
        }
    }

    return undefined;
}

function skipTrivia(tokens: readonly IRslToken[], startIndex: number): number {
    let index = startIndex;

    while (index < tokens.length && isTrivia(tokens[index])) {
        index++;
    }

    return index;
}

function isTrivia(token: IRslToken | undefined): boolean {
    return !!token && (
        token.kind === "whitespace" ||
        token.kind === "newline" ||
        token.kind === "comment" ||
        token.kind === "bom"
    );
}

function isStatementBoundary(token: IRslToken | undefined): boolean {
    return !!token && token.kind === "symbol" && token.raw === ";";
}

function isSymbol(token: IRslToken | undefined, value: string): boolean {
    return !!token && token.kind === "symbol" && token.raw === value;
}

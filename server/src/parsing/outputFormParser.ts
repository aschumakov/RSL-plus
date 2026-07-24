import type { IRslToken } from "../lexer";

/*
 * Документированные символы: l, r, c, a, t, d, m, w, z, f, i, iv.
 * Остальные ранее поддержанные символы оставлены как совместимые расширения.
 */
const FORMAT_CHARACTERS = /^[ilrcaemzfosvxtdw]+$/i;

export interface IRslFormatSpecifier {
    colon: IRslToken;
    value: IRslToken;
    text: string;
}

export interface IRslOutputArgument {
    start: number;
    end: number;
    tokens: IRslToken[];
    specifiers: IRslFormatSpecifier[];
}

export interface IRslOutputForm {
    form: IRslToken;
    openParen?: IRslToken;
    closeParen?: IRslToken;
    arguments: IRslOutputArgument[];
}

/**
 * Разбирает инструкции вывода поверх общего lexer-потока. Содержимое самой
 * формы остаётся непрозрачным: parser интересуют только форма, фактические
 * параметры и postfix-спецификаторы форматирования.
 */
export function parseOutputForms(
    tokens: readonly IRslToken[]
): IRslOutputForm[] {
    const result: IRslOutputForm[] = [];

    for (let index = 0; index < tokens.length; index++) {
        const form = tokens[index];
        if (form.kind !== "square" || form.squareKind !== "output") {
            continue;
        }

        const openIndex = nextSignificantIndex(tokens, index + 1);
        const open = openIndex >= 0 ? tokens[openIndex] : undefined;

        if (!open || open.kind !== "symbol" || open.raw !== "(") {
            result.push({ form, arguments: [] });
            continue;
        }

        const closeIndex = findMatchingParen(tokens, openIndex);
        const close = closeIndex >= 0 ? tokens[closeIndex] : undefined;
        const bodyEnd = closeIndex >= 0 ? closeIndex : tokens.length;
        const argumentTokenGroups = splitArguments(tokens, openIndex + 1, bodyEnd);

        result.push({
            form,
            openParen: open,
            closeParen: close,
            arguments: argumentTokenGroups
                .filter(group => group.length > 0)
                .map(group => ({
                    start: group[0].start,
                    end: group[group.length - 1].end,
                    tokens: group,
                    specifiers: collectSpecifiers(group)
                }))
        });
    }

    return result;
}

/** Возвращает все значения спецификаторов внутри списков параметров. */
export function collectFormatSpecifierTokens(
    tokens: readonly IRslToken[]
): IRslToken[] {
    const result = new Map<number, IRslToken>();

    /* Инструкции вывода имеют однозначный контекст. */
    for (const form of parseOutputForms(tokens)) {
        for (const argument of form.arguments) {
            for (const specifier of argument.specifiers) {
                result.set(specifier.value.start, specifier.value);
            }
        }
    }

    const declarationRanges = collectDeclarationParameterRanges(tokens);
    let parenthesisDepth = 0;

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (isTrivia(token) || token.kind === "comment" || token.kind === "square") {
            continue;
        }

        if (token.kind === "symbol" && token.raw === "(") {
            parenthesisDepth++;
            continue;
        }

        if (token.kind === "symbol" && token.raw === ")") {
            parenthesisDepth = Math.max(0, parenthesisDepth - 1);
            continue;
        }

        if (
            parenthesisDepth <= 0 ||
            token.kind !== "symbol" ||
            token.raw !== ":" ||
            declarationRanges.some(range =>
                range.start <= token.start && token.end <= range.end
            ) ||
            isInlineDeclarationColon(tokens, index)
        ) {
            continue;
        }

        const valueIndex = nextSignificantIndex(tokens, index + 1);
        if (valueIndex < 0) {
            continue;
        }

        const value = tokens[valueIndex];
        if (isFormatSpecifierValue(value)) {
            result.set(value.start, value);
        }
    }

    return Array.from(result.values()).sort((left, right) =>
        left.start - right.start
    );
}

/** Возвращает start identifier-спецификаторов, чтобы не считать их ссылками. */
export function collectFormatSpecifierTokenStarts(
    tokens: readonly IRslToken[]
): Set<number> {
    return new Set(
        collectFormatSpecifierTokens(tokens)
            .filter(token => token.kind === "identifier")
            .map(token => token.start)
    );
}

export function isFormatSpecifierValue(token: IRslToken): boolean {
    if (token.kind === "number") {
        return /^\d+$/.test(token.raw);
    }

    if (token.kind === "symbol") {
        return token.raw === "*";
    }

    return token.kind === "identifier" && FORMAT_CHARACTERS.test(token.value);
}


function tokenIndexAt(tokens: readonly IRslToken[], offset: number): number {
    let left = 0;
    let right = tokens.length - 1;
    let candidate = -1;
    while (left <= right) {
        const middle = (left + right) >>> 1;
        if (tokens[middle].start <= offset) {
            candidate = middle;
            left = middle + 1;
        } else {
            right = middle - 1;
        }
    }
    if (candidate < 0) {
        return -1;
    }
    return offset <= tokens[candidate].end ? candidate : -1;
}

interface IOffsetRange {
    start: number;
    end: number;
}

function collectDeclarationParameterRanges(
    tokens: readonly IRslToken[]
): IOffsetRange[] {
    const significant = tokens.filter(token =>
        !isTrivia(token) && token.kind !== "comment" && token.kind !== "square"
    );
    const result: IOffsetRange[] = [];

    for (let index = 0; index < significant.length; index++) {
        const keyword = significant[index];
        if (keyword.kind !== "identifier") {
            continue;
        }

        const word = keyword.value.toLowerCase();
        if (word !== "macro" && word !== "class") {
            continue;
        }

        let cursor = index + 1;
        if (
            word === "class" &&
            significant[cursor]?.kind === "symbol" &&
            significant[cursor].raw === "("
        ) {
            cursor = matchingSignificantParen(significant, cursor) + 1;
        }

        if (significant[cursor]?.kind !== "identifier") {
            continue;
        }
        cursor++;

        if (
            significant[cursor]?.kind !== "symbol" ||
            significant[cursor].raw !== "("
        ) {
            continue;
        }

        const close = matchingSignificantParen(significant, cursor);
        if (close > cursor) {
            result.push({
                start: significant[cursor].start,
                end: significant[close].end
            });
        }
    }

    return result;
}

function matchingSignificantParen(
    tokens: readonly IRslToken[],
    openIndex: number
): number {
    let depth = 0;
    for (let index = openIndex; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind !== "symbol") {
            continue;
        }
        if (token.raw === "(") {
            depth++;
        } else if (token.raw === ")") {
            depth--;
            if (depth === 0) {
                return index;
            }
        }
    }
    return openIndex;
}

function isInlineDeclarationColon(
    tokens: readonly IRslToken[],
    colonIndex: number
): boolean {
    let depth = 0;
    for (let index = colonIndex - 1; index >= 0; index--) {
        const token = tokens[index];
        if (isTrivia(token) || token.kind === "comment") {
            continue;
        }
        if (token.kind === "symbol") {
            if (token.raw === ")" || token.raw === "]") {
                depth++;
                continue;
            }
            if (token.raw === "(" || token.raw === "[") {
                if (depth === 0) {
                    return false;
                }
                depth--;
                continue;
            }
            if (depth === 0 && token.raw === ",") {
                return false;
            }
        }
        if (
            depth === 0 &&
            token.kind === "identifier" &&
            (token.value.toLowerCase() === "var" ||
                token.value.toLowerCase() === "const")
        ) {
            return true;
        }
    }
    return false;
}

function collectSpecifiers(tokens: readonly IRslToken[]): IRslFormatSpecifier[] {
    const result: IRslFormatSpecifier[] = [];

    for (let index = 0; index < tokens.length; index++) {
        const colon = tokens[index];
        if (colon.kind !== "symbol" || colon.raw !== ":") {
            continue;
        }

        const valueIndex = nextSignificantIndex(tokens, index + 1);
        if (valueIndex < 0) {
            continue;
        }

        const value = tokens[valueIndex];
        if (!isFormatSpecifierValue(value)) {
            continue;
        }

        result.push({
            colon,
            value,
            text: value.raw
        });
    }

    return result;
}

function splitArguments(
    tokens: readonly IRslToken[],
    start: number,
    end: number
): IRslToken[][] {
    const result: IRslToken[][] = [];
    let current: IRslToken[] = [];
    let parenthesisDepth = 0;
    let bracketDepth = 0;

    for (let index = start; index < end; index++) {
        const token = tokens[index];
        if (isTrivia(token) || token.kind === "comment") {
            continue;
        }

        if (token.kind === "symbol") {
            if (token.raw === "(") {
                parenthesisDepth++;
            } else if (token.raw === ")") {
                parenthesisDepth = Math.max(0, parenthesisDepth - 1);
            } else if (token.raw === "[") {
                bracketDepth++;
            } else if (token.raw === "]") {
                bracketDepth = Math.max(0, bracketDepth - 1);
            } else if (
                token.raw === "," &&
                parenthesisDepth === 0 &&
                bracketDepth === 0
            ) {
                result.push(current);
                current = [];
                continue;
            }
        }

        current.push(token);
    }

    result.push(current);
    return result;
}

function findMatchingParen(
    tokens: readonly IRslToken[],
    openIndex: number
): number {
    let depth = 0;

    for (let index = openIndex; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind !== "symbol") {
            continue;
        }

        if (token.raw === "(") {
            depth++;
        } else if (token.raw === ")") {
            depth--;
            if (depth === 0) {
                return index;
            }
        }
    }

    return -1;
}

function nextSignificantIndex(
    tokens: readonly IRslToken[],
    start: number
): number {
    for (let index = start; index < tokens.length; index++) {
        if (!isTrivia(tokens[index]) && tokens[index].kind !== "comment") {
            return index;
        }
    }

    return -1;
}

function isTrivia(token: IRslToken): boolean {
    return token.kind === "whitespace" ||
        token.kind === "newline" ||
        token.kind === "bom";
}

export function getFormatSpecifierAt(
    tokens: readonly IRslToken[],
    offset: number
): IRslToken | undefined {
    const index = tokenIndexAt(tokens, offset);
    if (index < 0) {
        return undefined;
    }

    const token = tokens[index];
    return collectFormatSpecifierTokens(tokens).some(candidate =>
        candidate.start === token.start && candidate.end === token.end
    )
        ? token
        : undefined;
}

export function describeFormatSpecifier(value: string): string {
    if (/^\d+$/.test(value)) {
        return "Числовой параметр ширины поля или количества знаков после десятичной точки.";
    }
    if (value === "*") {
        return "Значение спецификатора передаётся следующим фактическим параметром.";
    }

    const descriptions: { [name: string]: string } = {
        l: "выравнивание по левому краю",
        r: "выравнивание по правому краю",
        c: "выравнивание по центру",
        a: "разделение разрядов числа апострофами",
        e: "вывод Undefined как пустой строки",
        m: "расширенное форматирование Money, Date или Time",
        z: "не выводить нулевое значение",
        f: "прикладной формат значения",
        o: "заполнение числового поля слева нулями",
        s: "передача ссылки в COM как Short",
        v: "передача ссылки как Variant",
        x: "шестнадцатеричный формат целого числа",
        t: "обрезать значение по ширине поля",
        d: "заменить слишком длинное значение символами *",
        w: "перенести продолжение строки на следующие строки"
    };
    const items = value.toLowerCase().split("")
        .map(item => descriptions[item])
        .filter(item => !!item);
    return items.length > 0
        ? items.join("; ") + "."
        : "Спецификатор форматирования RSL.";
}

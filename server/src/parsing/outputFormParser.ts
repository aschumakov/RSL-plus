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
/** Всё, что даёт разбор инструкций вывода за один проход. */
interface IOutputFormAnalysis {
    forms: IRslOutputForm[];
    /** Значения спецификаторов по возрастанию смещения. */
    specifiers: IRslToken[];
    /** start identifier-спецификаторов: их нельзя считать ссылками. */
    identifierStarts: Set<number>;
}

/*
 * Разбор живёт вместе со своим потоком токенов.
 *
 * Ключ — сам массив токенов: каждый lex возвращает новый, поэтому устаревший
 * ответ отдать невозможно, а память освобождает GC вместе с ним. Спрашивают
 * разбор подсветка, диагностика, Hover и навигация по блокам — все они получают
 * один и тот же результат, посчитанный однажды на версию текста.
 */
const analysisCache = new WeakMap<
    readonly IRslToken[],
    IOutputFormAnalysis
>();

function analyzeOutputForms(
    tokens: readonly IRslToken[]
): IOutputFormAnalysis {
    const known = analysisCache.get(tokens);

    if (known) {
        return known;
    }

    const computed = computeOutputFormAnalysis(tokens);
    analysisCache.set(tokens, computed);
    return computed;
}

export function parseOutputForms(
    tokens: readonly IRslToken[]
): IRslOutputForm[] {
    return analyzeOutputForms(tokens).forms;
}

/** Возвращает все значения спецификаторов внутри списков параметров. */
export function collectFormatSpecifierTokens(
    tokens: readonly IRslToken[]
): IRslToken[] {
    return analyzeOutputForms(tokens).specifiers;
}

/** Возвращает start identifier-спецификаторов, чтобы не считать их ссылками. */
export function collectFormatSpecifierTokenStarts(
    tokens: readonly IRslToken[]
): Set<number> {
    return analyzeOutputForms(tokens).identifierStarts;
}

/**
 * Один проход по потоку токенов вместо трёх.
 *
 * Прежде файл обходился трижды: отдельно искались инструкции вывода, отдельно
 * списки параметров Macro и Class, отдельно двоеточия спецификаторов в скобках.
 * На модуле 700 КБ это была самая долгая непрерывная работа при подготовке
 * подсветки — около 25 мс, — притом что находилось в среднем ноль-два
 * спецификатора.
 *
 * Слить проходы можно потому, что порядок сведений совпадает с порядком текста:
 * список параметров начинается с открывающей скобки, а она стоит раньше любого
 * двоеточия внутри себя. Значит к моменту, когда обход дошёл до двоеточия, все
 * списки, способные его содержать, уже собраны — и проверка «двоеточие внутри
 * объявления» видит ровно то же, что видела при отдельном проходе.
 */
function computeOutputFormAnalysis(
    tokens: readonly IRslToken[]
): IOutputFormAnalysis {
    const forms: IRslOutputForm[] = [];
    const specifiers = new Map<number, IRslToken>();
    const declarationRanges: IOffsetRange[] = [];
    let parenthesisDepth = 0;

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        /*
         * Инструкция вывода — один токен: скобки и двоеточия внутри неё в общий
         * счёт вложенности не идут, поэтому она обрабатывается целиком и обход
         * переходит к следующему токену.
         */
        if (token.kind === "square") {
            if (token.squareKind === "output") {
                const form = readOutputForm(tokens, index);
                forms.push(form);

                /* Внутри инструкции вывода контекст однозначен. */
                for (const argument of form.arguments) {
                    for (const specifier of argument.specifiers) {
                        specifiers.set(specifier.value.start, specifier.value);
                    }
                }
            }

            continue;
        }

        if (isTrivia(token) || token.kind === "comment") {
            continue;
        }

        if (token.kind === "identifier") {
            /*
             * Длина отсеивает идентификатор до приведения к нижнему регистру:
             * интересны здесь ровно два слова, и оба длиной пять символов. На
             * модуле 563 КБ проход стоит 2,4 мс вместо 2,9 мс — приведение
             * каждого идентификатора файла было шестой частью его времени.
             */
            if (token.value.length !== 5) {
                continue;
            }

            const word = token.value.toLowerCase();

            if (word === "macro" || word === "class") {
                const range = readDeclarationParameterRange(
                    tokens,
                    index,
                    word
                );

                if (range) {
                    declarationRanges.push(range);
                }
            }

            continue;
        }

        if (token.kind !== "symbol") {
            continue;
        }

        if (token.raw === "(") {
            parenthesisDepth++;
            continue;
        }

        if (token.raw === ")") {
            parenthesisDepth = Math.max(0, parenthesisDepth - 1);
            continue;
        }

        if (
            parenthesisDepth <= 0 ||
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
            specifiers.set(value.start, value);
        }
    }

    /*
     * Порядок в Map зависит от того, что встретилось раньше, а потребители
     * ожидают возрастание смещения — как и при прежних двух проходах.
     */
    const ordered = Array.from(specifiers.values()).sort((left, right) =>
        left.start - right.start
    );

    return {
        forms,
        specifiers: ordered,
        identifierStarts: new Set(
            ordered
                .filter(token => token.kind === "identifier")
                .map(token => token.start)
        )
    };
}

/** Инструкция вывода со своими фактическими параметрами. */
function readOutputForm(
    tokens: readonly IRslToken[],
    index: number
): IRslOutputForm {
    const form = tokens[index];
    const openIndex = nextSignificantIndex(tokens, index + 1);
    const open = openIndex >= 0 ? tokens[openIndex] : undefined;

    if (!open || open.kind !== "symbol" || open.raw !== "(") {
        return { form, arguments: [] };
    }

    const closeIndex = findMatchingParen(tokens, openIndex);
    const close = closeIndex >= 0 ? tokens[closeIndex] : undefined;
    const bodyEnd = closeIndex >= 0 ? closeIndex : tokens.length;
    const argumentTokenGroups = splitArguments(tokens, openIndex + 1, bodyEnd);

    return {
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
    };
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

/** Следующий значимый токен, начиная с указанного места; -1, если их больше нет. */
function nextDeclarationIndex(
    tokens: readonly IRslToken[],
    from: number
): number {
    for (let index = from; index < tokens.length; index++) {
        const token = tokens[index];

        if (
            !isTrivia(token) &&
            token.kind !== "comment" &&
            token.kind !== "square"
        ) {
            return index;
        }
    }

    return -1;
}

/**
 * Список параметров объявления, начинающегося с этого слова, или undefined.
 *
 * Двоеточие внутри такого списка — это написанный тип параметра, а не
 * спецификатор форматирования.
 *
 * Обход идёт по исходному потоку токенов, а не по его отфильтрованной копии.
 * Копия — это массив на сотню тысяч элементов для одного файла, и на большом
 * модуле сборка мусора после неё стоила дороже самого обхода: подготовка
 * подсветки занимала около 40 мс непрерывной работы, из них четверть — GC.
 */
function readDeclarationParameterRange(
    tokens: readonly IRslToken[],
    keywordIndex: number,
    word: string
): IOffsetRange | undefined {
    let cursor = nextDeclarationIndex(tokens, keywordIndex + 1);

    if (
        word === "class" &&
        cursor >= 0 &&
        tokens[cursor].kind === "symbol" &&
        tokens[cursor].raw === "("
    ) {
        cursor = nextDeclarationIndex(
            tokens,
            matchingSignificantParen(tokens, cursor) + 1
        );
    }

    if (cursor < 0 || tokens[cursor].kind !== "identifier") {
        return undefined;
    }

    const open = nextDeclarationIndex(tokens, cursor + 1);

    if (
        open < 0 ||
        tokens[open].kind !== "symbol" ||
        tokens[open].raw !== "("
    ) {
        return undefined;
    }

    const close = matchingSignificantParen(tokens, open);

    return close > open
        ? { start: tokens[open].start, end: tokens[close].end }
        : undefined;
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

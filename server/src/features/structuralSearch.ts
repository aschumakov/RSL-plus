import {
    cachedSignificantTokens,
    normalizeIdentifier,
    type IRslToken
} from "../lexer";

/**
 * Поиск по структуре кода, а не по тексту.
 *
 * Регулярное выражение по коду хрупко: перенос строки, лишний пробел, вложенный
 * вызов в аргументе — и шаблон уже не совпадает. Здесь шаблон описывает форму
 * вызова, а совпадение ищется по токенам.
 *
 * Образец пишется как обычный вызов с заполнителями:
 *
 *   ExecMacroFile($file, $args...)
 *
 * `$имя` — ровно один аргумент, каким бы длинным он ни был; `$имя...` — все
 * оставшиеся, в том числе ни одного. Всё остальное в образце обязано совпасть
 * буквально, с точностью до регистра имён — RSL сравнивает их без регистра.
 *
 * Запускается только явной командой. Ни по правке, ни по открытию файла ничего
 * не ищется: обход проекта — работа не на один десяток миллисекунд.
 */
export interface IRslStructuralPattern {
    /** Имя вызываемого, как написано в образце. */
    callName: string;
    /** Аргументы образца по порядку. */
    arguments: IRslPatternArgument[];
}

export interface IRslPatternArgument {
    /** Заполнитель: имя без `$`; пусто у буквального аргумента. */
    placeholder?: string;
    /** Заполнитель забирает все оставшиеся аргументы. */
    rest?: boolean;
    /** Буквальные токены, которые обязаны совпасть. */
    tokens?: IRslToken[];
}

export interface IRslStructuralMatch {
    /** Границы всего вызова в тексте. */
    start: number;
    end: number;
    /** Что попало в заполнители: имя -> текст аргумента. */
    bindings: Record<string, string>;
}

export interface IRslPatternResult {
    pattern?: IRslStructuralPattern;
    /** Почему образец не разобран; пусто, если всё в порядке. */
    problem?: string;
}

/** Разбирает образец. Своего лексирования тут ровно один вызов — на образец. */
export function parseRslStructuralPattern(
    text: string,
    lex: (source: string) => readonly IRslToken[]
): IRslPatternResult {
    const tokens = significant(lex(text || ""));

    if (tokens.length === 0) {
        return { problem: "Образец пуст" };
    }

    const name = tokens[0];

    if (name.kind !== "identifier") {
        return { problem: "Образец обязан начинаться с имени вызова" };
    }

    const open = tokens[1];

    if (!open || open.kind !== "symbol" || open.raw !== "(") {
        return { problem: "После имени ожидается открывающая скобка" };
    }

    const groups = splitArguments(tokens, 1);

    if (!groups) {
        return { problem: "Скобка не закрыта" };
    }

    const args: IRslPatternArgument[] = [];

    for (let at = 0; at < groups.length; at++) {
        const group = groups[at].tokens;

        if (group.length === 0) {
            /* Пустой список аргументов: `Foo()`. */
            if (groups.length === 1) {
                continue;
            }

            return { problem: "Пустой аргумент в образце" };
        }

        const placeholder = placeholderOf(group);


        if (!placeholder) {
            args.push({ tokens: group });
            continue;
        }

        if (placeholder.rest && at !== groups.length - 1) {
            return {
                problem: "Заполнитель с многоточием обязан быть последним"
            };
        }

        args.push(placeholder);
    }

    return {
        pattern: {
            callName: name.value,
            arguments: args
        }
    };
}

/** Совпадения образца в одном файле. */
export function findRslStructuralMatches(
    pattern: IRslStructuralPattern,
    source: string,
    sourceTokens: readonly IRslToken[],
    isCancelled: () => boolean = () => false
): IRslStructuralMatch[] {
    const tokens = significant(sourceTokens);
    const wanted = normalizeIdentifier(pattern.callName);
    const result: IRslStructuralMatch[] = [];

    for (let index = 0; index < tokens.length; index++) {
        if (isCancelled()) {
            return result;
        }

        const token = tokens[index];

        if (
            token.kind !== "identifier" ||
            normalizeIdentifier(token.value) !== wanted
        ) {
            continue;
        }

        const open = tokens[index + 1];

        if (!open || open.kind !== "symbol" || open.raw !== "(") {
            continue;
        }

        const groups = splitArguments(tokens, index + 1);

        if (!groups) {
            continue;
        }

        const bindings = matchArguments(pattern.arguments, groups, source);

        if (!bindings) {
            continue;
        }

        const last = closingToken(tokens, index + 1);

        result.push({
            start: token.start,
            end: last ? last.end : token.end,
            bindings
        });
    }

    return result;
}

/** Сопоставление списков аргументов; undefined — не совпало. */
function matchArguments(
    expected: readonly IRslPatternArgument[],
    actual: readonly IRslArgumentGroup[],
    source: string
): Record<string, string> | undefined {
    const bindings: Record<string, string> = {};
    const groups = actual.length === 1 && actual[0].tokens.length === 0
        ? []
        : actual;

    for (let at = 0; at < expected.length; at++) {
        const item = expected[at];

        if (item.rest) {
            const rest = groups.slice(at);

            /*
             * Остаток берётся ОДНИМ участком — от начала первого
             * аргумента до конца последнего. Склейка через «, » потеряла
             * бы то, что стоит между аргументами: комментарии, переносы
             * строк и выравнивание.
             */
            bindings[item.placeholder || "rest"] = rest.length === 0
                ? ""
                : source
                    .slice(rest[0].start, rest[rest.length - 1].end)
                    .trim();

            return bindings;
        }

        const group = groups[at];

        if (!group) {
            return undefined;
        }

        if (item.placeholder) {
            bindings[item.placeholder] = textOf(group, source);
            continue;
        }

        if (!sameTokens(item.tokens || [], group.tokens)) {
            return undefined;
        }
    }

    return groups.length === expected.length ? bindings : undefined;
}

/**
 * Заполнитель, если группа — это ровно `$имя` или `$имя...`.
 *
 * Вид токена не проверяется: лексер RSL видит `$file` одним токеном и считает
 * его числом — доллар в языке начинает литерал. Для образца это неважно, важен
 * сам написанный текст.
 */
function placeholderOf(
    group: readonly IRslToken[]
): IRslPatternArgument | undefined {
    if (group.length !== 1) {
        return undefined;
    }

    const raw = group[0].raw;

    if (!raw.startsWith("$") || raw.length < 2) {
        return undefined;
    }

    const rest = raw.endsWith("...");
    const name = rest ? raw.slice(1, -3) : raw.slice(1);

    return name ? { placeholder: name, rest } : undefined;
}

function sameTokens(
    expected: readonly IRslToken[],
    actual: readonly IRslToken[]
): boolean {
    if (expected.length !== actual.length) {
        return false;
    }

    return expected.every((token, at) => {
        const other = actual[at];

        if (token.kind !== other.kind) {
            return false;
        }

        return token.kind === "identifier"
            ? normalizeIdentifier(token.value) === normalizeIdentifier(other.value)
            : token.raw === other.raw;
    });
}

/**
 * Написанный текст аргумента.
 *
 * Именно написанный, а не «от первого значимого токена до последнего»:
 * комментарий внутри аргумента значимым не считается, и такой срез
 * выбрасывал бы его молча. Обрамляющие пробелы снимаются — они
 * принадлежат не аргументу, а его расположению в строке.
 */
function textOf(group: IRslArgumentGroup, source: string): string {
    return source.slice(group.start, group.end).trim();
}

/**
 * Аргументы верхнего уровня: вложенные скобки их не разделяют.
 *
 * Кроме токенов группа помнит НАПИСАННЫЙ участок — от разделителя до
 * разделителя. Он нужен замене: комментарий внутри аргумента значимым
 * токеном не считается, и текст «от первого до последнего значимого»
 * молча выбрасывал бы его.
 */
interface IRslArgumentGroup {
    tokens: IRslToken[];
    /** Границы написанного участка между разделителями. */
    start: number;
    end: number;
}

function splitArguments(
    tokens: readonly IRslToken[],
    openIndex: number
): IRslArgumentGroup[] | undefined {
    const result: IRslArgumentGroup[] = [];
    let current: IRslToken[] = [];
    let from = tokens[openIndex] ? tokens[openIndex].end : 0;
    let depth = 0;

    for (let index = openIndex; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind === "symbol") {
            if (token.raw === "(" || token.raw === "[" || token.raw === "{") {
                depth++;

                if (depth === 1) {
                    from = token.end;
                    continue;
                }
            } else if (
                token.raw === ")" || token.raw === "]" || token.raw === "}"
            ) {
                depth--;

                if (depth === 0) {
                    result.push({
                        tokens: current,
                        start: from,
                        end: token.start
                    });

                    return result;
                }
            } else if (token.raw === "," && depth === 1) {
                result.push({
                    tokens: current,
                    start: from,
                    end: token.start
                });
                current = [];
                from = token.end;
                continue;
            } else if (token.raw === ";") {
                return undefined;
            }
        }

        if (depth >= 1) {
            current.push(token);
        }
    }

    return undefined;
}

function closingToken(
    tokens: readonly IRslToken[],
    openIndex: number
): IRslToken | undefined {
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
                return token;
            }
        }
    }

    return undefined;
}

function significant(tokens: readonly IRslToken[]): IRslToken[] {
    return cachedSignificantTokens(tokens as IRslToken[]);
}

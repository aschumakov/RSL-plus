import { lexRsl, type IRslLexResult, type IRslToken } from "../lexer";
import {
    parseRslSyntax,
    type IRslParseResult,
    type IRslSyntaxDiagnostic,
    type IRslSyntaxNode
} from "../syntaxParser";

/**
 * Инкрементальный разбор: переразбирается одна изменённая единица.
 *
 * Файл RSL — последовательность самостоятельных единиц верхнего уровня:
 * `Import`, `Macro`, `Class`, объявления модуля. Правка внутри тела процедуры
 * меняет ровно одну из них, остальные остаются те же: их поддеревья берутся
 * готовыми, и поправить нужно только смещения.
 *
 * Замер на файле 651 КБ: полный разбор 42 мс, разбор одной единицы 0,1 мс.
 * Остальное время точечного пути уходит на сдвиг хвоста — это цена того, что
 * смещения в дереве абсолютные.
 *
 * Путь сознательно узкий. Он берётся только когда:
 *
 *   • правка задела ровно одну единицу верхнего уровня — Macro или Class;
 *   • правка лежит строго внутри неё, не задевая границ;
 *   • единица переразобралась в одну единицу того же вида и тех же границ;
 *   • `Import` не задет: он меняет публичную поверхность и замыкание;
 *   • в единице не появилось незакрытого блока — иначе в полном разборе она
 *     поглотила бы следующие единицы.
 *
 * Любое сомнение возвращает undefined, и вызывающий делает полный разбор:
 * неверное дерево недопустимо, а не ускориться — можно.
 */

/**
 * Ошибки разбора, при которых границы единицы перестают быть надёжными.
 *
 * Пропущенная точка с запятой такой ошибкой не является: она встречается при
 * наборе постоянно и деления файла на единицы не меняет.
 */
const BOUNDARY_CODES: ReadonlySet<string> = new Set([
    "missing-end",
    "extra-end",
    "unterminated-string",
    "unterminated-comment",
    "unterminated-square",
    "missing-opening-parenthesis",
    "missing-closing-parenthesis"
]);

/** Ниже этого размера полный разбор и так дешевле любых проверок. */
export const INCREMENTAL_PARSE_MIN_CHARS = 50_000;

export interface IRslIncrementalParseDecision {
    reason:
        | "incremental"
        | "unchanged"
        | "smallFile"
        | "unsplittableEdit"
        | "noUnit"
        | "multipleUnits"
        | "unsupportedUnit"
        | "importTouched"
        | "unitBoundary"
        | "brokenBlock"
        /** Токен узла не нашёлся в новом потоке. */
        | "tokenMiss";
    editStart?: number;
    /** Разбор самой единицы. */
    unitParseMs?: number;
    /** Сдвиг смещений неизменившегося хвоста. */
    shiftMs?: number;
    unitKind?: string;
    unitName?: string;
    unitChars?: number;
}

/** Сдвиг смещений и строк для неизменившегося хвоста файла. */
export interface IRslParseShift {
    /** Смещение, начиная с которого хвост сдвинулся. */
    from: number;
    /** Насколько сдвинулся хвост по символам. */
    offsetDelta: number;
    /** Насколько сдвинулся хвост по строкам. */
    lineDelta: number;
}

/** Что именно переразобрано: нужно инкрементальной модели. */
export interface IRslParseSplice {
    unitIndex: number;
    unit: IRslSyntaxNode;
    previousUnitStart: number;
    previousUnitEnd: number;
    shift: IRslParseShift;
}

export interface IRslIncrementalParse {
    parse: IRslParseResult;
    splice: IRslParseSplice;
}

export function tryIncrementalRslParse(
    previousText: string,
    previousParse: IRslParseResult,
    nextText: string,
    nextLex: IRslLexResult,
    onDecision?: (decision: IRslIncrementalParseDecision) => void
): IRslIncrementalParse | undefined {
    const decide = (
        reason: IRslIncrementalParseDecision["reason"],
        fields?: Partial<IRslIncrementalParseDecision>
    ): undefined => {
        onDecision?.({ reason, ...fields });

        return undefined;
    };

    if (previousText === nextText) {
        return decide("unchanged");
    }

    if (previousText.length < INCREMENTAL_PARSE_MIN_CHARS) {
        return decide("smallFile");
    }

    const edit = editRange(previousText, nextText);

    if (!edit) {
        return decide("unsplittableEdit");
    }

    const units = previousParse.root.children;
    let unitIndex = -1;

    for (let index = 0; index < units.length; index++) {
        const unit = units[index];

        if (unit.end >= edit.oldStart && unit.start <= edit.oldEnd) {
            if (unitIndex >= 0) {
                return decide("multipleUnits", { editStart: edit.oldStart });
            }

            unitIndex = index;
        }
    }

    if (unitIndex < 0) {
        return decide("noUnit", { editStart: edit.oldStart });
    }

    const unit = units[unitIndex];

    if (
        unit.kind !== "MacroDeclaration" &&
        unit.kind !== "ClassDeclaration"
    ) {
        return decide("unsupportedUnit", {
            editStart: edit.oldStart,
            unitKind: unit.kind
        });
    }

    /*
     * Правка обязана лежать строго внутри единицы.
     *
     * Задетая граница означает, что могло измениться само деление файла:
     * дописанное `End;` закрывает процедуру раньше, стёртое — позже.
     */
    if (edit.oldStart <= unit.start || edit.oldEnd >= unit.end) {
        return decide("unitBoundary", {
            editStart: edit.oldStart,
            unitKind: unit.kind,
            unitName: unit.name
        });
    }

    const unitStart = unit.start;
    const unitEnd = unit.end + edit.delta;
    const unitTokens = tokensInRange(nextLex.tokens, unitStart, unitEnd);

    if (unitTokens.length === 0) {
        return decide("unitBoundary", { editStart: edit.oldStart });
    }

    const unitParseStarted = process.hrtime.bigint();
    const reparsed = parseRslSyntax(
        nextText,
        { ...nextLex, tokens: unitTokens },
        { buildExpressionTree: false }
    );
    const unitParseMs =
        Number(process.hrtime.bigint() - unitParseStarted) / 1e6;
    const replacement = reparsed.root.children;

    /*
     * Единица обязана остаться одной единицей того же вида и занять ровно тот
     * же участок текста.
     */
    if (
        replacement.length !== 1 ||
        replacement[0].kind !== unit.kind ||
        replacement[0].start !== unitStart ||
        replacement[0].end !== unitEnd
    ) {
        return decide("unitBoundary", {
            editStart: edit.oldStart,
            unitKind: unit.kind,
            unitName: unit.name,
            unitChars: unitEnd - unitStart
        });
    }

    /*
     * Незакрытый блок делает границы недостоверными: в полном разборе
     * процедура без `End;` поглощает остаток файла, а срез этого не видит.
     */
    if (reparsed.diagnostics.some(item => BOUNDARY_CODES.has(item.code))) {
        return decide("brokenBlock", {
            editStart: edit.oldStart,
            unitKind: unit.kind,
            unitName: unit.name
        });
    }

    const shiftStarted = process.hrtime.bigint();
    const shift: IRslParseShift = {
        from: unit.end,
        offsetDelta: edit.delta,
        lineDelta: countLines(nextText, unitStart, unitEnd) -
            countLines(previousText, unit.start, unit.end)
    };
    const children: IRslSyntaxNode[] = new Array(units.length);
    const cursor = createTokenCursor(nextLex.tokens);
    const miss = { happened: false };

    for (let index = 0; index < units.length; index++) {
        if (index < unitIndex) {
            children[index] = units[index];
            continue;
        }

        if (index === unitIndex) {
            children[index] = replacement[0];
            continue;
        }

        children[index] = shiftNode(units[index], shift, cursor, miss);
    }

    const shiftMs = Number(process.hrtime.bigint() - shiftStarted) / 1e6;

    if (miss.happened) {
        return decide("tokenMiss", {
            editStart: edit.oldStart,
            unitKind: unit.kind,
            unitName: unit.name
        });
    }

    onDecision?.({
        reason: "incremental",
        editStart: edit.oldStart,
        unitKind: unit.kind,
        unitName: unit.name,
        unitChars: unitEnd - unitStart,
        unitParseMs,
        shiftMs
    });

    const parse = withLazyTokens({
        root: {
            ...previousParse.root,
            end: nextText.length,
            children,
            tokens: []
        },
        diagnostics: spliceDiagnostics(
            previousParse.diagnostics,
            reparsed.diagnostics,
            unit,
            shift
        ),
        lex: nextLex
    });

    return {
        parse,
        splice: {
            unitIndex,
            unit: replacement[0],
            previousUnitStart: unit.start,
            previousUnitEnd: unit.end,
            shift
        }
    };
}

/**
 * Список значащих токенов считается при первом обращении.
 *
 * Отбор из всего потока стоит 9 мс на 651 КБ, а нужен он не разбору, а
 * проверкам: считать его в фазе разбора значит занимать основной поток зря.
 * Свойство ведёт себя как обычный массив — потребители ничего не замечают.
 */
function withLazyTokens(
    parse: Omit<IRslParseResult, "tokens">
): IRslParseResult {
    let cached: IRslToken[] | undefined;

    return Object.defineProperty(parse as IRslParseResult, "tokens", {
        configurable: true,
        enumerable: true,
        get() {
            if (!cached) {
                cached = significantTokens(parse.lex.tokens);
            }

            return cached;
        }
    });
}

/** Границы правки: общий префикс и общий суффикс. */
function editRange(
    previousText: string,
    nextText: string
): { oldStart: number; oldEnd: number; delta: number } | undefined {
    let prefix = 0;
    const shortest = Math.min(previousText.length, nextText.length);

    while (
        prefix < shortest &&
        previousText.charCodeAt(prefix) === nextText.charCodeAt(prefix)
    ) {
        prefix++;
    }

    let suffix = 0;

    while (
        suffix < shortest - prefix &&
        previousText.charCodeAt(previousText.length - 1 - suffix) ===
            nextText.charCodeAt(nextText.length - 1 - suffix)
    ) {
        suffix++;
    }

    const oldStart = prefix;
    const oldEnd = previousText.length - suffix;

    if (oldEnd < oldStart) {
        return undefined;
    }

    return {
        oldStart,
        oldEnd,
        delta: nextText.length - previousText.length
    };
}

function tokensInRange(
    tokens: readonly IRslToken[],
    start: number,
    end: number
): IRslToken[] {
    const result: IRslToken[] = [];
    let index = lowerBound(tokens, start);

    for (; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.start >= end) {
            break;
        }

        if (token.start >= start && token.end <= end) {
            result.push(token);
        }
    }

    return result;
}

/** Первый токен, который начинается не раньше offset. */
function lowerBound(tokens: readonly IRslToken[], offset: number): number {
    let low = 0;
    let high = tokens.length;

    while (low < high) {
        const middle = (low + high) >> 1;

        if (tokens[middle].start < offset) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    return low;
}

/**
 * Курсор по новому потоку токенов.
 *
 * Узлы обходятся по порядку документа, поэтому почти всегда достаточно двигать
 * один указатель вперёд: двоичный поиск на каждый токен стоил заметную часть
 * сдвига, а токенов в хвосте сотни тысяч.
 *
 * Почти — потому что токены узла идут не строго после токенов его детей:
 * закрывающий End; родителя лежит за ними, а следующий узел начинается раньше
 * него. На таком шаге указатель возвращается двоичным поиском.
 */
function createTokenCursor(
    tokens: readonly IRslToken[]
): (start: number, kind: string) => IRslToken | undefined {
    let position = 0;

    return (start, kind) => {
        if (position >= tokens.length || tokens[position].start > start) {
            position = lowerBound(tokens, start);
        }

        while (position < tokens.length && tokens[position].start < start) {
            position++;
        }

        const found = tokens[position];

        return found && found.start === start && found.kind === kind
            ? found
            : undefined;
    };
}

/**
 * Копия узла со сдвинутыми смещениями.
 *
 * Копия, а не правка на месте: прежнее дерево может держаться чьим-то кэшем, и
 * менять его смещения нельзя.
 */
function shiftNode(
    node: IRslSyntaxNode,
    shift: IRslParseShift,
    cursor: (start: number, kind: string) => IRslToken | undefined,
    miss: { happened: boolean }
): IRslSyntaxNode {
    const children = node.children.length > 0
        ? node.children.map(child => shiftNode(child, shift, cursor, miss))
        : node.children;
    const shifted: IRslSyntaxNode = {
        ...node,
        start: node.start + shift.offsetDelta,
        end: node.end + shift.offsetDelta,
        children,
        tokens: node.tokens.length > 0
            ? retargetTokens(node.tokens, shift.offsetDelta, cursor, miss)
            : node.tokens
    };

    if (typeof node.parameterListStart === "number") {
        shifted.parameterListStart = node.parameterListStart +
            shift.offsetDelta;
    }

    if (typeof node.parameterListEnd === "number") {
        shifted.parameterListEnd = node.parameterListEnd + shift.offsetDelta;
    }

    if (typeof node.valueStart === "number") {
        shifted.valueStart = node.valueStart + shift.offsetDelta;
    }

    if (typeof node.valueEnd === "number") {
        shifted.valueEnd = node.valueEnd + shift.offsetDelta;
    }

    return shifted;
}

/**
 * Токены узла берутся из нового потока.
 *
 * Объекты токенов после правки другие: инкрементальный lexer создаёт для
 * хвоста сдвинутые копии. Держать в узле прежние значило бы хранить неверные
 * смещения и номера строк.
 */
function retargetTokens(
    previous: readonly IRslToken[],
    offsetDelta: number,
    cursor: (start: number, kind: string) => IRslToken | undefined,
    miss: { happened: boolean }
): IRslToken[] {
    const result: IRslToken[] = new Array(previous.length);

    for (let index = 0; index < previous.length; index++) {
        const token = previous[index];
        const found = cursor(token.start + offsetDelta, token.kind);

        if (!found) {
            /*
             * Токен не нашёлся в новом потоке. Оставить прежний нельзя: у него
             * смещения прошлой версии, и узел станет тихо неверным. Правильный
             * ответ — отказаться от точечного пути.
             */
            miss.happened = true;
            result[index] = token;
            continue;
        }

        result[index] = found;
    }

    return result;
}

function spliceDiagnostics(
    previous: readonly IRslSyntaxDiagnostic[],
    replacement: readonly IRslSyntaxDiagnostic[],
    unit: IRslSyntaxNode,
    shift: IRslParseShift
): IRslSyntaxDiagnostic[] {
    const result: IRslSyntaxDiagnostic[] = [];

    for (const diagnostic of previous) {
        if (diagnostic.start >= unit.start && diagnostic.end <= unit.end) {
            /* Диагностики самой единицы приходят из нового разбора. */
            continue;
        }

        result.push(diagnostic.start >= unit.end
            ? {
                ...diagnostic,
                start: diagnostic.start + shift.offsetDelta,
                end: diagnostic.end + shift.offsetDelta
            }
            : diagnostic);
    }

    result.push(...replacement);
    result.sort((left, right) => left.start - right.start);

    return result;
}

/** Токены, участвующие в разборе: как их отбирает parseRslSyntax. */
function significantTokens(tokens: readonly IRslToken[]): IRslToken[] {
    const result: IRslToken[] = [];

    for (const token of tokens) {
        if (
            token.kind !== "whitespace" &&
            token.kind !== "newline" &&
            token.kind !== "comment" &&
            token.kind !== "bom"
        ) {
            result.push(token);
        }
    }

    return result;
}

function countLines(text: string, start: number, end: number): number {
    let lines = 0;

    for (let index = start; index < end; index++) {
        if (text.charCodeAt(index) === 10) {
            lines++;
        }
    }

    return lines;
}

/** Полный разбор для сравнения: нужен дифференциальной проверке. */
export function fullRslParse(text: string): IRslParseResult {
    return parseRslSyntax(
        text,
        lexRsl(text, { includeTrivia: true }),
        { buildExpressionTree: false }
    );
}

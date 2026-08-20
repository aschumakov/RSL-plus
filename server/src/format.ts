import {
    BLOCK_START_KEYWORDS,
    BRANCH_KEYWORDS,
    DECLARATION_KEYWORDS,
    DECLARATION_MODIFIERS,
    END_KEYWORD,
    isDeclarationModifier
} from "./language/rslLanguageReference";

import {
    IRslToken,
    lexRsl
} from "./lexer";

export const FORMATTER_REVISION = "spacing-v2";

/**
 * Объявление, перенесённое запятой на следующую строку.
 *
 * Состав модификаторов и ключевых слов берётся из справочника языка, чтобы
 * список не расходился с parser-ом: раньше здесь стоял свой перечень, в
 * который входил PUBLIC — слово, которого в языке нет.
 */
const CONTINUED_DECLARATION_PATTERN = new RegExp(
    `^(\\s*(?:(?:${DECLARATION_MODIFIERS.join("|")})\\s+)?` +
        `(?:${DECLARATION_KEYWORDS.filter(keyword =>
            keyword !== "macro" && keyword !== "class" && keyword !== "file"
        ).join("|")})\\s+)` +
        "([@A-Za-zА-Яа-яЁё_][@A-Za-zА-Яа-яЁё0-9_]*).*?,\\s*$",
    "i"
);

interface IContinuationContext {
    kind: "declaration" | "assignment";
    indentColumn: number;
}

interface IAssignmentAlignment {
    lineIndex: number;
    indentColumn: number;
    lhsEndColumn: number;
    operatorColumn: number;
}

/**
 * Безопасный форматтер RSL.
 *
 * Форматтер использует общий lexer и никогда не меняет содержимое строк,
 * комментариев и квадратных SQL/текстовых блоков. Также сохраняются BOM,
 * исходный тип перевода строк и наличие финального EOL.
 */
export interface IRslFormatOptions {
    /**
     * Отступ пробелами; false — табуляциями.
     *
     * Настройка редактора, и раньше она игнорировалась: файл с табуляциями
     * после форматирования оказывался с пробелами. Выравнивание присваиваний
     * при этом остаётся пробельным — оно считается по колонкам, и табуляция
     * шириной в настройку редактора его бы разъехала.
     */
    insertSpaces?: boolean;
}

export function FormatCode(
    text: string,
    tabSize: number = 4,
    options: IRslFormatOptions = {}
): string {
    const indentText = (level: number): string => options.insertSpaces === false
        ? "\t".repeat(Math.max(0, level))
        : " ".repeat(Math.max(0, level * tabSize));
    const source = text || "";
    const lex = lexRsl(source);
    const bom = lex.hasBom ? "\uFEFF" : "";
    const body = lex.hasBom ? source.substring(1) : source;
    const bodyOffset = lex.hasBom ? 1 : 0;
    const lines = body.split(/\r\n|\n|\r/);
    const lineStarts = buildLineStarts(body, lex.eol);
    const formatted: string[] = [];
    /* Выравнивание присваиваний собирается по ходу, без второго прохода. */
    const alignments: IAssignmentAlignment[] = [];
    const parenthesisStack: number[] = [];
    const lineTokenCursor = new LineTokenCursor(lex.tokens);
    let continuation: IContinuationContext | undefined;
    let indentLevel = 0;

    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
        const originalLine = lines[lineNumber];
        const absoluteLineStart = bodyOffset + lineStarts[lineNumber];
        const lineTokenData = lineTokenCursor.get(
            lineNumber,
            absoluteLineStart,
            originalLine.length
        );

        if (lineTokenData.protectedToken) {
            /*
             * Многострочный SQL/текст или комментарий сохраняется байт-в-байт
             * внутри строки. Он не влияет на RSL nesting/parentheses.
             */
            formatted.push(originalLine);
            continue;
        }

        if (originalLine.trim().length === 0) {
            formatted.push("");
            continue;
        }

        const lineTokens = lineTokenData.tokens;
        const normalizedLine = normalizeLineSafely(
            originalLine,
            absoluteLineStart,
            lineTokens
        );
        const structure = analyzeStructure(lineTokens);
        const isBranch = structure.firstKeyword !== undefined &&
            BRANCH_KEYWORDS.indexOf(structure.firstKeyword) >= 0;
        const startsWithEnd = structure.firstKeyword === END_KEYWORD;
        const startsTopLevelOnError =
            structure.firstKeyword === "onerror" &&
            indentLevel === 0;
        const lineIndentLevel = isBranch || startsWithEnd
            ? Math.max(indentLevel - 1, 0)
            : indentLevel;

        let indentLevelForLine = lineIndentLevel;
        let indentColumn = lineIndentLevel * tabSize;

        if (parenthesisStack.length > 0) {
            const lastOpen = parenthesisStack[parenthesisStack.length - 1];
            indentColumn = Math.max(
                indentColumn,
                normalizedLine.startsWith(")")
                    ? lastOpen
                    : lastOpen + 1
            );
        } else if (continuation) {
            indentColumn = Math.max(
                indentColumn,
                continuation.indentColumn
            );
        }

        formatted.push(
            (indentColumn === indentLevelForLine * tabSize
                ? indentText(indentLevelForLine)
                : " ".repeat(indentColumn)) + normalizedLine
        );

        /*
         * Строка лексируется один раз и БЕЗ отступа.
         *
         * Прежде каждая из этих функций лексировала отформатированную строку
         * сама — до четырёх проходов на строку, и каждый вместе с отступом. На
         * глубокой вложенности отступ и составляет почти всю строку, поэтому
         * форматирование росло квадратично: на 400 уровнях 540 мс.
         *
         * Колонки внутри строки считаются от её содержимого, поэтому наружу
         * они отдаются со сдвигом на indentColumn.
         */
        const { code: lineCode, tokens: codeTokens } =
            splitLineCode(normalizedLine);

        updateParenthesisStack(codeTokens, indentColumn, parenthesisStack);
        continuation = getNextContinuationContext(
            lineCode,
            codeTokens,
            indentColumn,
            continuation
        );

        const assignment = getAssignmentAlignment(
            lineCode,
            codeTokens,
            indentColumn,
            formatted.length - 1
        );

        if (assignment) {
            alignments.push(assignment);
        }

        indentLevel = Math.max(
            0,
            indentLevel +
                structure.blockStarts -
                structure.blockEnds +
                (startsTopLevelOnError ? 1 : 0)
        );
    }

    alignConsecutiveAssignments(formatted, alignments);
    return bom + formatted.join(lex.eol);
}

function alignConsecutiveAssignments(
    lines: string[],
    alignments: readonly IAssignmentAlignment[]
): void {
    let group: IAssignmentAlignment[] = [];

    const flushGroup = (): void => {
        if (group.length < 2) {
            group = [];
            return;
        }

        /*
         * Максимум считается циклом, а не через spread.
         *
         * `Math.max(...group.map(...))` передаёт по аргументу на строку, и на
         * длинной череде присваиваний это выходит за предел числа аргументов:
         * форматирование файла со 125 тысячами присваиваний падало с
         * RangeError. Группа ничем не ограничена, поэтому предел достижим.
         */
        let widestLhs = 0;

        for (const item of group) {
            if (item.lhsEndColumn > widestLhs) {
                widestLhs = item.lhsEndColumn;
            }
        }

        const targetOperatorColumn = widestLhs + 1;

        for (const item of group) {
            const line = lines[item.lineIndex];
            lines[item.lineIndex] =
                line.substring(0, item.lhsEndColumn) +
                " ".repeat(targetOperatorColumn - item.lhsEndColumn) +
                line.substring(item.operatorColumn);
        }

        group = [];
    };

    /*
     * Группа — подряд идущие присваивания с одинаковым отступом. Раньше цикл
     * шёл по всем строкам и лексировал каждую заново; теперь по уже собранным
     * присваиваниям, а разрыв в номерах строк и есть конец группы.
     */
    let previousLine = -2;

    for (const assignment of alignments) {
        if (
            assignment.lineIndex !== previousLine + 1 ||
            (group.length > 0 &&
                assignment.indentColumn !== group[0].indentColumn)
        ) {
            flushGroup();
        }

        group.push(assignment);
        previousLine = assignment.lineIndex;
    }

    flushGroup();
}

function getAssignmentAlignment(
    code: string,
    tokens: readonly IRslToken[],
    indentColumn: number,
    lineIndex: number
): IAssignmentAlignment | undefined {
    const operatorIndex = findSimpleAssignmentOperator(tokens);

    if (operatorIndex === undefined) {
        return undefined;
    }

    const operator = tokens[operatorIndex];
    const lhs = code.substring(0, operator.start).trim();

    if (!isSimpleAssignmentTarget(lhs)) {
        return undefined;
    }

    const lhsEndColumn = code
        .substring(0, operator.start)
        .replace(/[ \t]+$/g, "")
        .length;

    /* Колонки внутри содержимого, наружу — с отступом строки. */
    return {
        lineIndex,
        indentColumn,
        lhsEndColumn: indentColumn + lhsEndColumn,
        operatorColumn: indentColumn + operator.start
    };
}

function findSimpleAssignmentOperator(
    tokens: readonly IRslToken[]
): number | undefined {
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind !== "symbol" || token.raw !== "=") {
            continue;
        }

        const previous = findSignificantToken(tokens, index, -1);
        const next = findSignificantToken(tokens, index, 1);

        if (
            (previous &&
                previous.kind === "symbol" &&
                ["!", "<", ">", "=", "+", "-", "*", "/", "%"]
                    .indexOf(previous.raw) >= 0) ||
            (next && next.kind === "symbol" && next.raw === "=")
        ) {
            continue;
        }

        return index;
    }

    return undefined;
}

function findSignificantToken(
    tokens: readonly IRslToken[],
    startIndex: number,
    direction: -1 | 1
): IRslToken | undefined {
    for (
        let index = startIndex + direction;
        index >= 0 && index < tokens.length;
        index += direction
    ) {
        if (tokens[index].kind !== "whitespace") {
            return tokens[index];
        }
    }

    return undefined;
}

function isSimpleAssignmentTarget(value: string): boolean {
    const identifier =
        "[@A-Za-zА-Яа-яЁё_][@A-Za-zА-Яа-яЁё0-9_]*";
    const suffix = `(?:\\s*\\.\\s*${identifier}|\\([^)]*\\)|\\[[^\\]]*\\])`;
    return new RegExp(`^${identifier}(?:${suffix})*$`).test(value);
}

interface ILineStructure {
    firstKeyword?: string;
    blockStarts: number;
    blockEnds: number;
}

function analyzeStructure(tokens: IRslToken[]): ILineStructure {
    let firstKeyword: string | undefined;
    let blockStarts = 0;
    let blockEnds = 0;
    let canStartStatement = true;

    for (const token of tokens) {
        if (
            token.kind === "whitespace" ||
            token.kind === "comment" ||
            token.kind === "string" ||
            token.kind === "square" ||
            token.kind === "bom"
        ) {
            continue;
        }

        if (token.kind === "symbol") {
            if (token.raw === ";") {
                canStartStatement = true;
            } else if (token.raw !== "(" && token.raw !== ")") {
                canStartStatement = false;
            }

            continue;
        }

        if (token.kind !== "identifier") {
            canStartStatement = false;
            continue;
        }

        const word = token.value.toLowerCase();

        if (!firstKeyword) {
            firstKeyword = word;
        }

        if (word === END_KEYWORD) {
            blockEnds++;
            canStartStatement = false;
            continue;
        }

        if (canStartStatement && isDeclarationModifier(word)) {
            continue;
        }

        if (
            canStartStatement &&
            BLOCK_START_KEYWORDS.indexOf(word) >= 0
        ) {
            blockStarts++;
        }

        canStartStatement = false;
    }

    return {
        firstKeyword,
        blockStarts,
        blockEnds
    };
}

function normalizeLineSafely(
    line: string,
    absoluteStart: number,
    tokens: IRslToken[]
): string {
    const protectedTokens = tokens
        .filter(token =>
            token.kind === "string" ||
            token.kind === "comment" ||
            token.kind === "square"
        )
        .sort((left, right) => left.start - right.start);

    let result = "";
    let localPosition = 0;

    for (const token of protectedTokens) {
        const tokenStart = Math.max(0, token.start - absoluteStart);
        const tokenEnd = Math.min(line.length, token.end - absoluteStart);

        if (tokenStart < localPosition || tokenStart > line.length) {
            continue;
        }

        result += normalizeCodeSegment(
            line.substring(localPosition, tokenStart)
        );
        result += line.substring(tokenStart, tokenEnd);
        localPosition = tokenEnd;
    }

    result += normalizeCodeSegment(line.substring(localPosition));
    return result.trim();
}

function normalizeCodeSegment(segment: string): string {
    return segment
        .replace(/[ \t]*(==|!=|<=|>=|>|<)[ \t]*/g, " $1 ")
        .replace(
            /(^|[^!<>=+\-*/%])[ \t]*=[ \t]*(?!=)/g,
            "$1 = "
        )
        .replace(/,[ \t]*/g, ", ")
        .replace(/[ \t]+/g, " ");
}

function updateParenthesisStack(
    tokens: readonly IRslToken[],
    indentColumn: number,
    parenthesisStack: number[]
): void {
    for (const token of tokens) {
        if (token.kind !== "symbol") {
            continue;
        }

        if (token.raw === "(") {
            parenthesisStack.push(indentColumn + token.character);
        } else if (
            token.raw === ")" &&
            parenthesisStack.length > 0
        ) {
            parenthesisStack.pop();
        }
    }
}

function getNextContinuationContext(
    lineCode: string,
    tokens: readonly IRslToken[],
    indentColumn: number,
    current: IContinuationContext | undefined
): IContinuationContext | undefined {
    const code = lineCode.replace(/\s+$/g, "");

    if (current) {
        if (current.kind === "declaration") {
            return containsCodeSymbol(tokens, ";")
                ? undefined
                : current;
        }

        return code.endsWith("+") ? current : undefined;
    }

    const declarationMatch = code.match(CONTINUED_DECLARATION_PATTERN);

    if (declarationMatch) {
        return {
            kind: "declaration",
            indentColumn: indentColumn + declarationMatch[1].length
        };
    }

    if (!code.endsWith("+")) {
        return undefined;
    }

    const assignmentColumn = findAssignmentExpressionColumn(tokens, code);

    return assignmentColumn === undefined
        ? undefined
        : {
            kind: "assignment",
            indentColumn: indentColumn + assignmentColumn
        };
}

/** Код строки без построчного комментария и его токены — за одно лексирование. */
function splitLineCode(line: string): {
    code: string;
    tokens: IRslToken[];
} {
    const tokens = lexRsl(line).tokens;
    const comment = tokens.find(token =>
        token.kind === "comment" && token.raw.startsWith("//")
    );

    if (!comment) {
        return { code: line, tokens };
    }

    return {
        code: line.substring(0, comment.start),
        tokens: tokens.filter(token => token.start < comment.start)
    };
}

function findAssignmentExpressionColumn(
    tokens: readonly IRslToken[],
    line: string
): number | undefined {
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind !== "symbol" || token.raw !== "=") {
            continue;
        }

        const previous = tokens[index - 1];
        const next = tokens[index + 1];

        if (
            (previous && previous.kind === "symbol" &&
                ["!", "<", ">", "="].indexOf(previous.raw) >= 0) ||
            (next && next.kind === "symbol" && next.raw === "=")
        ) {
            continue;
        }

        let column = token.character + 1;

        while (column < line.length && /[ \t]/.test(line.charAt(column))) {
            column++;
        }

        return column;
    }

    return undefined;
}

/* Токены уже посчитаны вызывающим: лексировать строку второй раз незачем. */
function containsCodeSymbol(
    tokens: readonly IRslToken[],
    symbol: string
): boolean {
    return tokens.some(token =>
        token.kind === "symbol" && token.raw === symbol
    );
}

/**
 * Возвращает токены очередной строки последовательным проходом.
 *
 * Раньше форматтер для каждой строки заново выполнял filter/find по полному
 * массиву токенов, из-за чего время росло примерно как lines * tokens.
 */
class LineTokenCursor {
    private index = 0;

    constructor(private tokens: IRslToken[]) {
    }

    get(
        line: number,
        absoluteStart: number,
        length: number
    ): {
        tokens: IRslToken[];
        protectedToken?: IRslToken;
    } {
        while (
            this.index < this.tokens.length &&
            this.tokens[this.index].endLine < line
        ) {
            this.index++;
        }

        const absoluteEnd = absoluteStart + length;
        const lineTokens: IRslToken[] = [];
        let protectedToken: IRslToken | undefined;

        for (
            let scan = this.index;
            scan < this.tokens.length && this.tokens[scan].line <= line;
            scan++
        ) {
            const token = this.tokens[scan];

            if (
                (token.kind === "square" || token.kind === "comment") &&
                token.endLine > token.line &&
                token.line <= line &&
                line <= token.endLine
            ) {
                protectedToken = token;
                break;
            }

            if (
                token.line === line &&
                token.endLine === line &&
                token.start >= absoluteStart &&
                token.start <= absoluteEnd
            ) {
                lineTokens.push(token);
            }
        }

        return {
            tokens: lineTokens,
            protectedToken
        };
    }
}

function buildLineStarts(
    body: string,
    _eol: string
): number[] {
    const result: number[] = [0];

    for (let index = 0; index < body.length; index++) {
        const current = body.charAt(index);

        if (current === "\r") {
            if (body.charAt(index + 1) === "\n") {
                index++;
            }

            result.push(index + 1);
        } else if (current === "\n") {
            result.push(index + 1);
        }
    }

    return result;
}


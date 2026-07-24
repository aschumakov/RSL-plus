import {
    BLOCK_START_KEYWORDS,
    BRANCH_KEYWORDS,
    END_KEYWORD
} from "./languageMetadata";

import {
    IRslToken,
    lexRsl
} from "./lexer";

export const FORMATTER_REVISION = "spacing-v2";

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
export function FormatCode(text: string, tabSize: number = 4): string {
    const source = text || "";
    const lex = lexRsl(source);
    const bom = lex.hasBom ? "\uFEFF" : "";
    const body = lex.hasBom ? source.substring(1) : source;
    const bodyOffset = lex.hasBom ? 1 : 0;
    const lines = body.split(/\r\n|\n|\r/);
    const lineStarts = buildLineStarts(body, lex.eol);
    const formatted: string[] = [];
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

        const formattedLine = " ".repeat(indentColumn) + normalizedLine;
        formatted.push(formattedLine);

        updateParenthesisStack(formattedLine, parenthesisStack);
        continuation = getNextContinuationContext(
            formattedLine,
            continuation
        );

        indentLevel = Math.max(
            0,
            indentLevel +
                structure.blockStarts -
                structure.blockEnds +
                (startsTopLevelOnError ? 1 : 0)
        );
    }

    alignConsecutiveAssignments(formatted);
    return bom + formatted.join(lex.eol);
}

function alignConsecutiveAssignments(lines: string[]): void {
    let group: IAssignmentAlignment[] = [];

    const flushGroup = (): void => {
        if (group.length < 2) {
            group = [];
            return;
        }

        const targetOperatorColumn = Math.max(
            ...group.map(item => item.lhsEndColumn)
        ) + 1;

        for (const item of group) {
            const line = lines[item.lineIndex];
            lines[item.lineIndex] =
                line.substring(0, item.lhsEndColumn) +
                " ".repeat(targetOperatorColumn - item.lhsEndColumn) +
                line.substring(item.operatorColumn);
        }

        group = [];
    };

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const assignment = getAssignmentAlignment(lines[lineIndex], lineIndex);

        if (
            !assignment ||
            (group.length > 0 &&
                assignment.indentColumn !== group[0].indentColumn)
        ) {
            flushGroup();
        }

        if (assignment) {
            group.push(assignment);
        }
    }

    flushGroup();
}

function getAssignmentAlignment(
    line: string,
    lineIndex: number
): IAssignmentAlignment | undefined {
    const code = getCodeBeforeLineComment(line);
    const tokens = lexRsl(code).tokens;
    const operatorIndex = findSimpleAssignmentOperator(tokens);

    if (operatorIndex === undefined) {
        return undefined;
    }

    const operator = tokens[operatorIndex];
    const lhs = code.substring(0, operator.start).trim();

    if (!isSimpleAssignmentTarget(lhs)) {
        return undefined;
    }

    const indentColumn = code.length - code.trimStart().length;
    const lhsEndColumn = code
        .substring(0, operator.start)
        .replace(/[ \t]+$/g, "")
        .length;

    return {
        lineIndex,
        indentColumn,
        lhsEndColumn,
        operatorColumn: operator.start
    };
}

function findSimpleAssignmentOperator(
    tokens: IRslToken[]
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
    tokens: IRslToken[],
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
    line: string,
    parenthesisStack: number[]
): void {
    const tokens = lexRsl(line).tokens;

    for (const token of tokens) {
        if (token.kind !== "symbol") {
            continue;
        }

        if (token.raw === "(") {
            parenthesisStack.push(token.character);
        } else if (
            token.raw === ")" &&
            parenthesisStack.length > 0
        ) {
            parenthesisStack.pop();
        }
    }
}

function getNextContinuationContext(
    line: string,
    current: IContinuationContext | undefined
): IContinuationContext | undefined {
    const code = getCodeBeforeLineComment(line).replace(/\s+$/g, "");

    if (current) {
        if (current.kind === "declaration") {
            return containsCodeSymbol(code, ";")
                ? undefined
                : current;
        }

        return code.endsWith("+") ? current : undefined;
    }

    const declarationMatch = code.match(
        /^(\s*(?:(?:private|local|public)\s+)?(?:var|const|array|record)\s+)([@A-Za-zА-Яа-яЁё_][@A-Za-zА-Яа-яЁё0-9_]*).*?,\s*$/i
    );

    if (declarationMatch) {
        return {
            kind: "declaration",
            indentColumn: declarationMatch[1].length
        };
    }

    if (!code.endsWith("+")) {
        return undefined;
    }

    const assignmentColumn = findAssignmentExpressionColumn(code);

    return assignmentColumn === undefined
        ? undefined
        : {
            kind: "assignment",
            indentColumn: assignmentColumn
        };
}

function getCodeBeforeLineComment(line: string): string {
    const comment = lexRsl(line).tokens.find(token =>
        token.kind === "comment" && token.raw.startsWith("//")
    );

    return comment ? line.substring(0, comment.start) : line;
}

function findAssignmentExpressionColumn(line: string): number | undefined {
    const tokens = lexRsl(line).tokens;

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

function containsCodeSymbol(line: string, symbol: string): boolean {
    return lexRsl(line).tokens.some(token =>
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

function isDeclarationModifier(value: string): boolean {
    return value === "private" || value === "local" || value === "public";
}

import {
    BLOCK_START_KEYWORDS,
    BRANCH_KEYWORDS,
    END_KEYWORD
} from "./languageMetadata";

import {
    STOP_CHARS,
    MLC_O,
    MLC_C
} from "./enums";

type ContinuationKind = "declaration" | "assignment";

interface IContinuationContext {
    kind: ContinuationKind;

    /**
     * Абсолютная колонка, с которой должны начинаться строки продолжения.
     */
    indentColumn: number;
}

/**
 * Форматирует RSL-код.
 *
 * Основные правила:
 * - сохраняет исходный регистр идентификаторов и ключевых слов;
 * - форматирует вложенность macro/class/if/for/while/end;
 * - выравнивает продолжения многострочных вызовов по первому символу
 *   после соответствующей открывающей скобки;
 * - не анализирует скобки и операторы внутри строк и комментариев.
 */
export function FormatCode(text: string, tabSize: number = 4): string {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const formattedLines: string[] = [];

    let indentLevel = 0;
    let isMultilineComment = false;

    /*
     * Абсолютные позиции незакрытых круглых скобок в уже
     * отформатированном тексте.
     *
     * Например:
     *     var x = Func(
     *                  argument);
     */
    const parenthesisStack: number[] = [];

    /*
     * Контекст продолжения выражения вне круглых скобок:
     * - список объявлений после var/const/array/record;
     * - правая часть присваивания, разбитая оператором +.
     */
    let continuationContext: IContinuationContext | undefined;

    for (const originalLine of lines) {
        const trimmedOriginalLine = originalLine.trim();

        if (trimmedOriginalLine.length === 0) {
            formattedLines.push("");
            continue;
        }

        /*
         * Многострочные комментарии сохраняем без изменения содержимого.
         * Меняем только базовый отступ первой строки комментария.
         */
        if (isMultilineComment) {
            formattedLines.push(originalLine);

            if (trimmedOriginalLine.endsWith(MLC_C)) {
                isMultilineComment = false;
            }

            continue;
        }

        if (trimmedOriginalLine.startsWith(MLC_O)) {
            const indent = getCurrentIndent(
                indentLevel,
                tabSize,
                parenthesisStack,
                trimmedOriginalLine,
                continuationContext
            );

            formattedLines.push(
                " ".repeat(indent) + trimmedOriginalLine
            );

            if (!trimmedOriginalLine.endsWith(MLC_C)) {
                isMultilineComment = true;
            }

            continue;
        }

        /*
         * Однострочный комментарий форматируется только по отступу.
         * Его текст не изменяется.
         */
        if (trimmedOriginalLine.startsWith("//")) {
            const indent = getCurrentIndent(
                indentLevel,
                tabSize,
                parenthesisStack,
                trimmedOriginalLine,
                continuationContext
            );

            formattedLines.push(
                " ".repeat(indent) + trimmedOriginalLine
            );

            continue;
        }

        /*
         * Нормализуем пробелы только вне строк и комментариев.
         * Регистр намеренно не меняем.
         */
        const normalizedLine = normalizeLineSpacing(
            trimmedOriginalLine
        );

        const wordsInLine = extractWordsBeforeComment(
            normalizedLine
        ).map(removeStopChars);

        const lowerWords = wordsInLine.map(word =>
            word.toLowerCase()
        );

        const hasBlockStart = lowerWords.some(word =>
            BLOCK_START_KEYWORDS.indexOf(word) >= 0
        );

        const hasEnd = lowerWords.some(word =>
            word === END_KEYWORD
        );

        const isBranch = lowerWords.some(word =>
            BRANCH_KEYWORDS.indexOf(word) >= 0
        );

        /*
         * Else/ElIf и одиночный End выводятся на один уровень левее.
         * Сам indentLevel меняется только после формирования строки.
         */
        let lineIndentLevel = indentLevel;

        if (isBranch || (hasEnd && !hasBlockStart)) {
            lineIndentLevel = Math.max(indentLevel - 1, 0);
        }

        let indentColumn = lineIndentLevel * tabSize;

        /*
         * Если продолжается выражение с незакрытой скобкой,
         * выравниваем строку по позиции после последней открытой скобки.
         */
        if (parenthesisStack.length > 0) {
            const lastOpenParenthesis =
                parenthesisStack[parenthesisStack.length - 1];

            const continuationColumn = normalizedLine.startsWith(")")
                ? lastOpenParenthesis
                : lastOpenParenthesis + 1;

            indentColumn = Math.max(
                indentColumn,
                continuationColumn
            );
        } else if (continuationContext !== undefined) {
            indentColumn = Math.max(
                indentColumn,
                continuationContext.indentColumn
            );
        }

        const formattedLine =
            " ".repeat(indentColumn) + normalizedLine;

        formattedLines.push(formattedLine);

        /*
         * Обновляем стек уже по строке с окончательным отступом,
         * чтобы позиции скобок были абсолютными.
         */
        updateParenthesisStack(
            formattedLine,
            parenthesisStack
        );

        continuationContext = getNextContinuationContext(
            formattedLine,
            continuationContext
        );

        if (hasBlockStart && !hasEnd) {
            indentLevel++;
        } else if (hasEnd && !hasBlockStart) {
            indentLevel = Math.max(indentLevel - 1, 0);
        }
    }

    return formattedLines.join("\n").trim();
}

/**
 * Возвращает отступ для комментариев и служебных строк.
 */
function getCurrentIndent(
    indentLevel: number,
    tabSize: number,
    parenthesisStack: number[],
    trimmedLine: string,
    continuationContext: IContinuationContext | undefined
): number {
    let indent = indentLevel * tabSize;

    if (parenthesisStack.length > 0) {
        const lastOpenParenthesis =
            parenthesisStack[parenthesisStack.length - 1];

        const continuationColumn = trimmedLine.startsWith(")")
            ? lastOpenParenthesis
            : lastOpenParenthesis + 1;

        indent = Math.max(indent, continuationColumn);
    } else if (continuationContext !== undefined) {
        indent = Math.max(
            indent,
            continuationContext.indentColumn
        );
    }

    return indent;
}

/**
 * Вычисляет выравнивание следующей строки.
 *
 * Примеры:
 *
 *     private var first,
 *                 second,
 *                 third;
 *
 *     sql = "select ..."+
 *           "from ..."+
 *           "where ...";
 */
function getNextContinuationContext(
    line: string,
    current: IContinuationContext | undefined
): IContinuationContext | undefined {
    const code = getCodeBeforeLineComment(line)
        .replace(/\s+$/g, "");

    if (current !== undefined) {
        if (current.kind === "declaration") {
            /*
             * Объявление может занимать сколько угодно строк.
             * Заканчивается оно только точкой с запятой вне строки.
             */
            return containsCodeCharacter(code, ";")
                ? undefined
                : current;
        }

        /*
         * Конкатенация продолжается, пока последним значимым
         * символом строки остаётся +.
         */
        return code.endsWith("+")
            ? current
            : undefined;
    }

    /*
     * Запоминаем колонку первого имени после ключевого слова.
     * Допускаем private/local и тип/значение после первого имени.
     */
    const declarationMatch = code.match(
        /^(\s*(?:(?:private|local)\s+)?(?:var|const|array|record)\s+)([@A-Za-zА-Яа-яЁё_][@A-Za-zА-Яа-яЁё0-9_]*).*?,\s*$/i
    );

    if (declarationMatch !== null) {
        return {
            kind: "declaration",
            indentColumn: declarationMatch[1].length
        };
    }

    if (!code.endsWith("+")) {
        return undefined;
    }

    const assignmentColumn =
        findAssignmentExpressionColumn(code);

    if (assignmentColumn === undefined) {
        return undefined;
    }

    return {
        kind: "assignment",
        indentColumn: assignmentColumn
    };
}

/**
 * Возвращает код до //, не принимая // внутри строк за комментарий.
 */
function getCodeBeforeLineComment(line: string): string {
    let quote = "";

    for (let index = 0; index < line.length; index++) {
        const char = line[index];
        const nextChar = index + 1 < line.length
            ? line[index + 1]
            : "";

        if (quote.length > 0) {
            if (
                char === quote &&
                !isEscapedByBackslashes(line, index)
            ) {
                quote = "";
            }

            continue;
        }

        if (char === "\"" || char === "'") {
            quote = char;
            continue;
        }

        if (char === "/" && nextChar === "/") {
            return line.substring(0, index);
        }
    }

    return line;
}

/**
 * Ищет присваивание и возвращает колонку первого символа
 * правой части. ==, !=, <= и >= присваиваниями не считаются.
 */
function findAssignmentExpressionColumn(
    line: string
): number | undefined {
    let quote = "";

    for (let index = 0; index < line.length; index++) {
        const char = line[index];

        if (quote.length > 0) {
            if (
                char === quote &&
                !isEscapedByBackslashes(line, index)
            ) {
                quote = "";
            }

            continue;
        }

        if (char === "\"" || char === "'") {
            quote = char;
            continue;
        }

        if (char !== "=") {
            continue;
        }

        const previous = index > 0
            ? line[index - 1]
            : "";
        const next = index + 1 < line.length
            ? line[index + 1]
            : "";

        if (
            previous === "!" ||
            previous === "<" ||
            previous === ">" ||
            previous === "=" ||
            next === "="
        ) {
            continue;
        }

        let expressionColumn = index + 1;

        while (
            expressionColumn < line.length &&
            (
                line[expressionColumn] === " " ||
                line[expressionColumn] === "\t"
            )
        ) {
            expressionColumn++;
        }

        return expressionColumn;
    }

    return undefined;
}

/**
 * Проверяет наличие символа вне строк.
 */
function containsCodeCharacter(
    line: string,
    expected: string
): boolean {
    let quote = "";

    for (let index = 0; index < line.length; index++) {
        const char = line[index];

        if (quote.length > 0) {
            if (
                char === quote &&
                !isEscapedByBackslashes(line, index)
            ) {
                quote = "";
            }

            continue;
        }

        if (char === "\"" || char === "'") {
            quote = char;
            continue;
        }

        if (char === expected) {
            return true;
        }
    }

    return false;
}

function isEscapedByBackslashes(
    line: string,
    position: number
): boolean {
    let backslashCount = 0;
    let index = position - 1;

    while (index >= 0 && line[index] === "\\") {
        backslashCount++;
        index--;
    }

    return backslashCount % 2 === 1;
}

/**
 * Обновляет стек незакрытых круглых скобок.
 *
 * Скобки в строках и после // игнорируются.
 */
function updateParenthesisStack(
    line: string,
    parenthesisStack: number[]
): void {
    let inString = false;
    let escaped = false;

    for (let index = 0; index < line.length; index++) {
        const char = line[index];
        const nextChar = index + 1 < line.length
            ? line[index + 1]
            : "";

        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }

            if (char === "\\") {
                escaped = true;
                continue;
            }

            if (char === "\"") {
                inString = false;
            }

            continue;
        }

        if (char === "\"") {
            inString = true;
            continue;
        }

        if (char === "/" && nextChar === "/") {
            break;
        }

        if (char === "(") {
            parenthesisStack.push(index);
            continue;
        }

        if (char === ")" && parenthesisStack.length > 0) {
            parenthesisStack.pop();
        }
    }
}

/**
 * Нормализует пробелы вне строковых литералов и комментариев.
 *
 * Сейчас форматируются операторы сравнения:
 * ==, !=, <=, >=, <, >
 *
 * Содержимое SQL-строк не изменяется.
 */
function normalizeLineSpacing(line: string): string {
    let result = "";
    let codeSegment = "";
    let inString = false;
    let escaped = false;

    function flushCodeSegment(): void {
        if (codeSegment.length === 0) {
            return;
        }

        result += normalizeCodeSegment(codeSegment);
        codeSegment = "";
    }

    for (let index = 0; index < line.length; index++) {
        const char = line[index];
        const nextChar = index + 1 < line.length
            ? line[index + 1]
            : "";

        if (inString) {
            result += char;

            if (escaped) {
                escaped = false;
                continue;
            }

            if (char === "\\") {
                escaped = true;
                continue;
            }

            if (char === "\"") {
                inString = false;
            }

            continue;
        }

        if (char === "\"") {
            flushCodeSegment();
            result += char;
            inString = true;
            continue;
        }

        if (char === "/" && nextChar === "/") {
            flushCodeSegment();
            result += line.substring(index);
            return result.trim();
        }

        codeSegment += char;
    }

    flushCodeSegment();

    return result.trim();
}

function normalizeCodeSegment(segment: string): string {
    return segment
        .replace(/\s*(==|!=|<=|>=|>|<)\s*/g, " $1 ")
        .replace(/\s+/g, " ");
}

function removeStopChars(inputString: string): string {
    const stopCharsArray = Array.from(STOP_CHARS);

    return Array.from(inputString)
        .filter(char => stopCharsArray.indexOf(char) < 0)
        .join("");
}

/**
 * Извлекает слова из кода до однострочного комментария.
 * Строковые литералы игнорируются.
 */
function extractWordsBeforeComment(input: string): string[] {
    let code = "";
    let inString = false;
    let escaped = false;

    for (let index = 0; index < input.length; index++) {
        const char = input[index];
        const nextChar = index + 1 < input.length
            ? input[index + 1]
            : "";

        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }

            if (char === "\\") {
                escaped = true;
                continue;
            }

            if (char === "\"") {
                inString = false;
            }

            continue;
        }

        if (char === "\"") {
            inString = true;
            continue;
        }

        if (char === "/" && nextChar === "/") {
            break;
        }

        code += char;
    }

    const matches = code.match(/\b\w+\b/g);

    return matches !== null ? matches : [];
}

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
                trimmedOriginalLine
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
                trimmedOriginalLine
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
    trimmedLine: string
): number {
    let indent = indentLevel * tabSize;

    if (parenthesisStack.length > 0) {
        const lastOpenParenthesis =
            parenthesisStack[parenthesisStack.length - 1];

        const continuationColumn = trimmedLine.startsWith(")")
            ? lastOpenParenthesis
            : lastOpenParenthesis + 1;

        indent = Math.max(indent, continuationColumn);
    }

    return indent;
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
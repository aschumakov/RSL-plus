import {
    BLOCK_START_KEYWORDS,
    END_KEYWORD
} from "./languageMetadata";

export interface IRslFoldingRange {
    startLine: number;
    endLine: number;
    kind?: "comment";
}

interface IOpenBlock {
    keyword: string;
    startLine: number;
}

interface IScannerPosition {
    index: number;
    line: number;
}

const DECLARATION_MODIFIERS: { [name: string]: boolean } = {
    private: true,
    local: true,
    public: true
};

const BLOCK_START_LOOKUP: { [name: string]: boolean } =
    BLOCK_START_KEYWORDS.reduce(
        (result, keyword) => {
            result[keyword] = true;
            return result;
        },
        Object.create(null)
    );

/**
 * Строит диапазоны сворачивания по синтаксическим блокам RSL.
 *
 * Отступы не учитываются. Ключевые слова внутри строк,
 * комментариев и квадратных текстовых/SQL-блоков игнорируются.
 */
export function GetFoldingRanges(
    source: string
): IRslFoldingRange[] {
    const ranges: IRslFoldingRange[] = [];
    const blocks: IOpenBlock[] = [];
    const lineCommentLines: number[] = [];

    const position: IScannerPosition = {
        index: 0,
        line: 0
    };

    let canStartBlock = true;

    while (position.index < source.length) {
        const current = source.charAt(position.index);

        if (current === "\r") {
            position.index++;
            continue;
        }

        if (current === "\n") {
            position.index++;
            position.line++;
            canStartBlock = true;
            continue;
        }

        if (current === " " || current === "\t") {
            position.index++;
            continue;
        }

        if (startsWithAt(source, "//", position.index)) {
            if (canStartBlock) {
                lineCommentLines.push(position.line);
            }

            skipToLineEnd(source, position);
            continue;
        }

        if (startsWithAt(source, "/*", position.index)) {
            const startLine = position.line;
            skipBlockComment(source, position);

            if (position.line > startLine) {
                ranges.push({
                    startLine,
                    endLine: position.line,
                    kind: "comment"
                });
            }

            continue;
        }

        if (current === "\"" || current === "'") {
            canStartBlock = false;
            skipRslString(source, position, current);
            continue;
        }

        if (current === "[") {
            const startLine = position.line;
            canStartBlock = false;
            skipSquareBlock(source, position);

            if (position.line > startLine) {
                ranges.push({
                    startLine,
                    endLine: position.line
                });
            }

            continue;
        }

    if (isIdentifierStart(current)) {
        const word = readIdentifier(source, position)
            .toLowerCase();

        /*
        * End завершает текущий блок независимо от позиции
        * в строке. Это необходимо для однострочных конструкций:
        *
        * if (condition) return 1; end;
        */
        if (word === END_KEYWORD) {
            closeCurrentBlock(
                blocks,
                ranges,
                position.line
            );

            canStartBlock = false;
            continue;
        }

        /*
        * Начало нового блока распознаём только в допустимой
        * позиции строки. Иначе, например, имя функции
        * ifThenElse могло бы повлиять на структуру.
        */
        if (!canStartBlock) {
            continue;
        }

        if (DECLARATION_MODIFIERS[word]) {
            continue;
        }

        canStartBlock = false;

        if (BLOCK_START_LOOKUP[word]) {
            blocks.push({
                keyword: word,
                startLine: position.line
            });
        }

        continue;
    }

        canStartBlock = false;
        position.index++;
    }

    addLineCommentRanges(
        lineCommentLines,
        ranges
    );

    /*
     * Незакрытые блоки намеренно не сворачиваем до конца файла.
     * Иначе одна ошибочно распознанная или незавершённая конструкция
     * внутри класса превращает диапазон класса в Class -> EOF.
     */

    ranges.sort((left, right) => {
        if (left.startLine !== right.startLine) {
            return left.startLine - right.startLine;
        }

        return right.endLine - left.endLine;
    });

    return ranges;
}

function closeCurrentBlock(
    blocks: IOpenBlock[],
    ranges: IRslFoldingRange[],
    endLine: number
): void {
    const block = blocks.pop();

    if (
        block === undefined ||
        endLine <= block.startLine
    ) {
        return;
    }

    ranges.push({
        startLine: block.startLine,
        endLine
    });
}

function addLineCommentRanges(
    lines: number[],
    ranges: IRslFoldingRange[]
): void {
    if (lines.length === 0) {
        return;
    }

    let startLine = lines[0];
    let previousLine = lines[0];

    for (let index = 1; index < lines.length; index++) {
        const currentLine = lines[index];

        if (currentLine === previousLine + 1) {
            previousLine = currentLine;
            continue;
        }

        addLineCommentRange(
            startLine,
            previousLine,
            ranges
        );

        startLine = currentLine;
        previousLine = currentLine;
    }

    addLineCommentRange(
        startLine,
        previousLine,
        ranges
    );
}

function addLineCommentRange(
    startLine: number,
    endLine: number,
    ranges: IRslFoldingRange[]
): void {
    if (endLine <= startLine) {
        return;
    }

    ranges.push({
        startLine,
        endLine,
        kind: "comment"
    });
}

function readIdentifier(
    source: string,
    position: IScannerPosition
): string {
    const start = position.index;

    while (
        position.index < source.length &&
        isIdentifierPart(
            source.charAt(position.index)
        )
    ) {
        position.index++;
    }

    return source.substring(start, position.index);
}

function isIdentifierStart(value: string): boolean {
    return /[A-Za-zА-Яа-яЁё_]/.test(value);
}

function isIdentifierPart(value: string): boolean {
    return /[A-Za-zА-Яа-яЁё0-9_]/.test(value);
}

function skipRslString(
    source: string,
    position: IScannerPosition,
    quote: string
): void {
    position.index++;

    while (position.index < source.length) {
        const current = source.charAt(position.index);

        if (current === "\n") {
            position.line++;
            position.index++;
            continue;
        }

        if (
            current === quote &&
            !isEscapedByBackslashes(
                source,
                position.index
            )
        ) {
            position.index++;
            return;
        }

        position.index++;
    }
}

function skipSqlString(
    source: string,
    position: IScannerPosition,
    quote: string
): void {
    position.index++;

    while (position.index < source.length) {
        const current = source.charAt(position.index);

        if (current === "\n") {
            position.line++;
            position.index++;
            continue;
        }

        if (current !== quote) {
            position.index++;
            continue;
        }

        if (
            source.charAt(position.index + 1) === quote
        ) {
            position.index += 2;
            continue;
        }

        position.index++;
        return;
    }
}

function skipSquareBlock(
    source: string,
    position: IScannerPosition
): void {
    let depth = 1;
    position.index++;

    while (
        position.index < source.length &&
        depth > 0
    ) {
        const current = source.charAt(position.index);

        if (current === "\n") {
            position.line++;
            position.index++;
            continue;
        }

        if (
            startsWithAt(source, "--", position.index) ||
            startsWithAt(source, "//", position.index)
        ) {
            skipToLineEnd(source, position);
            continue;
        }

        if (startsWithAt(source, "/*", position.index)) {
            skipBlockComment(source, position);
            continue;
        }

        if (current === "\"" || current === "'") {
            skipSqlString(source, position, current);
            continue;
        }

        if (current === "[") {
            depth++;
            position.index++;
            continue;
        }

        if (current === "]") {
            depth--;
            position.index++;
            continue;
        }

        position.index++;
    }
}

function skipBlockComment(
    source: string,
    position: IScannerPosition
): void {
    position.index += 2;

    while (position.index < source.length) {
        if (startsWithAt(source, "*/", position.index)) {
            position.index += 2;
            return;
        }

        if (source.charAt(position.index) === "\n") {
            position.line++;
        }

        position.index++;
    }
}

function skipToLineEnd(
    source: string,
    position: IScannerPosition
): void {
    while (
        position.index < source.length &&
        source.charAt(position.index) !== "\r" &&
        source.charAt(position.index) !== "\n"
    ) {
        position.index++;
    }
}

function startsWithAt(
    source: string,
    value: string,
    index: number
): boolean {
    return source.substr(index, value.length) === value;
}

function isEscapedByBackslashes(
    source: string,
    index: number
): boolean {
    let backslashCount = 0;
    let current = index - 1;

    while (
        current >= 0 &&
        source.charAt(current) === "\\"
    ) {
        backslashCount++;
        current--;
    }

    return backslashCount % 2 === 1;
}

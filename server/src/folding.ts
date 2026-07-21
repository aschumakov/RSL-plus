import {
    BLOCK_START_KEYWORDS,
    END_KEYWORD
} from "./languageMetadata";

import {
    IRslLexResult,
    IRslToken,
    isFullLineComment,
    lexRsl
} from "./lexer";

export interface IRslFoldingRange {
    startLine: number;
    endLine: number;
    kind?: "comment";
}

interface IOpenBlock {
    keyword: string;
    startLine: number;
    branchStartLine?: number;
}

const DECLARATION_MODIFIERS: { [name: string]: boolean } = {
    private: true,
    local: true,
    public: true
};

const BLOCK_START_LOOKUP: { [name: string]: boolean } =
    BLOCK_START_KEYWORDS.reduce(
        (result, keyword) => {
            result[keyword.toLowerCase()] = true;
            return result;
        },
        Object.create(null)
    );

const IF_KEYWORD = "if";
const ELIF_KEYWORD = "elif";
const ELSE_KEYWORD = "else";

/** Строит folding ranges на общем RSL token stream. */
export function GetFoldingRanges(
    source: string,
    lexResult?: IRslLexResult
): IRslFoldingRange[] {
    const ranges: IRslFoldingRange[] = [];
    const blocks: IOpenBlock[] = [];
    const fullLineComments: number[] = [];
    const lex = lexResult || lexRsl(source || "");
    let canStartBlock = true;

    for (const token of lex.tokens) {
        if (token.kind === "newline") {
            canStartBlock = true;
            continue;
        }

        if (token.kind === "whitespace" || token.kind === "bom") {
            continue;
        }

        if (token.kind === "comment") {
            if (token.raw.startsWith("//")) {
                if (isFullLineComment(source, token)) {
                    fullLineComments.push(token.line);
                }
            } else if (token.endLine > token.line) {
                ranges.push({
                    startLine: token.line,
                    endLine: token.endLine,
                    kind: "comment"
                });
            }

            continue;
        }

        if (token.kind === "square") {
            if (token.endLine > token.line) {
                ranges.push({
                    startLine: token.line,
                    endLine: token.endLine
                });
            }

            canStartBlock = false;
            continue;
        }

        if (token.kind === "string") {
            canStartBlock = false;
            continue;
        }

        if (token.kind !== "identifier") {
            canStartBlock = false;
            continue;
        }

        const word = token.value.toLowerCase();

        if (word === END_KEYWORD.toLowerCase()) {
            closeCurrentBlock(blocks, ranges, token.line);
            canStartBlock = false;
            continue;
        }

        if (
            canStartBlock &&
            (word === ELIF_KEYWORD || word === ELSE_KEYWORD)
        ) {
            switchIfBranch(blocks, ranges, token.line);
            canStartBlock = false;
            continue;
        }

        if (!canStartBlock) {
            continue;
        }

        if (DECLARATION_MODIFIERS[word]) {
            continue;
        }

        canStartBlock = false;

        if (!BLOCK_START_LOOKUP[word]) {
            continue;
        }

        const block: IOpenBlock = {
            keyword: word,
            startLine: token.line
        };

        if (word === IF_KEYWORD) {
            block.branchStartLine = token.line;
        }

        blocks.push(block);
    }

    addLineCommentRanges(fullLineComments, ranges);
    ranges.sort((left, right) => {
        if (left.startLine !== right.startLine) {
            return left.startLine - right.startLine;
        }

        return right.endLine - left.endLine;
    });
    return ranges;
}

function switchIfBranch(
    blocks: IOpenBlock[],
    ranges: IRslFoldingRange[],
    branchLine: number
): void {
    const block = blocks.length > 0
        ? blocks[blocks.length - 1]
        : undefined;

    if (
        !block ||
        block.keyword !== IF_KEYWORD ||
        block.branchStartLine === undefined
    ) {
        return;
    }

    addIfBranchRange(ranges, block.branchStartLine, branchLine);
    block.branchStartLine = branchLine;
}

function closeCurrentBlock(
    blocks: IOpenBlock[],
    ranges: IRslFoldingRange[],
    endLine: number
): void {
    const block = blocks.pop();

    if (!block) {
        return;
    }

    if (
        block.keyword === IF_KEYWORD &&
        block.branchStartLine !== undefined
    ) {
        addIfBranchRange(ranges, block.branchStartLine, endLine);
        return;
    }

    if (endLine <= block.startLine) {
        return;
    }

    ranges.push({ startLine: block.startLine, endLine });
}

function addIfBranchRange(
    ranges: IRslFoldingRange[],
    branchStartLine: number,
    boundaryLine: number
): void {
    const endLine = boundaryLine - 1;

    if (endLine <= branchStartLine) {
        return;
    }

    ranges.push({ startLine: branchStartLine, endLine });
}

function addLineCommentRanges(
    lines: number[],
    ranges: IRslFoldingRange[]
): void {
    if (lines.length === 0) {
        return;
    }

    const unique = Array.from(new Set<number>(lines))
        .sort((left, right) => left - right);
    let start = unique[0];
    let previous = unique[0];

    for (let index = 1; index < unique.length; index++) {
        const current = unique[index];

        if (current === previous + 1) {
            previous = current;
            continue;
        }

        addLineCommentRange(start, previous, ranges);
        start = current;
        previous = current;
    }

    addLineCommentRange(start, previous, ranges);
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

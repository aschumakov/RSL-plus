import {
    CodeAction,
    CodeActionKind,
    Position,
    Range,
    SelectionRange
} from "vscode-languageserver/node";

import type { IRslSyntaxNode } from "../syntaxParser";
import { parseOutputForms } from "../parsing/outputFormParser";
import type { IIndexedModule } from "../workspaceIndex";
import { offsetInModule, positionInModule } from "../core/documentPosition";
import { tokenAtOffset } from "../lexer";

export const GO_TO_BLOCK_START_COMMAND = "rsl.goToBlockStart";
export const GO_TO_BLOCK_END_COMMAND = "rsl.goToBlockEnd";

const BLOCK_KINDS = new Set([
    "MacroDeclaration",
    "ClassDeclaration",
    "IfStatement",
    "WhileStatement",
    "ForStatement",
    "WithStatement",
    "OnErrorClause"
]);

export function buildSelectionRanges(
    module: IIndexedModule,
    positions: readonly Position[]
): SelectionRange[] {
    return positions.map(position => {
        const offset = offsetInModule(module, position);
        const ranges: Range[] = [];
        const token = tokenAt(module, offset);
        if (token && token.kind !== "comment" && token.kind !== "square") {
            ranges.push({
                start: { line: token.line, character: token.character },
                end: { line: token.endLine, character: token.endCharacter }
            });
        }

        ranges.push(statementRange(module, offset));
        appendOutputSelectionRanges(module, offset, ranges);
        collectContainingNodes(module.syntax.root, offset)
            .sort((left, right) => span(left) - span(right))
            .forEach(node => ranges.push(offsetRange(module, node.start, node.end)));
        ranges.push(offsetRange(module, 0, module.source.length));

        const unique = deduplicateRanges(ranges)
            .sort((left, right) => rangeSpan(module, left) - rangeSpan(module, right));
        let parent: SelectionRange | undefined;
        for (let index = unique.length - 1; index >= 0; index--) {
            parent = { range: unique[index], ...(parent ? { parent } : {}) };
        }
        return parent || { range: offsetRange(module, 0, module.source.length) };
    });
}

export function buildBlockNavigationActions(
    module: IIndexedModule,
    range: Range
): CodeAction[] {
    const offset = offsetInModule(module, range.start);
    const block = findCurrentBlock(module.syntax.root, offset);
    if (!block) {
        return [];
    }

    const args = [module.uri, range.start.line, range.start.character];
    return [
        {
            title: "Перейти к началу текущего блока",
            kind: CodeActionKind.Refactor,
            command: {
                title: "Перейти к началу текущего блока",
                command: GO_TO_BLOCK_START_COMMAND,
                arguments: args
            }
        },
        {
            title: "Перейти к концу текущего блока",
            kind: CodeActionKind.Refactor,
            command: {
                title: "Перейти к концу текущего блока",
                command: GO_TO_BLOCK_END_COMMAND,
                arguments: args
            }
        }
    ];
}

export function resolveBlockNavigationPosition(
    module: IIndexedModule,
    position: Position,
    direction: "start" | "end"
): Position | undefined {
    const block = findCurrentBlock(module.syntax.root, offsetInModule(module, position));
    if (!block) {
        return undefined;
    }

    if (direction === "start") {
        return positionInModule(module, block.start);
    }

    if (block.kind === "OnErrorClause") {
        const lastToken = [...module.syntax.tokens].reverse().find(token =>
            block.start <= token.start && token.end <= block.end
        );
        return positionInModule(module, lastToken ? lastToken.start : block.end);
    }

    const endKeyword = [...module.syntax.tokens].reverse().find(token =>
        token.kind === "identifier" &&
        token.value.toLowerCase() === "end" &&
        block.start <= token.start &&
        token.end <= block.end
    );
    return positionInModule(module, endKeyword ? endKeyword.start : block.end);
}

/**
 * Возвращает ближайший структурный блок целиком. Если текущий диапазон уже
 * совпадает с блоком, выбирается следующий внешний блок — команда может
 * последовательно расширять выделение If -> Macro -> Class.
 */
export function resolveCurrentBlockRange(
    module: IIndexedModule,
    position: Position,
    currentRange?: Range
): Range | undefined {
    const offset = offsetInModule(module, position);
    const hasSelection = !!currentRange && !rangesAreEmpty(currentRange);
    const selectionStart = currentRange
        ? offsetInModule(module, currentRange.start)
        : offset;
    const selectionEnd = currentRange
        ? offsetInModule(module, currentRange.end)
        : offset;
    const blocks = (hasSelection
        ? collectBlockNodes(module.syntax.root).filter(node => {
            const range = fullLineRange(module, node);
            return offsetInModule(module, range.start) <= selectionStart &&
                selectionEnd <= offsetInModule(module, range.end);
        })
        : collectContainingNodes(module.syntax.root, offset)
            .filter(node => BLOCK_KINDS.has(node.kind)))
        .sort((left, right) => span(left) - span(right));

    if (blocks.length === 0) {
        return undefined;
    }

    if (!hasSelection) {
        return fullLineRange(module, blocks[0]);
    }

    for (const block of blocks) {
        const range = fullLineRange(module, block);
        const start = offsetInModule(module, range.start);
        const end = offsetInModule(module, range.end);
        if (
            start <= selectionStart &&
            selectionEnd <= end &&
            (start < selectionStart || selectionEnd < end)
        ) {
            return range;
        }
    }

    return fullLineRange(module, blocks[0]);
}

function collectBlockNodes(
    node: IRslSyntaxNode,
    result: IRslSyntaxNode[] = []
): IRslSyntaxNode[] {
    if (BLOCK_KINDS.has(node.kind)) {
        result.push(node);
    }
    node.children.forEach(child => collectBlockNodes(child, result));
    return result;
}

function rangesAreEmpty(range: Range): boolean {
    return range.start.line === range.end.line &&
        range.start.character === range.end.character;
}

function fullLineRange(module: IIndexedModule, node: IRslSyntaxNode): Range {
    const startPosition = positionInModule(module, node.start);
    const endPosition = positionInModule(module, Math.max(node.start, node.end));
    const lineStart = module.lex.lineStarts[startPosition.line] || 0;
    const nextLineStart = endPosition.line + 1 < module.lex.lineStarts.length
        ? module.lex.lineStarts[endPosition.line + 1]
        : module.source.length;
    const lineEnd = trimLineEnd(
        module.source,
        module.lex.lineStarts[endPosition.line] || 0,
        nextLineStart
    );
    return offsetRange(module, lineStart, lineEnd);
}

function findCurrentBlock(
    root: IRslSyntaxNode,
    offset: number
): IRslSyntaxNode | undefined {
    return collectContainingNodes(root, offset)
        .filter(node => BLOCK_KINDS.has(node.kind))
        .sort((left, right) => span(left) - span(right))[0];
}

function collectContainingNodes(
    node: IRslSyntaxNode,
    offset: number,
    result: IRslSyntaxNode[] = []
): IRslSyntaxNode[] {
    if (offset < node.start || offset > node.end) {
        return result;
    }

    result.push(node);
    node.children.forEach(child => collectContainingNodes(child, offset, result));
    return result;
}


function appendOutputSelectionRanges(
    module: IIndexedModule,
    offset: number,
    ranges: Range[]
): void {
    for (const output of parseOutputForms(module.lex.tokens)) {
        const outputEnd = output.closeParen?.end || output.form.end;
        if (offset < output.form.start || offset > outputEnd) {
            continue;
        }

        const argument = output.arguments.find(item =>
            item.start <= offset && offset <= item.end
        );
        if (argument) {
            ranges.push(offsetRange(module, argument.start, argument.end));
        }
        ranges.push(offsetRange(module, output.form.start, outputEnd));
        return;
    }
}

function statementRange(module: IIndexedModule, offset: number): Range {
    const line = positionInModule(module, offset).line;
    const start = module.lex.lineStarts[line] || 0;
    const end = line + 1 < module.lex.lineStarts.length
        ? module.lex.lineStarts[line + 1]
        : module.source.length;
    return offsetRange(module, start, trimLineEnd(module.source, start, end));
}

function trimLineEnd(source: string, start: number, end: number): number {
    while (end > start && (source.charAt(end - 1) === "\n" || source.charAt(end - 1) === "\r")) {
        end--;
    }
    return end;
}

function tokenAt(module: IIndexedModule, offset: number) {
    /* Бинарный поиск: проход по всему потоку стоил своего на каждый запрос. */
    return tokenAtOffset(module.lex.tokens, offset);
}

function deduplicateRanges(ranges: readonly Range[]): Range[] {
    const seen = new Set<string>();
    return ranges.filter(range => {
        const key = `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

function rangeSpan(module: IIndexedModule, range: Range): number {
    return offsetInModule(module, range.end) - offsetInModule(module, range.start);
}

function span(node: IRslSyntaxNode): number {
    return Math.max(0, node.end - node.start);
}

function offsetRange(module: IIndexedModule, start: number, end: number): Range {
    return { start: positionInModule(module, start), end: positionInModule(module, end) };
}



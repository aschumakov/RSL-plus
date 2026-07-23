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
        const offset = offsetAt(module, position);
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
    const offset = offsetAt(module, range.start);
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
    const block = findCurrentBlock(module.syntax.root, offsetAt(module, position));
    if (!block) {
        return undefined;
    }

    if (direction === "start") {
        return positionAt(module, block.start);
    }

    if (block.kind === "OnErrorClause") {
        const lastToken = [...module.syntax.tokens].reverse().find(token =>
            block.start <= token.start && token.end <= block.end
        );
        return positionAt(module, lastToken ? lastToken.start : block.end);
    }

    const endKeyword = [...module.syntax.tokens].reverse().find(token =>
        token.kind === "identifier" &&
        token.value.toLowerCase() === "end" &&
        block.start <= token.start &&
        token.end <= block.end
    );
    return positionAt(module, endKeyword ? endKeyword.start : block.end);
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
    const line = positionAt(module, offset).line;
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
    return module.lex.tokens.find(token => token.start <= offset && offset <= token.end);
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
    return offsetAt(module, range.end) - offsetAt(module, range.start);
}

function span(node: IRslSyntaxNode): number {
    return Math.max(0, node.end - node.start);
}

function offsetRange(module: IIndexedModule, start: number, end: number): Range {
    return { start: positionAt(module, start), end: positionAt(module, end) };
}

function positionAt(module: IIndexedModule, offset: number): Position {
    const starts = module.lex.lineStarts;
    let left = 0;
    let right = starts.length - 1;
    let line = 0;
    while (left <= right) {
        const middle = (left + right) >>> 1;
        if (starts[middle] <= offset) {
            line = middle;
            left = middle + 1;
        } else {
            right = middle - 1;
        }
    }
    return { line, character: Math.max(0, offset - starts[line]) };
}

function offsetAt(module: IIndexedModule, position: Position): number {
    const line = Math.max(0, Math.min(position.line, module.lex.lineStarts.length - 1));
    const start = module.lex.lineStarts[line];
    const end = line + 1 < module.lex.lineStarts.length
        ? module.lex.lineStarts[line + 1]
        : module.source.length;
    return Math.max(start, Math.min(start + position.character, end));
}

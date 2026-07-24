import {
    DocumentRangeFormattingParams,
    Range,
    TextEdit
} from "vscode-languageserver";
import type { TextDocument } from "vscode-languageserver-textdocument";

import { FormatCode } from "../format";

/**
 * Форматирует только полные строки, пересекающие выделение.
 *
 * Полный документ используется лишь как контекст вычисления отступов.
 * Единственный TextEdit затрагивает только выбранные строки.
 */
export function formatRslDocumentRange(
    document: TextDocument,
    params: DocumentRangeFormattingParams
): TextEdit[] {
    const source = document.getText();
    const formatted = FormatCode(source, params.options.tabSize);
    const startLine = Math.max(0, params.range.start.line);
    const requestedEndLine = params.range.end.character === 0 &&
        params.range.end.line > startLine
        ? params.range.end.line - 1
        : params.range.end.line;
    const endLine = Math.max(startLine, requestedEndLine);
    const replacementRange: Range = {
        start: { line: startLine, character: 0 },
        end: endLine + 1 < document.lineCount
            ? { line: endLine + 1, character: 0 }
            : document.positionAt(source.length)
    };
    const formattedOffsets = lineRangeOffsets(
        formatted,
        startLine,
        endLine
    );
    const newText = formatted.substring(
        formattedOffsets.start,
        formattedOffsets.end
    );
    const oldText = document.getText(replacementRange);

    return newText === oldText
        ? []
        : [TextEdit.replace(replacementRange, newText)];
}

function lineRangeOffsets(
    text: string,
    startLine: number,
    endLine: number
): { start: number; end: number } {
    const starts = [0];
    const expression = /\r\n|\n|\r/g;
    let match: RegExpExecArray | null;

    while ((match = expression.exec(text)) !== null) {
        starts.push(match.index + match[0].length);
    }

    const safeStart = Math.min(startLine, starts.length - 1);
    const start = starts[safeStart];
    const end = endLine + 1 < starts.length
        ? starts[endLine + 1]
        : text.length;

    return { start, end };
}

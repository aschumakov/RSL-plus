import {
    CodeAction,
    CodeActionKind,
    CodeActionParams,
    Diagnostic,
    Position,
    Range,
    TextEdit,
    WorkspaceEdit
} from "vscode-languageserver";

import {
    GetImportDefinitionTargetsFromTokens
} from "./execMacroDefinition";
import { IIndexedModule } from "./workspaceIndex";

interface IDiagnosticData {
    start?: number;
    end?: number;
    name?: string;
    parameter?: boolean;
    moduleName?: string;
}

/**
 * Quick Fixes для диагностик, где правка однозначна и не требует догадок.
 */
export function buildRslCodeActions(
    module: IIndexedModule,
    params: CodeActionParams
): CodeAction[] {
    const result: CodeAction[] = [];

    for (const diagnostic of params.context.diagnostics) {
        const code = String(diagnostic.code || "");
        let action: CodeAction | undefined;

        switch (code) {
            case "debugbreak":
                action = createDeleteStatementAction(
                    module,
                    diagnostic,
                    "Удалить DEBUGBREAK"
                );
                break;

            case "unused-import":
                action = createRemoveImportAction(
                    module,
                    diagnostic,
                    "Удалить неиспользуемый Import"
                );
                break;

            case "duplicate-import":
                action = createRemoveImportAction(
                    module,
                    diagnostic,
                    "Удалить повторный Import"
                );
                break;

            case "unused-declaration":
                action = createRemoveSingleDeclarationAction(
                    module,
                    diagnostic
                );
                break;

            case "duplicate-else":
                action = createDeleteTokenAction(
                    module,
                    diagnostic,
                    "Удалить повторный ELSE"
                );
                break;

            case "extra-closing-bracket":
                action = createDeleteTokenAction(
                    module,
                    diagnostic,
                    "Удалить лишнюю скобку"
                );
                break;

            case "extra-end":
                action = createDeleteStatementAction(
                    module,
                    diagnostic,
                    "Удалить лишний END"
                );
                break;

            case "implicit-string-concatenation":
                action = createInsertTextAction(
                    module,
                    diagnostic,
                    "Добавить '+' между строками",
                    "+ "
                );
                break;

            default:
                break;
        }

        if (action) {
            result.push(action);
        }
    }

    return result;
}

function createDeleteStatementAction(
    module: IIndexedModule,
    diagnostic: Diagnostic,
    title: string
): CodeAction {
    const offsets = getDiagnosticOffsets(module, diagnostic);
    const range = getStatementOrLineRange(
        module,
        offsets.start,
        offsets.end
    );

    return createAction(
        module.uri,
        diagnostic,
        title,
        {
            range: offsetRange(module, range.start, range.end),
            newText: ""
        }
    );
}

function createDeleteTokenAction(
    module: IIndexedModule,
    diagnostic: Diagnostic,
    title: string
): CodeAction {
    const offsets = getDiagnosticOffsets(module, diagnostic);

    return createAction(
        module.uri,
        diagnostic,
        title,
        {
            range: offsetRange(module, offsets.start, offsets.end),
            newText: ""
        }
    );
}

function createInsertTextAction(
    module: IIndexedModule,
    diagnostic: Diagnostic,
    title: string,
    newText: string
): CodeAction {
    const offsets = getDiagnosticOffsets(module, diagnostic);

    return createAction(
        module.uri,
        diagnostic,
        title,
        {
            range: offsetRange(module, offsets.start, offsets.start),
            newText
        }
    );
}

function createRemoveImportAction(
    module: IIndexedModule,
    diagnostic: Diagnostic,
    title: string
): CodeAction | undefined {
    const offsets = getDiagnosticOffsets(module, diagnostic);
    const reference = GetImportDefinitionTargetsFromTokens(module.lex.tokens)
        .find(item =>
            item.start === offsets.start ||
            (
                item.start <= offsets.start &&
                offsets.end <= item.end
            )
        );

    if (!reference) {
        return undefined;
    }

    const range = getImportRemovalRange(
        module.source,
        reference.start,
        reference.end
    );

    if (!range) {
        return undefined;
    }

    return createAction(
        module.uri,
        diagnostic,
        title,
        {
            range: offsetRange(module, range.start, range.end),
            newText: ""
        }
    );
}

/**
 * Для неиспользуемого объявления предлагаем удаление только тогда,
 * когда Var/Const содержит ровно одно имя. Списки и параметры не меняем:
 * там автоматическая правка слишком легко затронет тип или значение соседа.
 */
function createRemoveSingleDeclarationAction(
    module: IIndexedModule,
    diagnostic: Diagnostic
): CodeAction | undefined {
    const data = diagnostic.data as IDiagnosticData | undefined;

    if (data?.parameter) {
        return undefined;
    }

    const offsets = getDiagnosticOffsets(module, diagnostic);
    const line = getLineOffsets(module, diagnostic.range.start.line);
    const text = module.source.substring(line.start, line.end);
    const declaration = text.replace(/\/\/.*$/, "");

    if (
        declaration.indexOf(",") >= 0 ||
        !/^\s*(?:(?:private|local|public)\s+)?(?:var|const)\s+[A-Za-z_$][\w$]*(?:\s*:\s*[^;=]+)?(?:\s*=\s*[^;]+)?;\s*$/i.test(declaration)
    ) {
        return undefined;
    }

    if (offsets.start < line.start || offsets.end > line.end) {
        return undefined;
    }

    const removal = includeFollowingNewline(module.source, line.start, line.end);

    return createAction(
        module.uri,
        diagnostic,
        "Удалить неиспользуемое объявление",
        {
            range: offsetRange(module, removal.start, removal.end),
            newText: ""
        }
    );
}

function createAction(
    uri: string,
    diagnostic: Diagnostic,
    title: string,
    edit: TextEdit
): CodeAction {
    const workspaceEdit: WorkspaceEdit = {
        changes: {
            [uri]: [edit]
        }
    };

    return {
        title,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        isPreferred: true,
        edit: workspaceEdit
    };
}

function getImportRemovalRange(
    source: string,
    start: number,
    end: number
): { start: number; end: number } | undefined {
    const statementStart = Math.max(
        source.lastIndexOf(";", start - 1) + 1,
        source.lastIndexOf("\n", start - 1) + 1
    );
    const semicolon = source.indexOf(";", end);

    if (semicolon < 0) {
        return undefined;
    }

    const after = source.substring(end, semicolon);
    const commaAfter = after.match(/^\s*,\s*/);

    if (commaAfter) {
        return {
            start,
            end: end + commaAfter[0].length
        };
    }

    const before = source.substring(statementStart, start);
    const commaBefore = before.match(/,\s*$/);

    if (commaBefore && commaBefore.index !== undefined) {
        return {
            start: statementStart + commaBefore.index,
            end
        };
    }

    const prefix = before.toLowerCase();

    if (!/\bimport\s*$/.test(prefix)) {
        return undefined;
    }

    return includeFollowingNewline(source, statementStart, semicolon + 1);
}

function getStatementOrLineRange(
    module: IIndexedModule,
    start: number,
    end: number
): { start: number; end: number } {
    const lineNumber = positionAt(module, start).line;
    const line = getLineOffsets(module, lineNumber);
    const before = module.source.substring(line.start, start).trim();
    const after = module.source.substring(end, line.end).trim();

    if (
        before.length === 0 &&
        (after.length === 0 || /^\(?\s*\)?\s*;?\s*$/.test(after))
    ) {
        return includeFollowingNewline(module.source, line.start, line.end);
    }

    let statementEnd = end;

    while (
        statementEnd < module.source.length &&
        /[\s();]/.test(module.source.charAt(statementEnd))
    ) {
        if (module.source.charAt(statementEnd) === "\n") {
            break;
        }
        statementEnd++;
    }

    return {
        start,
        end: statementEnd
    };
}

function includeFollowingNewline(
    source: string,
    start: number,
    end: number
): { start: number; end: number } {
    let resultEnd = end;

    if (source.substr(resultEnd, 2) === "\r\n") {
        resultEnd += 2;
    } else if (
        source.charAt(resultEnd) === "\n" ||
        source.charAt(resultEnd) === "\r"
    ) {
        resultEnd++;
    }

    return {
        start,
        end: resultEnd
    };
}

function getDiagnosticOffsets(
    module: IIndexedModule,
    diagnostic: Diagnostic
): { start: number; end: number } {
    const data = diagnostic.data as IDiagnosticData | undefined;

    return {
        start: typeof data?.start === "number"
            ? data.start
            : offsetAt(module, diagnostic.range.start),
        end: typeof data?.end === "number"
            ? data.end
            : offsetAt(module, diagnostic.range.end)
    };
}

function getLineOffsets(
    module: IIndexedModule,
    line: number
): { start: number; end: number } {
    const start = module.lex.lineStarts[Math.max(0, line)] || 0;
    const next = line + 1 < module.lex.lineStarts.length
        ? module.lex.lineStarts[line + 1]
        : module.source.length;
    let end = next;

    while (
        end > start &&
        (module.source.charAt(end - 1) === "\n" ||
            module.source.charAt(end - 1) === "\r")
    ) {
        end--;
    }

    return { start, end };
}

function offsetRange(
    module: IIndexedModule,
    start: number,
    end: number
): Range {
    return {
        start: positionAt(module, start),
        end: positionAt(module, end)
    };
}

function positionAt(module: IIndexedModule, offset: number): Position {
    const starts = module.lex.lineStarts;
    let left = 0;
    let right = starts.length - 1;
    let line = 0;

    while (left <= right) {
        const middle = Math.floor((left + right) / 2);

        if (starts[middle] <= offset) {
            line = middle;
            left = middle + 1;
        } else {
            right = middle - 1;
        }
    }

    return {
        line,
        character: Math.max(0, offset - starts[line])
    };
}

function offsetAt(module: IIndexedModule, position: Position): number {
    const line = Math.max(
        0,
        Math.min(position.line, module.lex.lineStarts.length - 1)
    );
    const lineStart = module.lex.lineStarts[line];
    const lineEnd = line + 1 < module.lex.lineStarts.length
        ? module.lex.lineStarts[line + 1]
        : module.source.length;

    return Math.max(
        lineStart,
        Math.min(lineStart + position.character, lineEnd)
    );
}

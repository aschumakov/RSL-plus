import {
    CodeAction,
    CodeActionKind,
    CodeActionParams,
    TextEdit
} from "vscode-languageserver";

import type { IIndexedModule } from "../workspaceIndex";
import { buildEnhancedRslCodeActions } from "./enhancedCodeActions";

export const RSL_FIX_ALL_KIND = `${CodeActionKind.SourceFixAll}.rsl`;

const SAFE_FIX_ALL_CODES = new Set([
    "debugbreak",
    "duplicate-import",
    "duplicate-semicolon"
]);

/** Source actions не показываются как lightbulb при каждом движении курсора. */
export function buildRslSourceCodeActions(
    module: IIndexedModule,
    params: CodeActionParams
): CodeAction[] {
    const result: CodeAction[] = [];

    if (requestedKind(params, CodeActionKind.SourceOrganizeImports)) {
        const organize = buildOrganizeImportsAction(module);
        if (organize) {
            result.push(organize);
        }
    }

    if (
        requestedKind(params, CodeActionKind.SourceFixAll) ||
        requestedKind(params, RSL_FIX_ALL_KIND)
    ) {
        const fixAll = buildSafeFixAllAction(module, params);
        if (fixAll) {
            result.push(fixAll);
        }
    }

    return result;
}

function buildSafeFixAllAction(
    module: IIndexedModule,
    params: CodeActionParams
): CodeAction | undefined {
    const diagnostics = params.context.diagnostics.filter(diagnostic =>
        SAFE_FIX_ALL_CODES.has(String(diagnostic.code || ""))
    );
    if (diagnostics.length === 0) {
        return undefined;
    }

    const actions = buildEnhancedRslCodeActions(module, {
        ...params,
        context: { ...params.context, diagnostics }
    });
    const edits = nonOverlappingEdits(
        module,
        actions.flatMap(action => action.edit?.changes?.[module.uri] || [])
    );
    if (edits.length === 0) {
        return undefined;
    }

    return {
        title: `RSL: исправить безопасные проблемы (${edits.length})`,
        kind: RSL_FIX_ALL_KIND,
        diagnostics,
        edit: { changes: { [module.uri]: edits } }
    };
}

function buildOrganizeImportsAction(
    module: IIndexedModule
): CodeAction | undefined {
    const declarations = module.syntax.root.children.filter(node =>
        node.kind === "ImportDeclaration"
    );
    const seen = new Set<string>();
    const edits: TextEdit[] = [];

    for (const declaration of declarations) {
        const items = declaration.children.filter(item =>
            item.kind === "ImportItem" && !!item.name
        );
        if (items.length === 0) {
            continue;
        }

        const kept = items.filter(item => {
            const key = normalizeImport(item.name!);
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
        if (kept.length === items.length) {
            continue;
        }

        const semicolon = followingSemicolon(module, declaration.end);
        if (
            semicolon < 0 ||
            containsComment(module, declaration.start, semicolon)
        ) {
            continue;
        }

        if (kept.length === 0) {
            const line = wholeLine(module.source, declaration.start, semicolon + 1);
            edits.push(TextEdit.replace(
                offsetRange(module, line.start, line.end),
                ""
            ));
            continue;
        }

        const prefix = module.source.substring(
            declaration.start,
            items[0].start
        );
        const itemTexts = kept.map(item =>
            module.source.substring(item.start, item.end)
        );
        edits.push(TextEdit.replace(
            offsetRange(module, declaration.start, semicolon + 1),
            `${prefix}${itemTexts.join(", ")};`
        ));
    }

    return edits.length > 0
        ? {
            title: "RSL: упорядочить Import (удалить повторы)",
            kind: CodeActionKind.SourceOrganizeImports,
            edit: { changes: { [module.uri]: edits } }
        }
        : undefined;
}

function requestedKind(params: CodeActionParams, expected: string): boolean {
    const only = params.context.only;
    return !!only && only.some(kind =>
        String(kind) === expected || String(kind).startsWith(expected + ".")
    );
}

function nonOverlappingEdits(
    module: IIndexedModule,
    edits: readonly TextEdit[]
): TextEdit[] {
    const sorted = edits.slice().sort((left, right) =>
        offsetAt(module, right.range.start) -
        offsetAt(module, left.range.start)
    );
    const result: TextEdit[] = [];
    let nearestStart = module.source.length + 1;

    for (const edit of sorted) {
        const start = offsetAt(module, edit.range.start);
        const end = offsetAt(module, edit.range.end);
        if (end > nearestStart) {
            continue;
        }
        result.push(edit);
        nearestStart = start;
    }
    return result;
}

function containsComment(
    module: IIndexedModule,
    start: number,
    end: number
): boolean {
    return module.lex.tokens.some(token =>
        token.kind === "comment" &&
        start <= token.start &&
        token.start <= end
    );
}

function followingSemicolon(module: IIndexedModule, offset: number): number {
    for (const token of module.lex.tokens) {
        if (token.start < offset) {
            continue;
        }
        if (
            token.kind === "whitespace" ||
            token.kind === "newline" ||
            token.kind === "comment"
        ) {
            continue;
        }
        return token.kind === "symbol" && token.raw === ";"
            ? token.start
            : -1;
    }
    return -1;
}

function normalizeImport(value: string): string {
    return value.trim().replace(/\\/g, "/").replace(/\.mac$/i, "").toLowerCase();
}

function wholeLine(source: string, start: number, end: number) {
    const lineStart = Math.max(0, source.lastIndexOf("\n", start - 1) + 1);
    if (source.substring(lineStart, start).trim()) {
        return { start, end };
    }
    if (source.substr(end, 2) === "\r\n") {
        end += 2;
    } else if (source.charAt(end) === "\r" || source.charAt(end) === "\n") {
        end++;
    }
    return { start: lineStart, end };
}

function offsetRange(module: IIndexedModule, start: number, end: number) {
    return { start: positionAt(module, start), end: positionAt(module, end) };
}

function positionAt(module: IIndexedModule, offset: number) {
    const starts = module.lex.lineStarts;
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1] <= offset) {
        line++;
    }
    return { line, character: Math.max(0, offset - starts[line]) };
}

function offsetAt(module: IIndexedModule, position: { line: number; character: number }) {
    const line = Math.max(0, Math.min(position.line, module.lex.lineStarts.length - 1));
    return Math.min(
        module.source.length,
        module.lex.lineStarts[line] + Math.max(0, position.character)
    );
}

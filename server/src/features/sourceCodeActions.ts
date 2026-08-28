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

/**
 * Source actions не показываются как lightbulb при каждом движении курсора.
 *
 * Организация Import живёт не здесь, а в реестре рефакторингов: у неё четыре
 * раздельных действия и правка, которая считается по требованию.
 */
export function buildRslSourceCodeActions(
    module: IIndexedModule,
    params: CodeActionParams
): CodeAction[] {
    if (
        !requestedKind(params, CodeActionKind.SourceFixAll) &&
        !requestedKind(params, RSL_FIX_ALL_KIND)
    ) {
        return [];
    }

    const fixAll = buildSafeFixAllAction(module, params);

    return fixAll ? [fixAll] : [];
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

function offsetAt(
    module: IIndexedModule,
    position: { line: number; character: number }
) {
    const line = Math.max(
        0,
        Math.min(position.line, module.lex.lineStarts.length - 1)
    );
    return Math.min(
        module.source.length,
        module.lex.lineStarts[line] + Math.max(0, position.character)
    );
}

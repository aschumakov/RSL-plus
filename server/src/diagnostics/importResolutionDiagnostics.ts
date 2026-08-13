import {
    Diagnostic,
    DiagnosticSeverity
} from "vscode-languageserver";

import { positionAtOffset } from "../core/documentPosition";
import { GetImportDefinitionTargetsFromTokens } from "../execMacroDefinition";
import type { IRslDiagnosticSettings } from "../interfaces";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

/** Предупреждает, когда Import по одному basename соответствует нескольким файлам. */
export function buildImportResolutionDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    settings?: IRslDiagnosticSettings
): Diagnostic[] {
    if (settings?.structure === false) {
        return [];
    }

    const result: Diagnostic[] = [];

    for (const reference of GetImportDefinitionTargetsFromTokens(
        module.lex.tokens
    )) {
        const resolution = index.resolveWorkspaceFile(reference.moduleName);

        if (resolution.kind !== "ambiguous") {
            continue;
        }

        const candidates = resolution.candidates
            .map(uri => displayUri(uri))
            .sort();

        result.push({
            severity: DiagnosticSeverity.Warning,
            range: {
                start: positionAtOffset(
                    module.lex.lineStarts,
                    reference.start
                ),
                end: positionAtOffset(module.lex.lineStarts, reference.end)
            },
            message:
                `Import ${reference.moduleName} неоднозначен: ` +
                candidates.join(", "),
            source: "RSL parser",
            code: "ambiguous-import",
            data: {
                start: reference.start,
                end: reference.end,
                moduleName: reference.moduleName,
                candidates: resolution.candidates
            }
        });
    }

    return result;
}

function displayUri(uri: string): string {
    return decodeURIComponent(uri)
        .replace(/^file:\/\//i, "")
        .replace(/\\/g, "/");
}


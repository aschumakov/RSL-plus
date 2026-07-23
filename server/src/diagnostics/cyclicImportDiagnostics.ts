import * as path from "path";
import { fileURLToPath } from "url";

import {
    Diagnostic,
    DiagnosticSeverity
} from "vscode-languageserver/node";

import { GetImportDefinitionTargetsFromTokens } from "../execMacroDefinition";
import type { IRslDiagnosticSettings } from "../interfaces";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

interface ICycleResult {
    cycle: string[];
    rootImportName: string;
}

export function buildCyclicImportDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    settings?: IRslDiagnosticSettings
): Diagnostic[] {
    if (settings?.structure === false || !index.areImportsEnabled) {
        return [];
    }

    const found = findCycle(module, index);
    if (!found) {
        return [];
    }

    const reference = GetImportDefinitionTargetsFromTokens(module.lex.tokens)
        .find(item => sameModuleName(item.moduleName, found.rootImportName));
    if (!reference) {
        return [];
    }

    return [{
        severity: DiagnosticSeverity.Warning,
        range: {
            start: positionAt(module, reference.start),
            end: positionAt(module, reference.end)
        },
        message: "Обнаружен циклический Import: " +
            found.cycle.map(displayModule).join(" → "),
        source: "RSL parser",
        code: "cyclic-import",
        data: {
            start: reference.start,
            end: reference.end,
            moduleName: reference.moduleName,
            cycle: found.cycle
        }
    }];
}

function findCycle(
    root: IIndexedModule,
    index: WorkspaceIndex
): ICycleResult | undefined {
    const state = new Map<string, "visiting" | "visited">();
    const stack: string[] = [];

    const visit = (
        uri: string,
        rootImportName: string
    ): ICycleResult | undefined => {
        const currentState = state.get(uri);
        if (currentState === "visiting") {
            const start = stack.indexOf(uri);
            return {
                cycle: [...stack.slice(Math.max(0, start)), uri],
                rootImportName
            };
        }
        if (currentState === "visited") {
            return undefined;
        }

        const current = index.getModule(uri);
        if (!current) {
            return undefined;
        }

        state.set(uri, "visiting");
        stack.push(uri);

        for (const importName of current.imports) {
            const resolution = index.resolveModule(importName);
            if (resolution.kind !== "resolved") {
                continue;
            }
            const found = visit(
                resolution.value.uri,
                uri === root.uri ? importName : rootImportName
            );
            if (found) {
                return found;
            }
        }

        stack.pop();
        state.set(uri, "visited");
        return undefined;
    };

    return visit(root.uri, root.imports[0] || "");
}

function sameModuleName(left: string, right: string): boolean {
    return normalizeName(left) === normalizeName(right);
}

function normalizeName(value: string): string {
    return value.replace(/\\/g, "/").replace(/\.mac$/i, "").toLowerCase();
}

function displayModule(uri: string): string {
    try {
        return path.basename(fileURLToPath(uri));
    } catch (_error) {
        return path.basename(decodeURIComponent(uri).replace(/\\/g, "/"));
    }
}

function positionAt(
    module: IIndexedModule,
    offset: number
): { line: number; character: number } {
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

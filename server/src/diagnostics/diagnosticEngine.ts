import type { Diagnostic } from "vscode-languageserver";

import { applyProjectDiagnosticRules } from "./diagnosticPostProcessor";
import {
    buildRslDiagnostics,
    normalizeDiagnosticSettings
} from "../diagnostics";
import { buildImportResolutionDiagnostics } from "./importResolutionDiagnostics";
import type { IRslDiagnosticSettings } from "../interfaces";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

export interface IRslDiagnosticContext {
    module: IIndexedModule;
    index: WorkspaceIndex;
    settings: IRslDiagnosticSettings | undefined;
}

export interface IRslDiagnosticRule {
    id: string;
    run(context: IRslDiagnosticContext): Diagnostic[];
}

/**
 * Реестр диагностик. Parser, semantic-анализ и правила RS-Bank подключаются
 * отдельными правилами вместо неявной цепочки из server.ts.
 */
export class RslDiagnosticEngine {
    private rules: IRslDiagnosticRule[] = [];

    constructor() {
        this.register({
            id: "core",
            run: context => buildRslDiagnostics(
                context.module,
                context.index,
                context.settings
            )
        });
        this.register({
            id: "import-resolution",
            run: context => buildImportResolutionDiagnostics(
                context.module,
                context.index,
                context.settings
            )
        });
    }

    register(rule: IRslDiagnosticRule): void {
        if (this.rules.some(item => item.id === rule.id)) {
            throw new Error(`Diagnostic rule already registered: ${rule.id}`);
        }

        this.rules.push(rule);
    }

    build(
        module: IIndexedModule,
        index: WorkspaceIndex,
        settings?: IRslDiagnosticSettings
    ): Diagnostic[] {
        const options = normalizeDiagnosticSettings(settings);

        if (!options.enabled || options.maxProblems === 0) {
            return [];
        }

        const diagnostics: Diagnostic[] = [];

        for (const rule of this.rules) {
            const remaining = options.maxProblems - diagnostics.length;

            if (remaining <= 0) {
                break;
            }

            const ruleSettings = {
                ...(settings || {}),
                maxProblems: remaining
            };
            diagnostics.push(...rule.run({
                module,
                index,
                settings: ruleSettings
            }).slice(0, remaining));
        }

        const processed = applyProjectDiagnosticRules(module, diagnostics);
        return deduplicate(processed).slice(0, options.maxProblems);
    }
}

function deduplicate(items: Diagnostic[]): Diagnostic[] {
    const result: Diagnostic[] = [];
    const seen = new Set<string>();

    for (const item of items) {
        const key = [
            item.code || "",
            item.range.start.line,
            item.range.start.character,
            item.range.end.line,
            item.range.end.character,
            item.message
        ].join(":");

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(item);
    }

    return result;
}

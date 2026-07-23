import type { Diagnostic } from "vscode-languageserver";

import { applyProjectDiagnosticRules } from "./diagnosticPostProcessor";
import {
    buildRslDiagnostics,
    normalizeDiagnosticSettings
} from "../diagnostics";
import { buildImportResolutionDiagnostics } from "./importResolutionDiagnostics";
import type { IRslDiagnosticSettings } from "../interfaces";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

export type DiagnosticPhase = "local" | "workspace";

export interface IRslDiagnosticContext {
    module: IIndexedModule;
    index: WorkspaceIndex;
    settings: IRslDiagnosticSettings | undefined;
}

export interface IRslDiagnosticRule {
    id: string;
    phase?: DiagnosticPhase;
    run(context: IRslDiagnosticContext): Diagnostic[];
}

/**
 * Двухфазный реестр диагностик.
 * Локальные ошибки публикуются без ожидания Import; workspace-проверки приходят позже.
 */
export class RslDiagnosticEngine {
    private rules: IRslDiagnosticRule[] = [];

    constructor() {
        this.register({
            id: "core-local",
            phase: "local",
            run: context => buildRslDiagnostics(
                context.module,
                context.index,
                localSettings(context.settings)
            )
        });
        this.register({
            id: "core-workspace",
            phase: "workspace",
            run: context => buildRslDiagnostics(
                context.module,
                context.index,
                workspaceSettings(context.settings)
            )
        });
        this.register({
            id: "import-resolution",
            phase: "workspace",
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
        this.rules.push({ ...rule, phase: rule.phase || "local" });
    }

    buildLocal(
        module: IIndexedModule,
        index: WorkspaceIndex,
        settings?: IRslDiagnosticSettings
    ): Diagnostic[] {
        return this.buildPhase("local", module, index, settings);
    }

    buildWorkspace(
        module: IIndexedModule,
        index: WorkspaceIndex,
        settings?: IRslDiagnosticSettings
    ): Diagnostic[] {
        return this.buildPhase("workspace", module, index, settings);
    }

    /** Совместимый полный результат для тестов и прямых вызовов. */
    build(
        module: IIndexedModule,
        index: WorkspaceIndex,
        settings?: IRslDiagnosticSettings
    ): Diagnostic[] {
        const options = normalizeDiagnosticSettings(settings);
        if (!options.enabled || options.maxProblems === 0) {
            return [];
        }
        const local = this.buildLocal(module, index, settings);
        const remaining = Math.max(0, options.maxProblems - local.length);
        const workspace = remaining > 0
            ? this.buildWorkspace(module, index, {
                ...(settings || {}),
                maxProblems: remaining
            })
            : [];
        return deduplicate([...local, ...workspace]).slice(0, options.maxProblems);
    }

    private buildPhase(
        phase: DiagnosticPhase,
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
            if ((rule.phase || "local") !== phase) {
                continue;
            }
            const remaining = options.maxProblems - diagnostics.length;
            if (remaining <= 0) {
                break;
            }
            diagnostics.push(...rule.run({
                module,
                index,
                settings: {
                    ...(settings || {}),
                    maxProblems: remaining
                }
            }).slice(0, remaining));
        }

        const processed = applyProjectDiagnosticRules(module, diagnostics);
        return deduplicate(processed).slice(0, options.maxProblems);
    }
}


function localSettings(
    settings?: IRslDiagnosticSettings
): IRslDiagnosticSettings {
    return {
        ...(settings || {}),
        unusedImports: false,
        ambiguousReferences: false
    };
}

function workspaceSettings(
    settings?: IRslDiagnosticSettings
): IRslDiagnosticSettings {
    const options = normalizeDiagnosticSettings(settings);
    return {
        enabled: options.enabled,
        deprecatedDeclarations: false,
        structure: false,
        unusedVariables: false,
        unusedImports: options.unusedImports,
        debugBreak: false,
        useBeforeDeclaration: false,
        ambiguousReferences: options.ambiguousReferences,
        maxProblems: options.maxProblems
    };
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
        if (!seen.has(key)) {
            seen.add(key);
            result.push(item);
        }
    }
    return result;
}

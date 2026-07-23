import type { Diagnostic } from "vscode-languageserver";

import { applyProjectDiagnosticRules } from "./diagnosticPostProcessor";
import {
    buildRslDiagnostics,
    normalizeDiagnosticSettings
} from "../diagnostics";
import { buildImportResolutionDiagnostics } from "./importResolutionDiagnostics";
import type { IRslDiagnosticSettings } from "../interfaces";
import { normalizeIdentifier } from "../lexer";
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
        const normalized = suppressValidOnErrorDiagnostics(module, processed);
        return deduplicate(normalized).slice(0, options.maxProblems);
    }
}


/**
 * ONERROR разрешён не только внутри MACRO. В исполняемом макрофайле он может
 * открывать обработчик ошибок до конца файла и не требует собственного END.
 * Старый structural-анализатор всё ещё выдаёт два ложных семейства сообщений;
 * нормализуем их на границе diagnostic engine, не скрывая остальные END-ошибки.
 */
function suppressValidOnErrorDiagnostics(
    module: IIndexedModule,
    diagnostics: Diagnostic[]
): Diagnostic[] {
    return diagnostics.filter(diagnostic =>
        !isInvalidOnErrorDiagnostic(module, diagnostic)
    );
}

function isInvalidOnErrorDiagnostic(
    module: IIndexedModule,
    diagnostic: Diagnostic
): boolean {
    const code = String(diagnostic.code || "").toLowerCase();
    const message = (diagnostic.message || "").toLowerCase();
    const mentionsOnError = code.includes("onerror") ||
        message.includes("onerror");

    if (
        code === "onerror-outside-macro" ||
        (mentionsOnError && message.includes("macro"))
    ) {
        return true;
    }

    const requiresEnd =
        code === "missing-end" ||
        code === "extra-end" ||
        /(^|[-_])end($|[-_])/.test(code) ||
        /\bend\b/.test(message);

    return requiresEnd && (
        mentionsOnError || diagnosticPointsToOnError(module, diagnostic)
    );
}

function diagnosticPointsToOnError(
    module: IIndexedModule,
    diagnostic: Diagnostic
): boolean {
    const start = diagnostic.range.start;
    const end = diagnostic.range.end;

    return module.lex.tokens.some(token =>
        token.kind === "identifier" &&
        normalizeIdentifier(token.value) === "onerror" &&
        positionInsideDiagnostic(
            token.line,
            token.character,
            start.line,
            start.character,
            end.line,
            end.character
        )
    );
}

function positionInsideDiagnostic(
    line: number,
    character: number,
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number
): boolean {
    if (line < startLine || line > endLine) {
        return false;
    }

    if (line === startLine && character < startCharacter) {
        return false;
    }

    if (line === endLine && character > endCharacter) {
        return false;
    }

    return true;
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

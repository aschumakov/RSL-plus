import type {
    CodeAction,
    CodeActionParams,
    Diagnostic
} from "vscode-languageserver";

import type { IIndexedModule } from "../workspaceIndex";

/**
 * Настройки, влияющие на вставляемый текст.
 *
 * Исправление дописывает код за пользователя, и регистр этого кода —
 * настройка проекта, а не свойство исправления.
 */
export interface IRslQuickFixOptions {
    keywordCase?: string;
}

export type RslQuickFixProvider = (
    module: IIndexedModule,
    diagnostic: Diagnostic,
    params: CodeActionParams,
    options: IRslQuickFixOptions
) => CodeAction | CodeAction[] | undefined;

/** Централизованный реестр фабрик Quick Fix по diagnostic.code. */
export class RslQuickFixRegistry {
    private providers = new Map<string, RslQuickFixProvider[]>();
    private fallbackProvider: RslQuickFixProvider | undefined;

    register(code: string, provider: RslQuickFixProvider): void {
        const key = normalizeCode(code);
        const items = this.providers.get(key) || [];
        items.push(provider);
        this.providers.set(key, items);
    }

    /**
     * Compatibility-провайдер для старых исправлений. Новое правило можно
     * переносить в register(code, provider) независимо от остальных.
     */
    setFallback(provider: RslQuickFixProvider): void {
        this.fallbackProvider = provider;
    }

    build(
        module: IIndexedModule,
        params: CodeActionParams,
        options: IRslQuickFixOptions = {}
    ): CodeAction[] {
        const result: CodeAction[] = [];

        for (const diagnostic of params.context.diagnostics) {
            const providers = this.providers.get(
                normalizeCode(diagnostic.code)
            ) || [];
            const customActions = collectActions(
                providers,
                module,
                diagnostic,
                params,
                options
            );

            if (customActions.length > 0) {
                result.push(...customActions);
                continue;
            }

            if (this.fallbackProvider) {
                result.push(...normalizeActions(this.fallbackProvider(
                    module,
                    diagnostic,
                    params,
                    options
                )));
            }
        }

        return deduplicateActions(result);
    }
}

function collectActions(
    providers: readonly RslQuickFixProvider[],
    module: IIndexedModule,
    diagnostic: Diagnostic,
    params: CodeActionParams,
    options: IRslQuickFixOptions
): CodeAction[] {
    const result: CodeAction[] = [];

    for (const provider of providers) {
        result.push(...normalizeActions(provider(
            module,
            diagnostic,
            params,
            options
        )));
    }

    return result;
}

function normalizeActions(
    value: CodeAction | CodeAction[] | undefined
): CodeAction[] {
    if (!value) {
        return [];
    }

    return Array.isArray(value) ? value : [value];
}

function normalizeCode(code: Diagnostic["code"]): string {
    return String(code || "").trim().toLowerCase();
}

function deduplicateActions(actions: readonly CodeAction[]): CodeAction[] {
    const result: CodeAction[] = [];
    const seen = new Set<string>();

    for (const action of actions) {
        const key = [
            action.kind || "",
            action.title,
            JSON.stringify(action.edit || {})
        ].join(":");

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(action);
    }

    return result;
}

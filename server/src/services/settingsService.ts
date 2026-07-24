import type { IRslSettings } from "../interfaces";

/**
 * Хранит уже разрешённые клиентом настройки.
 *
 * VS Code умеет учитывать resource scope быстрее и точнее на стороне
 * Extension Host. Клиент передаёт готовый snapshot при активации документа,
 * поэтому language server больше не выполняет workspace/configuration
 * round-trip для каждой открытой вкладки.
 */
export class RslSettingsService {
    private workspaceSettings: IRslSettings;
    private documentSettings = new Map<string, IRslSettings>();
    private resolvedListeners = new Set<
        (resource: string, settings: IRslSettings) => void
    >();

    constructor(private defaults: IRslSettings) {
        this.workspaceSettings = cloneSettings(defaults);
    }

    updateFromConfiguration(settingsRoot: unknown): void {
        const root = isRecord(settingsRoot) ? settingsRoot : {};
        const value = isRecord(root.RSLanguageServer)
            ? root.RSLanguageServer
            : root;

        this.workspaceSettings = mergeSettings(this.defaults, value);
    }

    /**
     * Обновляет resource-настройки активного документа без LSP-запроса.
     * Возвращает true, только если применённый snapshot действительно изменён.
     */
    updateResource(resource: string, settings: unknown): boolean {
        if (!resource) {
            return false;
        }

        const resolved = mergeSettings(this.defaults, settings);
        const previous = this.getAvailable(resource);
        this.documentSettings.set(resource, resolved);

        if (settingsEqual(previous, resolved)) {
            return false;
        }

        for (const listener of this.resolvedListeners) {
            listener(resource, cloneSettings(resolved));
        }
        return true;
    }

    getAvailable(resource: string): IRslSettings {
        return cloneSettings(
            this.documentSettings.get(resource) ??
            this.workspaceSettings
        );
    }

    clear(resource: string): void {
        this.documentSettings.delete(resource);
    }

    clearAll(): void {
        this.documentSettings.clear();
    }

    getWorkspaceSnapshot(): IRslSettings {
        return cloneSettings(this.workspaceSettings);
    }

    onDidResolve(
        listener: (resource: string, settings: IRslSettings) => void
    ): () => void {
        this.resolvedListeners.add(listener);
        return () => this.resolvedListeners.delete(listener);
    }
}

function mergeSettings(
    defaults: IRslSettings,
    value: unknown
): IRslSettings {
    const input = isRecord(value) ? value : {};
    const diagnostics = isRecord(input.diagnostics)
        ? input.diagnostics
        : {};

    return {
        import: typeof input.import === "string"
            ? input.import
            : defaults.import,
        diagnostics: {
            ...(defaults.diagnostics || {}),
            ...diagnostics
        }
    };
}

function cloneSettings(value: IRslSettings): IRslSettings {
    return {
        import: value.import,
        diagnostics: {
            ...(value.diagnostics || {})
        }
    };
}

function settingsEqual(
    left: IRslSettings,
    right: IRslSettings
): boolean {
    return left.import === right.import &&
        JSON.stringify(left.diagnostics || {}) ===
        JSON.stringify(right.diagnostics || {});
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

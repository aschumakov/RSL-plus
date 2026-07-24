import type { Connection } from "vscode-languageserver/node";

import type { IRslSettings } from "../interfaces";

/**
 * Изолирует workspace-настройки от resource-настроек конкретного документа.
 * Раньше последний завершившийся getConfiguration перезаписывал общий объект
 * globalSettings и мог повлиять на диагностику другого открытого файла.
 */
export class RslSettingsService {
    private hasConfigurationCapability = false;
    private workspaceSettings: IRslSettings;
    private documentSettings = new Map<string, Promise<IRslSettings>>();
    private resolvedDocumentSettings = new Map<string, IRslSettings>();
    private resolvedListeners = new Set<
        (resource: string, settings: IRslSettings) => void
    >();

    constructor(
        private connection: Connection,
        private defaults: IRslSettings
    ) {
        this.workspaceSettings = cloneSettings(defaults);
    }

    configure(hasConfigurationCapability: boolean): void {
        this.hasConfigurationCapability = hasConfigurationCapability;
        this.documentSettings.clear();
        this.resolvedDocumentSettings.clear();
    }

    updateFromConfiguration(settingsRoot: unknown): void {
        const root = isRecord(settingsRoot) ? settingsRoot : {};
        const value = isRecord(root.RSLanguageServer)
            ? root.RSLanguageServer
            : {};

        this.workspaceSettings = mergeSettings(this.defaults, value);
        this.documentSettings.clear();
        this.resolvedDocumentSettings.clear();
    }

    /**
     * Возвращает доступный снимок без LSP round-trip.
     *
     * До первого ответа workspace/configuration используются настройки,
     * переданные клиентом при initialize, либо безопасные defaults. Поэтому
     * parser, Import и Problems не блокируются занятой очередью Extension Host.
     */
    getAvailable(resource: string): IRslSettings {
        return cloneSettings(
            this.resolvedDocumentSettings.get(resource) ??
            this.workspaceSettings
        );
    }

    get(resource: string): Promise<IRslSettings> {
        if (!this.hasConfigurationCapability) {
            return Promise.resolve(this.getAvailable(resource));
        }

        const cached = this.documentSettings.get(resource);

        if (cached) {
            return cached;
        }

        const previous = this.getAvailable(resource);
        const created: Promise<IRslSettings> =
            this.connection.workspace.getConfiguration({
                scopeUri: resource,
                section: "RSLanguageServer"
            }).then((value: unknown) => {
                const resolved = mergeSettings(this.defaults, value);

                /*
                 * clear()/clearAll() могут инвалидировать запрос, пока VS Code
                 * ещё готовит ответ. Такой ответ нельзя возвращать в кэш.
                 */
                if (this.documentSettings.get(resource) === created) {
                    this.resolvedDocumentSettings.set(resource, resolved);
                    if (!settingsEqual(previous, resolved)) {
                        for (const listener of this.resolvedListeners) {
                            listener(resource, cloneSettings(resolved));
                        }
                    }
                }

                return cloneSettings(resolved);
            }, error => {
                if (this.documentSettings.get(resource) === created) {
                    this.documentSettings.delete(resource);
                }
                throw error;
            });
        this.documentSettings.set(resource, created);
        return created;
    }

    clear(resource: string): void {
        this.documentSettings.delete(resource);
        this.resolvedDocumentSettings.delete(resource);
    }

    clearAll(): void {
        this.documentSettings.clear();
        this.resolvedDocumentSettings.clear();
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

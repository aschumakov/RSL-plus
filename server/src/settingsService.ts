import type { Connection } from "vscode-languageserver/node";

import type { IRslSettings } from "./interfaces";

/**
 * Изолирует workspace-настройки от resource-настроек конкретного документа.
 * Раньше последний завершившийся getConfiguration перезаписывал общий объект
 * globalSettings и мог повлиять на диагностику другого открытого файла.
 */
export class RslSettingsService {
    private hasConfigurationCapability = false;
    private workspaceSettings: IRslSettings;
    private documentSettings = new Map<string, Promise<IRslSettings>>();

    constructor(
        private connection: Connection,
        private defaults: IRslSettings
    ) {
        this.workspaceSettings = cloneSettings(defaults);
    }

    configure(hasConfigurationCapability: boolean): void {
        this.hasConfigurationCapability = hasConfigurationCapability;
        this.documentSettings.clear();
    }

    updateFromConfiguration(settingsRoot: unknown): void {
        const root = isRecord(settingsRoot) ? settingsRoot : {};
        const value = isRecord(root.RSLanguageServer)
            ? root.RSLanguageServer
            : {};

        this.workspaceSettings = mergeSettings(this.defaults, value);
        this.documentSettings.clear();
    }

    get(resource: string): Promise<IRslSettings> {
        if (!this.hasConfigurationCapability) {
            return Promise.resolve(cloneSettings(this.workspaceSettings));
        }

        const cached = this.documentSettings.get(resource);

        if (cached) {
            return cached;
        }

        const created: Promise<IRslSettings> =
            this.connection.workspace.getConfiguration({
                scopeUri: resource,
                section: "RSLanguageServer"
            }).then((value: unknown) => mergeSettings(this.defaults, value));
        this.documentSettings.set(resource, created);
        return created;
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

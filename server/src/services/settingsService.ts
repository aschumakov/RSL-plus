import type {
    IRslFormatSettings,
    IRslSettings
} from "../interfaces";

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
        const value = isRecord(root.rslPlus)
            ? root.rslPlus
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
    const imports = isRecord(input.imports) ? input.imports : {};
    const autoImport = isRecord(input.autoImport) ? input.autoImport : {};
    const analysis = isRecord(input.analysis) ? input.analysis : {};
    const semanticHighlighting = isRecord(input.semanticHighlighting)
        ? input.semanticHighlighting
        : {};
    const inlayHints = isRecord(input.inlayHints) ? input.inlayHints : {};
    const format = isRecord(input.format) ? input.format : {};
    const language = isRecord(input.language) ? input.language : {};
    const dialect = isLanguageDialect(language.dialect)
        ? language.dialect
        : defaults.language?.dialect || "rsBank";

    return {
        language: { dialect },
        imports: {
            enabled: typeof imports.enabled === "boolean"
                ? imports.enabled
                : defaults.imports.enabled
        },
        autoImport: {
            enabled: typeof autoImport.enabled === "boolean"
                ? autoImport.enabled
                : defaults.autoImport.enabled
        },
        analysis: {
            workspaceIndexing: isWorkspaceIndexingMode(
                analysis.workspaceIndexing
            )
                ? analysis.workspaceIndexing
                : defaults.analysis.workspaceIndexing
        },
        semanticHighlighting: {
            maxFileSizeKb: typeof semanticHighlighting.maxFileSizeKb === "number"
                ? Math.max(0, semanticHighlighting.maxFileSizeKb)
                : defaults.semanticHighlighting.maxFileSizeKb
        },
        inlayHints: {
            /*
             * Раздел мог отсутствовать в defaults: настройки приходят и от
             * встроенного snapshot, и от клиента, и от вызывающего кода.
             * Обращение к отсутствующей секции роняло бы разрешение настроек
             * целиком, а не теряло одно значение.
             */
            /*
             * Выключено по умолчанию.
             *
             * Подсказка типа стоит у каждого объявления без написанного типа —
             * в файле их сотни, и постоянно висящий текст мешает читать код
             * тем, кто его не просил. Кому нужно, включает настройкой.
             */
            variableTypes: typeof inlayHints.variableTypes === "boolean"
                ? inlayHints.variableTypes
                : defaults.inlayHints?.variableTypes === true,
            parameterNames: typeof inlayHints.parameterNames === "boolean"
                ? inlayHints.parameterNames
                : defaults.inlayHints?.parameterNames !== false
        },
        format: {
            keywordCase: isKeywordCase(format.keywordCase)
                ? format.keywordCase
                : defaults.format?.keywordCase || "asIs",
            spaceAroundOperators:
                typeof format.spaceAroundOperators === "boolean"
                    ? format.spaceAroundOperators
                    : defaults.format?.spaceAroundOperators !== false,
            alignAssignments: typeof format.alignAssignments === "boolean"
                ? format.alignAssignments
                : defaults.format?.alignAssignments !== false,
            useEditorConfig: typeof format.useEditorConfig === "boolean"
                ? format.useEditorConfig
                : defaults.format?.useEditorConfig !== false,
            indentStyle: isIndentStyle(format.indentStyle)
                ? format.indentStyle
                : defaults.format?.indentStyle || "editor",
            indentSize: typeof format.indentSize === "number" &&
                format.indentSize > 0
                ? Math.floor(format.indentSize)
                : defaults.format?.indentSize || 0
        },
        diagnostics: {
            ...(defaults.diagnostics || {}),
            ...diagnostics,
            dialect
        }
    };
}

function isKeywordCase(
    value: unknown
): value is IRslFormatSettings["keywordCase"] {
    return value === "asIs" || value === "lower" || value === "upper" ||
        value === "capitalize";
}

function isIndentStyle(
    value: unknown
): value is IRslFormatSettings["indentStyle"] {
    return value === "editor" || value === "space" || value === "tab";
}

function cloneSettings(value: IRslSettings): IRslSettings {
    return {
        language: { dialect: value.language?.dialect || "rsBank" },
        imports: { ...value.imports },
        autoImport: { ...value.autoImport },
        analysis: { ...value.analysis },
        semanticHighlighting: { ...value.semanticHighlighting },
        inlayHints: {
            variableTypes: value.inlayHints?.variableTypes === true,
            parameterNames: value.inlayHints?.parameterNames !== false
        },
        format: { ...value.format },
        diagnostics: {
            ...(value.diagnostics || {})
        }
    };
}

function settingsEqual(
    left: IRslSettings,
    right: IRslSettings
): boolean {
    return left.imports.enabled === right.imports.enabled &&
        left.language.dialect === right.language.dialect &&
        left.autoImport.enabled === right.autoImport.enabled &&
        left.analysis.workspaceIndexing === right.analysis.workspaceIndexing &&
        left.semanticHighlighting.maxFileSizeKb ===
            right.semanticHighlighting.maxFileSizeKb &&
        left.inlayHints?.variableTypes ===
            right.inlayHints?.variableTypes &&
        left.inlayHints?.parameterNames ===
            right.inlayHints?.parameterNames &&
        JSON.stringify(left.format || {}) ===
            JSON.stringify(right.format || {}) &&
        JSON.stringify(left.diagnostics || {}) ===
        JSON.stringify(right.diagnostics || {});
}

function isLanguageDialect(
    value: unknown
): value is IRslSettings["language"]["dialect"] {
    return value === "rsBank" || value === "coreRsl";
}

function isWorkspaceIndexingMode(
    value: unknown
): value is IRslSettings["analysis"]["workspaceIndexing"] {
    return value === "activeImports" ||
        value === "workspaceIdle" ||
        value === "full";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

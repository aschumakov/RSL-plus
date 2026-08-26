import { Uri, workspace } from "vscode";

export interface IRslClientSettings {
    language: { dialect: "rsBank" | "coreRsl" };
    imports: { enabled: boolean };
    autoImport: { enabled: boolean };
    analysis: {
        workspaceIndexing: "activeImports" | "workspaceIdle" | "full";
    };
    semanticHighlighting: { maxFileSizeKb: number };
    inlayHints: { variableTypes: boolean; parameterNames: boolean };
    format: {
        keywordCase: string;
        spaceAroundOperators: boolean;
        alignAssignments: boolean;
        useEditorConfig: boolean;
        indentStyle: string;
        indentSize: number;
    };
    /*
     * Раздел обязан перечислять ВСЕ настройки диагностик из package.json.
     *
     * Сервер берёт значения только отсюда: то, что клиент не прочитал, до него
     * не доходит вовсе. Настройка, объявленная в package.json и забытая здесь,
     * видна в интерфейсе VS Code и не делает ничего — так было с
     * redundantImports, unknownVariables, файлами известных имён и
     * unknownSpecialVariables.
     */
    diagnostics: {
        enabled: boolean;
        deprecatedDeclarations: boolean;
        structure: boolean;
        unusedVariables: boolean;
        unusedImports: boolean;
        debugBreak: boolean;
        useBeforeDeclaration: boolean;
        ambiguousReferences: boolean;
        redundantImports: boolean;
        unknownVariables: string;
        unknownVariablesKnownGlobalsFile: string;
        unknownVariablesAuditFile: string;
        unknownSpecialVariables: string;
        maxProblems: number;
    };
}

/** Единственная точка чтения публичных настроек rslPlus. */
export function readRslSettings(resource?: Uri): IRslClientSettings {
    return {
        language: {
            dialect: readSetting(
                "language.dialect",
                "rsBank" as const,
                resource
            )
        },
        imports: { enabled: readSetting("imports.enabled", true, resource) },
        autoImport: {
            enabled: readSetting("autoImport.enabled", true, resource)
        },
        analysis: {
            workspaceIndexing: readSetting(
                "analysis.workspaceIndexing",
                "activeImports" as const,
                resource
            )
        },
        semanticHighlighting: {
            maxFileSizeKb: readSetting(
                "semanticHighlighting.maxFileSizeKb",
                512,
                resource
            )
        },
        inlayHints: {
            variableTypes: readSetting(
                "inlayHints.variableTypes",
                true,
                resource
            ),
            parameterNames: readSetting(
                "inlayHints.parameterNames",
                true,
                resource
            )
        },
        format: {
            keywordCase: readSetting(
                "format.keywordCase",
                "lower",
                resource
            ),
            spaceAroundOperators: readSetting(
                "format.spaceAroundOperators",
                true,
                resource
            ),
            alignAssignments: readSetting(
                "format.alignAssignments",
                true,
                resource
            ),
            useEditorConfig: readSetting(
                "format.useEditorConfig",
                true,
                resource
            ),
            indentStyle: readSetting(
                "format.indentStyle",
                "editor",
                resource
            ),
            indentSize: readSetting("format.indentSize", 0, resource)
        },
        diagnostics: {
            enabled: readSetting("diagnostics.enabled", true, resource),
            deprecatedDeclarations: readSetting(
                "diagnostics.deprecatedDeclarations",
                true,
                resource
            ),
            structure: readSetting("diagnostics.structure", true, resource),
            unusedVariables: readSetting(
                "diagnostics.unusedVariables",
                true,
                resource
            ),
            unusedImports: readSetting(
                "diagnostics.unusedImports",
                true,
                resource
            ),
            debugBreak: readSetting(
                "diagnostics.debugBreak",
                true,
                resource
            ),
            useBeforeDeclaration: readSetting(
                "diagnostics.useBeforeDeclaration",
                true,
                resource
            ),
            ambiguousReferences: readSetting(
                "diagnostics.ambiguousReferences",
                true,
                resource
            ),
            redundantImports: readSetting(
                "diagnostics.redundantImports",
                true,
                resource
            ),
            unknownVariables: readSetting(
                "diagnostics.unknownVariables",
                "off",
                resource
            ),
            unknownVariablesKnownGlobalsFile: readSetting(
                "diagnostics.unknownVariablesKnownGlobalsFile",
                "",
                resource
            ),
            unknownVariablesAuditFile: readSetting(
                "diagnostics.unknownVariablesAuditFile",
                "",
                resource
            ),
            unknownSpecialVariables: readSetting(
                "diagnostics.unknownSpecialVariables",
                "all",
                resource
            ),
            maxProblems: readSetting(
                "diagnostics.maxProblems",
                200,
                resource
            )
        }
    };
}

export function readSetting<T>(
    key: string,
    fallback: T,
    resource?: Uri
): T {
    return workspace.getConfiguration("rslPlus", resource).get<T>(
        key,
        fallback
    );
}

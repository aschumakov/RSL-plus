import { Uri, workspace } from "vscode";

export interface IRslClientSettings {
    language: { dialect: "rsBank" | "coreRsl" };
    imports: { enabled: boolean };
    autoImport: { enabled: boolean };
    analysis: {
        workspaceIndexing: "activeImports" | "workspaceIdle" | "full";
    };
    semanticHighlighting: { maxFileSizeKb: number };
    diagnostics: {
        enabled: boolean;
        deprecatedDeclarations: boolean;
        structure: boolean;
        unusedVariables: boolean;
        unusedImports: boolean;
        debugBreak: boolean;
        useBeforeDeclaration: boolean;
        ambiguousReferences: boolean;
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

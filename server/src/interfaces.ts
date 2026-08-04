import { Location } from "vscode-languageserver";

import { varType } from "./enums";
/**
 * Универсальная пара значений.
 */
export interface If_s<T> {
    first: boolean;
    second: T;
}


/**
 * Запрос на открытие позиции в файле.
 */
export interface IReqOpenLocation {
    uri: string;
    location: Location;
    range: IRange;
}


/**
 * Тип лексического токена.
 *
 * code    — обычный RSL-код;
 * string  — строковый литерал;
 * square  — многострочный блок [ ... ];
 * comment — однострочный или блочный комментарий.
 */
export type TokenKind =
    "code" |
    "string" |
    "square" |
    "comment";


/**
 * Токен исходного текста.
 */
export interface IToken {
    str: string;
    range: IRange;
    kind?: TokenKind;
}


/**
 * Настройки диагностик language server.
 */
export interface IRslDiagnosticSettings {
    enabled?: boolean;
    deprecatedDeclarations?: boolean;
    structure?: boolean;
    unusedVariables?: boolean;
    unusedImports?: boolean;
    debugBreak?: boolean;
    useBeforeDeclaration?: boolean;
    ambiguousReferences?: boolean;
    /** Совместимость синтаксиса и семантики с выбранным окружением RSL. */
    dialect?: RslLanguageDialect;
    maxProblems?: number;
}

export type RslLanguageDialect = "rsBank" | "coreRsl";

export type RslWorkspaceIndexingMode =
    "activeImports" |
    "workspaceIdle" |
    "full";


/**
 * Настройки language server.
 */
export interface IRslSettings {
    language: {
        dialect: RslLanguageDialect;
    };
    imports: {
        enabled: boolean;
    };
    autoImport: {
        enabled: boolean;
    };
    analysis: {
        workspaceIndexing: RslWorkspaceIndexingMode;
    };
    semanticHighlighting: {
        maxFileSizeKb: number;
    };
    diagnostics?: IRslDiagnosticSettings;
}


/**
 * Диапазон в абсолютных смещениях документа.
 */
export interface IRange {
    start: number;
    end: number;
}


/**
 * Массив строковых значений.
 */
export interface IArray {
    _it: Array<string>;
    is(it: string): If_s<number>;
    str(num: varType | number): string;
}

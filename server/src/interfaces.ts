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
    /**
     * Import модуля, который уже приходит через другой Import этого файла.
     *
     * По умолчанию выключено: явный Import — это ещё и страховка от того, что
     * соседний модуль перестанет импортировать общий.
     */
    redundantImports?: boolean;
    /**
     * Необъявленные переменные: off | safe | strict.
     *
     * По умолчанию off. Компилятор RSL разрешает имена ещё и из RSM, DLM,
     * встроенных модулей и собственного контекста сборки, поэтому отсутствие
     * объявления в проекте само по себе ошибкой не является.
     */
    unknownVariables?: RslUnknownVariablesSetting;
    /**
     * Проверять состав полностью известных классов.
     *
     * Только их: у прикладных классов состав взят из документации, а она
     * неполна, и «нет такого члена» там было бы догадкой.
     */
    unknownMembers?: boolean;
    /**
     * Предупреждать о спецпеременной, которой нет ни в справочнике, ни в
     * объявлениях файла.
     *
     * По умолчанию all: проверяется любое незнакомое имя, потому что главная
     * польза правила — поймать описку, а `{currdate}` вместо `{curdate}`
     * компилятор пропускает молча. Режим assigned оставлен для тех, кому
     * достаточно имён с присваиванием: такие ведут себя как обычные переменные.
     */
    unknownSpecialVariables?: RslSpecialVariablesSetting;
    /** Файл со списком известных глобальных имён: одно имя на строку. */
    unknownVariablesKnownGlobalsFile?: string;
    /**
     * Путь к отчёту audit. Если задан, находки уходят в отчёт, а не в Problems.
     */
    unknownVariablesAuditFile?: string;
    /** Совместимость синтаксиса и семантики с выбранным окружением RSL. */
    dialect?: RslLanguageDialect;
    maxProblems?: number;
}

export type RslUnknownVariablesSetting = "off" | "safe" | "strict";

/** Режим проверки спецпеременных: предупреждать или молчать. */
export type RslSpecialVariablesSetting = "off" | "assigned" | "all";

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
    inlayHints: {
        /** Показывать выведенный тип у объявлений без написанного типа. */
        variableTypes: boolean;
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

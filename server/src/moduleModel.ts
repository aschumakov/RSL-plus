import { CBase, type IExternalLocationRange } from "./common";
import type { IRslLexResult } from "./lexer";
import {
    getImportNamesFromSyntax,
    type IRslParseResult,
    parseRslSyntax
} from "./syntaxParser";
import {
    scanExternalModule,
    type IExternalModuleScanResult
} from "./indexing/externalModuleScanner";

export type RslModuleModelKind = "open" | "external";

/**
 * Общий контракт модуля. Для external summary поля source/syntax/lex указывают
 * на пустые разделяемые значения и практически не расходуют память.
 */
export interface IRslModuleModel {
    kind: RslModuleModelKind;
    source: string;
    sourceLength: number;
    symbolTree: CBase;
    syntax: IRslParseResult;
    lex: IRslLexResult;
    imports: string[];
    /** Готовые line/character позиции внешних символов без повторного чтения файла. */
    definitionRanges?: Map<CBase, IExternalLocationRange>;
}

const EMPTY_LEX_RESULT = Object.freeze({
    tokens: Object.freeze([]),
    eol: "\n",
    hasFinalEol: false,
    hasBom: false,
    lineStarts: Object.freeze([0])
}) as unknown as IRslLexResult;

const EMPTY_PARSE_RESULT = Object.freeze({
    root: Object.freeze({
        kind: "Program",
        start: 0,
        end: 0,
        children: Object.freeze([]),
        tokens: Object.freeze([])
    }),
    diagnostics: Object.freeze([]),
    tokens: Object.freeze([]),
    lex: EMPTY_LEX_RESULT
}) as unknown as IRslParseResult;

export function createRslModuleModel(
    source: string,
    symbolTree: CBase,
    isOpen: boolean
): IRslModuleModel {
    return isOpen
        ? createOpenModuleModel(source, symbolTree)
        : createExternalModuleSummary(source);
}

export function createOpenModuleModel(
    source: string,
    symbolTree: CBase,
    parsedSyntax?: IRslParseResult
): IRslModuleModel {
    const syntax = parsedSyntax ||
        symbolTree.getSyntaxResult() ||
        parseRslSyntax(source, undefined, { buildExpressionTree: false });

    return {
        kind: "open",
        source,
        sourceLength: source.length,
        symbolTree,
        syntax,
        lex: syntax.lex,
        imports: getImportNamesFromSyntax(syntax.root)
    };
}

/**
 * Строит компактную модель закрытого файла однопроходным scanner-ом.
 * Statement/expression AST и полный token stream не создаются и не удерживаются.
 */
export function createExternalModuleSummary(source: string): IRslModuleModel {
    const scan = scanExternalModule(source);

    return createExternalModuleSummaryFromScan(source.length, scan);
}

export function createExternalModuleSummaryFromScan(
    sourceLength: number,
    scan: IExternalModuleScanResult
): IRslModuleModel {
    return {
        kind: "external",
        source: "",
        sourceLength,
        symbolTree: scan.symbolTree,
        syntax: EMPTY_PARSE_RESULT,
        lex: EMPTY_LEX_RESULT,
        imports: scan.imports,
        definitionRanges: scan.definitionRanges
    };
}

/** Превращает полную модель закрытого редактора в external summary. */
export function compactOpenModuleModel(
    model: IRslModuleModel
): IRslModuleModel {
    if (model.kind === "external") {
        return model;
    }

    return createExternalModuleSummary(model.source);
}

export function isOpenModuleModel(
    model: IRslModuleModel
): boolean {
    return model.kind === "open";
}

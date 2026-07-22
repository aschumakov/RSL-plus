import { CBase } from "./common";
import type { IRslLexResult } from "./lexer";
import {
    getImportNamesFromSyntax,
    type IRslParseResult,
    parseRslSyntax
} from "./syntaxParser";

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
    symbolTree: CBase
): IRslModuleModel {
    const syntax = symbolTree.getSyntaxResult() || parseRslSyntax(source);

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
 * Строит компактную модель закрытого файла: parser используется временно,
 * после чего остаются только Import и экспортируемое legacy symbol tree.
 */
export function createExternalModuleSummary(
    source: string,
    parsedSyntax?: IRslParseResult
): IRslModuleModel {
    const syntax = parsedSyntax || parseRslSyntax(source, undefined, {
        buildExpressionTree: false,
        includeTrivia: false
    });
    const imports = getImportNamesFromSyntax(syntax.root);
    const symbolTree = CBase.fromExternalSyntax(source, syntax);

    return {
        kind: "external",
        source: "",
        sourceLength: source.length,
        symbolTree,
        syntax: EMPTY_PARSE_RESULT,
        lex: EMPTY_LEX_RESULT,
        imports
    };
}

/** Превращает полную модель закрытого редактора в external summary без reparse. */
export function compactOpenModuleModel(
    model: IRslModuleModel
): IRslModuleModel {
    if (model.kind === "external") {
        return model;
    }

    return createExternalModuleSummary(model.source, model.syntax);
}

export function isOpenModuleModel(
    model: IRslModuleModel
): boolean {
    return model.kind === "open";
}

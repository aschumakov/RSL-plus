import type { IRslLexResult } from "./lexer";
import {
    type IRslParseResult,
    parseRslSyntax
} from "./syntaxParser";
import {
    buildRslSymbolTree,
    extractCompactDeclarations,
    extractDeclarationsFromSyntax,
    type IExternalLocationRange,
    type IRslDeclarationSnapshot
} from "./analysis/declarationExtractor";
import type { RslSymbol } from "./symbols/rslSymbol";

export type RslModuleModelKind = "open" | "external";

/** Полная модель только открытого документа либо компактный external summary. */
export interface IRslModuleModel {
    kind: RslModuleModelKind;
    source: string;
    sourceLength: number;
    symbolTree: RslSymbol;
    syntax: IRslParseResult;
    lex: IRslLexResult;
    imports: string[];
    definitionRanges?: Map<RslSymbol, IExternalLocationRange>;
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
    isOpen: boolean,
    parsedSyntax?: IRslParseResult
): IRslModuleModel {
    return isOpen
        ? createOpenModuleModel(source, parsedSyntax)
        : createExternalModuleSummary(source);
}

export function createOpenModuleModel(
    source: string,
    parsedSyntax?: IRslParseResult
): IRslModuleModel {
    const syntax = parsedSyntax || parseRslSyntax(
        source,
        undefined,
        { buildExpressionTree: false }
    );
    const declarations = extractDeclarationsFromSyntax(source, syntax);
    const built = buildRslSymbolTree(source.length, declarations.declarations);

    return {
        kind: "open",
        source,
        sourceLength: source.length,
        symbolTree: built.root,
        syntax,
        lex: syntax.lex,
        imports: declarations.imports,
        definitionRanges: built.definitionRanges
    };
}

/** Закрытый файл не удерживает исходник, AST и token stream. */
export function createExternalModuleSummary(source: string): IRslModuleModel {
    return createExternalModuleSummaryFromDeclarations(
        source.length,
        extractCompactDeclarations(source)
    );
}

export function createExternalModuleSummaryFromDeclarations(
    sourceLength: number,
    declarations: IRslDeclarationSnapshot
): IRslModuleModel {
    const built = buildRslSymbolTree(
        sourceLength,
        declarations.declarations
    );
    return {
        kind: "external",
        source: "",
        sourceLength,
        symbolTree: built.root,
        syntax: EMPTY_PARSE_RESULT,
        lex: EMPTY_LEX_RESULT,
        imports: declarations.imports,
        definitionRanges: built.definitionRanges
    };
}

export function compactOpenModuleModel(
    model: IRslModuleModel
): IRslModuleModel {
    return model.kind === "external"
        ? model
        : createExternalModuleSummary(model.source);
}

export function isOpenModuleModel(model: IRslModuleModel): boolean {
    return model.kind === "open";
}

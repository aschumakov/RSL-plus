import type { IRslLexResult } from "./lexer";
import {
    type IRslParseResult,
    parseRslSyntax
} from "./syntaxParser";
import {
    buildRslSymbolTree,
    extractCompactDeclarations,
    extractDeclarationsFromSyntax,
    type IRslDeclarationSnapshot,
    type IRslDefinitionRanges
} from "./analysis/declarationExtractor";
import { CompletionItemKind } from "vscode-languageserver";
import { RslSymbol } from "./symbols/rslSymbol";

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
    definitionRanges?: IRslDefinitionRanges;
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

/**
 * Закрытый файл не удерживает исходник, AST и token stream.
 *
 * Не удерживает и параметры импортируемых Macro: их некому читать из другого
 * файла (см. includeCallableParameters), а в дескрипторах они составляют
 * основной объём — на файле 300КБ это 5155 дескрипторов против 1290.
 */
export function createExternalModuleSummary(source: string): IRslModuleModel {
    return createExternalModuleSummaryFromDeclarations(
        source.length,
        extractCompactDeclarations(source, {
            includeCallableParameters: false
        })
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

/**
 * Внешняя сводка из уже разобранной открытой модели.
 *
 * Закрытие файла не повод сканировать его заново. Полная модель уже содержит
 * дерево символов, импорты и диапазоны объявлений — всё, что нужно внешней
 * сводке. Прежде здесь звался extractCompactDeclarations по исходному тексту,
 * то есть только что разобранный файл разбирался ещё раз.
 *
 * Тяжёлое состояние не удерживается: исходник, AST и поток токенов остаются в
 * закрытой модели пустыми, а параметры Macro отбрасываются — читать их из
 * другого файла некому, а в дескрипторах они и составляют основной объём.
 */
export function createExternalModuleSummaryFromOpenModel(
    model: IRslModuleModel
): IRslModuleModel {
    return {
        kind: "external",
        source: "",
        sourceLength: model.sourceLength,
        symbolTree: withoutCallableParameters(model.symbolTree),
        syntax: EMPTY_PARSE_RESULT,
        lex: EMPTY_LEX_RESULT,
        imports: model.imports,
        definitionRanges: model.definitionRanges
    };
}

/**
 * Дерево без параметров вызываемых объявлений.
 *
 * Идентификаторы символов при этом сохраняются: их назначает построение
 * дерева по имени и месту в родителе, а не сквозным счётчиком, поэтому
 * отбрасывание детей у Macro не сдвигает идентификаторы соседей.
 */
function withoutCallableParameters(symbol: RslSymbol): RslSymbol {
    const children = isCallableKind(symbol.kind)
        ? []
        : symbol.children
            /*
             * Непубличное во внешнюю сводку не входит.
             *
             * Из другого файла такие имена не видны, и компактное сканирование
             * их не собирает: см. includePrivate. Оставить их значило бы
             * показать соседнему файлу то, чего он видеть не должен, — и
             * заодно держать в памяти лишнее.
             */
            .filter(child => !child.isPrivate)
            .map(withoutCallableParameters);
    const sameChildren = children.length === symbol.children.length &&
        children.every((child, at) => child === symbol.children[at]);

    if (sameChildren) {
        return symbol;
    }

    return new RslSymbol({
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        visibility: symbol.visibility,
        range: symbol.range,
        selectionRange: symbol.selectionRange,
        typeName: symbol.typeName,
        typeVariant: symbol.isTypeVariant,
        value: symbol.value,
        documentation: symbol.documentation,
        builtin: symbol.isBuiltin,
        parameterText: symbol.parameterText,
        baseClassName: symbol.baseClassName,
        children
    });
}

function isCallableKind(kind: CompletionItemKind): boolean {
    return kind === CompletionItemKind.Function ||
        kind === CompletionItemKind.Method ||
        kind === CompletionItemKind.Constructor;
}

export function compactOpenModuleModel(
    model: IRslModuleModel
): IRslModuleModel {
    return model.kind === "external"
        ? model
        : createExternalModuleSummaryFromOpenModel(model);
}

export function isOpenModuleModel(model: IRslModuleModel): boolean {
    return model.kind === "open";
}

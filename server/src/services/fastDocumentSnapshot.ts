import { DocumentSymbol, SymbolKind } from "vscode-languageserver";
import type { TextDocument } from "vscode-languageserver-textdocument";

import {
    GetFoldingRanges,
    type IRslFoldingRange
} from "../folding";
import { lexRsl, type IRslLexResult } from "../lexer";
import {
    extractCompactDeclarations,
    type IRslDeclarationDescriptor,
    type IRslDeclarationSnapshot
} from "../analysis/declarationExtractor";
import { tryIncrementalRelex } from "./incrementalLex";

/** Лёгкий versioned snapshot: один lexer-проход, presentation кэшируется. */
export interface IFastDocumentSnapshot {
    uri: string;
    version: number;
    createdAtMs: number;
    /**
     * Текст ровно этой версии. Все производные snapshot считаются от него, а
     * не от document.getText(): документ к моменту обращения мог уйти вперёд,
     * и тогда объявления считались бы по новому тексту, а токены — по старым.
     */
    text: string;
    lex: IRslLexResult;
    foldingRanges?: IRslFoldingRange[];
    /**
     * Import этой версии — единственное, что переживает построение Structure.
     *
     * Сами дескрипторы объявлений не сохраняются: всё, что от них нужно,
     * уже лежит в symbols, а держать их рядом означало платить второй раз
     * за то же содержимое — около 7 МиБ на открытый файл 1,1 МБ.
     */
    imports?: string[];
    symbols?: DocumentSymbol[];
    symbolsPreparedAtMs?: number;
}

export function createFastDocumentSnapshot(
    document: TextDocument,
    previous?: IFastDocumentSnapshot
): IFastDocumentSnapshot {
    const text = document.getText();
    const lex = (previous &&
        tryIncrementalRelex(previous.text, previous.lex, text)) ||
        lexRsl(text);

    return {
        uri: document.uri,
        version: document.version,
        createdAtMs: Date.now(),
        text,
        lex
    };
}

export function getFastFoldingRanges(
    snapshot: IFastDocumentSnapshot
): IRslFoldingRange[] {
    if (!snapshot.foldingRanges) {
        snapshot.foldingRanges = GetFoldingRanges(
            snapshot.text,
            snapshot.lex
        );
    }
    return snapshot.foldingRanges;
}

/**
 * Объявления и Import этой версии документа.
 *
 * Тот же declaration extractor, что и для compact-модулей workspace. Результат
 * в snapshot не кэшируется: Structure строится из него один раз, а держать
 * дескрипторы дальше означало бы дублировать в памяти то, что уже лежит в
 * symbols. Список Import при этом сохраняется — он маленький и нужен до
 * полного разбора.
 */
export function getFastDocumentDeclarations(
    snapshot: IFastDocumentSnapshot
): IRslDeclarationSnapshot {
    const declarations = extractCompactDeclarations(snapshot.text, {
        includePrivate: true,
        tokens: snapshot.lex.tokens
    });
    snapshot.imports = declarations.imports;
    return declarations;
}

/** Import этой версии, без повторного сканирования, если Structure готова. */
export function getFastDocumentImports(
    snapshot: IFastDocumentSnapshot
): string[] {
    if (!snapshot.imports) {
        getFastDocumentDeclarations(snapshot);
    }
    return snapshot.imports || [];
}

/** Outline использует тот же declaration extractor, что compact workspace. */
export function getFastDocumentSymbols(
    document: TextDocument,
    snapshot: IFastDocumentSnapshot
): DocumentSymbol[] {
    if (!snapshot.symbols) {
        snapshot.symbols = getFastDocumentDeclarations(snapshot)
            .declarations
            .map(declaration => toDocumentSymbol(document, declaration));
        snapshot.symbolsPreparedAtMs = Date.now();
    }
    return snapshot.symbols;
}

function toDocumentSymbol(
    document: TextDocument,
    declaration: IRslDeclarationDescriptor
): DocumentSymbol {
    const kind = declaration.kind === "macro"
        ? declaration.isMethod ? SymbolKind.Method : SymbolKind.Function
        : declaration.kind === "class"
            ? SymbolKind.Class
            : declaration.isConstant
                ? SymbolKind.Constant
                : declaration.isProperty
                    ? SymbolKind.Property
                    : SymbolKind.Variable;
    return {
        name: declaration.name,
        kind,
        detail: declaration.typeName,
        range: {
            start: document.positionAt(declaration.start),
            end: document.positionAt(declaration.end)
        },
        selectionRange: {
            start: document.positionAt(declaration.selectionStart),
            end: document.positionAt(declaration.selectionEnd)
        },
        children: declaration.children.map(child =>
            toDocumentSymbol(document, child)
        )
    };
}

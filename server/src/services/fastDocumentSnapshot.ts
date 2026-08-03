import { DocumentSymbol, SymbolKind } from "vscode-languageserver";
import type { TextDocument } from "vscode-languageserver-textdocument";

import {
    GetFoldingRanges,
    type IRslFoldingRange
} from "../folding";
import { lexRsl, type IRslLexResult } from "../lexer";
import {
    extractCompactDeclarations,
    type IRslDeclarationDescriptor
} from "../analysis/declarationExtractor";

/** Лёгкий versioned snapshot: один lexer-проход, presentation кэшируется. */
export interface IFastDocumentSnapshot {
    uri: string;
    version: number;
    createdAtMs: number;
    lex: IRslLexResult;
    foldingRanges?: IRslFoldingRange[];
    symbols?: DocumentSymbol[];
    symbolsPreparedAtMs?: number;
}

export function createFastDocumentSnapshot(
    document: TextDocument
): IFastDocumentSnapshot {
    return {
        uri: document.uri,
        version: document.version,
        createdAtMs: Date.now(),
        lex: lexRsl(document.getText())
    };
}

export function getFastFoldingRanges(
    document: TextDocument,
    snapshot: IFastDocumentSnapshot
): IRslFoldingRange[] {
    if (!snapshot.foldingRanges) {
        snapshot.foldingRanges = GetFoldingRanges(
            document.getText(),
            snapshot.lex
        );
    }
    return snapshot.foldingRanges;
}

/** Outline использует тот же declaration extractor, что compact workspace. */
export function getFastDocumentSymbols(
    document: TextDocument,
    snapshot: IFastDocumentSnapshot
): DocumentSymbol[] {
    if (!snapshot.symbols) {
        const declarations = extractCompactDeclarations(document.getText(), {
            includePrivate: true,
            tokens: snapshot.lex.tokens
        });
        snapshot.symbols = declarations.declarations.map(declaration =>
            toDocumentSymbol(document, declaration)
        );
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

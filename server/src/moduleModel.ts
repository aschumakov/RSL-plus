import { CBase } from "./common";
import type { IRslLexResult } from "./lexer";
import {
    getImportNamesFromSyntax,
    type IRslParseResult,
    parseRslSyntax
} from "./syntaxParser";

/**
 * Единый владелец результатов разбора модуля.
 *
 * symbolTree пока сохраняет legacy CBase для совместимости существующих
 * provider-ов. Новые проверки должны использовать syntax/lex напрямую.
 * После миграции provider-ов это поле можно будет удалить без изменения
 * WorkspaceIndex и формата кэшей.
 */
export interface IRslModuleModel {
    source: string;
    sourceLength: number;
    symbolTree: CBase;
    syntax: IRslParseResult;
    lex: IRslLexResult;
    imports: string[];
}

export function createRslModuleModel(
    source: string,
    symbolTree: CBase,
    isOpen: boolean
): IRslModuleModel {
    const parsedSyntax =
        symbolTree.getSyntaxResult() || parseRslSyntax(source);
    const syntax = isOpen
        ? parsedSyntax
        : compactExternalSyntax(parsedSyntax);

    return {
        source: isOpen ? source : "",
        sourceLength: source.length,
        symbolTree,
        syntax,
        lex: syntax.lex,
        imports: getImportNamesFromSyntax(parsedSyntax.root)
    };
}

/**
 * Для закрытого импортируемого модуля сохраняются lexer tokens и Import,
 * но не полное statement-дерево и parser diagnostics.
 */
function compactExternalSyntax(
    syntax: IRslParseResult
): IRslParseResult {
    return {
        root: {
            ...syntax.root,
            children: syntax.root.children.filter(child =>
                child.kind === "ImportDeclaration"
            ),
            tokens: []
        },
        diagnostics: [],
        tokens: syntax.tokens,
        lex: syntax.lex
    };
}

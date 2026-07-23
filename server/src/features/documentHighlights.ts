import {
    DocumentHighlight,
    DocumentHighlightKind
} from "vscode-languageserver/node";

import { collectFormatSpecifierTokenStarts } from "../parsing/outputFormParser";
import { normalizeIdentifier, type IRslToken } from "../lexer";
import type { RslScopeResolver } from "../scopeResolver";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

export function buildRslDocumentHighlights(
    module: IIndexedModule,
    index: WorkspaceIndex,
    resolver: RslScopeResolver,
    offset: number
): DocumentHighlight[] {
    const formatSpecifierStarts = collectFormatSpecifierTokenStarts(
        module.lex.tokens
    );
    const selectedToken = module.syntax.tokens.find(token =>
        token.start <= offset && offset <= token.end
    );
    if (selectedToken && formatSpecifierStarts.has(selectedToken.start)) {
        return [];
    }

    const target = resolver.resolveAt(module.uri, module.object, offset);
    if (!target) {
        return [];
    }

    const targetName = normalizeIdentifier(target.object.Name);
    const declarationStart = findDeclarationStart(
        index.getModule(target.uri),
        targetName,
        target.object.Range.start,
        target.object.Range.end
    );
    const result: DocumentHighlight[] = [];
    const tokens = module.syntax.tokens;

    for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
        const token = tokens[tokenIndex];
        if (
            token.kind !== "identifier" ||
            normalizeIdentifier(token.value) !== targetName ||
            formatSpecifierStarts.has(token.start)
        ) {
            continue;
        }

        const resolved = resolver.resolveAt(
            module.uri,
            module.object,
            token.start
        );
        if (
            !resolved ||
            resolved.uri !== target.uri ||
            resolved.object !== target.object
        ) {
            continue;
        }

        const declaration = target.uri === module.uri &&
            declarationStart === token.start;
        const write = declaration || isAssignmentTarget(tokens, tokenIndex);

        result.push({
            range: {
                start: { line: token.line, character: token.character },
                end: { line: token.endLine, character: token.endCharacter }
            },
            kind: write
                ? DocumentHighlightKind.Write
                : DocumentHighlightKind.Read
        });
    }

    return result;
}

function findDeclarationStart(
    module: IIndexedModule | undefined,
    normalizedName: string,
    start: number,
    end: number
): number | undefined {
    if (!module) {
        return undefined;
    }

    return module.syntax.tokens.find(token =>
        token.kind === "identifier" &&
        start <= token.start &&
        token.end <= end &&
        normalizeIdentifier(token.value) === normalizedName
    )?.start;
}

function isAssignmentTarget(
    tokens: readonly IRslToken[],
    index: number
): boolean {
    const next = tokens[index + 1];
    return !!next && next.kind === "symbol" && next.raw === "=";
}

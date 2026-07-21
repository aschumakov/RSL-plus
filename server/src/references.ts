import {
    Location,
    Position,
    Range
} from "vscode-languageserver";

import { normalizeIdentifier } from "./lexer";
import { RslScopeResolver } from "./scopeResolver";
import { WorkspaceIndex } from "./workspaceIndex";

/**
 * Поиск ссылок по уже загруженному workspace index.
 * Перед вызовом server.ts при необходимости лениво индексирует остальные .mac.
 */
export function findRslReferences(
    index: WorkspaceIndex,
    resolver: RslScopeResolver,
    uri: string,
    offset: number,
    includeDeclaration: boolean
): Location[] {
    const module = index.getModule(uri);

    if (!module) {
        return [];
    }

    const target = resolver.resolveAt(
        uri,
        module.object,
        offset
    );

    if (!target) {
        return [];
    }

    const targetName = normalizeIdentifier(target.object.Name);
    const result: Location[] = [];
    const seen = new Set<string>();

    for (const candidateModule of index.getIndexedModules()) {
        for (const token of candidateModule.lex.tokens) {
            if (
                token.kind !== "identifier" ||
                normalizeIdentifier(token.value) !== targetName
            ) {
                continue;
            }

            const resolved = resolver.resolveAt(
                candidateModule.uri,
                candidateModule.object,
                token.start
            );

            if (
                !resolved ||
                resolved.uri !== target.uri ||
                resolved.object !== target.object
            ) {
                continue;
            }

            const declaration =
                candidateModule.uri === target.uri &&
                isDeclarationToken(
                    candidateModule,
                    target.object.Name,
                    target.object.Range.start,
                    target.object.Range.end,
                    token.start,
                    token.end
                );

            if (declaration && !includeDeclaration) {
                continue;
            }

            const range: Range = {
                start: {
                    line: token.line,
                    character: token.character
                },
                end: {
                    line: token.endLine,
                    character: token.endCharacter
                }
            };
            const key = [
                candidateModule.uri,
                range.start.line,
                range.start.character,
                range.end.line,
                range.end.character
            ].join(":");

            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            result.push({
                uri: candidateModule.uri,
                range
            });
        }
    }

    return result.sort(compareLocations);
}


function isDeclarationToken(
    module: { lex: { tokens: Array<{
        kind: string;
        value: string;
        start: number;
        end: number;
    }> } },
    name: string,
    rangeStart: number,
    rangeEnd: number,
    tokenStart: number,
    tokenEnd: number
): boolean {
    const normalized = normalizeIdentifier(name);
    const declaration = module.lex.tokens.find(token =>
        token.kind === "identifier" &&
        token.start >= rangeStart &&
        token.end <= rangeEnd &&
        normalizeIdentifier(token.value) === normalized
    );

    return !!declaration &&
        declaration.start === tokenStart &&
        declaration.end === tokenEnd;
}

function compareLocations(left: Location, right: Location): number {
    const uriComparison = left.uri.localeCompare(right.uri);

    if (uriComparison !== 0) {
        return uriComparison;
    }

    return comparePositions(left.range.start, right.range.start);
}

function comparePositions(left: Position, right: Position): number {
    if (left.line !== right.line) {
        return left.line - right.line;
    }

    return left.character - right.character;
}

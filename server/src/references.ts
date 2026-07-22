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
 * Фоновый WorkspaceModuleLoader наполняет индекс независимо от запроса.
 */
export function findRslReferences(
    index: WorkspaceIndex,
    resolver: RslScopeResolver,
    uri: string,
    offset: number,
    includeDeclaration: boolean,
    isCancelled: () => boolean = () => false
): Location[] {
    const module = index.getModule(uri);

    if (!module || isCancelled()) {
        return [];
    }

    const target = resolver.resolveAt(
        uri,
        module.object,
        offset
    );

    if (!target || isCancelled()) {
        return [];
    }

    const targetName = normalizeIdentifier(target.object.Name);
    const targetModule = index.getModule(target.uri);
    const declarationToken = targetModule
        ? findDeclarationToken(targetModule, targetName, target.object)
        : undefined;
    const result: Location[] = [];
    const seen = new Set<string>();

    for (const candidateModule of index.getIndexedModules()) {
        if (isCancelled()) {
            return [];
        }

        for (const token of candidateModule.syntax.tokens) {
            if (isCancelled()) {
                return [];
            }

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
                !!declarationToken &&
                declarationToken.start === token.start &&
                declarationToken.end === token.end;

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

function findDeclarationToken(
    module: { syntax: { tokens: Array<{
        kind: string;
        value: string;
        start: number;
        end: number;
    }> } },
    normalizedName: string,
    object: { Range: { start: number; end: number } }
): { start: number; end: number } | undefined {
    const tokens = module.syntax.tokens;
    let index = lowerBoundByStart(tokens, object.Range.start);

    while (index < tokens.length) {
        const token = tokens[index++];

        if (token.start > object.Range.end) {
            break;
        }

        if (
            token.kind === "identifier" &&
            token.end <= object.Range.end &&
            normalizeIdentifier(token.value) === normalizedName
        ) {
            return token;
        }
    }

    return undefined;
}

function lowerBoundByStart(
    tokens: Array<{ start: number }>,
    start: number
): number {
    let left = 0;
    let right = tokens.length;

    while (left < right) {
        const middle = (left + right) >>> 1;

        if (tokens[middle].start < start) {
            left = middle + 1;
        } else {
            right = middle;
        }
    }

    return left;
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

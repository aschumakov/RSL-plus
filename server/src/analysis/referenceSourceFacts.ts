import {
    isIdentifierPart,
    isIdentifierStart,
    lexRsl,
    normalizeIdentifier
} from "../lexer";

export interface IReferenceSourceFacts {
    hashes: Uint32Array;
    imports: string[];
}

/**
 * Строит компактные факты файла без AST: уникальные hashes идентификаторов
 * и нормализованный список Import. Известные imports можно передать из уже
 * выполненного external scanner, чтобы не запускать дополнительный lexer.
 */
export function scanReferenceSource(
    source: string,
    knownImports?: readonly string[]
): IReferenceSourceFacts {
    return {
        hashes: collectIdentifierHashes(source),
        imports: normalizeReferenceImports(
            knownImports || collectImportNames(source)
        )
    };
}

export function containsReferenceIdentifier(
    source: string,
    normalizedName: string
): boolean {
    let position = 0;

    while (position < source.length) {
        if (!isIdentifierStart(source.charAt(position))) {
            position++;
            continue;
        }

        const start = position++;
        while (
            position < source.length &&
            isIdentifierPart(source.charAt(position))
        ) {
            position++;
        }

        if (
            position - start === normalizedName.length &&
            identifierEqualsIgnoreCase(source, start, position, normalizedName)
        ) {
            return true;
        }
    }

    return false;
}

export function hashReferenceIdentifier(value: string): number {
    let result = 2166136261 >>> 0;
    for (let index = 0; index < value.length; index++) {
        result ^= value.charCodeAt(index);
        result = Math.imul(result, 16777619) >>> 0;
    }
    return result;
}

export function containsSortedIdentifierHash(
    hashes: Uint32Array,
    target: number
): boolean {
    let left = 0;
    let right = hashes.length - 1;

    while (left <= right) {
        const middle = (left + right) >>> 1;
        const value = hashes[middle];
        if (value === target) {
            return true;
        }
        if (value < target) {
            left = middle + 1;
        } else {
            right = middle - 1;
        }
    }
    return false;
}

export function normalizeReferenceImports(
    values: readonly string[]
): string[] {
    return Array.from(new Set(values
        .map(normalizeReferenceModuleName)
        .filter(value => !!value)));
}

export function normalizeReferenceModuleName(value: string): string {
    let result = (value || "").trim().replace(/\\/g, "/").toLowerCase();
    while (result.startsWith("./")) {
        result = result.substring(2);
    }
    if (result && !result.endsWith(".mac")) {
        result += ".mac";
    }
    return result;
}

function collectIdentifierHashes(source: string): Uint32Array {
    const hashes = new Set<number>();
    let position = 0;

    while (position < source.length) {
        if (!isIdentifierStart(source.charAt(position))) {
            position++;
            continue;
        }

        const start = position++;
        while (
            position < source.length &&
            isIdentifierPart(source.charAt(position))
        ) {
            position++;
        }

        const name = normalizeIdentifier(source.substring(start, position));
        if (name) {
            hashes.add(hashReferenceIdentifier(name));
        }
    }

    return Uint32Array.from(
        Array.from(hashes).sort((left, right) => left - right)
    );
}

function collectImportNames(source: string): string[] {
    const tokens = lexRsl(source, { includeTrivia: false }).tokens;
    const result: string[] = [];

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (
            token.kind !== "identifier" ||
            normalizeIdentifier(token.value) !== "import"
        ) {
            continue;
        }

        let current: string[] = [];
        for (index++; index < tokens.length; index++) {
            const item = tokens[index];
            const word = item.kind === "identifier"
                ? normalizeIdentifier(item.value)
                : "";

            if (item.kind === "symbol" && item.raw === ",") {
                pushImport(result, current);
                current = [];
                continue;
            }
            if (item.kind === "symbol" && item.raw === ";") {
                pushImport(result, current);
                break;
            }
            if (
                current.length > 0 &&
                item.line > token.line &&
                isStatementKeyword(word)
            ) {
                pushImport(result, current);
                index--;
                break;
            }
            if (item.kind !== "comment" && item.kind !== "square") {
                current.push(item.raw);
            }
        }
    }

    return result;
}

function pushImport(result: string[], parts: string[]): void {
    const value = parts.join("").trim().replace(/^["']|["']$/g, "");
    if (value) {
        result.push(value);
    }
}

function isStatementKeyword(word: string): boolean {
    return [
        "import", "var", "const", "array", "file", "record", "macro",
        "class", "if", "while", "for", "with", "return", "break",
        "continue", "onerror", "local", "private"
    ].includes(word);
}

function identifierEqualsIgnoreCase(
    source: string,
    start: number,
    end: number,
    normalizedName: string
): boolean {
    for (let index = 0; index < end - start; index++) {
        if (
            source.charAt(start + index).toLowerCase() !==
            normalizedName.charAt(index)
        ) {
            return false;
        }
    }
    return true;
}

export const referenceSourceFactsTesting = {
    collectIdentifierHashes,
    containsReferenceIdentifier,
    containsSortedIdentifierHash,
    hashReferenceIdentifier
};

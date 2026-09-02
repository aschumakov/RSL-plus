import { normalizeModuleName } from "../core/language/moduleName";
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

/**
 * Имя модуля для записей о ссылках.
 *
 * Разбор написания общий: см. core/language/moduleName. Своя копия здесь
 * ошибалась на удвоенном обратном слеше — `"..\\user\\lib.mac"` превращался в
 * `..//user//lib.mac`, и записи о ссылках расходились с каталогом проекта.
 */
export function normalizeReferenceModuleName(value: string): string {
    return value ? normalizeModuleName(value) : "";
}

/**
 * Хэши уникальных идентификаторов файла — отсортированные.
 *
 * Обход идёт по сырому тексту, а не по токенам, и это существенно.
 * Набор нужен как ОТСЕЧКА для поиска ссылок: пропустить файл, в котором
 * имени нет. Имя может лежать в строке — `R2M(obj, "Method")`,
 * `ExecMacroFile("lib.mac")` — и в комментарии; по токенам такие
 * вхождения пропали бы, и поиск перестал бы их находить.
 */
export function collectIdentifierHashes(source: string): Uint32Array {
    const hashes = new Set<number>();
    const length = source.length;
    let position = 0;

    while (position < length) {
        if (!isIdentifierStartCode(source.charCodeAt(position))) {
            position++;
            continue;
        }

        /*
         * Хэш считается прямо по диапазону текста.
         *
         * Прежде на каждое вхождение заводились две строки: вырезка
         * идентификатора и её приведённая к нижнему регистру копия. На
         * настоящем проекте это самое частое действие во всём компактном
         * чтении — идентификаторов в файле тысячи, — и обходилось оно в
         * четверть его времени. Здесь строк не создаётся вовсе.
         *
         * Регистр складывается посимвольно, и для набора символов имени RSL
         * это то же самое, что toLowerCase: латиница и А-Я сдвигаются на 32,
         * Ё переходит в ё, цифры и подчёркивание не меняются.
         */
        let hash = 2166136261 >>> 0;

        while (position < length) {
            const code = source.charCodeAt(position);

            if (!isIdentifierPartCode(code)) {
                break;
            }

            hash ^= foldIdentifierCode(code);
            hash = Math.imul(hash, 16777619) >>> 0;
            position++;
        }

        hashes.add(hash);
    }

    return Uint32Array.from(
        Array.from(hashes).sort((left, right) => left - right)
    );
}

/** Начало имени: подчёркивание, латиница, А-я, Ё и ё. */
function isIdentifierStartCode(code: number): boolean {
    return code === 95 ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 0x0410 && code <= 0x044f) ||
        code === 0x0401 ||
        code === 0x0451;
}

function isIdentifierPartCode(code: number): boolean {
    return isIdentifierStartCode(code) || (code >= 48 && code <= 57);
}

/** Нижний регистр для символов имени: то же, что toLowerCase на них. */
function foldIdentifierCode(code: number): number {
    if (code >= 65 && code <= 90) {
        return code + 32;
    }

    if (code >= 0x0410 && code <= 0x042f) {
        return code + 32;
    }

    return code === 0x0401 ? 0x0451 : code;
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

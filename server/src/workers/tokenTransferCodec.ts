import type { IRslToken, RslSquareKind, RslTokenKind } from "../lexer";

const KIND_BY_INDEX: RslTokenKind[] = [
    "identifier", "number", "string", "comment",
    "square", "symbol", "whitespace", "newline", "bom"
];
const KIND_TO_INDEX = new Map<RslTokenKind, number>(
    KIND_BY_INDEX.map((kind, index) => [kind, index])
);

const SQUARE_KIND_BY_INDEX: Array<RslSquareKind | undefined> = [
    undefined, "output", "sql"
];
const SQUARE_KIND_TO_INDEX = new Map<RslSquareKind | undefined, number>(
    SQUARE_KIND_BY_INDEX.map((kind, index) => [kind, index])
);

export interface IEncodedTokenColumns {
    length: number;
    kind: Uint8Array;
    start: Uint32Array;
    end: Uint32Array;
    line: Uint32Array;
    character: Uint32Array;
    endLine: Uint32Array;
    endCharacter: Uint32Array;
    squareKind: Uint8Array;
    raw: string[];
    value: string[];
}

export interface IEncodedTokens {
    columns: IEncodedTokenColumns;
    transferList: ArrayBuffer[];
}

/**
 * Кодирует токены в columnar-формат для передачи через worker_threads.
 *
 * Числовые поля переносятся как transferable ArrayBuffer без копирования
 * (postMessage(..., transferList) вместо structured clone всего дерева
 * объектов). raw/value остаются обычными строковыми массивами: клонирование
 * примитивных строк дешевле, чем усложнение формата ради них.
 */
export function encodeTokens(tokens: readonly IRslToken[]): IEncodedTokens {
    const length = tokens.length;
    const kind = new Uint8Array(length);
    const start = new Uint32Array(length);
    const end = new Uint32Array(length);
    const line = new Uint32Array(length);
    const character = new Uint32Array(length);
    const endLine = new Uint32Array(length);
    const endCharacter = new Uint32Array(length);
    const squareKind = new Uint8Array(length);
    const raw = new Array<string>(length);
    const value = new Array<string>(length);

    for (let index = 0; index < length; index++) {
        const token = tokens[index];
        kind[index] = KIND_TO_INDEX.get(token.kind) ?? 0;
        start[index] = token.start;
        end[index] = token.end;
        line[index] = token.line;
        character[index] = token.character;
        endLine[index] = token.endLine;
        endCharacter[index] = token.endCharacter;
        squareKind[index] = SQUARE_KIND_TO_INDEX.get(token.squareKind) ?? 0;
        raw[index] = token.raw;
        value[index] = token.value;
    }

    const columns: IEncodedTokenColumns = {
        length,
        kind,
        start,
        end,
        line,
        character,
        endLine,
        endCharacter,
        squareKind,
        raw,
        value
    };

    return {
        columns,
        transferList: [
            kind.buffer,
            start.buffer,
            end.buffer,
            line.buffer,
            character.buffer,
            endLine.buffer,
            endCharacter.buffer,
            squareKind.buffer
        ]
    };
}

export function decodeTokens(columns: IEncodedTokenColumns): IRslToken[] {
    const result: IRslToken[] = new Array(columns.length);

    for (let index = 0; index < columns.length; index++) {
        const squareKind = SQUARE_KIND_BY_INDEX[columns.squareKind[index]];
        result[index] = {
            kind: KIND_BY_INDEX[columns.kind[index]],
            raw: columns.raw[index],
            value: columns.value[index],
            start: columns.start[index],
            end: columns.end[index],
            line: columns.line[index],
            character: columns.character[index],
            endLine: columns.endLine[index],
            endCharacter: columns.endCharacter[index],
            ...(squareKind ? { squareKind } : {})
        };
    }

    return result;
}

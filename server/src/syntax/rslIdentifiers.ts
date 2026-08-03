import { normalizeIdentifier } from "../lexer";

export const RSL_PARSER_VERSION = "2026-08-03-v7-semantic-symbols";

const KEYWORDS = new Set([
    "array", "end", "or", "break", "file", "private", "class", "for",
    "record", "const", "if", "return", "continue", "import", "var",
    "cpdos", "local", "while", "cpwin", "macro", "with", "elif", "not",
    "else", "onerror", "and", "this", "true", "false", "null", "public"
]);

const TYPES = new Set([
    "variant", "integer", "double", "doublel", "string", "bool", "date",
    "time", "datetime", "memaddr", "procref", "methodref", "decimal",
    "numeric", "money", "moneyl", "specval", "object", "r2m"
]);

export function isRslKeyword(value: string): boolean {
    return KEYWORDS.has(normalizeIdentifier(value));
}

export function isRslType(value: string): boolean {
    return TYPES.has(normalizeIdentifier(value).replace(/^@/, ""));
}

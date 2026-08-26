import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { TextEdit, type WorkspaceEdit } from "vscode-languageserver";
import type { TextDocument } from "vscode-languageserver-textdocument";

import { decodeRslSourceText } from "../core/textDecoding";
import { lexRsl, normalizeIdentifier, type IRslToken } from "../lexer";
import type { WorkspaceIndex } from "../workspaceIndex";

/**
 * Переименование macro-файла: правки ссылок на него.
 *
 * Меняются только однозначно разрешённые ссылки:
 *
 *   Import lib;                     — имя модуля;
 *   ExecMacroFile("lib.mac", …)     — имя файла строкой.
 *
 * Динамически собранная строка не трогается: её значение известно только во
 * время выполнения, и подставлять туда новое имя — гадание.
 *
 * Файлы-кандидаты берутся из постоянного каталога проекта: он помнит и Import
 * каждого модуля, и упомянутые в нём имена macro-файлов. Поэтому ответ не
 * требует обхода тысяч файлов на диске — читаются только те, что действительно
 * ссылаются на переименованный.
 */

export interface IRslFileRename {
    oldUri: string;
    newUri: string;
}

export interface IRslRenameEnvironment {
    index: WorkspaceIndex;
    /** Открытые документы: их текст берётся из редактора, а не с диска. */
    getDocument(uri: string): TextDocument | undefined;
    log?(message: string): void;
}

export function buildRslFileRenameEdit(
    environment: IRslRenameEnvironment,
    renames: readonly IRslFileRename[]
): WorkspaceEdit | null {
    const changes: Record<string, TextEdit[]> = {};

    for (const rename of renames) {
        const oldName = moduleNameOf(rename.oldUri);
        const newName = moduleNameOf(rename.newUri);

        if (!oldName || !newName || oldName === newName) {
            continue;
        }

        for (const uri of candidateUris(environment, oldName)) {
            if (uri === rename.oldUri) {
                continue;
            }

            const text = readSource(environment, uri);

            if (!text) {
                continue;
            }

            const edits = renameEditsIn(text, oldName, newName);

            if (edits.length === 0) {
                continue;
            }

            changes[uri] = (changes[uri] || []).concat(edits);
        }
    }

    return Object.keys(changes).length > 0 ? { changes } : null;
}

/**
 * Файлы, которые стоит проверить.
 *
 * Каталог знает, кто импортирует модуль, — этого достаточно для
 * `Import`. Строковые ссылки `ExecMacroFile("lib.mac")` ищутся среди
 * загруженных моделей: их токены уже в памяти. Держать такой список в
 * каталоге пришлось бы ценой прохода по токенам на каждую правку
 * файла — переименование того не стоит.
 */
function candidateUris(
    environment: IRslRenameEnvironment,
    oldName: string
): string[] {
    const result = new Set(
        environment.index.catalog.modulesReferencing(oldName)
    );
    const fileName = oldName.toLowerCase() + ".mac";

    for (const module of environment.index.getIndexedModules()) {
        if (result.has(module.uri)) {
            continue;
        }

        for (const token of module.lex?.tokens || []) {
            if (
                token.kind === "string" &&
                token.raw.slice(1, -1).trim().toLowerCase() === fileName
            ) {
                result.add(module.uri);
                break;
            }
        }
    }

    return [...result].sort();
}

/** Имя модуля — имя файла без расширения. */
function moduleNameOf(uri: string): string {
    try {
        const name = path.basename(fileURLToPath(uri));

        return /\.mac$/iu.test(name) ? name.slice(0, -4) : "";
    } catch (_error) {
        return "";
    }
}

function readSource(
    environment: IRslRenameEnvironment,
    uri: string
): string | undefined {
    const document = environment.getDocument(uri);

    if (document) {
        return document.getText();
    }

    const module = environment.index.getModule(uri);

    if (module?.source) {
        return module.source;
    }

    try {
        return decodeRslSourceText(fs.readFileSync(fileURLToPath(uri)));
    } catch (error) {
        environment.log?.(
            `Не удалось прочитать ${uri} для переименования: ${String(error)}`
        );

        return undefined;
    }
}

/**
 * Правки в одном файле.
 *
 * Позиции считаются по токенам, а не поиском подстроки: имя `lib` встречается
 * и внутри `library`, и в комментарии, и в чужой строке.
 */
function renameEditsIn(
    text: string,
    oldName: string,
    newName: string
): TextEdit[] {
    const lex = lexRsl(text, { includeTrivia: true });
    const wanted = normalizeIdentifier(oldName);
    const wantedFile = wanted + ".mac";
    const edits: TextEdit[] = [];
    let inImport = false;

    for (const token of lex.tokens) {
        if (token.kind === "identifier") {
            const word = normalizeIdentifier(token.value);

            if (word === "import") {
                inImport = true;
                continue;
            }

            if (inImport && word === wanted) {
                edits.push(replacement(token, newName));
            }

            continue;
        }

        if (token.kind === "string") {
            const quote = token.raw[0];
            const value = token.raw.slice(1, -1);

            if (value.trim().toLowerCase() === wantedFile) {
                edits.push({
                    range: {
                        start: {
                            line: token.line,
                            character: token.character
                        },
                        end: {
                            line: token.endLine,
                            character: token.endCharacter
                        }
                    },
                    newText: quote + value.replace(
                        new RegExp(escapeRegExp(oldName), "iu"),
                        newName
                    ) + quote
                });
            }

            continue;
        }

        if (token.kind === "symbol" && token.raw === ";") {
            inImport = false;
        }
    }

    return edits;
}

function replacement(token: IRslToken, newName: string): TextEdit {
    return {
        range: {
            start: { line: token.line, character: token.character },
            end: { line: token.endLine, character: token.endCharacter }
        },
        newText: newName
    };
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { TextEdit, type WorkspaceEdit } from "vscode-languageserver";
import type { TextDocument } from "vscode-languageserver-textdocument";

import { decodeRslSourceText } from "../core/textDecoding";
import {
    GetMacroFileReferencesFromTokens,
    type IRslMacroFileReference
} from "../execMacroDefinition";
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
 * Каталог знает и кто импортирует модуль, и кто упоминает его файл строкой:
 * `ExecMacroFile("lib.mac")`. Строковые ссылки в каталог складывает фоновая
 * достройка, которая читает файл целиком, — поэтому отвечает он и про файлы,
 * которые ни разу не открывались.
 *
 * Загруженные модели просматриваются всё равно: файл, правленный в редакторе,
 * мог получить новую ссылку уже после того, как его прочитала достройка.
 */
function candidateUris(
    environment: IRslRenameEnvironment,
    oldName: string
): string[] {
    const result = new Set(
        environment.index.catalog.modulesReferencing(oldName)
    );
    const fileName = oldName.toLowerCase() + ".mac";

    for (const uri of environment.index.catalog.modulesMentioningFile(
        fileName
    )) {
        result.add(uri);
    }

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
 * Правится ровно два вида ссылок: имя модуля внутри `Import` и первый
 * аргумент `ExecMacroFile`. Всё остальное — не ссылка: `MsgBox("lib.mac")`
 * это текст сообщения, а `library` — другое имя, и трогать их значило бы
 * менять работающий код при переименовании файла.
 */
function renameEditsIn(
    text: string,
    oldName: string,
    newName: string
): TextEdit[] {
    const lex = lexRsl(text, { includeTrivia: true });
    const wanted = normalizeIdentifier(oldName);
    const edits: TextEdit[] = [];
    let inImport = false;

    /* Строковые ссылки: только первый аргумент ExecMacroFile. */
    for (const reference of GetMacroFileReferencesFromTokens(lex.tokens)) {
        const edit = fileReferenceEdit(reference, oldName, newName);

        if (edit) {
            edits.push(edit);
        }
    }

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

        if (token.kind === "symbol" && token.raw === ";") {
            inImport = false;
        }
    }

    return edits;
}

/**
 * Правка строковой ссылки на файл.
 *
 * Меняется только имя файла; путь, расширение, кавычки и написание
 * остального остаются как были — редактор покажет эту правку в
 * предварительном просмотре, и она обязана быть предсказуемой.
 */
function fileReferenceEdit(
    reference: IRslMacroFileReference,
    oldName: string,
    newName: string
): TextEdit | undefined {
    const value = reference.value;
    const separator = Math.max(
        value.lastIndexOf("/"),
        value.lastIndexOf("\\")
    );
    const directory = value.slice(0, separator + 1);
    const fileName = value.slice(separator + 1);
    const dot = fileName.lastIndexOf(".");
    const stem = dot < 0 ? fileName : fileName.slice(0, dot);
    const extension = dot < 0 ? "" : fileName.slice(dot);

    if (normalizeIdentifier(stem) !== normalizeIdentifier(oldName)) {
        return undefined;
    }

    const token = reference.token;
    const quote = token.raw[0];

    return {
        range: {
            start: { line: token.line, character: token.character },
            end: { line: token.endLine, character: token.endCharacter }
        },
        newText: quote + directory + newName + extension + quote
    };
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


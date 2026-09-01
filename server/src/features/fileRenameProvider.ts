import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { TextEdit, type WorkspaceEdit } from "vscode-languageserver";
import type { TextDocument } from "vscode-languageserver-textdocument";

import { decodeRslSourceText } from "../core/textDecoding";
import {
    GetImportDefinitionTargetsFromTokens,
    GetMacroFileReferencesFromTokens,
    type IImportDefinitionTarget,
    type IRslMacroFileReference
} from "../execMacroDefinition";
import { lexRsl, normalizeIdentifier, type IRslToken } from "../lexer";
import { rangeAtOffsets } from "../core/documentPosition";
import type { WorkspaceIndex } from "../workspaceIndex";

/** Текст файла и, если они уже есть, токены и начала строк той же версии. */
interface IRenameSource {
    text: string;
    tokens?: readonly IRslToken[];
    lineStarts?: readonly number[];
}

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

            const source = readSource(environment, uri);

            if (!source) {
                continue;
            }

            const edits = renameEditsIn(source, oldName, newName);

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
            if (token.kind !== "string") {
                continue;
            }

            /*
             * Сравнивается имя файла, а не вся строка.
             *
             * `Import "sub/lib.mac";` ссылается на тот же файл, что и
             * `Import "lib.mac";`, но по целой строке не совпадал — и такой
             * файл в кандидаты не попадал вовсе.
             */
            const written = token.raw.slice(1, -1).trim().toLowerCase();
            const separator = Math.max(
                written.lastIndexOf("/"),
                written.lastIndexOf("\\")
            );

            if (written.slice(separator + 1) === fileName) {
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

/**
 * Текст файла и токены ТОЙ ЖЕ версии, если они уже есть.
 *
 * Открытый документ обычно уже разобран, и его поток токенов лежит в
 * модели. Лексировать тот же текст заново незачем: на файле 700 КБ это
 * несколько миллисекунд на каждый переименованный файл.
 *
 * Токены берутся только к своему тексту: модель отстающей версии сюда не
 * годится, поэтому сравнивается сам текст, а не номер версии.
 */
function readSource(
    environment: IRslRenameEnvironment,
    uri: string
): IRenameSource | undefined {
    const document = environment.getDocument(uri);
    const module = environment.index.getModule(uri);

    if (document) {
        const text = document.getText();

        return module?.source === text
            ? { text, tokens: module.lex.tokens, lineStarts: module.lex.lineStarts }
            : { text };
    }

    if (module?.source) {
        return {
            text: module.source,
            tokens: module.lex.tokens,
            lineStarts: module.lex.lineStarts
        };
    }

    try {
        return {
            text: decodeRslSourceText(fs.readFileSync(fileURLToPath(uri)))
        };
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
    source: IRenameSource,
    oldName: string,
    newName: string
): TextEdit[] {
    /* Готовые токены той же версии, иначе — лексируем сами. */
    const lex = source.tokens && source.lineStarts
        ? undefined
        : lexRsl(source.text, { includeTrivia: true });
    const tokens = source.tokens || lex!.tokens;
    const lineStarts = source.lineStarts || lex!.lineStarts;
    const wanted = normalizeIdentifier(oldName);
    const edits: TextEdit[] = [];

    /* Строковые ссылки: только первый аргумент ExecMacroFile. */
    for (const reference of GetMacroFileReferencesFromTokens(
        tokens as IRslToken[]
    )) {
        const edit = fileReferenceEdit(reference, oldName, newName);

        if (edit) {
            edits.push(edit);
        }
    }

    /*
     * Директивы Import разбирает общий механизм.
     *
     * Здесь была своя упрощённая машина состояний: «встретили слово
     * import — до точки с запятой правим совпавшие идентификаторы». Она
     * не видела строковую форму `Import "lib.mac";` и не знала про пути,
     * а поддерживаемый синтаксис Import с тех пор ушёл вперёд.
     */
    for (const target of GetImportDefinitionTargetsFromTokens(
        tokens as IRslToken[]
    )) {
        const edit = importNameEdit(
            source.text,
            lineStarts,
            target,
            wanted,
            newName
        );

        if (edit) {
            edits.push(edit);
        }
    }

    return edits;
}

/**
 * Правка имени модуля в директиве Import.
 *
 * Меняется только само имя: путь, расширение и кавычки остаются как написаны.
 * Диапазон имени даёт общий разбор — в него кавычки не входят, поэтому
 * `Import "sub/lib.mac";` превращается в `Import "sub/other.mac";`, а не
 * теряет путь.
 */
function importNameEdit(
    text: string,
    lineStarts: readonly number[],
    target: IImportDefinitionTarget,
    wantedName: string,
    newName: string
): TextEdit | undefined {
    const written = text.slice(target.nameStart, target.nameEnd);
    const separator = Math.max(
        written.lastIndexOf("/"),
        written.lastIndexOf("\\")
    );
    const directory = written.slice(0, separator + 1);
    const fileName = written.slice(separator + 1);
    const dot = fileName.lastIndexOf(".");
    const stem = dot < 0 ? fileName : fileName.slice(0, dot);
    const extension = dot < 0 ? "" : fileName.slice(dot);

    if (normalizeIdentifier(stem) !== wantedName) {
        return undefined;
    }

    return TextEdit.replace(
        rangeAtOffsets(lineStarts, target.nameStart, target.nameEnd),
        directory + newName + extension
    );
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



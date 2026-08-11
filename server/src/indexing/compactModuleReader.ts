import * as fs from "fs";
import { fileURLToPath } from "url";

import {
    extractCompactDeclarations,
    type IRslDeclarationSnapshot
} from "../analysis/declarationExtractor";
import { normalizeIdentifier } from "../lexer";
import type {
    ICompactModuleRequest,
    ICompactModuleResponse
} from "./compactModuleProtocol";

/*
 * Чтение и компактное сканирование внешнего модуля.
 *
 * Одна реализация на два хоста: worker (обычный путь) и основной поток
 * (резервный, если worker не удалось запустить). Разные реализации разошлись
 * бы, и тогда модуль, загруженный резервным путём, отличался бы от
 * загруженного через worker — а это ровно тот класс расхождений, который
 * трудно заметить и легко получить.
 */

/*
 * Память на последние разобранные файлы.
 *
 * Один и тот же файл приходит дважды в обычном сценарии: сначала адресной
 * проверкой экспорта (Ctrl+Click по неизвестному символу), потом обычной
 * загрузкой этой же Import-ветви. Ключ включает mtime и размер, поэтому
 * изменённый файл никогда не отдаётся из памяти — только повторный запрос
 * того же содержимого.
 */
const MEMO_LIMIT = 8;
const memo = new Map<string, IRslDeclarationSnapshot>();

function remember(key: string, snapshot: IRslDeclarationSnapshot): void {
    memo.set(key, snapshot);

    while (memo.size > MEMO_LIMIT) {
        const oldest = memo.keys().next().value as string | undefined;

        if (oldest === undefined) {
            break;
        }
        memo.delete(oldest);
    }
}

export async function readCompactModule(
    request: ICompactModuleRequest
): Promise<ICompactModuleResponse> {
    const base = {
        id: request.id,
        uri: request.uri,
        generation: request.generation
    };

    let filePath: string;

    try {
        filePath = fileURLToPath(request.uri);
    } catch (error) {
        return { ...base, status: "missing", error: errorToString(error) };
    }

    let stat: fs.Stats;

    try {
        stat = await fs.promises.stat(filePath);
    } catch (error) {
        return { ...base, status: "missing", error: errorToString(error) };
    }

    const mtimeMs = Math.floor(stat.mtimeMs);

    if (request.knownMtimeMs !== undefined && request.knownMtimeMs === mtimeMs) {
        return { ...base, status: "unchanged", mtimeMs };
    }

    const key = `${filePath}:${mtimeMs}:${stat.size}`;
    const remembered = memo.get(key);

    if (remembered) {
        return indexed(base, request, remembered, mtimeMs, stat.size, true);
    }

    /* mtime и размер совпали — значит переиспользуется ровно то содержимое. */

    try {
        const source = await fs.promises.readFile(filePath, "utf8");
        const expected = request.expectedExport
            ? normalizeIdentifier(request.expectedExport)
            : undefined;

        /*
         * Дешёвая отсечка до сканирования: файл, в котором искомого
         * идентификатора нет ни в каком виде, экспортировать его не может.
         */
        if (expected !== undefined && !containsIdentifier(source, expected)) {
            return { ...base, status: "not-exported", mtimeMs };
        }

        /*
         * Состав ответа обязан совпадать с createExternalModuleSummary,
         * иначе модуль, загруженный через worker, отличался бы от
         * загруженного на месте.
         */
        const snapshot = extractCompactDeclarations(source, {
            includeCallableParameters: false
        });
        remember(key, snapshot);
        return indexed(base, request, snapshot, mtimeMs, source.length, false);
    } catch (error) {
        return { ...base, status: "failed", error: errorToString(error) };
    }
}

function containsIdentifier(source: string, normalizedName: string): boolean {
    const lower = source.toLowerCase();
    let index = lower.indexOf(normalizedName);

    while (index >= 0) {
        const before = index > 0 ? lower.charAt(index - 1) : "";
        const after = lower.charAt(index + normalizedName.length);

        if (!isIdentifierCharacter(before) && !isIdentifierCharacter(after)) {
            return true;
        }

        index = lower.indexOf(normalizedName, index + normalizedName.length);
    }

    return false;
}

function isIdentifierCharacter(value: string): boolean {
    return !!value && /[a-zа-яё0-9_@]/i.test(value);
}

function indexed(
    base: { id: number; uri: string; generation: number },
    request: ICompactModuleRequest,
    snapshot: IRslDeclarationSnapshot,
    mtimeMs: number,
    sourceLength: number,
    reused: boolean
): ICompactModuleResponse {
    const expected = request.expectedExport
        ? normalizeIdentifier(request.expectedExport)
        : undefined;

    return {
        ...base,
        status: "indexed",
        mtimeMs,
        sourceLength,
        declarations: snapshot.declarations,
        imports: snapshot.imports,
        reused,
        exportsRequestedName: expected === undefined
            ? undefined
            : snapshot.declarations.some(declaration =>
                declaration.visibility === "public" &&
                normalizeIdentifier(declaration.name) === expected
            )
    };
}

function errorToString(error: unknown): string {
    return error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
}

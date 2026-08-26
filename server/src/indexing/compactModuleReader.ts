import * as fs from "fs";
import { fileURLToPath } from "url";

import { contentFingerprint } from "../analysis/contentFingerprint";
import {
    extractCompactDeclarations,
    type IRslDeclarationSnapshot
} from "../analysis/declarationExtractor";
import {
    GetMacroFileReferenceNamesFromTokens
} from "../execMacroDefinition";
import { lexRsl, normalizeIdentifier } from "../lexer";
import { CompactModuleCache } from "./compactModuleCache";
import type {
    ICompactModuleRequest,
    ICompactModuleResponse
} from "./compactModuleProtocol";
import { decodeRslSourceText } from "../core/textDecoding";

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
 * загрузкой этой же Import-ветви. Ключ — отпечаток содержимого, а не путь с
 * mtime: изменённый файл не может попасть в чужую запись, а два файла с
 * одинаковым текстом дают одинаковые объявления и делят одну запись законно.
 */
const MEMO_LIMIT = 8;

/*
 * Длина в символах хранится вместе со снимком, а не берётся из stat.size.
 * Это разные числа: в файле с русскими комментариями байтов заметно больше,
 * чем символов, и ответ из памяти сообщал бы модулю другую длину, чем ответ
 * после сканирования того же файла.
 */
interface IMemoEntry {
    snapshot: IRslDeclarationSnapshot;
    sourceLength: number;
}

const memo = new Map<string, IMemoEntry>();

/*
 * Постоянный кэш живёт рядом с памятью на последние файлы и работает по тому
 * же ключу — отпечатку содержимого. Разница только в сроке жизни: memo
 * обслуживает повторный запрос внутри сессии, кэш — первый запрос после
 * перезапуска. Экземпляр модульный, потому что readCompactModule вызывается и
 * из worker'а, и с основного потока как резервный путь; каждый хост
 * настраивает свой (см. configureCompactModuleCache).
 */
const diskCache = new CompactModuleCache();

/**
 * Включает постоянный кэш для текущего хоста.
 *
 * Без вызова кэш выключен, и чтение работает как раньше — это важно для
 * тестов и для среды без каталога расширения.
 */
export function configureCompactModuleCache(
    cacheFilePath: string | undefined,
    log?: (message: string) => void
): void {
    /*
     * Смена настройки — это смена хоста или сессии, а память на последние файлы
     * принадлежит прежней. Заодно это единственный способ проверить сам кэш на
     * диске: память опрашивается раньше него и по тому же отпечатку, поэтому без
     * сброса «перезапуск» в тесте отвечал бы из памяти и проверял бы её, а не
     * кэш.
     */
    memo.clear();
    diskCache.configure(cacheFilePath, log);
}

/** Доступ к кэшу для владельца процесса: сброс при остановке, статистика. */
export function compactModuleCache(): CompactModuleCache {
    return diskCache;
}

/* Отпечаток общий с ReferenceIndex: см. analysis/contentFingerprint.ts. */
const fingerprintOf = contentFingerprint;

/**
 * Сводка из постоянного кэша; попутно кладётся в память сессии.
 *
 * Кэш отдаёт запись только при совпавшем отпечатке, поэтому проверять
 * актуальность здесь второй раз не нужно.
 */
async function rememberFromDisk(
    uri: string,
    fingerprint: string
): Promise<IMemoEntry | undefined> {
    const cached = await diskCache.get(uri, fingerprint);

    if (!cached) {
        return undefined;
    }

    const entry: IMemoEntry = {
        snapshot: cached.snapshot,
        sourceLength: cached.sourceLength
    };
    remember(fingerprint, entry);
    return entry;
}

function remember(key: string, entry: IMemoEntry): void {
    memo.set(key, entry);

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

    try {
        /*
         * Файл читается всегда, и только потом решается, менялся ли он.
         * Обратный порядок (сверить mtime и не читать) отдавал бы unchanged по
         * дате изменения — свойству, которое не следует за содержимым, см.
         * ICompactModuleFingerprint.
         */
        const content = await fs.promises.readFile(filePath);
        const fingerprint = fingerprintOf(content);

        if (request.knownFingerprint === fingerprint) {
            return { ...base, status: "unchanged", mtimeMs, fingerprint };
        }

        const remembered = memo.get(fingerprint) ||
            await rememberFromDisk(request.uri, fingerprint);

        if (remembered) {
            /*
             * Запись в кэш нужна и здесь. Память сессии ключуется отпечатком,
             * а не URI: файл, чьё содержимое уже сканировалось для другого
             * URI, попадал бы в память, но не на диск — и сканировался бы
             * заново в следующей сессии. Повторную запись того же отпечатка
             * кэш отбрасывает сам.
             */
            diskCache.set(request.uri, {
                fingerprint,
                mtimeMs,
                sourceLength: remembered.sourceLength,
                snapshot: remembered.snapshot
            });
            return indexed(
                base,
                request,
                remembered.snapshot,
                mtimeMs,
                fingerprint,
                remembered.sourceLength,
                true
            );
        }

        /* Макросы бывают в UTF-8 и в CP866; см. decodeRslSource. */
        const source = decodeRslSourceText(content);
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
        /*
         * Лексирование одно на оба ответа.
         *
         * Сканер объявлений всё равно лексирует файл внутри себя; передав
         * ему готовый поток, тем же проходом собираются и строковые
         * ссылки на файлы.
         */
        const tokens = lexRsl(source, { includeTrivia: false }).tokens;
        const snapshot: IRslDeclarationSnapshot = {
            ...extractCompactDeclarations(source, {
                includeCallableParameters: false,
                tokens
            }),
            fileReferences: GetMacroFileReferenceNamesFromTokens(tokens)
        };
        remember(fingerprint, { snapshot, sourceLength: source.length });
        diskCache.set(request.uri, {
            fingerprint,
            mtimeMs,
            sourceLength: source.length,
            snapshot
        });
        return indexed(
            base,
            request,
            snapshot,
            mtimeMs,
            fingerprint,
            source.length,
            false
        );
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
    fingerprint: string,
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
        fingerprint,
        sourceLength,
        declarations: snapshot.declarations,
        imports: snapshot.imports,
        fileReferences: snapshot.fileReferences || [],
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

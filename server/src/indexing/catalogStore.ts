import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import type { IRslDeclarationDescriptor } from "../analysis/declarationExtractor";

/**
 * Постоянный каталог проекта: состав файлов между запусками.
 *
 * Каталог символов собирается фоновым обходом всего проекта — на проверенном
 * проекте это 6165 файлов и 104 МБ чтения. До конца обхода Ctrl+T, переход к
 * реализации и иерархия типов видят только то, что успело прочитаться, и
 * ответ на один и тот же запрос в первые секунды после запуска меняется на
 * глазах.
 *
 * Состав файлов сохраняется и читается при следующем запуске: полный ответ
 * доступен сразу, а обход идёт следом и правит только то, что изменилось.
 *
 * Записи разложены по корзинам и читаются целиком: в отличие от ссылок,
 * каталог нужен весь и сразу — по нему отвечает Ctrl+T.
 */

/** Признак неизменности файла без его чтения: см. referenceShards. */
export interface IRslCatalogStamp {
    mtimeMs: number;
    size: number;
}

/**
 * Запись, восстановленная с диска, считается несверенной.
 *
 * Дата и размер не доказывают, что файл прежний: их сохраняют системы контроля
 * версий и утилиты копирования, а правка одинаковой длины не меняет ни того ни
 * другого. Пока сессия не прочитала файл сама, её запись — предположение.
 *
 * Полный Ctrl+T сразу после запуска от этого не страдает: восстановленный
 * каталог доступен немедленно, а сверяет его фоновый обход, читая файлы в
 * рабочем потоке. Плата — обход проходит проект один раз за сессию, как и до
 * появления постоянного каталога; выигрышем же был не быстрый обход, а
 * готовый Ctrl+T с первой секунды.
 */

/** Состав одного файла, каким его знает каталог. */
export interface IRslCatalogRecord {
    uri: string;
    stamp: IRslCatalogStamp;
    declarations: IRslDeclarationDescriptor[];
    imports: string[];
    fileReferences: string[];
    /** Запись сделана в этой сессии по прочитанному файлу; на диск не идёт. */
    confirmed?: boolean;
}

interface ISerializedCatalogBucket {
    version: number;
    files: IRslCatalogRecord[];
}

export interface IRslCatalogStoreOptions {
    log?(message: string): void;
    buckets?: number;
    /**
     * Через сколько сохранять после изменения.
     *
     * Проверкам нужно, чтобы на диск писал только явный flush: иначе отложенное
     * сохранение попадает в середину проверки и она меряет не то, что проверяет.
     */
    saveDebounceMs?: number;
}

export interface IRslCatalogStoreStats {
    /** Сколько файлов описано. */
    files: number;
    /** Сколько корзин ждёт записи. */
    dirtyBuckets: number;
    /** Прочитано ли хранилище с диска. */
    loaded: boolean;
}

/*
 * 1: состав файла и признак неизменности по дате и размеру.
 */
const STORE_VERSION = 1;
const DEFAULT_BUCKETS = 32;
const SAVE_DEBOUNCE_MS = 5000;

function bucketOf(uri: string, buckets: number): number {
    let hash = 2166136261;

    for (let at = 0; at < uri.length; at++) {
        hash ^= uri.charCodeAt(at);
        hash = Math.imul(hash, 16777619);
    }

    return Math.abs(hash) % buckets;
}

export class RslCatalogStore {
    private readonly buckets: number;
    private directory: string | undefined;
    private records = new Map<string, IRslCatalogRecord>();
    private dirty = new Set<number>();
    private saveTimer: NodeJS.Timeout | undefined;
    private loadedFromDisk = false;
    /** Незаконченные записи: их обязан дождаться flush. */
    private inFlight = new Set<Promise<void>>();
    /**
     * Текущее сохранение: следующее ждёт его.
     *
     * Отложенное сохранение и явный flush иначе идут одновременно, и то, что
     * началось раньше со старым снимком, переименовывает свой временный файл
     * последним — поверх свежего. Терялись при этом ровно те записи, которые
     * добавились между двумя сохранениями.
     */
    private saving: Promise<void> = Promise.resolve();
    private readonly saveDebounceMs: number;

    constructor(private options: IRslCatalogStoreOptions = {}) {
        this.buckets = Math.max(1, options.buckets ?? DEFAULT_BUCKETS);
        this.saveDebounceMs = options.saveDebounceMs ?? SAVE_DEBOUNCE_MS;
    }

    configurePersistence(directory: string | undefined): void {
        this.directory = directory ? path.resolve(directory) : undefined;
        this.records.clear();
        this.dirty.clear();
        this.loadedFromDisk = false;
    }

    /**
     * Читает сохранённый состав проекта.
     *
     * Возвращает записи только тех файлов, которые есть в проекте сейчас:
     * файл могли удалить или переименовать, пока сервер не работал, и
     * показывать его символы в Ctrl+T было бы враньём.
     */
    async load(workspaceUris: readonly string[]): Promise<IRslCatalogRecord[]> {
        this.records.clear();
        this.loadedFromDisk = true;

        if (!this.directory) {
            return [];
        }

        const known = new Set(workspaceUris);
        const result: IRslCatalogRecord[] = [];

        for (let bucket = 0; bucket < this.buckets; bucket++) {
            let raw: string;

            try {
                raw = await fs.promises.readFile(
                    this.bucketPath(bucket),
                    "utf8"
                );
            } catch {
                /* Корзины нет: обычное состояние первого запуска. */
                continue;
            }

            let parsed: ISerializedCatalogBucket;

            try {
                parsed = JSON.parse(raw) as ISerializedCatalogBucket;
            } catch (error) {
                this.options.log?.(
                    "Сохранённый каталог повреждён и пропущен: " + error
                );

                continue;
            }

            if (!parsed || parsed.version !== STORE_VERSION) {
                continue;
            }

            for (const record of parsed.files || []) {
                if (!known.has(record.uri)) {
                    continue;
                }

                this.records.set(record.uri, record);
                result.push(record);
            }
        }

        return result;
    }

    /**
     * Изменился ли файл с тех пор, как его записали.
     *
     * Неизменность проверяется по дате и размеру: fingerprint надёжнее, но
     * требует прочитать файл — то есть ровно ту работу, которой обход и должен
     * избежать. Ошибка в эту сторону безопасна: изменённый файл, признанный
     * прежним, будет перечитан наблюдателем за файлами, а неизменный,
     * признанный изменённым, — просто перечитан зря.
     */
    async isUnchanged(uri: string): Promise<boolean> {
        const record = this.records.get(uri);

        /*
         * Несверенная запись неизменности не доказывает: см. IRslCatalogStamp.
         * Так фоновый обход читает восстановленный проект один раз за сессию,
         * а повторные обходы — уже нет.
         */
        if (!record || !record.confirmed) {
            return false;
        }

        const stamp = await stampOf(uri);

        return !!stamp &&
            stamp.size === record.stamp.size &&
            stamp.mtimeMs === record.stamp.mtimeMs;
    }

    /**
     * Запомнить состав файла.
     *
     * Обход зовёт запись, не дожидаясь её: он занят своим делом, а запись
     * начинается с обращения к файловой системе за датой. Поэтому незаконченные
     * записи учитываются, и flush ждёт их — иначе состав последних файлов
     * обхода не попадал бы на диск.
     */
    record(
        uri: string,
        declarations: readonly IRslDeclarationDescriptor[],
        imports: readonly string[],
        fileReferences: readonly string[]
    ): Promise<void> {
        const running = this.write(uri, declarations, imports, fileReferences)
            .finally(() => this.inFlight.delete(running));

        this.inFlight.add(running);

        return running;
    }

    private async write(
        uri: string,
        declarations: readonly IRslDeclarationDescriptor[],
        imports: readonly string[],
        fileReferences: readonly string[]
    ): Promise<void> {
        const stamp = await stampOf(uri);

        if (!stamp) {
            return;
        }

        this.records.set(uri, {
            uri,
            stamp,
            declarations: [...declarations],
            imports: [...imports],
            fileReferences: [...fileReferences],
            /* Запись этой сессии: файл только что прочитали. */
            confirmed: true
        });
        this.dirty.add(bucketOf(uri, this.buckets));
        this.scheduleSave();
    }

    /** Файл изменился или удалён: запись о нём больше не годится. */
    invalidate(uri: string): void {
        if (this.records.delete(uri)) {
            this.dirty.add(bucketOf(uri, this.buckets));
            this.scheduleSave();
        }
    }

    /** Проект сменился: записи о чужих файлах не нужны. */
    retainWorkspaceFiles(uris: readonly string[]): void {
        const known = new Set(uris);

        for (const uri of [...this.records.keys()]) {
            if (!known.has(uri)) {
                this.invalidate(uri);
            }
        }
    }

    get stats(): IRslCatalogStoreStats {
        return {
            files: this.records.size,
            dirtyBuckets: this.dirty.size,
            loaded: this.loadedFromDisk
        };
    }

    flush(): Promise<void> {
        this.saving = this.saving.then(() => this.flushOnce());

        return this.saving;
    }

    private async flushOnce(): Promise<void> {
        /* Записи, начатые обходом и ещё не дошедшие до памяти. */
        while (this.inFlight.size > 0) {
            await Promise.allSettled([...this.inFlight]);
        }

        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }

        if (!this.directory || this.dirty.size === 0) {
            return;
        }

        const pending = [...this.dirty];

        this.dirty.clear();

        try {
            await fs.promises.mkdir(this.directory, { recursive: true });
        } catch (error) {
            this.options.log?.(
                "Не удалось создать каталог сохранённого состава: " + error
            );

            return;
        }

        const byBucket = new Map<number, IRslCatalogRecord[]>();

        for (const record of this.records.values()) {
            const bucket = bucketOf(record.uri, this.buckets);

            if (!pending.includes(bucket)) {
                continue;
            }

            const list = byBucket.get(bucket) || [];

            list.push(record);
            byBucket.set(bucket, list);
        }

        for (const bucket of pending) {
            await this.saveBucket(bucket, byBucket.get(bucket) || []);
        }
    }

    private async saveBucket(
        bucket: number,
        files: IRslCatalogRecord[]
    ): Promise<void> {
        const target = this.bucketPath(bucket);

        try {
            if (files.length === 0) {
                await fs.promises.rm(target, { force: true });

                return;
            }

            /* Через временный файл: оборванная запись оставила бы огрызок. */
            const temporary = target + ".tmp";
            const payload: ISerializedCatalogBucket = {
                version: STORE_VERSION,
                /*
                 * Признак сверки на диск не идёт: после перезапуска доверять
                 * прежней сверке нельзя, а записанный он превратил бы
                 * восстановленную запись в подтверждённую.
                 */
                files: files.map(({ confirmed: _confirmed, ...rest }) => rest)
            };

            await fs.promises.writeFile(
                temporary,
                JSON.stringify(payload),
                "utf8"
            );
            await fs.promises.rename(temporary, target);
        } catch (error) {
            this.options.log?.(
                "Не удалось сохранить состав проекта: " + error
            );
        }
    }

    private bucketPath(bucket: number): string {
        return path.join(
            this.directory || "",
            "catalog-" + String(bucket).padStart(3, "0") + ".json"
        );
    }

    private scheduleSave(): void {
        if (!this.directory || this.saveTimer) {
            return;
        }

        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            void this.flush();
        }, this.saveDebounceMs);
        this.saveTimer.unref?.();
    }
}

async function stampOf(uri: string): Promise<IRslCatalogStamp | undefined> {
    let filePath: string;

    try {
        filePath = fileURLToPath(uri);
    } catch {
        return undefined;
    }

    try {
        const stat = await fs.promises.stat(filePath);

        return { mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
        return undefined;
    }
}

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
    /** Сколько объявлений ждёт записи на диск; всё прочее в памяти не живёт. */
    pendingDeclarations: number;
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

/** Что известно о файле между сохранениями: без состава. */
interface IRslCatalogEntry {
    stamp: IRslCatalogStamp;
    /** Запись сделана в этой сессии по прочитанному файлу. */
    confirmed: boolean;
}

export class RslCatalogStore {
    private readonly buckets: number;
    private directory: string | undefined;
    /**
     * Что известно о файлах: только отпечаток и признак сверки.
     *
     * Состав файла здесь НЕ живёт. Рабочий каталог держит свой экземпляр, и
     * второй, лежавший тут ради следующего сохранения, стоил на проекте из
     * 6165 модулей и 98 640 объявлений около 16 МиБ — при том, что нужен он
     * ровно в момент записи корзины.
     */
    private entries = new Map<string, IRslCatalogEntry>();
    /**
     * Состав, ещё не дошедший до диска.
     *
     * null — файл удалён и должен исчезнуть из корзины. Живёт до ближайшего
     * сохранения: корзина читается с диска, правится этими записями и пишется
     * обратно.
     */
    private pending = new Map<string, IRslCatalogRecord | null>();
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
        this.entries.clear();
        this.pending.clear();
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
    async load(
        workspaceUris: readonly string[],
        onRecord?: (record: IRslCatalogRecord) => void | Promise<void>
    ): Promise<number> {
        this.entries.clear();
        this.pending.clear();
        this.loadedFromDisk = true;

        if (!this.directory) {
            return 0;
        }

        const known = new Set(workspaceUris);
        let restored = 0;

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

                this.entries.set(record.uri, {
                    stamp: record.stamp,
                    confirmed: false
                });
                restored++;

                /*
                 * Состав отдаётся вызывающему и здесь не остаётся. Он нужен
                 * один раз — чтобы наполнить рабочий каталог, — и держать его
                 * ради этого всю сессию незачем. Отдаётся по одной записи, а
                 * не массивом: иначе в памяти всё равно оказался бы весь
                 * состав проекта разом.
                 */
                await onRecord?.(record);
            }
        }

        return restored;
    }

    /**
     * Изменился ли файл с тех пор, как ЭТА сессия его прочитала.
     *
     * Прежде здесь стояло, что ошибка безопасна: изменённый файл, признанный
     * прежним, перечитает наблюдатель за файлами. Для правки при работающем
     * сервере это верно, а для правки между запусками — нет: наблюдатель её не
     * видел и не увидит, а постоянные записи существуют ровно ради этого
     * случая. Поэтому дата и размер сверяются только у записи, которую эта
     * сессия уже подтвердила чтением, — см. IRslCatalogRecord.confirmed.
     */
    async isUnchanged(uri: string): Promise<boolean> {
        const record = this.entries.get(uri);

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

        /* Запись этой сессии: файл только что прочитали. */
        this.entries.set(uri, { stamp, confirmed: true });
        this.pending.set(uri, {
            uri,
            stamp,
            declarations: [...declarations],
            imports: [...imports],
            fileReferences: [...fileReferences]
        });
        this.dirty.add(bucketOf(uri, this.buckets));
        this.scheduleSave();
    }

    /** Файл изменился или удалён: запись о нём больше не годится. */
    invalidate(uri: string): void {
        if (!this.entries.delete(uri) && !this.pending.has(uri)) {
            return;
        }

        /* Удаление тоже ждёт сохранения: иначе оно не дойдёт до корзины. */
        this.pending.set(uri, null);
        this.dirty.add(bucketOf(uri, this.buckets));
        this.scheduleSave();
    }

    /** Проект сменился: записи о чужих файлах не нужны. */
    retainWorkspaceFiles(uris: readonly string[]): void {
        const known = new Set(uris);

        for (const uri of [...this.entries.keys()]) {
            if (!known.has(uri)) {
                this.invalidate(uri);
            }
        }
    }

    get stats(): IRslCatalogStoreStats {
        return {
            files: this.entries.size,
            pendingDeclarations: this.declarationCount(),
            dirtyBuckets: this.dirty.size,
            loaded: this.loadedFromDisk
        };
    }

    /**
     * Сколько объявлений держат записи.
     *
     * Второй экземпляр состава проекта: рабочий каталог держит свой, а этот
     * нужен, чтобы перезаписать корзину при следующем сохранении. На 6165
     * модулях и 98 640 объявлениях это около 16 МиБ, и в отчёте о памяти они
     * были не видны вовсе — назывались только файлы.
     *
     * Считается по требованию: отчёт спрашивают руками, а держать счётчик
     * ради него значило бы обновлять его на каждой записи.
     */
    private declarationCount(): number {
        let count = 0;

        for (const record of this.pending.values()) {
            count += record ? record.declarations.length : 0;
        }

        return count;
    }

    /**
     * Записать всё немедленно.
     *
     * Отложенное сохранение при этом снимается: оно записало бы то же самое,
     * но уже после того, как вызывающий счёл работу законченной. Именно так
     * проверки ловили ENOTEMPTY — отложенная запись создавала файл в каталоге,
     * который тест в этот момент удалял.
     */
    flush(): Promise<void> {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }

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

        /* Что изменилось, разложено по корзинам: остальное лежит на диске. */
        const changes = new Map<number, Map<string, IRslCatalogRecord | null>>();

        for (const [uri, record] of this.pending) {
            const bucket = bucketOf(uri, this.buckets);

            if (!pending.includes(bucket)) {
                continue;
            }

            const list = changes.get(bucket) || new Map();

            list.set(uri, record);
            changes.set(bucket, list);
        }

        for (const bucket of pending) {
            const applied = changes.get(bucket);

            await this.saveBucket(bucket, applied || new Map());

            for (const uri of applied?.keys() || []) {
                this.pending.delete(uri);
            }
        }
    }

    /**
     * Переписать корзину, применив к ней изменения.
     *
     * Корзина читается с диска и правится, а не собирается из памяти: состав
     * неизменившихся файлов в памяти больше не живёт. Читается ровно та
     * корзина, которой изменения касаются, — их 32, и правка одного файла
     * трогает одну.
     */
    /** Состав корзины на диске с наложенными изменениями. */
    private async mergeBucket(
        bucket: number,
        changes: Map<string, IRslCatalogRecord | null>
    ): Promise<IRslCatalogRecord[]> {
        const known = new Map<string, IRslCatalogRecord>();

        try {
            const raw = await fs.promises.readFile(
                this.bucketPath(bucket),
                "utf8"
            );
            const parsed = JSON.parse(raw) as ISerializedCatalogBucket;

            if (parsed && parsed.version === STORE_VERSION) {
                for (const record of parsed.files || []) {
                    known.set(record.uri, record);
                }
            }
        } catch {
            /* Корзины ещё нет или она повреждена: перепишем целиком. */
        }

        for (const [uri, record] of changes) {
            if (record) {
                known.set(uri, record);
            } else {
                known.delete(uri);
            }
        }

        /*
         * Файлы, выбывшие из проекта, в корзине не остаются: retainWorkspaceFiles
         * снимает их из entries, но на диск это доходит только здесь.
         */
        for (const uri of [...known.keys()]) {
            if (!this.entries.has(uri) && !changes.has(uri)) {
                known.delete(uri);
            }
        }

        /* Порядок задан: иначе один и тот же состав давал бы разные файлы. */
        return [...known.values()].sort((left, right) =>
            left.uri < right.uri ? -1 : (left.uri > right.uri ? 1 : 0));
    }

    private async saveBucket(
        bucket: number,
        changes: Map<string, IRslCatalogRecord | null>
    ): Promise<void> {
        const target = this.bucketPath(bucket);
        const files = await this.mergeBucket(bucket, changes);

        try {
            if (files.length === 0) {
                await fs.promises.rm(target, { force: true });

                return;
            }

            /* Через временный файл: оборванная запись оставила бы огрызок. */
            const temporary = target + ".tmp";
            const payload: ISerializedCatalogBucket = { version: STORE_VERSION, files };

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

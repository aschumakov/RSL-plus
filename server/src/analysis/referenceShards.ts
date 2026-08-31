import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { decodeRslSourceText } from "../core/textDecoding";
import { contentFingerprint } from "./contentFingerprint";

/**
 * Постоянные записи о ссылках: что и куда ссылается в закрытых файлах.
 *
 * Find All References сегодня для каждого файла-кандидата читает его с диска,
 * лексирует, разбирает и разрешает имена заново. На проверенном проекте
 * популярное имя даёт 2533 файла-кандидата на 66 МБ, и один только их разбор
 * стоит 4,2 секунды — при каждом запросе, сколько бы раз его ни повторили.
 *
 * Разрешённые ссылки записываются по файлам и переживают перезапуск. Запись
 * появляется тогда, когда файл всё равно пришлось разобрать, поэтому индекс
 * ничего не стоит ни при индексации проекта, ни в памяти до первого запроса.
 *
 * Запись хранится по имени, а не по цели: разбирая файл ради одного символа,
 * мы уже разрешили ВСЕ вхождения этого имени, и следующий вопрос про другой
 * символ с тем же именем ответится без чтения.
 */

/** Одна разрешённая ссылка: куда ведёт и где написана. */
export interface IRslShardReference {
    /** Устойчивое тождество цели: URI и идентификатор символа. */
    targetKey: string;
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
    /** Это само объявление, а не обращение к нему. */
    isDeclaration: boolean;
}

/**
 * Признак неизменности файла без его чтения.
 *
 * Отпечаток содержимого надёжнее, но требует прочитать файл — то есть ровно то,
 * чего запись и должна избежать. Поэтому неизменность проверяется по stat, а от
 * правок, сделанных при работающем сервере, запись защищает наблюдатель за
 * файлами: он зовёт invalidate. Правка при выключенном сервере меняет дату, и
 * запись отбрасывается по ней.
 */
interface IRslShardStamp {
    mtimeMs: number;
    size: number;
    /**
     * Отпечаток содержимого; см. contentFingerprint.
     *
     * Дата и размер — не основание считать файл прежним: их сохраняют системы
     * контроля версий и утилиты копирования, а правка одинаковой длины не
     * меняет ни того ни другого. Для Rename цена такой ошибки — правка по
     * устаревшим диапазонам, то есть испорченный файл.
     */
    fingerprint: string;
}

interface IRslShardEntry {
    stamp: IRslShardStamp;
    /** Имя -> все его разрешённые вхождения в этом файле. */
    names: Map<string, IRslShardReference[]>;
    /**
     * Отпечаток сверен с диском в этой сессии.
     *
     * На диск не пишется: после перезапуска доверять прежней сверке нельзя.
     * Записи, сделанной в этой сессии, сверка не нужна — файл только что
     * прочитали. Восстановленную сверяет первое же обращение, и стоит это
     * одного чтения на файл за сессию: разбор и разрешение имён — то, ради
     * чего запись и заведена, — не повторяются.
     */
    confirmed?: boolean;
}

interface ISerializedShard {
    version: number;
    files: Array<{
        uri: string;
        mtimeMs: number;
        size: number;
        fingerprint?: string;
        names: Array<{ name: string; refs: IRslShardReference[] }>;
    }>;
}

export interface IRslReferenceShardOptions {
    log?(message: string): void;
    /** Сколько корзин: по одной на файл было бы слишком много мелких файлов. */
    buckets?: number;
    /** Через сколько сохранять после изменения: см. catalogStore. */
    saveDebounceMs?: number;
}

export interface IRslReferenceShardStats {
    /** Сколько файлов описано в загруженных корзинах. */
    files: number;
    /** Сколько имён в них описано. */
    names: number;
    /** Сколько корзин уже прочитано с диска. */
    loadedBuckets: number;
    /** Сколько корзин ждёт записи. */
    dirtyBuckets: number;
}

/*
 * 1: имя -> разрешённые ссылки, неизменность по дате и размеру.
 */
const SHARD_VERSION = 1;
const DEFAULT_BUCKETS = 64;
const SAVE_DEBOUNCE_MS = 3000;

/** Номер корзины по URI: он же имя файла корзины. */
function bucketOf(uri: string, buckets: number): number {
    let hash = 2166136261;

    for (let at = 0; at < uri.length; at++) {
        hash ^= uri.charCodeAt(at);
        hash = Math.imul(hash, 16777619);
    }

    return Math.abs(hash) % buckets;
}

export class RslReferenceShardStore {
    private readonly buckets: number;
    private directory: string | undefined;
    /** Прочитанные корзины: номер -> записи файлов. */
    private loaded = new Map<number, Map<string, IRslShardEntry>>();
    private loading = new Map<number, Promise<void>>();
    private dirty = new Set<number>();
    private saveTimer: NodeJS.Timeout | undefined;
    private workspaceUris: Set<string> | undefined;
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

    constructor(private options: IRslReferenceShardOptions = {}) {
        this.buckets = Math.max(1, options.buckets ?? DEFAULT_BUCKETS);
        this.saveDebounceMs = options.saveDebounceMs ?? SAVE_DEBOUNCE_MS;
    }

    configurePersistence(directory: string | undefined): void {
        this.directory = directory ? path.resolve(directory) : undefined;
        this.loaded.clear();
        this.loading.clear();
        this.dirty.clear();
    }

    /**
     * Разрешённые ссылки этого имени в этом файле.
     *
     * undefined — записи нет или она устарела: файл придётся прочитать. Пустой
     * массив — тоже ответ: имя в файле есть, но ни одна его встреча никуда не
     * ведёт. Без этого различия такой файл перечитывался бы каждый раз.
     */
    async lookup(
        uri: string,
        name: string
    ): Promise<IRslShardReference[] | undefined> {
        const entry = await this.entryOf(uri);

        if (!entry) {
            return undefined;
        }

        /*
         * Сверенная запись отвечает сразу.
         *
         * Ни stat, ни чтения: правки этой сессии снимают запись через
         * наблюдателя за файлами, а между сессиями её сверяет первое
         * обращение. Прежде здесь был stat на каждый файл-кандидат — на
         * популярном имени это 2533 обращения к файловой системе при каждом
         * повторном поиске.
         */
        if (entry.confirmed) {
            return entry.names.get(name);
        }

        if (!await this.confirm(uri, entry)) {
            return undefined;
        }

        return entry.names.get(name);
    }

    /**
     * Сверить восстановленную запись с содержимым файла.
     *
     * Дата и размер проверяются первыми: они дешевле и отсеивают обычную
     * правку. Совпали — читается содержимое, потому что правка одинаковой
     * длины с восстановленной датой их не меняет, а Rename по устаревшим
     * диапазонам портит файл молча.
     */
    private async confirm(
        uri: string,
        entry: IRslShardEntry
    ): Promise<boolean> {
        const stamp = await stampOf(uri);

        if (!stamp || !sameStamp(stamp, entry.stamp)) {
            this.forgetEntry(uri);

            return false;
        }

        let content: Buffer;

        try {
            content = await fs.promises.readFile(fileURLToPath(uri));
        } catch {
            this.forgetEntry(uri);

            return false;
        }

        if (
            contentFingerprint(decodeRslSourceText(content)) !==
            entry.stamp.fingerprint
        ) {
            this.forgetEntry(uri);

            return false;
        }

        entry.confirmed = true;

        return true;
    }

    /**
     * Запомнить разрешённые ссылки имени в файле.
     *
     * Текст берётся у вызывающего: он его только что прочитал и разобрал, а
     * отпечаток по готовой строке ничего не стоит. Читать файл здесь ещё раз
     * значило бы удвоить ту работу, ради которой запись и заводится.
     */
    async record(
        uri: string,
        name: string,
        references: readonly IRslShardReference[],
        source: string
    ): Promise<void> {
        const stat = await stampOf(uri);

        if (!stat) {
            return;
        }

        const stamp: IRslShardStamp = {
            ...stat,
            fingerprint: contentFingerprint(source)
        };
        const bucket = bucketOf(uri, this.buckets);

        await this.ensureBucket(bucket);

        const entries = this.loaded.get(bucket);

        if (!entries) {
            return;
        }

        /*
         * Прежние имена достаются новой записи только при том же содержимом.
         *
         * Сравнивается отпечаток, а не дата с размером. Иначе подмена той же
         * длины с восстановленной датой оставляла бы в записи имена от старого
         * текста: пересчитали имя A — имя B осталось прежним, а запись после
         * record считается сверенной, и содержимое больше никто не проверит.
         */
        const known = entries.get(uri);
        const reusable = known &&
            known.stamp.fingerprint === stamp.fingerprint;
        const entry = reusable
            ? known
            : { stamp, names: new Map<string, IRslShardReference[]>() };

        /* Дата могла измениться при том же содержимом: она тоже обновляется. */
        entry.stamp = stamp;
        /* Запись этой сессии сверена по построению: текст только что читали. */
        entry.confirmed = true;
        entry.names.set(name, [...references]);
        entries.set(uri, entry);
        this.dirty.add(bucket);
        this.scheduleSave();
    }

    /** Файл изменился: всё, что о нём записано, устарело. */
    invalidate(uri: string): void {
        this.forgetEntry(uri);
    }

    /** Файлов проекта больше нет: их записи не нужны. */
    retainWorkspaceFiles(uris: readonly string[]): void {
        this.workspaceUris = new Set(uris);

        for (const [bucket, entries] of this.loaded) {
            for (const uri of [...entries.keys()]) {
                if (!this.workspaceUris.has(uri)) {
                    entries.delete(uri);
                    this.dirty.add(bucket);
                }
            }
        }
    }

    get stats(): IRslReferenceShardStats {
        let files = 0;
        let names = 0;

        for (const entries of this.loaded.values()) {
            files += entries.size;

            for (const entry of entries.values()) {
                names += entry.names.size;
            }
        }

        return {
            files,
            names,
            loadedBuckets: this.loaded.size,
            dirtyBuckets: this.dirty.size
        };
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
                "Не удалось создать каталог записей о ссылках: " + error
            );

            return;
        }

        for (const bucket of pending) {
            await this.saveBucket(bucket);
        }
    }

    private forgetEntry(uri: string): void {
        const bucket = bucketOf(uri, this.buckets);
        const entries = this.loaded.get(bucket);

        if (entries?.delete(uri)) {
            this.dirty.add(bucket);
        }
    }

    private async entryOf(uri: string): Promise<IRslShardEntry | undefined> {
        const bucket = bucketOf(uri, this.buckets);

        await this.ensureBucket(bucket);

        return this.loaded.get(bucket)?.get(uri);
    }

    /**
     * Корзина читается по первому обращению.
     *
     * Держать в памяти все ссылки проекта незачем: запрос касается одного
     * имени, а корзина — одной шестьдесят четвёртой файлов.
     */
    private ensureBucket(bucket: number): Promise<void> {
        if (this.loaded.has(bucket)) {
            return Promise.resolve();
        }

        const running = this.loading.get(bucket);

        if (running) {
            return running;
        }

        const promise = this.loadBucket(bucket).finally(() => {
            this.loading.delete(bucket);
        });

        this.loading.set(bucket, promise);

        return promise;
    }

    private async loadBucket(bucket: number): Promise<void> {
        const entries = new Map<string, IRslShardEntry>();

        this.loaded.set(bucket, entries);

        if (!this.directory) {
            return;
        }

        let raw: string;

        try {
            raw = await fs.promises.readFile(
                this.bucketPath(bucket),
                "utf8"
            );
        } catch {
            /* Корзины ещё нет: это обычное состояние до первого запроса. */
            return;
        }

        let parsed: ISerializedShard;

        try {
            parsed = JSON.parse(raw) as ISerializedShard;
        } catch (error) {
            this.options.log?.(
                "Запись о ссылках повреждена и пропущена: " + error
            );

            return;
        }

        if (!parsed || parsed.version !== SHARD_VERSION) {
            return;
        }

        for (const file of parsed.files || []) {
            if (this.workspaceUris && !this.workspaceUris.has(file.uri)) {
                continue;
            }

            if (!file.fingerprint) {
                /* Запись прежнего формата: сверять её нечем. */
                continue;
            }

            entries.set(file.uri, {
                stamp: {
                    mtimeMs: file.mtimeMs,
                    size: file.size,
                    fingerprint: file.fingerprint
                },
                names: new Map(
                    (file.names || []).map(item => [item.name, item.refs])
                )
            });
        }
    }

    private async saveBucket(bucket: number): Promise<void> {
        const entries = this.loaded.get(bucket);

        if (!entries || !this.directory) {
            return;
        }

        const payload: ISerializedShard = {
            version: SHARD_VERSION,
            files: [...entries.entries()].map(([uri, entry]) => ({
                uri,
                mtimeMs: entry.stamp.mtimeMs,
                size: entry.stamp.size,
                fingerprint: entry.stamp.fingerprint,
                names: [...entry.names.entries()].map(([name, refs]) => ({
                    name,
                    refs
                }))
            }))
        };
        const target = this.bucketPath(bucket);

        try {
            if (payload.files.length === 0) {
                await fs.promises.rm(target, { force: true });

                return;
            }

            /*
             * Через временный файл: оборванная запись оставила бы корзину
             * наполовину записанной, и следующий запуск счёл бы её порченой.
             */
            const temporary = target + ".tmp";

            await fs.promises.writeFile(
                temporary,
                JSON.stringify(payload),
                "utf8"
            );
            await fs.promises.rename(temporary, target);
        } catch (error) {
            this.options.log?.("Не удалось сохранить записи о ссылках: " + error);
        }
    }

    private bucketPath(bucket: number): string {
        return path.join(
            this.directory || "",
            "refs-" + String(bucket).padStart(3, "0") + ".json"
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

function sameStamp(
    left: { mtimeMs: number; size: number },
    right: { mtimeMs: number; size: number }
): boolean {
    return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

/** Дата и размер файла: без чтения содержимого. */
async function stampOf(
    uri: string
): Promise<{ mtimeMs: number; size: number } | undefined> {
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

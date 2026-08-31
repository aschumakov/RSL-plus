import { systemRslClock, type IRslClock } from "../core/clock";
import type { WorkspaceIndex } from "../workspaceIndex";
import type { ICompactModuleResponse } from "./compactModuleProtocol";
import type {
    IRslDeclarationDescriptor
} from "../analysis/declarationExtractor";

/**
 * Полный каталог проекта независимо от режима индексации.
 *
 * Каталог заполнялся по мере индексации: модуль попадал в него, когда его
 * загружали ради Import или ради открытого файла. В режиме activeImports —
 * по умолчанию — большинство файлов не загружается никогда, и Ctrl+T,
 * Go to Implementation и переименование файла отвечали по той части проекта,
 * которую пользователь успел задеть. Ответ зависел от истории сеанса.
 *
 * Здесь каталог достраивается своим обходом. Чтение файла и его компактное
 * сканирование уходят в тот же worker, что и обычная фоновая индексация, с
 * фоновым приоритетом: навигация, Completion и Import активного файла его
 * обгоняют. На основном потоке остаётся только запись готовых дескрипторов в
 * каталог, и она ограничена бюджетом порции.
 *
 * Так было не всегда: первая версия читала и сканировала по двенадцать файлов
 * подряд прямо на основном потоке. На файлах по 700 КБ одна такая порция
 * занимала поток больше секунды — ровно то, что пользователь чувствует как
 * подвисание при вводе.
 */

export interface IRslCatalogWarmupOptions {
    index: WorkspaceIndex;
    /**
     * Компактное чтение файла: тот же worker, что у фоновой индексации.
     *
     * Ответ содержит дескрипторы, импорты и строковые ссылки — всё, что нужно
     * каталогу, и ничего тяжёлого (см. compactModuleProtocol).
     */
    read(uri: string): Promise<ICompactModuleResponse>;
    log?(message: string): void;
    clock?: IRslClock;
    /** Сколько файлов запрашивать у worker одновременно. */
    concurrency?: number;
    /** Сколько времени порция вправе занимать основной поток. */
    budgetMs?: number;
    /** Пауза между порциями. */
    pauseMs?: number;
    /** Сколько ждать тишины после правки, прежде чем вернуться к работе. */
    idleMs?: number;
    /** Каталог пополнился: зависимые ответы могли устареть. */
    onCatalogChanged?(uris: readonly string[]): void;
    /** Отчёт о ходе: для лога и тестов. */
    onProgress?(progress: IRslCatalogWarmupProgress): void;
    /**
     * Сохранённый состав проекта, если он ведётся.
     *
     * Обход спрашивает его о каждом файле: неизменный файл не читается вовсе,
     * а прочитанный — записывается, чтобы следующий запуск начал с готового
     * каталога.
     */
    store?: IRslCatalogWarmupStore;
}

/** Что обходу нужно от сохранённого состава проекта. */
export interface IRslCatalogWarmupStore {
    isUnchanged(uri: string): Promise<boolean>;
    /** Сверена ли запись чтением в этой сессии; см. RslCatalogStore. */
    isConfirmed(uri: string): boolean;
    record(
        uri: string,
        declarations: readonly IRslDeclarationDescriptor[],
        imports: readonly string[],
        fileReferences: readonly string[]
    ): Promise<void>;
}

export interface IRslCatalogWarmupProgress {
    total: number;
    done: number;
    skipped: number;
    /** Обход закончен: очередь пуста. */
    complete: boolean;
}

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_BUDGET_MS = 10;
const DEFAULT_PAUSE_MS = 25;
const DEFAULT_IDLE_MS = 1500;

export class RslCatalogWarmupService {
    private queue: string[] = [];
    private queued = new Set<string>();
    private timer: unknown;
    private idleTimer: unknown;
    private running = false;
    /**
     * Текущая порция, если она идёт.
     *
     * Порция вынимает файлы из очереди и только потом читает их. Пока она
     * читает, очередь уже пуста — и второй запуск считает обход законченным,
     * хотя часть файлов ещё в работе. Ждать надо не пустую очередь, а
     * закончившуюся порцию.
     */
    private current: Promise<void> | undefined;
    private suspended = false;
    private done = 0;
    private skipped = 0;
    /** Сколько файлов не читалось: их состав уже был сохранён. */
    private reused = 0;
    private total = 0;
    private readonly clock: IRslClock;

    constructor(private readonly options: IRslCatalogWarmupOptions) {
        this.clock = options.clock || systemRslClock;
    }

    /**
     * Добавить файлы проекта в очередь достройки.
     *
     * Файл, о котором каталог уже знает всё — и состав, и строковые ссылки, —
     * пропускается: обход достраивает, а не пересчитывает. Файл, попавший в
     * каталог из подробной модели, ссылок не имеет, и его прочитать нужно.
     */
    add(uris: readonly string[]): void {
        for (const uri of uris) {
            if (this.queued.has(uri) || this.isComplete(uri)) {
                continue;
            }

            this.enqueue(uri);
        }

        this.schedule();
    }

    /**
     * Пользователь работает: обход ждёт.
     *
     * Возвращается сам, после тишины: иначе каждая правка требовала бы явного
     * разрешения продолжать, а забытое разрешение означало бы каталог,
     * достроенный до половины.
     */
    suspend(): void {
        this.suspended = true;
        this.clearTimer();
        this.armIdleTimer();
    }

    resume(): void {
        this.clearIdleTimer();

        if (!this.suspended) {
            return;
        }

        this.suspended = false;
        this.schedule();
    }

    /** Проект закрыт: очередь больше не нужна. */
    stop(): void {
        this.queue = [];
        this.queued.clear();
        this.clearTimer();
        this.clearIdleTimer();
    }

    /** Файл изменился на диске: перечитать его в каталог. */
    invalidate(uri: string): void {
        if (this.queued.has(uri)) {
            return;
        }

        this.enqueue(uri);
        this.schedule();
    }

    get progress(): IRslCatalogWarmupProgress {
        return {
            total: this.total,
            done: this.done,
            skipped: this.skipped,
            complete: this.queue.length === 0
        };
    }

    /** Проход до конца: для тестов и batch-режима. */
    async runToCompletion(): Promise<IRslCatalogWarmupProgress> {
        while (this.queue.length > 0 || this.current) {
            await this.runChunk(Number.POSITIVE_INFINITY);
        }

        return this.progress;
    }

    private enqueue(uri: string): void {
        this.queued.add(uri);
        this.queue.push(uri);
        this.total++;
    }

    /**
     * Знает ли каталог об этом файле всё.
     *
     * Строковые ссылки появляются только у файла, прочитанного этим обходом:
     * запись из подробной модели их не содержит, и без перечитывания
     * переименование файла не нашло бы ссылку в нём.
     */
    private isComplete(uri: string): boolean {
        if (!this.options.index.catalog.hasFileReferences(uri)) {
            return false;
        }

        /*
         * Восстановленная запись — ещё не прочитанный файл.
         *
         * Строковые ссылки у неё есть, потому что их сохранили прошлым
         * запуском, и по одному их наличию файл выглядел полностью известным:
         * обход не ставил его в очередь вовсе. Обещанная сверка «один раз за
         * сессию» при этом не выполнялась ни разу, и символ из файла,
         * изменённого между запусками, оставался в Ctrl+T до конца сессии.
         */
        return !this.options.store || this.options.store.isConfirmed(uri);
    }

    private schedule(): void {
        if (
            this.suspended ||
            this.running ||
            this.timer !== undefined ||
            this.queue.length === 0
        ) {
            return;
        }

        this.timer = this.clock.setTimeout(
            () => {
                this.timer = undefined;
                void this.tick();
            },
            this.options.pauseMs ?? DEFAULT_PAUSE_MS
        );
    }

    private async tick(): Promise<void> {
        await this.runChunk(this.options.budgetMs ?? DEFAULT_BUDGET_MS);
        this.options.onProgress?.(this.progress);
        this.schedule();
    }

    /**
     * Одна порция: запросы уходят в worker, ответы пишутся в каталог.
     *
     * Бюджет считается по работе на основном потоке — записи в каталог, — а не
     * по ожиданию worker: ожидание поток не занимает.
     */
    /**
     * Порция обхода, и только одна разом.
     *
     * Обход запускается и по таймеру, и явным ожиданием. Две порции сразу не
     * ускоряют его, а удваивают занятость основного потока — и путают счёт:
     * файлы одной уже вынуты из очереди, а другая считает очередь пустой.
     */
    private runChunk(budgetMs: number): Promise<void> {
        if (!this.current) {
            this.current = this.processChunk(budgetMs)
                .finally(() => {
                    this.current = undefined;
                });
        }

        return this.current;
    }

    private async processChunk(budgetMs: number): Promise<void> {
        this.running = true;

        const changed: string[] = [];
        let spentMs = 0;

        try {
            while (this.queue.length > 0 && spentMs < budgetMs) {
                if (this.suspended) {
                    break;
                }

                const batch = this.queue.splice(
                    0,
                    Math.max(1, this.options.concurrency ?? DEFAULT_CONCURRENCY)
                );

                for (const uri of batch) {
                    this.queued.delete(uri);
                }

                const responses = await Promise.all(
                    batch.map(uri => this.readSafely(uri))
                );
                const started = process.hrtime.bigint();

                for (const response of responses) {
                    if (response && this.record(response)) {
                        changed.push(response.uri);
                    }
                }

                spentMs += Number(process.hrtime.bigint() - started) / 1e6;
            }
        } finally {
            this.running = false;
        }

        if (changed.length > 0) {
            this.options.onCatalogChanged?.(changed);
        }
    }

    /** Сколько файлов обход не читал: их состав взят из сохранённого. */
    get reusedFiles(): number {
        return this.reused;
    }

    private async readSafely(
        uri: string
    ): Promise<ICompactModuleResponse | undefined> {
        /*
         * Неизменный файл не читается.
         *
         * Его состав уже в каталоге — он загружен из сохранённого при старте.
         * Прочитать его значило бы получить ровно то же самое, заплатив за
         * весь проект: на проверенном проекте это 6165 файлов и 104 МБ.
         */
        if (this.options.store && await this.options.store.isUnchanged(uri)) {
            this.reused++;

            return undefined;
        }

        try {
            return await this.options.read(uri);
        } catch (error) {
            this.options.log?.(
                "Каталог: файл не прочитан " + uri + ": " + String(error)
            );
            this.skipped++;

            return undefined;
        }
    }

    /** Записать состав файла; true — каталог изменился. */
    private record(response: ICompactModuleResponse): boolean {
        if (response.status !== "indexed") {
            this.skipped++;

            return false;
        }

        /*
         * Открытый файл живёт по буферу редактора, и его модель свежее любого
         * чтения с диска. Перезаписать её ответом обхода значило бы вернуть
         * каталог к состоянию сохранённого файла.
         */
        const loaded = this.options.index.getModule(response.uri);

        if (loaded?.isOpen) {
            this.skipped++;

            return false;
        }

        this.options.index.catalog.recordDeclarations({
            uri: response.uri,
            version: 0,
            declarations: response.declarations,
            imports: response.imports,
            fileReferences: new Set(response.fileReferences)
        });
        this.done++;

        /* Следующий запуск начнёт с готового каталога, а не с чтения. */
        void this.options.store?.record(
            response.uri,
            response.declarations,
            response.imports,
            response.fileReferences
        );

        return true;
    }

    private armIdleTimer(): void {
        this.clearIdleTimer();
        this.idleTimer = this.clock.setTimeout(
            () => {
                this.idleTimer = undefined;
                this.resume();
            },
            this.options.idleMs ?? DEFAULT_IDLE_MS
        );
    }

    private clearIdleTimer(): void {
        if (this.idleTimer !== undefined) {
            this.clock.clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }
    }

    private clearTimer(): void {
        if (this.timer !== undefined) {
            this.clock.clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
}

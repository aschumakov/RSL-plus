import { systemRslClock, type IRslClock } from "../core/clock";
import {
    createExternalModuleSummary,
    type IRslModuleModel
} from "../moduleModel";
import type { WorkspaceIndex } from "../workspaceIndex";

/**
 * Полный каталог проекта независимо от режима индексации.
 *
 * Каталог заполнялся по мере индексации: модуль попадал в него, когда его
 * загружали ради Import или ради открытого файла. В режиме activeImports —
 * по умолчанию — большинство файлов не загружается никогда, и Ctrl+T,
 * Go to Implementation и переименование файла отвечали по той части проекта,
 * которую пользователь успел задеть. Ответ зависел от истории сеанса.
 *
 * Здесь каталог достраивается своим обходом: файл читается, из него компактным
 * сканером берутся объявления, каталог их запоминает — и модель тут же
 * выбрасывается. В хранилище модулей она не попадает, LRU открытых файлов не
 * вытесняется, память растёт на компактные записи каталога, а не на модели.
 *
 * Обход идёт порциями и уступает дорогу: он нужен «через минуту после
 * открытия», а не «сейчас», и не имеет права занимать поток, пока пользователь
 * печатает.
 */

export interface IRslCatalogWarmupOptions {
    index: WorkspaceIndex;
    /** Чтение файла: сервер читает с диска, тест — из карты. */
    readFile(uri: string): string | undefined;
    log?(message: string): void;
    clock?: IRslClock;
    /** Файлов за порцию. */
    chunkFiles?: number;
    /** Пауза между порциями. */
    pauseMs?: number;
    /**
     * Файл больше этого размера пропускается.
     *
     * Каталог нужен для навигации по именам; сгенерированный модуль на десятки
     * мегабайт даёт мало имён и много работы.
     */
    maxFileBytes?: number;
    /** Отчёт о ходе: для лога и тестов. */
    onProgress?(progress: IRslCatalogWarmupProgress): void;
}

export interface IRslCatalogWarmupProgress {
    total: number;
    done: number;
    skipped: number;
    /** Обход закончен: очередь пуста. */
    complete: boolean;
}

const DEFAULT_CHUNK_FILES = 12;
const DEFAULT_PAUSE_MS = 20;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;

export class RslCatalogWarmupService {
    private queue: string[] = [];
    private queued = new Set<string>();
    private timer: unknown;
    private running = false;
    private suspended = false;
    private done = 0;
    private skipped = 0;
    private total = 0;
    private readonly clock: IRslClock;

    constructor(private readonly options: IRslCatalogWarmupOptions) {
        this.clock = options.clock || systemRslClock;
    }

    /**
     * Добавить файлы проекта в очередь достройки.
     *
     * Уже известные каталогу пропускаются: обход достраивает, а не пересчитывает.
     */
    add(uris: readonly string[]): void {
        for (const uri of uris) {
            if (this.queued.has(uri) || this.options.index.catalog.has(uri)) {
                continue;
            }

            this.queued.add(uri);
            this.queue.push(uri);
            this.total++;
        }

        this.schedule();
    }

    /** Пользователь работает: обход подождёт. */
    suspend(): void {
        this.suspended = true;
        this.clearTimer();
    }

    resume(): void {
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
    }

    /** Файл изменился на диске: перечитать его в каталог. */
    invalidate(uri: string): void {
        if (this.queued.has(uri)) {
            return;
        }

        this.queued.add(uri);
        this.queue.push(uri);
        this.total++;
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

    /** Синхронный проход до конца: для тестов и для batch-режима. */
    runToCompletion(): IRslCatalogWarmupProgress {
        while (this.queue.length > 0) {
            this.processChunk(this.queue.length);
        }

        return this.progress;
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
                this.tick();
            },
            this.options.pauseMs ?? DEFAULT_PAUSE_MS
        );
    }

    private tick(): void {
        this.processChunk(this.options.chunkFiles ?? DEFAULT_CHUNK_FILES);
        this.options.onProgress?.(this.progress);
        this.schedule();
    }

    private processChunk(count: number): void {
        this.running = true;

        try {
            for (let index = 0; index < count && this.queue.length > 0; index++) {
                const uri = this.queue.shift() as string;

                this.queued.delete(uri);
                this.record(uri);
            }
        } finally {
            this.running = false;
        }
    }

    /**
     * Прочитать файл и запомнить его состав.
     *
     * Ошибка чтения — не повод останавливать обход: файл мог быть удалён между
     * обнаружением и чтением, и это обычное дело в большом проекте.
     */
    private record(uri: string): void {
        let source: string | undefined;

        try {
            source = this.options.readFile(uri);
        } catch (error) {
            this.options.log?.(
                "Каталог: файл не прочитан " + uri + ": " + String(error)
            );
            this.skipped++;

            return;
        }

        if (source === undefined) {
            this.skipped++;

            return;
        }

        const limit = this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

        if (source.length * 2 > limit) {
            this.skipped++;

            return;
        }

        /*
         * Модель компактная и одноразовая: она нужна ровно на время записи в
         * каталог. Загруженной моделью файла она не считается — иначе обход
         * вытеснил бы из хранилища то, что нужно открытым файлам.
         */
        const summary: IRslModuleModel = createExternalModuleSummary(source);

        this.options.index.catalog.record({
            uri,
            version: 0,
            symbolTree: summary.symbolTree,
            imports: summary.imports,
            lex: summary.lex
        });
        this.options.index.catalog.recordFileReferences(
            uri,
            fileReferencesIn(source)
        );
        this.done++;
    }

    private clearTimer(): void {
        if (this.timer !== undefined) {
            this.clock.clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
}

/*
 * Строковые ссылки на файлы модулей.
 *
 * `ExecMacroFile("lib.mac")` — ссылка на файл, которую не видит ни Import, ни
 * дерево символов. Переименование файла обязано её обновить, а найти её можно
 * только в тексте. Разбор для этого не нужен: достаточно строковых литералов,
 * похожих на имя файла модуля.
 *
 * Ищется по тексту, а не по токенам: обход читает файл один раз и токены ему
 * больше ни для чего не нужны, а лексирование проекта стоило бы в разы дороже.
 */
const FILE_REFERENCE_PATTERN =
    /["']\s*([\wА-Яа-яЁё@.\-\\/]+\.(?:mac|rsm|dlm))\s*["']/giu;

export function fileReferencesIn(source: string): Set<string> {
    const result = new Set<string>();
    let match: RegExpExecArray | null;

    FILE_REFERENCE_PATTERN.lastIndex = 0;

    while ((match = FILE_REFERENCE_PATTERN.exec(source)) !== null) {
        const value = match[1].replace(/\\/gu, "/");
        const name = value.slice(value.lastIndexOf("/") + 1);

        result.add(name.toLowerCase());
    }

    return result;
}

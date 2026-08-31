import { createWorkSlice, type IRslWorkSlice } from "../core/timeSlice";
import type { IRslCatalogRecord } from "./catalogStore";
import type { WorkspaceCatalog } from "./workspaceCatalog";

/**
 * Перенос сохранённого состава проекта в рабочий каталог.
 *
 * Порциями с уступкой потоку. Одним куском перенос 98 640 объявлений занимал
 * поток на 170 мс подряд — это много дольше бюджета отзывчивости в 25 мс, и
 * приходится это на запуск, когда пользователь уже набирает текст.
 *
 * Отдельным модулем, а не строками в server.ts: непрерывность занятости —
 * свойство, которое надо проверять, а обработчик инициализации целиком
 * проверке не поддаётся.
 */

/** Порция переноса: меньше бюджета отзывчивости с запасом. */
export const RSL_CATALOG_RESTORE_SLICE_MS = 8;

/**
 * Порог, за которым один файл переносится по частям.
 *
 * Уступка между файлами не спасает от одного патологически большого: на
 * проверенном проекте худший файл — 4140 объявлений и 3,7 мс, но уже 25 000
 * объявлений в одном файле занимают поток на 40 мс, то есть за бюджетом.
 * Файлы крупнее порога заводятся в каталог порциями.
 */
export const RSL_CATALOG_RESTORE_BATCH = 4000;

export interface IRslCatalogRestoreOptions {
    /** Файл открыт в редакторе: его модель свежее сохранённой. */
    isOpen(uri: string): boolean;
    sliceMs?: number;
    /** Порог дробления одного файла; см. RSL_CATALOG_RESTORE_BATCH. */
    batch?: number;
    /** Уступка потоку; в проверках подменяется на счётчик. */
    onYield?(): void;
}

/** Приёмник записей: наполняет каталог порциями и считает перенесённое. */
export class RslCatalogRestore {
    private readonly slice: IRslWorkSlice;
    private readonly batch: number;
    private restored = 0;

    constructor(
        private readonly catalog: WorkspaceCatalog,
        private readonly options: IRslCatalogRestoreOptions
    ) {
        this.slice = createWorkSlice(
            options.sliceMs ?? RSL_CATALOG_RESTORE_SLICE_MS
        );
        this.batch = Math.max(1, options.batch ?? RSL_CATALOG_RESTORE_BATCH);
    }

    get count(): number {
        return this.restored;
    }

    async add(record: IRslCatalogRecord): Promise<void> {
        await this.yieldIfNeeded();

        if (this.options.isOpen(record.uri)) {
            /* У открытого документа своя модель, и она свежее. */
            return;
        }

        const declarations = record.declarations;

        if (declarations.length <= this.batch) {
            this.catalog.recordDeclarations({
                uri: record.uri,
                version: 0,
                declarations,
                imports: record.imports,
                fileReferences: new Set(record.fileReferences)
            });
            this.restored++;

            return;
        }

        /*
         * Крупный файл записывается порциями самим каталогом.
         *
         * Дробить его снаружи нельзя: тождество символа считается по всему
         * файлу — номер повторения одноимённых объявлений и идентификатор
         * модуля общие, — и отдельными вызовами записи одинаковые объявления
         * по разные стороны границы порции получали бы один symbolId.
         */
        await this.catalog.recordDeclarationsInBatches(
            {
                uri: record.uri,
                version: 0,
                declarations,
                imports: record.imports,
                fileReferences: new Set(record.fileReferences)
            },
            this.batch,
            () => this.yieldIfNeeded()
        );

        this.restored++;
    }

    private async yieldIfNeeded(): Promise<void> {
        if (!this.slice.shouldYield()) {
            return;
        }

        this.options.onYield?.();
        await this.slice.yieldNow();
    }
}

/** Перенести готовый список записей: удобство для проверок. */
export async function restoreRslCatalogRecords(
    catalog: WorkspaceCatalog,
    records: readonly IRslCatalogRecord[],
    options: IRslCatalogRestoreOptions
): Promise<number> {
    const restore = new RslCatalogRestore(catalog, options);

    for (const record of records) {
        await restore.add(record);
    }

    return restore.count;
}

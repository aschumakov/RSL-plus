import { createWorkSlice } from "../core/timeSlice";
import type { IRslCatalogRecord } from "./catalogStore";
import type { WorkspaceCatalog } from "./workspaceCatalog";

/**
 * Перенос сохранённого состава проекта в рабочий каталог.
 *
 * Порциями с уступкой потоку. Одним куском перенос 98 640 символов занимал
 * поток на 170 мс подряд — это много дольше бюджета отзывчивости в 25 мс, и
 * приходится это ровно на запуск, когда пользователь уже набирает текст.
 *
 * Отдельным модулем, а не строками в server.ts: непрерывность занятости —
 * свойство, которое надо проверять, а обработчик инициализации целиком
 * проверке не поддаётся.
 */

/** Порция переноса: меньше бюджета отзывчивости с запасом. */
export const RSL_CATALOG_RESTORE_SLICE_MS = 8;

export interface IRslCatalogRestoreOptions {
    /** Файл открыт в редакторе: его модель свежее сохранённой. */
    isOpen(uri: string): boolean;
    sliceMs?: number;
    /** Уступка потоку; в проверках подменяется на счётчик. */
    onYield?(): void;
}

export async function restoreRslCatalogRecords(
    catalog: WorkspaceCatalog,
    records: readonly IRslCatalogRecord[],
    options: IRslCatalogRestoreOptions
): Promise<number> {
    const slice = createWorkSlice(
        options.sliceMs ?? RSL_CATALOG_RESTORE_SLICE_MS
    );
    let restored = 0;

    for (const record of records) {
        if (slice.shouldYield()) {
            options.onYield?.();
            await slice.yieldNow();
        }

        if (options.isOpen(record.uri)) {
            /* У открытого документа своя модель, и она свежее. */
            continue;
        }

        catalog.recordDeclarations({
            uri: record.uri,
            version: 0,
            declarations: record.declarations,
            imports: record.imports,
            fileReferences: new Set(record.fileReferences)
        });
        restored++;
    }

    return restored;
}

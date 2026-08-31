/**
 * Что сервер держит в памяти и почему.
 *
 * Общая цифра heap ни о чём не говорит: она не отвечает ни на вопрос «кто
 * занял», ни на вопрос «почему выросло». Проверенный проект — 6165 файлов,
 * 143 МБ исходников, 97 тысяч символов каталога и около 307 МБ кучи, — и
 * каждая новая постоянная структура добавляет к этой сумме, не объявляя,
 * сколько именно.
 *
 * Здесь собрано то, что можно посчитать без обхода объектов: число записей и
 * учтённый объём каждого хранилища плюс причины вытеснения. Оценка объёма
 * приблизительна — JS не сообщает размер объекта, — но она пропорциональна
 * содержимому и годится, чтобы увидеть, кто вырос.
 */

/** Одна строка отчёта: что это и сколько его. */
export interface IRslStatusEntry {
    name: string;
    /** Сколько записей: файлов, документов, символов. */
    count: number;
    /** Учтённый объём в байтах, если он известен. */
    bytes?: number;
    /** Предел, при достижении которого начинается вытеснение. */
    limit?: number;
    /** Чем измеряются записи: для читаемости отчёта. */
    unit?: string;
}

export interface IRslServerStatus {
    entries: IRslStatusEntry[];
    /** Почему вытеснялись внешние сводки. */
    evictions: {
        byCount: number;
        byBytes: number;
        /** Сколько раз вытеснение остановилось: всё остальное закреплено. */
        blockedByPinned: number;
    };
    memory: {
        heapUsedBytes: number;
        heapTotalBytes: number;
        rssBytes: number;
        /** Собран ли мусор перед замером: без --expose-gc нет. */
        collected: boolean;
    };
}

/** Что нужно отчёту от сервера: ровно счётчики, ничего больше. */
export interface IRslStatusSources {
    openModels(): number;
    externalModules(): { count: number; bytes: number; limit: number };
    catalog(): { modules: number; symbols: number; bytes: number };
    referenceIndex(): { files: number; identifiers: number; persisted: number };
    referenceShards(): { files: number; names: number; buckets: number };
    catalogStore(): {
        files: number;
        declarations: number;
        loaded: boolean;
    };
    importContexts(): number;
    diagnosticCache(): { entries: number; bytes: number };
    semanticTokens(): number;
    pinnedModules(): number;
    changeLogSteps(): number;
    evictions(): {
        byCount: number;
        byBytes: number;
        blockedByPinned: number;
    };
}

export function collectRslServerStatus(
    sources: IRslStatusSources
): IRslServerStatus {
    const external = sources.externalModules();
    const catalog = sources.catalog();
    const references = sources.referenceIndex();
    const shards = sources.referenceShards();
    const store = sources.catalogStore();
    const diagnostics = sources.diagnosticCache();

    /*
     * Сборка мусора перед замером: без неё в heap попадает всё, что ещё не
     * убрано, и отчёт показывает шум вместо удержанного.
     */
    const collected = typeof global.gc === "function";

    if (collected) {
        global.gc?.();
        global.gc?.();
    }

    const memory = process.memoryUsage();

    return {
        entries: [
            {
                name: "Открытые модели документов",
                count: sources.openModels(),
                unit: "документов"
            },
            {
                name: "Сводки внешних модулей",
                count: external.count,
                bytes: external.bytes,
                limit: external.limit,
                unit: "модулей"
            },
            {
                name: "Каталог проекта",
                count: catalog.symbols,
                bytes: catalog.bytes,
                unit: "символов"
            },
            {
                name: "Каталог проекта: модули",
                count: catalog.modules,
                unit: "файлов"
            },
            {
                name: "Сохранённый состав проекта",
                count: store.files,
                unit: store.loaded ? "файлов" : "файлов (не читался)"
            },
            {
                /*
                 * Второй экземпляр состава: рабочий каталог держит свой.
                 * В отчёте назывались только файлы, и эта память была не
                 * видна вовсе — на 6165 модулях около 16 МиБ.
                 */
                name: "Сохранённый состав: объявления",
                count: store.declarations,
                unit: "объявлений"
            },
            {
                name: "Индекс идентификаторов",
                count: references.files,
                unit: "файлов"
            },
            {
                name: "Индекс идентификаторов: записей",
                count: references.identifiers,
                unit: "идентификаторов"
            },
            {
                name: "Записи о ссылках",
                count: shards.files,
                unit: "файлов в " + shards.buckets + " корзинах"
            },
            {
                name: "Записи о ссылках: имён",
                count: shards.names,
                unit: "имён"
            },
            {
                name: "Import-контексты",
                count: sources.importContexts(),
                unit: "документов"
            },
            {
                name: "Кэш диагностик",
                count: diagnostics.entries,
                bytes: diagnostics.bytes,
                unit: "записей"
            },
            {
                name: "Кэш семантической подсветки",
                count: sources.semanticTokens(),
                unit: "документов"
            },
            {
                name: "Закреплённые зависимости",
                count: sources.pinnedModules(),
                unit: "модулей"
            },
            {
                name: "Журнал правок",
                count: sources.changeLogSteps(),
                unit: "шагов"
            }
        ],
        evictions: sources.evictions(),
        memory: {
            heapUsedBytes: memory.heapUsed,
            heapTotalBytes: memory.heapTotal,
            rssBytes: memory.rss,
            collected
        }
    };
}

function megabytes(bytes: number): string {
    return (bytes / (1024 * 1024)).toFixed(1) + " МБ";
}

function thousands(value: number): string {
    return value.toLocaleString("ru-RU");
}

/** Отчёт в виде текста: его показывает команда и пишет лог. */
export function formatRslServerStatus(status: IRslServerStatus): string {
    const lines = ["RSL-plus: что сервер держит в памяти", ""];
    const width = Math.max(
        ...status.entries.map(entry => entry.name.length)
    );

    for (const entry of status.entries) {
        const parts = [thousands(entry.count)];

        if (entry.unit) {
            parts.push(entry.unit);
        }

        if (entry.bytes !== undefined) {
            parts.push("~" + megabytes(entry.bytes));
        }

        if (entry.limit !== undefined) {
            parts.push("предел " + thousands(entry.limit));
        }

        lines.push("  " + entry.name.padEnd(width) + "  " + parts.join(", "));
    }

    lines.push(
        "",
        "  Вытеснение сводок: по числу " + status.evictions.byCount +
        ", по объёму " + status.evictions.byBytes +
        ", остановлено закреплением " + status.evictions.blockedByPinned,
        "",
        "  Куча " + megabytes(status.memory.heapUsedBytes) + " из " +
        megabytes(status.memory.heapTotalBytes) +
        ", процесс " + megabytes(status.memory.rssBytes) +
        (status.memory.collected
            ? ""
            : " (без сборки мусора: запустите сервер с --expose-gc для точного замера)")
    );

    return lines.join("\n");
}

/**
 * Снимок условий расчёта диагностик.
 *
 * У результата проверки четыре источника: текст файла, замыкание Import,
 * состав проекта и настройки. Раньше каждая фаза складывала свой ключ из того
 * подмножества, которое считала нужным, — и подмножества расходились: локальная
 * фаза не смотрела на каталог, межфайловая пересчитывалась от правки текста, а
 * причину пересчёта потом приходилось выяснять по логу.
 *
 * Снимок один, а ключ у каждой проверки свой: он складывается ровно из тех
 * составляющих, от которых эта проверка зависит. Так правка Import не отменяет
 * результат проверки, которая импортов не читает.
 */

export interface IRslComputationSnapshot {
    /** Версия текста документа. */
    textVersion: number;
    /**
     * Ключ замыкания Import.
     *
     * Меняется и от правки списка Import, и от дочитывания импортированного
     * модуля: до загрузки ответ проверки был бы «переменная неизвестна».
     */
    importClosure: string;
    /** Ревизия каталога проекта: состав модулей и их публичных имён. */
    catalog: number;
    /** Отпечаток нормализованных настроек диагностики. */
    settings: string;
}

/** Из чего складывается ключ конкретной проверки. */
export interface IRslSnapshotDependencies {
    text?: boolean;
    importClosure?: boolean;
    catalog?: boolean;
    settings?: boolean;
}

/**
 * Ключ переиспользования.
 *
 * Отсутствующая составляющая занимает место прочерком, а не выпадает: иначе
 * ключи проверок с разными зависимостями могли бы совпасть.
 */
export function rslSnapshotKey(
    snapshot: IRslComputationSnapshot,
    depends: IRslSnapshotDependencies
): string {
    return [
        depends.text ? snapshot.textVersion : "-",
        depends.importClosure ? snapshot.importClosure : "-",
        depends.catalog ? snapshot.catalog : "-",
        depends.settings ? snapshot.settings : "-"
    ].join("\u0000");
}

/** Объединение зависимостей: нужно фазе, собранной из нескольких проверок. */
export function mergeRslSnapshotDependencies(
    parts: Iterable<IRslSnapshotDependencies>
): IRslSnapshotDependencies {
    const result: IRslSnapshotDependencies = {};

    for (const part of parts) {
        result.text = result.text || part.text;
        result.importClosure = result.importClosure || part.importClosure;
        result.catalog = result.catalog || part.catalog;
        result.settings = result.settings || part.settings;
    }

    return result;
}

/** Различаются ли снимки в том, что важно этой проверке. */
export function rslSnapshotsDiffer(
    left: IRslComputationSnapshot,
    right: IRslComputationSnapshot,
    depends: IRslSnapshotDependencies
): boolean {
    return rslSnapshotKey(left, depends) !== rslSnapshotKey(right, depends);
}

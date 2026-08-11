import type {
    IRslDeclarationDescriptor
} from "../analysis/declarationExtractor";

/**
 * Протокол компактной индексации внешних файлов.
 *
 * Смысл выноса — снять с основного потока чтение и сканирование файлов,
 * которые пользователь не открывал. Он оправдан только при компактном
 * ответе: замеры (npm run bench --scenario=external) на файле 550КБ дают
 * 48.6 мс сканирования на месте против 7 мс на передачу ответа. С полным
 * AST в ответе выноса не бывает — распаковка копии стоит дороже самой
 * работы, поэтому в ответе НЕ ДОЛЖНО появиться:
 *
 *   - исходного текста;
 *   - синтаксического дерева;
 *   - массива токенов;
 *   - объектов RslSymbol (их строит основной поток из дескрипторов).
 *
 * Состав дескрипторов такой же, как у createExternalModuleSummary: только
 * экспортируемые объявления, без параметров Macro (см.
 * includeCallableParameters в declarationExtractor.ts).
 */
export interface ICompactModuleRequest {
    id: number;
    /** URI модуля; worker сам преобразует его в путь и читает файл. */
    uri: string;
    /**
     * Поколение очереди загрузчика. Worker его не интерпретирует и возвращает
     * как есть: решение "результат уже не нужен" принимает основной поток.
     */
    generation: number;
    /**
     * Известный основному потоку mtime. Если файл не менялся, worker отвечает
     * unchanged и не тратит ни чтения, ни сканирования.
     */
    knownMtimeMs?: number;
    /**
     * Адресная проверка экспорта (Ctrl+Click по неизвестному символу).
     * Worker дополнительно сообщает, экспортирует ли модуль это имя.
     */
    expectedExport?: string;
    /**
     * Приоритет в очереди сервиса.
     *
     * Ctrl+Click и Import активного файла не должны стоять за фоновой
     * индексацией проекта: одна очередь означала бы, что переход по символу
     * ждёт сотни файлов, до которых пользователю сейчас нет дела.
     */
    priority?: "foreground" | "background";
}

interface ICompactModuleResponseBase {
    id: number;
    uri: string;
    generation: number;
}

export interface ICompactModuleIndexed extends ICompactModuleResponseBase {
    status: "indexed";
    mtimeMs: number;
    sourceLength: number;
    declarations: IRslDeclarationDescriptor[];
    imports: string[];
    /** Задан только для запроса с expectedExport. */
    exportsRequestedName?: boolean;
    /** true, если ответ собран из памяти worker'а без повторного чтения. */
    reused: boolean;
}

export interface ICompactModuleUnchanged extends ICompactModuleResponseBase {
    status: "unchanged";
    mtimeMs: number;
}

/**
 * Ответ на запрос с expectedExport: файл не экспортирует нужное имя.
 *
 * Отдельный исход, а не indexed с пустым составом: он позволяет не платить ни
 * сканированием, ни передачей за файлы-кандидаты, которые вообще не содержат
 * искомого идентификатора — а при обходе workspace по Ctrl+Click это
 * большинство файлов.
 */
export interface ICompactModuleNotExported extends ICompactModuleResponseBase {
    status: "not-exported";
    mtimeMs: number;
}

export interface ICompactModuleFailed extends ICompactModuleResponseBase {
    /** missing — файла нет или он недоступен; failed — ошибка разбора. */
    status: "missing" | "failed";
    error?: string;
}

export type ICompactModuleResponse =
    | ICompactModuleIndexed
    | ICompactModuleUnchanged
    | ICompactModuleNotExported
    | ICompactModuleFailed;

/**
 * То, что загрузчику нужно от worker service.
 *
 * Загрузчик зависит от протокола, а не от реализации: это позволяет
 * подставить в тестах управляемый индексатор (например, задержать ответ и
 * проверить, что локальная навигация в это время работает) и оставляет
 * возможность работать вообще без worker'а.
 */
export interface ICompactModuleIndexer {
    index(
        request: Omit<ICompactModuleRequest, "id">
    ): Promise<ICompactModuleResponse>;
}

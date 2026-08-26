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
/**
 * Приоритет запроса в очереди worker service.
 *
 * Уровней три, а не два, потому что «не фон» — это ещё не «пользователь ждёт
 * прямо сейчас». Явно вызванный Auto Import ставит в очередь сразу пачку
 * адресных проверок экспорта (десятки файлов-кандидатов), и в одной очереди с
 * ним переход по Ctrl+Click или Import только что открытого файла оказывался
 * за всей пачкой. Поэтому:
 *
 *   foreground — адресная навигация и Import активного документа: ответ ждёт
 *                конкретное действие пользователя;
 *   search     — обход кандидатов для явно вызванного Auto Import: работа
 *                нужная, но лампочка терпит и обгонять навигацию не должна;
 *   background — индексация проекта: уступает всему остальному.
 */
export type CompactModulePriority = "foreground" | "search" | "background";

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
     * Известный основному потоку fingerprint содержимого (см. поле ответа).
     * Если он совпал с фактическим, worker отвечает unchanged и не тратит
     * сканирование.
     */
    knownFingerprint?: string;
    /**
     * Адресная проверка экспорта (Ctrl+Click по неизвестному символу).
     * Worker дополнительно сообщает, экспортирует ли модуль это имя.
     */
    expectedExport?: string;
    /**
     * Приоритет в очереди сервиса; по умолчанию foreground.
     *
     * Ctrl+Click и Import активного файла не должны стоять ни за фоновой
     * индексацией проекта, ни за обходом кандидатов Auto Import: одна очередь
     * означала бы, что переход по символу ждёт десятки и сотни файлов, до
     * которых пользователю сейчас нет дела.
     */
    priority?: CompactModulePriority;
    /**
     * Служебный запрос: записать отложенный кэш и подтвердить.
     *
     * Файлом кэша владеет worker, поэтому сбросить его перед остановкой может
     * только он сам. Отдельного канала для этого нет намеренно: запрос идёт по
     * той же очереди, а значит гарантированно после уже принятых запросов, чьи
     * результаты и надо сохранить.
     */
    flushCache?: boolean;
}

interface ICompactModuleResponseBase {
    id: number;
    uri: string;
    generation: number;
}

/**
 * Отпечаток содержимого файла: размер в байтах и hash.
 *
 * Только по mtime «файл не менялся» решать нельзя. Дата изменения — не
 * свойство содержимого: её сохраняют системы контроля версий и утилиты
 * копирования, а разрешение mtime на части файловых систем грубее интервала
 * между правками. Ответ unchanged в таком случае оставлял бы в индексе прежние
 * объявления — то есть переходы и Problems по уже несуществующему коду.
 *
 * Обратная сторона: отпечаток требует чтения файла, тогда как сравнение mtime
 * обходилось одним stat. Это осознанный обмен: чтение с hash на файле 550КБ
 * стоит 1 мс против 33 мс сканирования (1100КБ — 1.6 мс против 57.5 мс), а
 * пропускается именно сканирование и передача ответа.
 *
 * Заодно правка «сохранили без изменений» теперь тоже распознаётся: mtime у
 * неё новый, а содержимое прежнее, и модуль больше не публикуется заново — то
 * есть не запускает пересчёт межфайловых Problems у всех зависимых файлов.
 */
export interface ICompactModuleFingerprint {
    /** Формат: "<размер в байтах>:<sha1 содержимого>". */
    fingerprint: string;
}

export interface ICompactModuleIndexed
    extends ICompactModuleResponseBase, ICompactModuleFingerprint {
    status: "indexed";
    mtimeMs: number;
    sourceLength: number;
    declarations: IRslDeclarationDescriptor[];
    imports: string[];
    /**
     * Имена файлов из строк ExecMacroFile.
     *
     * Их знает только тот, кто читал текст, а нужны они каталогу: без них
     * переименование файла не находит ссылки в файлах, которые ни разу не
     * открывались. Список короткий — обычно пустой, — и запрет на
     * тяжёлые поля в ответе не нарушает.
     */
    fileReferences: readonly string[];
    /** Задан только для запроса с expectedExport. */
    exportsRequestedName?: boolean;
    /** true, если сканирование взято из памяти worker'а по отпечатку. */
    reused: boolean;
}

export interface ICompactModuleUnchanged
    extends ICompactModuleResponseBase, ICompactModuleFingerprint {
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

/** Ответ на служебный flushCache. */
export interface ICompactModuleFlushed extends ICompactModuleResponseBase {
    status: "flushed";
}

export type ICompactModuleResponse =
    | ICompactModuleFlushed
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

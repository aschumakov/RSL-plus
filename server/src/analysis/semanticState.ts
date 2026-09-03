import { LruCache } from "../core/lruCache";

/**
 * Одна модель актуальности семантических ответов.
 *
 * У любого семантического ответа — типа, разрешённого имени, подсказки,
 * Problems, подсветки — есть НАБОР состояний, от которых он зависит. Раньше
 * каждый потребитель складывал свой ключ из того подмножества, которое считал
 * нужным, и подмножества расходились:
 *
 *   подсказка сверялась с замыканием и ревизией каталога;
 *   подсветка — с ключом Import-контекста;
 *   локальная фаза Problems — с одним набором полей, межфайловая с другим;
 *   resolver и вывод типов — с парой чисел;
 *   а прочие просто ждали, когда их позовут invalidate().
 *
 * Расхождение не косметическое. Потребитель, забывший состояние, отдаёт
 * устаревший ответ; потребитель, взявший лишнее, пересчитывает то, что не
 * менялось. И то и другое здесь случалось.
 *
 * Здесь состояния названы один раз, а каждый потребитель объявляет, от чего
 * зависит ИМЕННО ЕГО ответ. Общей ревизии нет: ревизия всего индекса растёт от
 * любого модуля проекта, и сверка с ней означала бы сброс горячих кэшей
 * открытого документа от фонового чтения постороннего файла.
 */

/**
 * От чего зависит ответ.
 *
 * Поля не взаимозаменяемы, и различие между ними — это различие в цене:
 *
 *   semantic — одно число, обобщающее imports, closure и workspace. Меняется от
 *     любого изменения окружения документа. Годится там, где ответ зависит от
 *     окружения ЦЕЛИКОМ, и стоит одно сравнение. Такова горячая часть: resolver
 *     и вывод типов спрашивают её десятки тысяч раз на файл.
 *
 *   imports, closure, workspace — строки, различающие, ЧТО именно изменилось.
 *     Нужны там, где ответ зависит от части окружения: проверка, не читающая
 *     Import, не обязана пересчитываться от их правки.
 *
 * Брать и то и другое незачем: semantic меняется всякий раз, когда меняется
 * любая из трёх строк.
 */
export interface IRslSemanticDependencies {
    /** Текст самого документа. */
    text?: boolean;
    /** Написанные в файле Import — включая те, что пока никуда не ведут. */
    imports?: boolean;
    /** Внешние интерфейсы модулей замыкания. */
    closure?: boolean;
    /** Состав проекта и публичные имена его модулей. */
    catalog?: boolean;
    /** Состав файлов проекта: от него зависит, разрешится ли имя вообще. */
    workspace?: boolean;
    /** Каталог прикладных модулей платформы. */
    platform?: boolean;
    /** Обобщение imports + closure + workspace одним числом. */
    semantic?: boolean;
    /** Настройки: их вид знает сам потребитель и передаёт при слепке. */
    settings?: boolean;
}

/** Откуда берутся значения состояний. */
export interface IRslSemanticStateSource {
    /** Версия текста документа; -1, если модели нет. */
    textVersion(uri: string): number;
    /** Ключ написанных Import. */
    importsKey(uri: string): string;
    /** Ключ интерфейсов модулей замыкания. */
    closureKey(uri: string): string;
    /** Ревизия каталога проекта. */
    catalogRevision(): number;
    /** Ревизия состава файлов проекта. */
    workspaceRevision(): number;
    /** Ревизия каталога прикладных модулей платформы. */
    platformRevision(): number;
    /** Ревизия окружения документа: обобщение трёх предыдущих. */
    semanticRevision(uri: string): number;
}

/**
 * Слепок: документ, набор зависимостей и значения на момент снятия.
 *
 * Хранится строкой, потому что единственная операция над ним — сравнение.
 * Отсутствующая составляющая занимает место прочерком, а не выпадает: иначе
 * слепки с разными наборами зависимостей могли бы совпасть.
 */
export interface IRslSemanticStamp {
    readonly uri: string;
    readonly depends: IRslSemanticDependencies;
    readonly key: string;
}

/** Настройки и прочее, чего источник не знает. */
export interface IRslSemanticExtras {
    settings?: string;
}

/** Горячий набор `{semantic, platform}` в числовом виде: см. hotStamp. */
export interface IRslHotStamp {
    semantic: number;
    platform: number;
}

/** Совпадают ли горячие наборы. */
export function sameRslHotStamp(
    left: IRslHotStamp | undefined,
    right: IRslHotStamp
): boolean {
    return left !== undefined &&
        left.semantic === right.semantic &&
        left.platform === right.platform;
}

const MISSING = "-";
/*
 * Разделитель, который не может встретиться в значении: URI, ключи имён и
 * отпечатки настроек — обычный текст.
 */
const SEPARATOR = "\u0000";

/**
 * Сколько документов держат запомненные ответы.
 *
 * Открытых документов одновременно единицы; запас нужен на переключение между
 * файлами в течение сессии. Без границы карта росла бы на каждый открытый за
 * сессию файл и не уменьшалась никогда.
 */
const DOCUMENT_SLOTS = 32;

export class RslSemanticState {
    private readonly slots = new LruCache<
        string,
        Map<string, { key: string; value: unknown }>
    >(DOCUMENT_SLOTS);
    private hitCount = 0;
    private missCount = 0;
    private resetCount = 0;

    constructor(private readonly source: IRslSemanticStateSource) {}

    /**
     * Ключ по составляющим: по нему видно, ЧТО именно изменилось.
     *
     * Нужен диагностикам: «пересчитали заново» — бесполезная запись в
     * логе, а «пересчитали, потому что изменился каталог» показывает,
     * куда смотреть. Составляющие те же, что в ключе, поэтому лишней
     * работы здесь нет.
     */
    captureParts(
        uri: string,
        depends: IRslSemanticDependencies,
        extras: IRslSemanticExtras = {}
    ): Record<string, string> {
        const parts: Record<string, string> = {};

        if (depends.text) {
            parts.text = String(this.source.textVersion(uri));
        }

        if (depends.imports) {
            parts.imports = this.source.importsKey(uri);
        }

        if (depends.closure) {
            parts.closure = this.source.closureKey(uri);
        }

        if (depends.catalog) {
            parts.catalog = String(this.source.catalogRevision());
        }

        if (depends.workspace) {
            parts.workspace = String(this.source.workspaceRevision());
        }

        if (depends.platform) {
            parts.platform = String(this.source.platformRevision());
        }

        if (depends.semantic) {
            parts.semantic = String(this.source.semanticRevision(uri));
        }

        if (depends.settings) {
            parts.settings = extras.settings ?? "";
        }

        return parts;
    }

    /** Слепок ровно тех состояний, от которых зависит ответ. */
    capture(
        uri: string,
        depends: IRslSemanticDependencies,
        extras: IRslSemanticExtras = {}
    ): IRslSemanticStamp {
        return { uri, depends, key: this.key(uri, depends, extras) };
    }

    /**
     * Изменилось ли что-нибудь из этого с момента слепка.
     *
     * Ради этого слепок и нужен. Фоновая работа и всякий await разрывают
     * запрос: пока считалось, документ могли поправить, зависимость —
     * дочитать, настройку — сменить. Публиковать посчитанное по прежним
     * условиям нельзя, и решать это на глаз по одной версии текста мало.
     */
    isStale(
        stamp: IRslSemanticStamp,
        extras: IRslSemanticExtras = {}
    ): boolean {
        return this.key(stamp.uri, stamp.depends, extras) !== stamp.key;
    }

    /**
     * Запомненный ответ, пока его условия не изменились.
     *
     * Это замена локальным схемам ключей. Потребитель объявляет, от чего
     * зависит ответ, и получает и запоминание, и правильный сброс — вместо
     * собственной карты, собственного ключа и собственного invalidate().
     */
    remember<T>(
        uri: string,
        slot: string,
        depends: IRslSemanticDependencies,
        compute: () => T,
        extras: IRslSemanticExtras = {}
    ): T {
        const key = this.key(uri, depends, extras);
        let byslot = this.slots.get(uri);

        if (!byslot) {
            byslot = new Map();
            this.slots.set(uri, byslot);
        }

        const known = byslot.get(slot);

        if (known && known.key === key) {
            this.hitCount++;

            return known.value as T;
        }

        if (known) {
            this.resetCount++;
        }

        this.missCount++;

        const value = compute();

        byslot.set(slot, { key, value });

        return value;
    }

    /**
     * Горячая пара состояний без построения строки.
     *
     * Набор `{semantic, platform}` спрашивают на каждый идентификатор файла: на
     * файле 379 КБ это 37 627 раз за одно построение подсветки. Собирать там
     * строку нельзя — первая версия кэша разрешения имён именно это и делала и
     * вышла дороже того, что экономила.
     *
     * Поэтому у горячего набора своё представление: два числа, которые
     * потребитель сравнивает сам. Определение того, ОТ ЧЕГО он зависит,
     * остаётся здесь, в одном месте с остальными.
     */
    hotStamp(uri: string): IRslHotStamp {
        return {
            semantic: this.source.semanticRevision(uri),
            platform: this.source.platformRevision()
        };
    }

    /** Забыть запомненное для документа: он закрыт или удалён. */
    forget(uri: string): void {
        this.slots.delete(uri);
    }

    /** Счётчики попаданий и сбросов: по ним видно, работает ли отсечение. */
    get counters(): { hits: number; misses: number; resets: number } {
        return {
            hits: this.hitCount,
            misses: this.missCount,
            resets: this.resetCount
        };
    }

    /**
     * Ключ: только запрошенные составляющие.
     *
     * Незапрошенные не вычисляются вовсе — часть из них строит строки по
     * замыканию Import, и считать их для потребителя, которому довольно
     * одного числа, значило бы платить за то, чего он не спрашивал.
     */
    private key(
        uri: string,
        depends: IRslSemanticDependencies,
        extras: IRslSemanticExtras
    ): string {
        return [
            depends.text ? this.source.textVersion(uri) : MISSING,
            depends.imports ? this.source.importsKey(uri) : MISSING,
            depends.closure ? this.source.closureKey(uri) : MISSING,
            depends.catalog ? this.source.catalogRevision() : MISSING,
            depends.workspace ? this.source.workspaceRevision() : MISSING,
            depends.platform ? this.source.platformRevision() : MISSING,
            depends.semantic ? this.source.semanticRevision(uri) : MISSING,
            depends.settings ? extras.settings ?? "" : MISSING
        ].join(SEPARATOR);
    }
}

/** Объединение зависимостей: нужно тому, кто собран из нескольких частей. */
export function mergeRslSemanticDependencies(
    parts: Iterable<IRslSemanticDependencies>
): IRslSemanticDependencies {
    const result: IRslSemanticDependencies = {};

    for (const part of parts) {
        result.text = result.text || part.text;
        result.imports = result.imports || part.imports;
        result.closure = result.closure || part.closure;
        result.catalog = result.catalog || part.catalog;
        result.workspace = result.workspace || part.workspace;
        result.platform = result.platform || part.platform;
        result.semantic = result.semantic || part.semantic;
        result.settings = result.settings || part.settings;
    }

    return result;
}

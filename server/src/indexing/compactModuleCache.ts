import * as fs from "fs";
import * as path from "path";

import type {
    IRslDeclarationSnapshot
} from "../analysis/declarationExtractor";

/*
 * Постоянный кэш компактных сводок внешних модулей.
 *
 * Сводка внешнего модуля — это объявления и Import, то есть результат
 * однопроходного сканирования файла. Сканирование стоит 33 мс на файле 550КБ
 * (npm run bench --scenario=external), и при старте сессии оно повторяется для
 * всего проекта заново, хотя файлы с прошлого запуска в большинстве своём не
 * менялись. Кэш снимает именно это повторное сканирование.
 *
 * Чтение файла кэш НЕ снимает и не пытается: запись годна только тогда, когда
 * отпечаток содержимого совпал с фактическим, а отпечаток без чтения не
 * получить. Обмен тот же, что у ответа unchanged: чтение с hash дешевле
 * сканирования более чем на порядок, а неверно признанная актуальной запись
 * означала бы переходы и Problems по коду, которого в файле нет.
 *
 * Полные AST и исходный текст здесь не хранятся сознательно. Их распаковка
 * стоит дороже самой работы (см. ICompactModuleRequest), а объём такого кэша
 * измерялся бы сотнями мегабайт на проект.
 *
 * Записи удалённых и исключённых из проекта файлов не вычищаются намеренно.
 * Активная инвалидация здесь ничего не защищает: запись отдаётся только при
 * совпавшем отпечатке, а файла, которого нет в каталоге проекта, загрузчик не
 * запрашивает. Единственная цена — место на диске, и её ограничивает
 * MAX_ENTRIES.
 */

/**
 * Версия формата.
 *
 * Увеличивается при любом изменении состава дескрипторов
 * (IRslDeclarationDescriptor) или структуры файла: старая запись, разобранная
 * новым кодом, дала бы неполную модель молча. Несовпадение версии — причина
 * выбросить весь файл, а не пытаться его переносить.
 *
 * Поднимать версию нужно и тогда, когда изменился не формат, а СПОСОБ
 * получения содержимого. Версия 2 — распознавание CP866: до неё файлы в этой
 * кодировке читались как UTF-8, и в кэш попали сводки без русских имён.
 * Отпечаток считается по байтам файла, поэтому он совпадал, запись отдавалась
 * как актуальная, и исправление кодировки не дошло бы до тех, у кого кэш уже
 * есть.
 */
/*
 * Версия 3: в сводке появились строковые ссылки на файлы. Записи прежней
 * версии не годятся — без них переименование файла молча не нашло бы
 * ссылки в файлах, попавших в кэш до этой версии.
 */
const CACHE_VERSION = 3;
const SAVE_DEBOUNCE_MS = 3000;

/**
 * Предел числа записей.
 *
 * Кэш существует ради старта сессии, а не ради полноты: держать сводки файлов,
 * к которым обращений не было, значит платить за них временем загрузки и
 * записи. При переполнении выбрасываются записи, не использованные в текущей
 * сессии.
 */
const MAX_ENTRIES = 4000;

/**
 * Предел объёма кэша на диске.
 *
 * Одного предела по числу записей не хватает: объём сводки задаётся не
 * размером файла, а числом экспортируемых объявлений в нём. На замере (40
 * файлов по 120КБ, сплошь экспортируемые Macro) вышло 18 МБ — то есть по
 * одному лишь MAX_ENTRIES кэш дорос бы до гигабайтов. Загрузка такого файла
 * стоила бы больше, чем сэкономленное сканирование, ради которого кэш и
 * существует.
 */
const MAX_BYTES = 32 * 1024 * 1024;

export interface ICompactModuleCacheEntry {
    fingerprint: string;
    mtimeMs: number;
    sourceLength: number;
    snapshot: IRslDeclarationSnapshot;
}

interface ISerializedEntry {
    uri: string;
    fingerprint: string;
    mtimeMs: number;
    sourceLength: number;
    declarations: IRslDeclarationSnapshot["declarations"];
    imports: string[];
    /**
     * Строковые ссылки на файлы модулей.
     *
     * Хранятся вместе со сводкой: иначе запись, поднятая из кэша, отдавала бы
     * сводку без ссылок — и переименование файла молча не находило бы ссылки в
     * файлах, попавших в кэш в прошлой сессии.
     */
    fileReferences: string[];
}

interface ISerializedCache {
    version: number;
    entries: ISerializedEntry[];
}

export interface ICompactModuleCacheOptions {
    log?(message: string): void;
}

export interface ICompactModuleCacheStats {
    entries: number;
    hits: number;
    misses: number;
    loaded: boolean;
}

export class CompactModuleCache {
    private entries = new Map<string, ICompactModuleCacheEntry>();
    /* Записи, пригодившиеся в этой сессии: они выживают при переполнении. */
    private used = new Set<string>();
    private cacheFilePath: string | undefined;
    private saveTimer: NodeJS.Timeout | undefined;
    private loadPromise: Promise<void> | undefined;
    private dirty = false;
    /* Номер правки: по нему видно, менялись ли записи во время записи на диск. */
    private revision = 0;
    /* Одна запись одновременно: у отложенной и явной один временный файл. */
    private saving: Promise<void> | undefined;
    private hits = 0;
    private misses = 0;

    constructor(private options: ICompactModuleCacheOptions = {}) {}

    configure(
        cacheFilePath: string | undefined,
        log?: (message: string) => void
    ): void {
        if (log) {
            this.options = { ...this.options, log };
        }

        const normalized = (cacheFilePath || "").trim();

        if ((normalized || undefined) === this.cacheFilePath) {
            return;
        }

        this.cancelSave();
        this.cacheFilePath = normalized || undefined;
        this.entries.clear();
        this.used.clear();
        this.loadPromise = undefined;
        this.dirty = false;
    }

    get configured(): boolean {
        return this.cacheFilePath !== undefined;
    }

    get stats(): ICompactModuleCacheStats {
        return {
            entries: this.entries.size,
            hits: this.hits,
            misses: this.misses,
            loaded: this.loadPromise !== undefined
        };
    }

    /**
     * Сводка для файла, если запись есть и отпечаток совпал.
     *
     * Отпечаток сравнивается всегда: запись, оставшаяся от прошлой версии
     * файла, обязана считаться промахом, а не устаревшим попаданием.
     */
    async get(
        uri: string,
        fingerprint: string
    ): Promise<ICompactModuleCacheEntry | undefined> {
        if (!this.cacheFilePath) {
            return undefined;
        }

        await this.ensureLoaded();
        const entry = this.entries.get(uri);

        if (!entry || entry.fingerprint !== fingerprint) {
            this.misses++;
            return undefined;
        }

        this.hits++;
        this.used.add(uri);
        return entry;
    }

    set(uri: string, entry: ICompactModuleCacheEntry): void {
        if (!this.cacheFilePath || !uri) {
            return;
        }

        const previous = this.entries.get(uri);

        if (previous && previous.fingerprint === entry.fingerprint) {
            this.used.add(uri);
            return;
        }

        this.entries.set(uri, entry);
        this.used.add(uri);
        this.dirty = true;
        this.revision++;
        this.scheduleSave();
    }

    /** Немедленно сохраняет отложенную запись, не дожидаясь паузы. */
    async flush(): Promise<void> {
        this.cancelSave();

        /*
         * Дождаться незавершённой записи нужно и без своей работы: таймер мог
         * сработать за миг до flush, и выйти, пока запись идёт, значит оставить
         * файл в неизвестном состоянии.
         */
        if (!this.dirty) {
            await this.saving?.catch(() => undefined);

            return;
        }

        await this.saveSerialized().catch(error => this.options.log?.(
            `Compact module cache save failed: ${errorToString(error)}`
        ));
    }

    /**
     * Записи не пересекаются.
     *
     * Отложенная запись и явный flush писали один и тот же временный файл. При
     * наложении одна переименовывала его первой, вторая не находила и — на
     * Windows-пути через unlink — успевала удалить сам кэш, не заменив его.
     */
    private saveSerialized(): Promise<void> {
        const next = (this.saving ?? Promise.resolve())
            .catch(() => undefined)
            .then(() => this.saveToDisk());

        this.saving = next.catch(() => undefined);

        return next;
    }

    private ensureLoaded(): Promise<void> {
        if (!this.loadPromise) {
            const cacheFilePath = this.cacheFilePath;
            this.loadPromise = cacheFilePath
                ? this.loadFromDisk(cacheFilePath)
                : Promise.resolve();
        }

        return this.loadPromise;
    }

    private async loadFromDisk(cacheFilePath: string): Promise<void> {
        let raw: string;

        try {
            raw = await fs.promises.readFile(cacheFilePath, "utf8");
        } catch (_error) {
            /* Первый запуск или удалённый кэш — штатный случай. */
            return;
        }

        try {
            const parsed = JSON.parse(raw) as ISerializedCache;

            if (
                parsed.version !== CACHE_VERSION ||
                !Array.isArray(parsed.entries)
            ) {
                return;
            }

            for (const item of parsed.entries) {
                if (
                    !item ||
                    typeof item.uri !== "string" ||
                    typeof item.fingerprint !== "string" ||
                    !Array.isArray(item.declarations) ||
                    !Array.isArray(item.imports)
                ) {
                    continue;
                }

                this.entries.set(item.uri, {
                    fingerprint: item.fingerprint,
                    mtimeMs: Number(item.mtimeMs) || 0,
                    sourceLength: Math.max(0, Number(item.sourceLength) || 0),
                    snapshot: {
                        declarations: item.declarations,
                        imports: item.imports,
                        fileReferences: Array.isArray(item.fileReferences)
                            ? item.fileReferences
                            : []
                    }
                });
            }
        } catch (error) {
            /*
             * Повреждённый кэш не должен ломать сессию: он лишь ускоряет
             * старт, и работа без него — обычный первый запуск.
             */
            this.entries.clear();
            this.options.log?.(
                `Compact module cache ignored: ${errorToString(error)}`
            );
        }
    }

    private cancelSave(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
    }

    /*
     * Хвостовая пауза: таймер перезапускается на каждой записи, поэтому
     * индексация проекта целиком приводит к одному сохранению после того, как
     * она утихла, а не к перезаписи файла каждые несколько секунд.
     *
     * Сохранение, не успевшее пройти до остановки сервера, теряется. Цена —
     * повторное сканирование последних файлов в следующей сессии, поэтому
     * гарантированной записи при выходе здесь нет.
     */
    private scheduleSave(): void {
        if (!this.cacheFilePath) {
            return;
        }

        this.cancelSave();
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            this.saveSerialized().catch(error => this.options.log?.(
                `Compact module cache save failed: ${errorToString(error)}`
            ));
        }, SAVE_DEBOUNCE_MS);
        this.saveTimer.unref?.();
    }

    private async saveToDisk(): Promise<void> {
        const cacheFilePath = this.cacheFilePath;

        if (!cacheFilePath) {
            return;
        }

        /*
         * Снимок номера правки, а не снятие dirty.
         *
         * Прежде dirty снимался здесь, до записи. Отказ writeFile или rename
         * логировался, но повторный flush уже считал, что писать нечего, — и
         * кэш оставался на диске устаревшим до конца сеанса.
         */
        const revisionAtStart = this.revision;
        const entries: ISerializedEntry[] = [];

        for (const [uri, entry] of this.entries) {
            entries.push({
                uri,
                fingerprint: entry.fingerprint,
                mtimeMs: entry.mtimeMs,
                sourceLength: entry.sourceLength,
                declarations: entry.snapshot.declarations,
                imports: entry.snapshot.imports,
                fileReferences: [...(entry.snapshot.fileReferences || [])]
            });
        }

        /*
         * Порядок вытеснения: сначала записи, не пригодившиеся в этой сессии
         * (файл, к которому обращались, скорее понадобится и в следующей),
         * внутри группы — крупные раньше мелких, потому что за каждый
         * сэкономленный байт крупная запись даёт меньше попаданий. Дальше
         * сортировка по URI, чтобы отбор был детерминированным.
         */
        entries.sort((left, right) => {
            const leftUsed = this.used.has(left.uri) ? 0 : 1;
            const rightUsed = this.used.has(right.uri) ? 0 : 1;
            return leftUsed - rightUsed ||
                sizeOf(right) - sizeOf(left) ||
                left.uri.localeCompare(right.uri);
        });

        const kept: ISerializedEntry[] = [];
        let bytes = 0;
        let dropped = 0;

        for (const entry of entries) {
            const size = sizeOf(entry);

            if (kept.length >= MAX_ENTRIES || bytes + size > MAX_BYTES) {
                dropped++;
                continue;
            }

            kept.push(entry);
            bytes += size;
        }

        if (dropped > 0) {
            this.options.log?.(
                `Compact module cache: сохранено ${kept.length} записей ` +
                `(${Math.round(bytes / 1024)}КБ), не поместилось ${dropped}`
            );
        }

        kept.sort((left, right) => left.uri.localeCompare(right.uri));

        const payload: ISerializedCache = {
            version: CACHE_VERSION,
            entries: kept
        };
        await fs.promises.mkdir(path.dirname(cacheFilePath), {
            recursive: true
        });
        const temporary = `${cacheFilePath}.tmp`;
        await fs.promises.writeFile(
            temporary,
            JSON.stringify(payload),
            "utf8"
        );

        try {
            await fs.promises.rename(temporary, cacheFilePath);
        } catch (_error) {
            /* Windows не заменяет существующий файл через rename. */
            await fs.promises.unlink(cacheFilePath).catch(() => undefined);
            await fs.promises.rename(temporary, cacheFilePath);
        }

        /*
         * Записано ровно то, что было на начало записи. Правка, пришедшая
         * во время неё, в этот снимок не попала — и dirty остаётся.
         */
        if (this.revision === revisionAtStart) {
            this.dirty = false;
        }
    }
}

/*
 * Оценка веса записи в сохранённом файле.
 *
 * Считается один раз на запись и запоминается: JSON.stringify по дескрипторам
 * крупного модуля стоит заметно, а при отборе к каждой записи обращаются
 * несколько раз — и при сортировке, и при наборе бюджета.
 */
const sizeCache = new WeakMap<ISerializedEntry, number>();

function sizeOf(entry: ISerializedEntry): number {
    const known = sizeCache.get(entry);

    if (known !== undefined) {
        return known;
    }

    const size = Buffer.byteLength(JSON.stringify(entry), "utf8");
    sizeCache.set(entry, size);
    return size;
}

function errorToString(error: unknown): string {
    return error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
}

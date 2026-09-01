import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { normalizeIdentifier } from "../lexer";
import {
    buildReferenceCandidateUris,
    type IReferenceImportModule
} from "./referenceImportGraph";
import { contentFingerprint } from "./contentFingerprint";
import {
    RslRequestSourceCache,
    type IRslReadSource
} from "./requestSourceCache";
import {
    containsReferenceIdentifier,
    containsSortedIdentifierHash,
    hashReferenceIdentifier,
    normalizeReferenceImports,
    referenceSourceFactsTesting,
    scanReferenceSource
} from "./referenceSourceFacts";
import { decodeRslSourceText } from "../core/textDecoding";

export type { IReferenceImportModule } from "./referenceImportGraph";

/*
 * 3: запись хранит отпечаток содержимого вместо даты и размера.
 *
 * Версия поднята, чтобы кэш прежнего формата не читался: у его записей нет
 * отпечатка, а значит нет и основания считать их актуальными.
 */
const CACHE_VERSION = 3;
const DEFAULT_READ_BATCH_SIZE = 16;
const SAVE_DEBOUNCE_MS = 3000;

/**
 * Совместимость вызывающего кода: stat здесь больше не решает актуальность.
 *
 * Запись сверяется по отпечатку содержимого (см. contentFingerprint), потому
 * что дата и размер этого не гарантируют.
 */
export interface IReferenceFileStat {
    mtimeMs?: number;
    size?: number;
}

export interface IReferenceCandidateSource {
    uri: string;
    source: string;
}

export interface IReferenceIndexStats {
    indexedFiles: number;
    indexedIdentifiers: number;
    persistedFiles: number;
}

export interface IReferenceIndexOptions {
    log?(message: string): void;
    readBatchSize?: number;
}

interface IReferenceFileEntry {
    /** Отпечаток содержимого, по которому запись считается актуальной. */
    fingerprint: string;
    hashes: Uint32Array;
    imports: string[];
    /**
     * Отпечаток сверен с диском в этой сессии.
     *
     * На диск не пишется: после перезапуска доверять прежней проверке нельзя.
     * Пока запись не сверена, её нельзя использовать для вывода «в файле нет
     * такого идентификатора» — именно этот вывод и терял ссылки.
     */
    validated?: boolean;
}

interface ISerializedEntry {
    uri: string;
    fingerprint: string;
    hashes: string;
    imports: string[];
}

interface ISerializedIndex {
    version: number;
    files: ISerializedEntry[];
}

/**
 * Компактный точный индекс 32-bit hash идентификаторов по файлам.
 *
 * В отличие от фиксированного Bloom-фильтра, его точность не ухудшается на
 * больших макросах. Коллизия hash безопасна: перед parser всё равно выполняется
 * точная проверка имени в исходнике.
 */
export class ReferenceIndex {
    private entries = new Map<string, IReferenceFileEntry>();
    private workspaceUris = new Set<string>();
    private cacheFilePath: string | undefined;
    private saveTimer: NodeJS.Timeout | undefined;
    /* Одна запись одновременно: у отложенной и явной один временный файл. */
    private saving: Promise<void> | undefined;
    private loadPromise: Promise<void> = Promise.resolve();
    private loadStarted = false;
    private persistedFiles = 0;
    private readBatchSize: number;
    private importGraphValidated = false;
    /** Сколько записей пришло готовыми от компактного чтения. */
    private acceptedFacts = 0;

    constructor(private options: IReferenceIndexOptions = {}) {
        this.readBatchSize = Math.max(
            1,
            options.readBatchSize ?? DEFAULT_READ_BATCH_SIZE
        );
    }

    configurePersistence(cacheFilePath: string | undefined): void {
        const normalized = (cacheFilePath || "").trim();
        this.cacheFilePath = normalized || undefined;
        this.loadStarted = false;
        this.loadPromise = Promise.resolve();
    }

    retainWorkspaceFiles(uris: readonly string[]): void {
        const retained = new Set(uris.filter(uri => !!uri));
        const catalogChanged = retained.size !== this.workspaceUris.size ||
            Array.from(retained).some(uri => !this.workspaceUris.has(uri));
        let changed = false;

        for (const uri of this.entries.keys()) {
            if (!retained.has(uri)) {
                this.entries.delete(uri);
                changed = true;
            }
        }

        this.workspaceUris = retained;
        if (catalogChanged) {
            this.importGraphValidated = false;
        }
        if (changed) {
            this.scheduleSave();
        }
    }

    invalidate(uri: string): void {
        this.importGraphValidated = false;
        if (this.entries.delete(uri)) {
            this.scheduleSave();
        }
    }

    /**
     * Принять факты, посчитанные тем, кто уже прочитал файл.
     *
     * Компактное чтение файла держит текст в руках и считает и
     * отпечаток, и хэши идентификаторов. Без этого индекс читал тот же
     * файл во второй раз — на основном потоке и в тот момент, когда
     * пользователь ждёт ответа на поиск ссылок.
     *
     * Запись помечается сверенной: отпечаток посчитан по фактическому
     * содержимому, а не восстановлен из хранилища.
     */
    acceptScannedFacts(
        uri: string,
        fingerprint: string,
        hashes: Uint32Array,
        imports: readonly string[]
    ): void {
        if (!uri || !fingerprint) {
            return;
        }

        const existing = this.entries.get(uri);

        if (existing?.validated && existing.fingerprint === fingerprint) {
            return;
        }

        this.entries.set(uri, {
            fingerprint,
            hashes,
            imports: normalizeReferenceImports(imports),
            validated: true
        });
        this.importGraphValidated = false;
        this.acceptedFacts++;
        this.scheduleSave();
    }

    /** Сколько раз факты пришли готовыми; для проверок и лога. */
    get acceptedScannedFacts(): number {
        return this.acceptedFacts;
    }

    indexSource(
        uri: string,
        source: string,
        /* Оставлен для совместимости вызывающего кода; актуальность решает
         * отпечаток содержимого, а не дата с размером. */
        _stat?: IReferenceFileStat,
        imports?: readonly string[]
    ): void {
        if (!uri) {
            return;
        }

        const fingerprint = contentFingerprint(source);
        const existing = this.entries.get(uri);

        /*
         * Сравнивается отпечаток содержимого, а не дата с размером: правка,
         * не меняющая длину файла (Alpha на Bravo), при сохранённой дате
         * оставляла в индексе прежний набор идентификаторов, и поиск нового
         * имени не находил ничего.
         */
        if (existing && existing.fingerprint === fingerprint) {
            return;
        }

        const facts = scanReferenceSource(source, imports);
        this.entries.set(uri, {
            fingerprint,
            hashes: facts.hashes,
            imports: facts.imports,
            /* Отпечаток посчитан по фактическому содержимому. */
            validated: true
        });
        this.importGraphValidated = false;
        this.scheduleSave();
    }

    /**
     * Возвращает безопасно суженный набор файлов по полному Import-графу.
     * Если persisted-граф неполон или хотя бы один файл изменился, используется
     * полный workspace: точность References важнее эвристического ускорения.
     */
    async getCandidateUris(
        declarationUri: string,
        workspaceUris: readonly string[],
        loadedModules: readonly IReferenceImportModule[] = [],
        isCancelled: () => boolean = () => false
    ): Promise<string[]> {
        await this.ensureLoaded();
        const allUris = Array.from(new Set(workspaceUris.filter(uri => !!uri)));

        if (
            !declarationUri ||
            isCancelled() ||
            !await this.ensureImportGraphValid(
                allUris,
                loadedModules,
                isCancelled
            )
        ) {
            return allUris;
        }

        return buildReferenceCandidateUris(
            declarationUri,
            Array.from(this.entries, ([uri, entry]) => ({
                uri,
                imports: entry.imports
            })),
            allUris,
            loadedModules
        );
    }

    async findCandidates(
        normalizedName: string,
        uris: readonly string[],
        isCancelled: () => boolean = () => false,
        /* Прочитанное за этот запрос: см. RslRequestSourceCache. */
        sources?: RslRequestSourceCache
    ): Promise<IReferenceCandidateSource[]> {
        await this.ensureLoaded();

        const target = normalizeIdentifier(normalizedName);
        if (!target || isCancelled()) {
            return [];
        }

        const targetHash = hashReferenceIdentifier(target);
        const result: IReferenceCandidateSource[] = [];
        const uniqueUris = Array.from(new Set(uris.filter(uri => !!uri)));

        for (
            let start = 0;
            start < uniqueUris.length;
            start += this.readBatchSize
        ) {
            if (isCancelled()) {
                return [];
            }

            const batch = uniqueUris.slice(start, start + this.readBatchSize);
            const candidates = await Promise.all(batch.map(uri =>
                this.inspectFile(uri, target, targetHash, sources)
            ));

            for (const candidate of candidates) {
                if (candidate) {
                    result.push(candidate);
                }
            }
        }

        return result;
    }

    getStats(): IReferenceIndexStats {
        let identifiers = 0;
        for (const entry of this.entries.values()) {
            identifiers += entry.hashes.length;
        }

        return {
            indexedFiles: this.entries.size,
            indexedIdentifiers: identifiers,
            persistedFiles: this.persistedFiles
        };
    }

    async flush(): Promise<void> {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }

        /* Не читаем и не переписываем кэш, если References не использовался. */
        if (!this.loadStarted && this.entries.size === 0) {
            return;
        }

        await this.ensureLoaded();
        await this.saveSerialized();
    }

    /**
     * Записи не пересекаются.
     *
     * Отложенная запись и явный flush писали один и тот же временный файл.
     * clearTimeout останавливает таймер, но не запись, которую он уже начал: при
     * наложении одна переименовывала временный файл первой, а вторая на
     * Windows-пути успевала удалить сам кэш, не заменив его ничем.
     */
    private saveSerialized(): Promise<void> {
        const next = (this.saving ?? Promise.resolve())
            .catch(() => undefined)
            .then(() => this.saveToDisk());

        this.saving = next.catch(() => undefined);

        return next;
    }

    private ensureLoaded(): Promise<void> {
        if (!this.loadStarted) {
            this.loadStarted = true;
            this.loadPromise = this.cacheFilePath
                ? this.loadFromDisk(this.cacheFilePath)
                : Promise.resolve();
        }

        return this.loadPromise;
    }

    private async inspectFile(
        uri: string,
        normalizedName: string,
        targetHash: number,
        sources?: RslRequestSourceCache
    ): Promise<IReferenceCandidateSource | undefined> {
        let filePath: string;

        try {
            filePath = fileURLToPath(uri);
        } catch (_error) {
            return undefined;
        }

        let entry = this.entries.get(uri);

        /*
         * Файл не читается только по СВЕРЕННОЙ записи.
         *
         * Это единственное место, ради которого индекс существует: если в
         * наборе идентификаторов файла нужного имени нет, читать его незачем.
         * Но вывод «нет» имеет право делать лишь запись, чей отпечаток уже
         * сверён с диском в этой сессии. Раньше здесь сравнивались дата и
         * размер, а они не меняются при правке одинаковой длины — и файл с
         * новым именем молча пропускался.
         *
         * Сверка стоит одного чтения на файл за сессию: дальше правки
         * сбрасывают запись через наблюдателя за файлами (invalidate), и
         * повторные поиски снова обходятся без чтения.
         */
        if (
            entry?.validated &&
            !containsSortedIdentifierHash(entry.hashes, targetHash)
        ) {
            return undefined;
        }

        /*
         * Чтение общее с записями о ссылках: см. RslRequestSourceCache.
         *
         * Оба хранилища проверяют актуальность одних и тех же файлов, и в
         * холодной сессии один файл читался, декодировался и хешировался по два
         * раза за один запрос References.
         */
        const read = sources
            ? await sources.read(uri)
            : await readOwnSource(filePath);

        if (!read) {
            this.invalidate(uri);
            return undefined;
        }

        const source = read.source;

        if (!entry || entry.fingerprint !== read.fingerprint) {
            /* Содержимое разошлось с записью — пересканируем. */
            this.indexSource(uri, source, {});
            entry = this.entries.get(uri);
        } else if (!entry.validated) {
            entry.validated = true;
        }

        if (!entry || !containsSortedIdentifierHash(entry.hashes, targetHash)) {
            return undefined;
        }

        return containsReferenceIdentifier(source, normalizedName)
            ? { uri, source }
            : undefined;
    }

    /**
     * Можно ли сузить кандидатов по сохранённому графу Import.
     *
     * Граф строится из записей индекса, поэтому доверять ему можно только
     * когда все записи сверены с диском по отпечатку. Ранее здесь сравнивались
     * дата и размер: правка Import, не изменившая длину файла, оставляла граф
     * прежним, и файл выпадал из кандидатов.
     *
     * Отказ безопасен — вызывающий берёт все файлы проекта, то есть ищет шире,
     * а не меньше. И он самоустраняется: тот же поиск прочитает и сверит файлы,
     * так что следующий раз граф уже применим.
     */
    private async ensureImportGraphValid(
        uris: readonly string[],
        loadedModules: readonly IReferenceImportModule[],
        isCancelled: () => boolean
    ): Promise<boolean> {
        if (this.importGraphValidated) {
            return true;
        }

        if (isCancelled()) {
            return false;
        }

        const loadedUris = new Set(loadedModules.map(module => module.uri));

        for (const uri of uris) {
            if (loadedUris.has(uri)) {
                continue;
            }

            if (!this.entries.get(uri)?.validated) {
                return false;
            }
        }

        this.importGraphValidated = true;
        return true;
    }

    private async loadFromDisk(cacheFilePath: string): Promise<void> {
        let raw: string;

        try {
            raw = await fs.promises.readFile(cacheFilePath, "utf8");
        } catch (_error) {
            return;
        }

        try {
            const parsed = JSON.parse(raw) as ISerializedIndex;
            if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.files)) {
                return;
            }

            let loaded = 0;
            for (const item of parsed.files) {
                if (!item || typeof item.uri !== "string") {
                    continue;
                }

                if (
                    this.workspaceUris.size > 0 &&
                    !this.workspaceUris.has(item.uri)
                ) {
                    continue;
                }

                const hashes = decodeHashes(item.hashes);
                if (!hashes) {
                    continue;
                }

                if (!item.fingerprint) {
                    /* Запись прежнего формата без отпечатка доверия не имеет. */
                    continue;
                }

                if (!this.entries.has(item.uri)) {
                    this.entries.set(item.uri, {
                        fingerprint: item.fingerprint,
                        hashes,
                        imports: normalizeReferenceImports(item.imports || [])
                    });
                }
                loaded++;
            }
            this.persistedFiles = loaded;
            this.importGraphValidated = false;
        } catch (error) {
            this.options.log?.(
                `Reference index cache ignored: ${errorToString(error)}`
            );
        }
    }

    private scheduleSave(): void {
        if (!this.cacheFilePath) {
            return;
        }

        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }

        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            this.saveSerialized().catch(error => this.options.log?.(
                `Reference index save failed: ${errorToString(error)}`
            ));
        }, SAVE_DEBOUNCE_MS);
    }

    private async saveToDisk(): Promise<void> {
        if (!this.cacheFilePath) {
            return;
        }

        const files: ISerializedEntry[] = [];
        for (const [uri, entry] of this.entries) {
            if (this.workspaceUris.size > 0 && !this.workspaceUris.has(uri)) {
                continue;
            }

            files.push({
                uri,
                fingerprint: entry.fingerprint,
                hashes: encodeHashes(entry.hashes),
                imports: entry.imports.slice()
            });
        }

        files.sort((left, right) => left.uri.localeCompare(right.uri));
        const payload: ISerializedIndex = {
            version: CACHE_VERSION,
            files
        };
        const directory = path.dirname(this.cacheFilePath);
        await fs.promises.mkdir(directory, { recursive: true });
        const temporary = this.cacheFilePath + ".tmp";
        await fs.promises.writeFile(
            temporary,
            JSON.stringify(payload),
            "utf8"
        );
        try {
            await fs.promises.rename(temporary, this.cacheFilePath);
        } catch (_error) {
            /* Windows не заменяет существующий файл через rename. */
            await fs.promises.unlink(this.cacheFilePath).catch(() => undefined);
            await fs.promises.rename(temporary, this.cacheFilePath);
        }
        this.persistedFiles = files.length;
    }
}

function encodeHashes(hashes: Uint32Array): string {
    const buffer = Buffer.allocUnsafe(hashes.length * 4);
    for (let index = 0; index < hashes.length; index++) {
        buffer.writeUInt32LE(hashes[index], index * 4);
    }
    return buffer.toString("base64");
}

function decodeHashes(value: string): Uint32Array | undefined {
    try {
        const buffer = Buffer.from(value || "", "base64");
        if (buffer.byteLength % 4 !== 0) {
            return undefined;
        }

        const result = new Uint32Array(buffer.byteLength / 4);
        for (let index = 0; index < result.length; index++) {
            result[index] = buffer.readUInt32LE(index * 4);
        }
        return result;
    } catch (_error) {
        return undefined;
    }
}

function errorToString(error: unknown): string {
    return error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
}

export const referenceIndexTesting = referenceSourceFactsTesting;

/** Своё чтение, когда общего кэша запроса нет: см. RslRequestSourceCache. */
async function readOwnSource(
    filePath: string
): Promise<IRslReadSource | undefined> {
    try {
        const source = decodeRslSourceText(
            await fs.promises.readFile(filePath)
        );

        return { source, fingerprint: contentFingerprint(source) };
    } catch {
        return undefined;
    }
}

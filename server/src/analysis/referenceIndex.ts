import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { normalizeIdentifier } from "../lexer";
import {
    buildReferenceCandidateUris,
    type IReferenceImportModule
} from "./referenceImportGraph";
import {
    containsReferenceIdentifier,
    containsSortedIdentifierHash,
    hashReferenceIdentifier,
    normalizeReferenceImports,
    referenceSourceFactsTesting,
    scanReferenceSource
} from "./referenceSourceFacts";

export type { IReferenceImportModule } from "./referenceImportGraph";

const CACHE_VERSION = 2;
const DEFAULT_READ_BATCH_SIZE = 16;
const SAVE_DEBOUNCE_MS = 3000;

export interface IReferenceFileStat {
    mtimeMs: number;
    size: number;
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

interface IReferenceFileEntry extends IReferenceFileStat {
    hashes: Uint32Array;
    imports: string[];
}

interface ISerializedEntry {
    uri: string;
    mtimeMs: number;
    size: number;
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
    private loadPromise: Promise<void> = Promise.resolve();
    private loadStarted = false;
    private persistedFiles = 0;
    private readBatchSize: number;
    private importGraphValidated = false;

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

    indexSource(
        uri: string,
        source: string,
        stat: IReferenceFileStat,
        imports?: readonly string[]
    ): void {
        if (!uri) {
            return;
        }

        const normalizedStat = {
            mtimeMs: normalizeMtime(stat.mtimeMs),
            size: Math.max(0, stat.size)
        };
        const existing = this.entries.get(uri);
        if (
            existing &&
            existing.mtimeMs === normalizedStat.mtimeMs &&
            existing.size === normalizedStat.size
        ) {
            return;
        }

        const facts = scanReferenceSource(source, imports);
        this.entries.set(uri, {
            ...normalizedStat,
            hashes: facts.hashes,
            imports: facts.imports
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
        isCancelled: () => boolean = () => false
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
                this.inspectFile(uri, target, targetHash)
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
        await this.saveToDisk();
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
        targetHash: number
    ): Promise<IReferenceCandidateSource | undefined> {
        let filePath: string;

        try {
            filePath = fileURLToPath(uri);
        } catch (_error) {
            return undefined;
        }

        let stat: fs.Stats;
        try {
            stat = await fs.promises.stat(filePath);
        } catch (_error) {
            this.invalidate(uri);
            return undefined;
        }

        const normalizedStat: IReferenceFileStat = {
            mtimeMs: normalizeMtime(stat.mtimeMs),
            size: stat.size
        };
        let entry = this.entries.get(uri);
        const valid = !!entry &&
            entry.mtimeMs === normalizedStat.mtimeMs &&
            entry.size === normalizedStat.size;

        if (valid && entry && !containsSortedIdentifierHash(entry.hashes, targetHash)) {
            return undefined;
        }

        let source: string;
        try {
            source = await fs.promises.readFile(filePath, "utf8");
        } catch (_error) {
            return undefined;
        }

        if (!valid) {
            this.indexSource(uri, source, normalizedStat);
            entry = this.entries.get(uri);
        }

        if (!entry || !containsSortedIdentifierHash(entry.hashes, targetHash)) {
            return undefined;
        }

        return containsReferenceIdentifier(source, normalizedName)
            ? { uri, source }
            : undefined;
    }

    private async ensureImportGraphValid(
        uris: readonly string[],
        loadedModules: readonly IReferenceImportModule[],
        isCancelled: () => boolean
    ): Promise<boolean> {
        if (this.importGraphValidated) {
            return true;
        }

        const loadedUris = new Set(loadedModules.map(module => module.uri));
        const diskUris = uris.filter(uri => !loadedUris.has(uri));

        for (
            let start = 0;
            start < diskUris.length;
            start += this.readBatchSize
        ) {
            if (isCancelled()) {
                return false;
            }

            const batch = diskUris.slice(start, start + this.readBatchSize);
            const valid = await Promise.all(batch.map(async uri => {
                const entry = this.entries.get(uri);
                if (!entry) {
                    return false;
                }

                try {
                    const filePath = fileURLToPath(uri);
                    const stat = await fs.promises.stat(filePath);
                    return entry.mtimeMs === normalizeMtime(stat.mtimeMs) &&
                        entry.size === stat.size;
                } catch (_error) {
                    return false;
                }
            }));

            if (valid.some(value => !value)) {
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

                if (!this.entries.has(item.uri)) {
                    this.entries.set(item.uri, {
                        mtimeMs: normalizeMtime(item.mtimeMs),
                        size: Math.max(0, item.size),
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
            this.saveToDisk().catch(error => this.options.log?.(
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
                mtimeMs: entry.mtimeMs,
                size: entry.size,
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

function normalizeMtime(value: number): number {
    return Math.floor(Number.isFinite(value) ? value : 0);
}

function errorToString(error: unknown): string {
    return error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
}

export const referenceIndexTesting = referenceSourceFactsTesting;

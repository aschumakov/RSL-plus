import { InteractiveActivityGate } from "../core/interactiveActivityGate";
import {
    defaultRslProjectConfig,
    isExcludedByRslConfig,
    readRslProjectConfig,
    type IRslProjectConfig
} from "../config/projectConfig";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

import type { InitializeParams, WorkspaceFolder } from "vscode-languageserver/node";
import type { PerformanceLogger } from "../performanceLogger";
import {
    isExcludedRslDirectory,
    resolveRslWorkspaceRoots,
    uniqueRoots
} from "./workspaceModuleResolver";

export interface IWorkspaceFileDiscoveryOptions {
    log(message: string): void;
    performance?: PerformanceLogger;
    onFiles(uris: readonly string[]): void;
    initialDelayMs?: number;
    interactivePauseMs?: number;
}

/*
 * Исключаемые каталоги и корни проекта — общие с адресным поиском.
 *
 * Прежде обход и переход к определению держали свои списки, и они разошлись:
 * переход находил файлы в dist, build, archive, backup и .history, а каталог
 * их не видел. См. workspaceModuleResolver.
 */

/**
 * Строит каталог .mac в отдельном процессе language server.
 * В Extension Host больше нет глобального workspace.findFiles по .mac, из-за
 * которого UI и приём LSP-ответов могли останавливаться на несколько секунд.
 */
export class WorkspaceFileDiscoveryService {
    /** Ключ одинаковости -> исходный путь корня; регистр сохраняется. */
    private roots = new Map<string, string>();
    private timer: NodeJS.Timeout | undefined;
    private generation = 0;
    private running = false;
    /* Окно тишины после действия пользователя: см. InteractiveActivityGate. */
    private interactive: InteractiveActivityGate;
    private initialDelayMs: number;
    private interactivePauseMs: number;
    /**
     * Настройка проекта, если она есть.
     *
     * Без файла остаётся умолчание — пустые списки, то есть ровно
     * прежнее поведение обхода.
     */
    private projectConfig: IRslProjectConfig = defaultRslProjectConfig();

    constructor(private options: IWorkspaceFileDiscoveryOptions) {
        this.initialDelayMs = Math.max(0, options.initialDelayMs ?? 2000);
        this.interactivePauseMs = Math.max(
            0,
            options.interactivePauseMs ?? 500
        );
        this.interactive = new InteractiveActivityGate(this.interactivePauseMs);
    }

    configure(params: InitializeParams): void {
        this.roots = rootMap(resolveRslWorkspaceRoots(params));
        this.applyProjectConfig();
        this.restart();
    }

    /**
     * Читает .rslplus.json и добавляет к корням то, что в нём названо.
     *
     * Каталоги заглушек становятся обычными корнями: для сервера
     * заглушка — такой же файл проекта, и отдельного пути обхода ей не
     * нужно.
     */
    private applyProjectConfig(): void {
        const roots = [...this.roots.values()];
        const answer = readRslProjectConfig(roots);

        this.projectConfig = answer.config;

        for (const problem of answer.problems) {
            this.options.log(
                "Настройка проекта: " + problem +
                (answer.filePath ? " (" + answer.filePath + ")" : "")
            );
        }

        const extra = [
            ...answer.config.moduleRoots,
            ...answer.config.stubPaths
        ];

        for (const root of roots) {
            for (const item of extra) {
                const full = path.resolve(root, item);

                if (!this.roots.has(rootKey(full))) {
                    this.roots.set(rootKey(full), full);
                }
            }
        }
    }

    /** Настройка проекта: её же спрашивают разрешение имён и каталог. */
    get config(): IRslProjectConfig {
        return this.projectConfig;
    }

    /** Корни проекта: их же обходит адресный поиск по имени модуля. */
    rootPaths(): string[] {
        return [...this.roots.values()];
    }

    updateWorkspaceFolders(
        added: readonly WorkspaceFolder[],
        removed: readonly WorkspaceFolder[]
    ): void {
        for (const folder of removed) {
            const root = uriToPath(folder.uri);
            if (root) this.roots.delete(rootKey(root));
        }
        for (const folder of added) {
            const root = uriToPath(folder.uri);
            if (root) this.roots.set(rootKey(root), path.resolve(root));
        }
        this.restart();
    }

    schedule(delayMs: number = this.initialDelayMs): void {
        if (this.timer || this.running || this.roots.size === 0) {
            return;
        }
        const generation = this.generation;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.scan(generation).catch(error => this.options.log(
                `Workspace discovery failed: ${errorToString(error)}`
            ));
        }, Math.max(0, delayMs));
    }

    noteInteractiveActivity(): void {
        this.interactive.note();
    }

    dispose(): void {
        this.generation++;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
    }

    private restart(): void {
        this.generation++;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.schedule();
    }

    private async scan(generation: number): Promise<void> {
        if (this.running || generation !== this.generation) return;
        this.running = true;
        const startedAt = Date.now();
        const span = this.options.performance?.enabled
            ? this.options.performance.start("workspaceInventory.server", {
                roots: this.roots.size
            })
            : undefined;
        const files: string[] = [];
        const directories = this.rootPaths();
        let processedSinceYield = 0;

        try {
            while (directories.length > 0 && generation === this.generation) {
                await this.waitForInteractiveWindow(generation);
                const directory = directories.shift()!;
                let entries: fs.Dirent[];
                try {
                    entries = await fs.promises.readdir(directory, {
                        withFileTypes: true
                    });
                } catch (_error) {
                    continue;
                }

                for (const entry of entries) {
                    const full = path.join(directory, entry.name);

                    if (this.isExcluded(full)) {
                        continue;
                    }

                    if (entry.isDirectory()) {
                        if (!isExcludedRslDirectory(entry.name)) {
                            directories.push(full);
                        }
                    } else if (entry.isFile() && /\.mac$/i.test(entry.name)) {
                        files.push(pathToFileURL(full).toString());
                    }
                }

                if (++processedSinceYield >= 8) {
                    processedSinceYield = 0;
                    await yieldToEventLoop();
                }
            }

            if (generation === this.generation) {
                this.options.onFiles(files);
            }
        } finally {
            this.running = false;
            if (span) {
                this.options.performance!.end(span, {
                    durationMs: Date.now() - startedAt,
                    files: files.length,
                    stale: generation !== this.generation
                });
            }
            if (generation !== this.generation) this.schedule();
        }
    }

    /** Исключён ли путь шаблонами настройки проекта. */
    private isExcluded(fullPath: string): boolean {
        const patterns = this.projectConfig.exclude;

        if (patterns.length === 0) {
            return false;
        }

        for (const root of this.roots.values()) {
            const relative = path.relative(root, fullPath);

            if (relative && !relative.startsWith("..")) {
                return isExcludedByRslConfig(relative, patterns);
            }
        }

        return false;
    }

    private async waitForInteractiveWindow(generation: number): Promise<void> {
        while (
            generation === this.generation &&
            this.interactive.isBusy()
        ) {
            await delay(Math.min(100, this.interactive.remainingMs()));
        }
    }
}

function rootMap(roots: readonly string[]): Map<string, string> {
    return new Map(uniqueRoots(roots).map(root => [rootKey(root), root]));
}

/** Ключ одинаковости корня: регистр значим только для сравнения. */
function rootKey(value: string): string {
    const resolved = path.resolve(value);

    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function uriToPath(uri: string): string | undefined {
    try { return fileURLToPath(uri); } catch (_error) { return undefined; }
}

function yieldToEventLoop(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)));
}

function errorToString(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

import * as fs from "fs";
import * as path from "path";

export type PerformanceValue = string | number | boolean | null;

export interface IPerformanceFields {
    [name: string]: PerformanceValue | undefined;
}

export interface IPerformanceSpan {
    event: string;
    fields: IPerformanceFields;
    started: [number, number];
    memoryBefore: NodeJS.MemoryUsage;
}

/**
 * Опциональный файловый профилировщик крупных операций language server.
 *
 * При пустом пути профилировщик не вызывает таймеры, process.memoryUsage()
 * и файловую систему. Формат файла — JSON Lines, одна операция на строку.
 */
export class PerformanceLogger {
    private filePath: string | undefined;
    private pending: Promise<void> = Promise.resolve();
    private memoryTimer: NodeJS.Timeout | undefined;
    private errorReported = false;

    constructor(private onError?: (message: string) => void) {
    }

    get enabled(): boolean {
        return this.filePath !== undefined;
    }

    configure(filePath?: string): void {
        this.stopMemorySampling();
        const value = (filePath || "").trim();
        this.filePath = value
            ? path.resolve(value)
            : undefined;
        this.errorReported = false;

        if (!this.filePath) {
            return;
        }

        this.mark("session.start", {
            nodeVersion: process.version,
            logFile: this.filePath
        });
        this.memoryTimer = setInterval(
            () => this.mark("memory.sample"),
            10000
        );
        this.memoryTimer.unref();
    }

    start(
        event: string,
        fields: IPerformanceFields = {}
    ): IPerformanceSpan | undefined {
        if (!this.filePath) {
            return undefined;
        }

        return {
            event,
            fields,
            started: process.hrtime(),
            memoryBefore: process.memoryUsage()
        };
    }

    end(
        span: IPerformanceSpan | undefined,
        fields: IPerformanceFields = {}
    ): void {
        if (!span || !this.filePath) {
            return;
        }

        const elapsed = process.hrtime(span.started);
        const memoryAfter = process.memoryUsage();
        const durationMs = elapsed[0] * 1000 + elapsed[1] / 1000000;

        this.write({
            timestamp: new Date().toISOString(),
            pid: process.pid,
            event: span.event,
            durationMs: round(durationMs),
            ...span.fields,
            ...fields,
            heapUsedBeforeBytes: span.memoryBefore.heapUsed,
            heapUsedAfterBytes: memoryAfter.heapUsed,
            heapUsedDeltaBytes:
                memoryAfter.heapUsed - span.memoryBefore.heapUsed,
            rssBeforeBytes: span.memoryBefore.rss,
            rssAfterBytes: memoryAfter.rss,
            rssDeltaBytes: memoryAfter.rss - span.memoryBefore.rss,
            externalBytes: memoryAfter.external,
            arrayBuffersBytes: memoryAfter.arrayBuffers
        });
    }

    mark(
        event: string,
        fields: IPerformanceFields = {}
    ): void {
        if (!this.filePath) {
            return;
        }

        const memory = process.memoryUsage();
        this.write({
            timestamp: new Date().toISOString(),
            pid: process.pid,
            event,
            ...fields,
            heapUsedBytes: memory.heapUsed,
            heapTotalBytes: memory.heapTotal,
            rssBytes: memory.rss,
            externalBytes: memory.external,
            arrayBuffersBytes: memory.arrayBuffers
        });
    }

    async shutdown(): Promise<void> {
        this.stopMemorySampling();
        if (this.filePath) {
            this.mark("session.end");
        }
        await this.pending;
    }

    private write(record: Record<string, PerformanceValue | undefined>): void {
        const target = this.filePath;

        if (!target) {
            return;
        }

        const line = JSON.stringify(record) + "\n";
        this.pending = this.pending
            .then(() => fs.promises.mkdir(path.dirname(target), {
                recursive: true
            }))
            .then(() => fs.promises.appendFile(target, line, "utf8"))
            .catch(error => {
                if (!this.errorReported) {
                    this.errorReported = true;
                    this.onError?.(
                        `Performance log write failed: ${target}; ` +
                        errorToString(error)
                    );
                }
            });
    }

    private stopMemorySampling(): void {
        if (this.memoryTimer) {
            clearInterval(this.memoryTimer);
            this.memoryTimer = undefined;
        }
    }
}

function round(value: number): number {
    return Math.round(value * 1000) / 1000;
}

function errorToString(error: unknown): string {
    return error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
}

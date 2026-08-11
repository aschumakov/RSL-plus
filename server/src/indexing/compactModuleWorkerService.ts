import { Worker } from "worker_threads";

import { resolveServerOutFile } from "../paths";
import type {
    ICompactModuleRequest,
    ICompactModuleResponse
} from "./compactModuleProtocol";

export interface ICompactModuleWorkerOptions {
    log(message: string): void;
}

interface IPendingRequest {
    request: ICompactModuleRequest;
    resolve(response: ICompactModuleResponse): void;
}

/**
 * Один worker для компактной индексации внешних файлов.
 *
 * Одного потока достаточно: worker занят чтением и однопроходным
 * сканированием, а не тяжёлым разбором, и параллельные потоки только
 * конкурировали бы за диск и ядра с основным. Запросы обрабатываются по
 * одному, но в двух очередях: приоритет проставляет загрузчик, потому что
 * только он знает, какая Import-ветвь сейчас активна.
 *
 * Worker создаётся лениво при первом запросе и переживает падения: упавший
 * поток не завершает language server, а заменяется при следующем запросе.
 * Незавершённый запрос при этом не теряется — он получает ответ "failed",
 * и загрузчик сам решает, повторять его или обойтись без модуля.
 */
export class CompactModuleWorkerService {
    private worker: Worker | undefined;
    private inFlight: IPendingRequest | undefined;
    /*
     * Две очереди вместо одной: запросы активного документа (Import открытого
     * файла, адресная проверка по Ctrl+Click) обгоняют фоновую индексацию
     * проекта и Auto Import. В одной очереди переход по символу ждал бы все
     * ранее поставленные файлы, до которых пользователю сейчас нет дела.
     */
    private foregroundQueue: IPendingRequest[] = [];
    private backgroundQueue: IPendingRequest[] = [];
    private nextId = 1;
    private disposed = false;

    constructor(private options: ICompactModuleWorkerOptions) {}

    private get queuedCount(): number {
        return this.foregroundQueue.length + this.backgroundQueue.length;
    }

    get isBusy(): boolean {
        return this.inFlight !== undefined || this.queuedCount > 0;
    }

    /**
     * Ставит файл в очередь на компактную индексацию.
     *
     * Никогда не отклоняется: недоступный файл, упавший worker и ошибка
     * разбора приходят как status, потому что для загрузчика это штатные
     * исходы, а не исключения.
     */
    index(
        request: Omit<ICompactModuleRequest, "id">
    ): Promise<ICompactModuleResponse> {
        const id = this.nextId++;
        const full: ICompactModuleRequest = { ...request, id };

        if (this.disposed) {
            return Promise.resolve({
                id,
                uri: request.uri,
                generation: request.generation,
                status: "failed",
                error: "CompactModuleWorkerService уже остановлен"
            });
        }

        return new Promise<ICompactModuleResponse>(resolve => {
            (request.priority === "background"
                ? this.backgroundQueue
                : this.foregroundQueue
            ).push({ request: full, resolve });
            this.pump();
        });
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        const queued = [...this.foregroundQueue, ...this.backgroundQueue];
        const pending = this.inFlight ? [this.inFlight, ...queued] : queued;
        this.inFlight = undefined;
        this.foregroundQueue = [];
        this.backgroundQueue = [];

        for (const item of pending) {
            item.resolve(this.failure(item.request, "shutdown"));
        }

        const worker = this.worker;
        this.worker = undefined;

        if (worker) {
            await worker.terminate();
        }
    }

    private pump(): void {
        if (this.disposed || this.inFlight) {
            return;
        }

        /* Foreground всегда обслуживается раньше фоновой индексации. */
        const next = this.foregroundQueue.shift() ||
            this.backgroundQueue.shift();

        if (!next) {
            return;
        }

        const worker = this.ensureWorker();

        if (!worker) {
            next.resolve(this.failure(next.request, "worker не запускается"));
            this.pump();
            return;
        }

        this.inFlight = next;

        try {
            worker.ref();
            worker.postMessage(next.request);
        } catch (error) {
            this.inFlight = undefined;
            next.resolve(this.failure(next.request, errorToString(error)));
            this.pump();
        }
    }

    private ensureWorker(): Worker | undefined {
        if (this.worker) {
            return this.worker;
        }

        try {
            const worker = new Worker(
                resolveServerOutFile("indexing/compactModuleWorker.js")
            );
            worker.on("message", (response: ICompactModuleResponse) =>
                this.settle(response)
            );
            worker.on("error", error => {
                this.options.log(
                    `Compact module worker error: ${errorToString(error)}`
                );
                this.replaceWorker(worker, errorToString(error));
            });
            worker.on("exit", code => {
                if (code !== 0 && !this.disposed) {
                    this.options.log(
                        `Compact module worker завершился с кодом ${code}`
                    );
                    this.replaceWorker(worker, `exit ${code}`);
                }
            });
            /*
             * Простаивающий worker не держит event loop: иначе процесс не
             * завершится сам, даже когда индексировать больше нечего. На время
             * запроса поток снова ref-ится (см. pump), потому что unref-нутый
             * worker не мешает Node выйти прямо посреди обработки — и ответ
             * не пришёл бы никогда.
             */
            worker.unref();
            this.worker = worker;
            return worker;
        } catch (error) {
            this.options.log(
                `Compact module worker не создан: ${errorToString(error)}`
            );
            return undefined;
        }
    }

    private settle(response: ICompactModuleResponse): void {
        const pending = this.inFlight;

        if (!pending || pending.request.id !== response.id) {
            /* Ответ от заменённого worker'а: отбрасываем. */
            return;
        }

        this.inFlight = undefined;
        pending.resolve(response);

        if (this.queuedCount === 0) {
            this.worker?.unref();
        }
        this.pump();
    }

    private replaceWorker(worker: Worker, reason: string): void {
        if (this.worker !== worker) {
            /* Уже заменён парным событием: error и exit приходят оба. */
            return;
        }

        this.worker = undefined;
        void worker.terminate().catch(() => undefined);

        const pending = this.inFlight;
        this.inFlight = undefined;

        if (pending) {
            pending.resolve(this.failure(pending.request, reason));
        }

        if (!this.disposed) {
            /* Новый worker создастся лениво следующим запросом. */
            this.pump();
        }
    }

    private failure(
        request: ICompactModuleRequest,
        error: string
    ): ICompactModuleResponse {
        return {
            id: request.id,
            uri: request.uri,
            generation: request.generation,
            status: "failed",
            error
        };
    }
}

function errorToString(error: unknown): string {
    return error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
}

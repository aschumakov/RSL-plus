import * as path from "path";
import { Worker } from "worker_threads";

import type { IRslLexResult, IRslToken } from "../lexer";
import type {
    IRslParseResult,
    IRslSyntaxDiagnostic,
    IRslSyntaxNode
} from "../syntaxParser";

interface IWorkerSyntaxResult {
    root: IRslSyntaxNode;
    diagnostics: IRslSyntaxDiagnostic[];
    tokens: IRslToken[];
}

type IWorkerResponse =
    | {
        id: number;
        ok: true;
        syntax: IWorkerSyntaxResult;
    }
    | {
        id: number;
        ok: false;
        /** Разбор прерван по разделяемому флагу; результата нет. */
        cancelled: true;
    }
    | {
        id: number;
        ok: false;
        error: string;
    };

export type ParsePriority = "foreground" | "background";

interface IPendingParse {
    id: number;
    uri: string;
    lex: IRslLexResult;
    resolve(value: IRslParseResult | undefined): void;
    reject(error: unknown): void;
}

interface IQueuedRequest {
    id: number;
    uri: string;
    source: string;
    priority: ParsePriority;
}

interface IWorkerSlot {
    worker: Worker;
    /** Разделяемый с worker'ом флаг отмены: id прерываемого запроса. */
    cancelSignal: Int32Array;
    busy: boolean;
    /** Запрос, который worker считает физически прямо сейчас. */
    request?: IQueuedRequest;
}

export interface ISyntaxParseService {
    readonly currentUri: string | undefined;

    parse(
        uri: string,
        source: string,
        lex: IRslLexResult,
        priority?: ParsePriority
    ): Promise<IRslParseResult | undefined>;

    /**
     * Понижает приоритет запроса до background, не отменяя его.
     *
     * Вызывается, когда документ перестал быть активным: результат ещё
     * нужен, но занимать слот в ущерб новому активному документу такой
     * запрос больше не вправе (см. yieldSlotForForeground).
     */
    demote?(uri: string): void;

    cancel(uri?: string): boolean;
    dispose(): Promise<void>;
}

export interface IWorkerSyntaxParsePoolOptions {
    /** От 1 до 3 worker'ов; по умолчанию 2. */
    poolSize?: number;
}

/**
 * Пул worker_threads для полного syntax parse.
 *
 * Worker'ы создаются один раз и не уничтожаются при отмене: cancel()
 * отбрасывает результат по id, а сам worker остаётся тёплым и сразу берёт
 * следующий запрос из очереди.
 *
 * Отмена при этом не только логическая: parser в worker'е опрашивает
 * разделяемый флаг (SharedArrayBuffer) и прерывает разбор, поэтому слот
 * освобождается физически, а не только "на бумаге". На этом же механизме
 * построено вытеснение: foreground-запрос, которому не досталось
 * свободного слота, прерывает заведомо ненужную работу вместо ожидания —
 * см. yieldSlotForForeground().
 */
export class WorkerSyntaxParsePool implements ISyntaxParseService {
    private slots: IWorkerSlot[] = [];
    private readonly pendingById = new Map<number, IPendingParse>();
    private readonly pendingByUri = new Map<string, IPendingParse>();
    private foregroundQueue: IQueuedRequest[] = [];
    private backgroundQueue: IQueuedRequest[] = [];
    private backgroundSlotsInUse = 0;
    private nextId = 1;
    private readonly poolSize: number;
    /*
     * Сколько слотов резервируется для foreground (активный документ).
     * При poolSize > 1 фон не может занять все слоты сразу, чтобы новый
     * foreground-запрос попадал в свободный слот без вытеснения. Один
     * этот резерв проблему не решает: слоты могут быть заняты запросами,
     * которые были foreground на момент постановки и устарели позже
     * (быстрое переключение вкладок), — против них работает
     * demote() + yieldSlotForForeground().
     */
    private readonly foregroundReserve: number;
    private disposed = false;

    constructor(
        private log: (message: string) => void,
        options: IWorkerSyntaxParsePoolOptions = {}
    ) {
        this.poolSize = Math.max(1, Math.min(3, options.poolSize ?? 2));
        this.foregroundReserve = this.poolSize > 1 ? 1 : 0;
    }

    get currentUri(): string | undefined {
        return this.pendingByUri.keys().next().value;
    }

    parse(
        uri: string,
        source: string,
        lex: IRslLexResult,
        priority: ParsePriority = "foreground"
    ): Promise<IRslParseResult | undefined> {
        if (this.disposed) {
            return Promise.resolve(undefined);
        }

        /*
         * Тот же uri мог уже ждать результата предыдущей версии.
         * Отменяем его как штатное завершение перед постановкой нового.
         */
        this.cancel(uri);

        const id = this.nextId++;

        return new Promise((resolve, reject) => {
            const pending: IPendingParse = { id, uri, lex, resolve, reject };
            this.pendingById.set(id, pending);
            this.pendingByUri.set(uri, pending);

            const request: IQueuedRequest = { id, uri, source, priority };
            const slot = this.findIdleSlot(priority);

            if (slot) {
                this.dispatch(slot, request);
                return;
            }

            (priority === "background"
                ? this.backgroundQueue
                : this.foregroundQueue
            ).push(request);

            if (priority === "foreground") {
                this.yieldSlotForForeground();
            }
        });
    }

    demote(uri: string): void {
        const pending = this.pendingByUri.get(uri);

        if (!pending) {
            return;
        }

        const queued = this.foregroundQueue.find(
            item => item.id === pending.id
        );

        if (queued) {
            this.foregroundQueue = this.foregroundQueue.filter(
                item => item !== queued
            );
            queued.priority = "background";
            this.backgroundQueue.push(queued);
            return;
        }

        const slot = this.slots.find(
            item => item.request?.id === pending.id
        );

        if (slot?.request && slot.request.priority === "foreground") {
            /*
             * Слот уже занят физически; понижение приоритета не освобождает
             * его само, но делает эту работу законной жертвой вытеснения для
             * следующего foreground-запроса.
             */
            slot.request.priority = "background";
            this.backgroundSlotsInUse++;
        }
    }

    cancel(uri?: string): boolean {
        if (uri === undefined) {
            const uris = Array.from(this.pendingByUri.keys());
            uris.forEach(pendingUri => this.cancel(pendingUri));
            return uris.length > 0;
        }

        const pending = this.pendingByUri.get(uri);

        if (!pending) {
            return false;
        }

        this.pendingById.delete(pending.id);
        this.pendingByUri.delete(uri);
        this.foregroundQueue = this.foregroundQueue.filter(
            item => item.id !== pending.id
        );
        this.backgroundQueue = this.backgroundQueue.filter(
            item => item.id !== pending.id
        );

        /*
         * Если запрос уже ушёл в worker, он прерывается по разделяемому
         * флагу: иначе отменённый разбор продолжал бы занимать слот
         * физически (см. yieldSlotForForeground).
         */
        const slot = this.slots.find(item => item.request?.id === pending.id);
        if (slot) {
            this.requestAbort(slot);
        }

        /* Отмена — штатное завершение (undefined, а не reject). */
        pending.resolve(undefined);
        return true;
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        this.foregroundQueue = [];
        this.backgroundQueue = [];

        for (const pending of this.pendingById.values()) {
            pending.resolve(undefined);
        }
        this.pendingById.clear();
        this.pendingByUri.clear();

        const slots = this.slots;
        this.slots = [];
        await Promise.all(slots.map(slot => slot.worker.terminate()));
    }

    /*
     * background не может занять больше (poolSize - foregroundReserve)
     * слотов одновременно — это и есть резерв для активного документа.
     */
    private canDispatchBackground(): boolean {
        return this.backgroundSlotsInUse <
            this.poolSize - this.foregroundReserve;
    }

    private findIdleSlot(priority: ParsePriority): IWorkerSlot | undefined {
        if (priority === "background" && !this.canDispatchBackground()) {
            return undefined;
        }

        for (const slot of this.slots) {
            if (!slot.busy) {
                return slot;
            }
        }

        return this.slots.length < this.poolSize
            ? this.createSlot()
            : undefined;
    }

    private freeSlot(slot: IWorkerSlot): void {
        if (slot.request?.priority === "background") {
            this.backgroundSlotsInUse = Math.max(
                0,
                this.backgroundSlotsInUse - 1
            );
        }
        slot.busy = false;
        slot.request = undefined;
    }

    /**
     * Просит worker прервать текущий разбор.
     *
     * Флаг разделяемый (SharedArrayBuffer), parser опрашивает его раз в
     * несколько сотен инструкций, поэтому слот освобождается за единицы
     * миллисекунд и worker остаётся тёплым — в отличие от terminate(),
     * который стоит создания нового потока с повторной загрузкой модулей.
     */
    private requestAbort(slot: IWorkerSlot): void {
        if (slot.request) {
            Atomics.store(slot.cancelSignal, 0, slot.request.id);
        }
    }

    /**
     * Освобождает слот под запрос активного документа.
     *
     * Прерывается только заведомо ненужная работа: уже отменённый запрос
     * (его результат всё равно будет отброшен) либо background — в том
     * числе понижённый demote() разбор вкладки, которую пользователь
     * только что покинул. Ещё нужный запрос-жертва не теряется: он
     * возвращается в свою очередь при получении ответа "cancelled" и будет
     * пересчитан, когда слот освободится штатно.
     *
     * Слот не возвращается сразу: worker освободит его сам через несколько
     * миллисекунд, и pumpQueue() отдаст его foreground-запросу первым.
     */
    private yieldSlotForForeground(): void {
        const victim = this.slots.find(slot =>
            slot.busy &&
            slot.request !== undefined &&
            !this.pendingById.has(slot.request.id)
        ) || this.slots.find(slot =>
            slot.busy && slot.request?.priority === "background"
        );

        if (victim) {
            this.requestAbort(victim);
        }
    }

    /*
     * Раньше main-поток отправлял worker'у уже готовый lex (columnar
     * transferable-кодек), чтобы избежать повторного lexRsl внутри worker.
     * Контролируемый бенчмарк (500/150/40 замеров на файлах ~1KB/15KB/160KB)
     * показал обратный эффект: ответ доминирует размером дерева `root`
     * (каждый узел несёт свой срез tokens), поэтому выигрыш от устранения
     * relex тонет в стоимости передачи lex на вход, и итог оказывается на
     * 19-33% медленнее простого варианта "worker лексирует сам". Worker
     * снова лексирует source самостоятельно.
     */
    private dispatch(slot: IWorkerSlot, request: IQueuedRequest): void {
        slot.busy = true;
        slot.request = request;

        if (request.priority === "background") {
            this.backgroundSlotsInUse++;
        }

        /*
         * Сброс флага обязателен: id прерванного запроса мог остаться в
         * сигнале этого слота, а прерванный запрос возвращается в очередь с
         * тем же id — worker прервал бы его сразу же, и так по кругу.
         * id нумеруются с 1, поэтому 0 означает "отмены нет".
         */
        Atomics.store(slot.cancelSignal, 0, 0);

        try {
            slot.worker.postMessage({
                id: request.id,
                source: request.source
            });
        } catch (error) {
            this.freeSlot(slot);
            this.settleFailure(request.id, error);
            this.pumpQueue(slot);
        }
    }

    private takeNextQueued(queue: IQueuedRequest[]): IQueuedRequest | undefined {
        while (queue.length > 0) {
            const candidate = queue.shift();

            if (candidate && this.pendingById.has(candidate.id)) {
                return candidate;
            }
            /* Запрос мог быть отменён, пока стоял в очереди — пропускаем. */
        }

        return undefined;
    }

    private pumpQueue(slot: IWorkerSlot): void {
        if (this.disposed) {
            return;
        }

        /* Foreground всегда обслуживается раньше фоновых вкладок. */
        const next = this.takeNextQueued(this.foregroundQueue) ??
            (this.canDispatchBackground()
                ? this.takeNextQueued(this.backgroundQueue)
                : undefined);

        if (!next) {
            return;
        }

        this.dispatch(slot, next);
    }

    private settleFailure(id: number, error: unknown): void {
        const pending = this.pendingById.get(id);

        if (!pending) {
            return;
        }

        this.pendingById.delete(id);
        this.pendingByUri.delete(pending.uri);
        pending.reject(error);
    }

    private createSlot(): IWorkerSlot {
        const workerPath = path.join(
            __dirname,
            "../workers/syntaxParserWorker.js"
        );
        const cancelSignal = new Int32Array(new SharedArrayBuffer(4));
        const worker = new Worker(workerPath, {
            workerData: { cancelSignal }
        });
        const slot: IWorkerSlot = { worker, cancelSignal, busy: false };
        this.slots.push(slot);

        worker.on("message", (response: IWorkerResponse) => {
            const aborted = slot.request;
            this.freeSlot(slot);

            const pending = this.pendingById.get(response.id);

            if ("cancelled" in response) {
                /*
                 * Разбор прерван ради активного документа, но результат ещё
                 * нужен: запрос возвращается в очередь и будет пересчитан,
                 * когда слот освободится штатно.
                 */
                if (pending && aborted?.id === response.id) {
                    (aborted.priority === "background"
                        ? this.backgroundQueue
                        : this.foregroundQueue
                    ).push(aborted);
                }
            } else if (pending) {
                this.pendingById.delete(response.id);
                this.pendingByUri.delete(pending.uri);

                if ("error" in response) {
                    pending.reject(new Error(response.error));
                } else {
                    pending.resolve({
                        root: response.syntax.root,
                        diagnostics: response.syntax.diagnostics,
                        tokens: response.syntax.tokens,
                        lex: pending.lex
                    });
                }
            }
            /*
             * Отсутствие pending означает, что parse был отменён раньше:
             * ответ (в том числе "cancelled") отбрасывается, worker
             * остаётся тёплым для очереди.
             */

            this.pumpQueue(slot);
        });

        worker.on("error", error => {
            this.log(`Parser worker error: ${errorToString(error)}`);
            this.replaceSlot(slot, error);
        });

        worker.on("exit", code => {
            if (code !== 0 && !this.disposed) {
                this.log(`Parser worker завершился с кодом ${code}`);
                this.replaceSlot(
                    slot,
                    new Error(`Parser worker завершился с кодом ${code}`)
                );
            }
        });

        return slot;
    }

    private replaceSlot(slot: IWorkerSlot, error: unknown): void {
        if (!this.slots.includes(slot)) {
            /* Уже обработано парным событием (error и exit могут прийти оба). */
            return;
        }

        this.slots = this.slots.filter(item => item !== slot);
        void slot.worker.terminate().catch(() => undefined);

        const failedId = slot.request?.id;
        this.freeSlot(slot);

        if (failedId !== undefined) {
            this.settleFailure(failedId, error);
        }

        if (this.disposed) {
            return;
        }

        this.pumpQueue(this.createSlot());
    }
}

function errorToString(error: unknown): string {
    return error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
}

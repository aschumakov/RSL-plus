import * as path from "path";
import { Worker } from "worker_threads";

import type { IRslLexResult } from "../lexer";
import type {
    IRslParseResult,
    IRslSyntaxDiagnostic,
    IRslSyntaxNode
} from "../syntaxParser";
import {
    decodeTokens,
    encodeTokens,
    type IEncodedTokenColumns
} from "../workers/tokenTransferCodec";

interface IWorkerSyntaxResult {
    root: IRslSyntaxNode;
    diagnostics: IRslSyntaxDiagnostic[];
    tokens: IEncodedTokenColumns;
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
        error: string;
    };

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
    lex: IRslLexResult;
}

interface IWorkerSlot {
    worker: Worker;
    busy: boolean;
    currentId?: number;
}

export interface ISyntaxParseService {
    readonly currentUri: string | undefined;

    parse(
        uri: string,
        source: string,
        lex: IRslLexResult
    ): Promise<IRslParseResult | undefined>;

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
 * В отличие от прежней однопоточной версии, worker'ы создаются один раз и
 * не уничтожаются при отмене — cancel() просто отбрасывает результат по id,
 * а сам worker остаётся тёплым и сразу берёт следующий запрос из очереди.
 * Несколько worker'ов позволяют парсить активный документ и фоновые вкладки
 * одновременно, а не строго по очереди на единственном потоке.
 */
export class WorkerSyntaxParsePool implements ISyntaxParseService {
    private slots: IWorkerSlot[] = [];
    private readonly pendingById = new Map<number, IPendingParse>();
    private readonly pendingByUri = new Map<string, IPendingParse>();
    private queue: IQueuedRequest[] = [];
    private nextId = 1;
    private readonly poolSize: number;
    private disposed = false;

    constructor(
        private log: (message: string) => void,
        options: IWorkerSyntaxParsePoolOptions = {}
    ) {
        this.poolSize = Math.max(1, Math.min(3, options.poolSize ?? 2));
    }

    get currentUri(): string | undefined {
        return this.pendingByUri.keys().next().value;
    }

    parse(
        uri: string,
        source: string,
        lex: IRslLexResult
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

            const request: IQueuedRequest = { id, uri, source, lex };
            const slot = this.findIdleSlot();

            if (slot) {
                this.dispatch(slot, request);
            } else {
                this.queue.push(request);
            }
        });
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
        this.queue = this.queue.filter(item => item.id !== pending.id);

        /*
         * Отмена — штatное завершение (undefined, а не reject). Если запрос
         * уже ушёл в worker, синхронный parse внутри worker_threads всё
         * равно нельзя прервать: ответ придёт позже и будет молча
         * отброшен в обработчике message, а worker останется тёплым.
         */
        pending.resolve(undefined);
        return true;
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        this.queue = [];

        for (const pending of this.pendingById.values()) {
            pending.resolve(undefined);
        }
        this.pendingById.clear();
        this.pendingByUri.clear();

        const slots = this.slots;
        this.slots = [];
        await Promise.all(slots.map(slot => slot.worker.terminate()));
    }

    private findIdleSlot(): IWorkerSlot | undefined {
        for (const slot of this.slots) {
            if (!slot.busy) {
                return slot;
            }
        }

        return this.slots.length < this.poolSize
            ? this.createSlot()
            : undefined;
    }

    private dispatch(slot: IWorkerSlot, request: IQueuedRequest): void {
        slot.busy = true;
        slot.currentId = request.id;

        const encodedLex = encodeTokens(request.lex.tokens);
        const message = {
            id: request.id,
            source: request.source,
            lex: {
                tokens: encodedLex.columns,
                eol: request.lex.eol,
                hasFinalEol: request.lex.hasFinalEol,
                hasBom: request.lex.hasBom,
                lineStarts: request.lex.lineStarts
            }
        };

        try {
            slot.worker.postMessage(message, encodedLex.transferList);
        } catch (error) {
            slot.busy = false;
            slot.currentId = undefined;
            this.settleFailure(request.id, error);
            this.pumpQueue(slot);
        }
    }

    private pumpQueue(slot: IWorkerSlot): void {
        if (this.disposed) {
            return;
        }

        const next = this.queue.shift();

        if (!next) {
            return;
        }

        /* Запрос мог быть отменён, пока стоял в очереди. */
        if (!this.pendingById.has(next.id)) {
            this.pumpQueue(slot);
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
        const worker = new Worker(workerPath);
        const slot: IWorkerSlot = { worker, busy: false };
        this.slots.push(slot);

        worker.on("message", (response: IWorkerResponse) => {
            slot.busy = false;
            slot.currentId = undefined;

            const pending = this.pendingById.get(response.id);

            if (pending) {
                this.pendingById.delete(response.id);
                this.pendingByUri.delete(pending.uri);

                if ("error" in response) {
                    pending.reject(new Error(response.error));
                } else {
                    pending.resolve({
                        root: response.syntax.root,
                        diagnostics: response.syntax.diagnostics,
                        tokens: decodeTokens(response.syntax.tokens),
                        lex: pending.lex
                    });
                }
            }
            /*
             * Отсутствие pending означает, что parse был отменён раньше:
             * ответ отбрасывается, worker остаётся тёплым для очереди.
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

        if (slot.currentId !== undefined) {
            this.settleFailure(slot.currentId, error);
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

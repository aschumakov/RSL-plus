import * as path from "path";
import { Worker } from "worker_threads";

import type {
    IRslLexResult,
    IRslToken
} from "../lexer";
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
        error: string;
    };

interface IPendingParse {
    id: number;
    uri: string;
    lex: IRslLexResult;
    resolve(value: IRslParseResult | undefined): void;
    reject(error: unknown): void;
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

export class WorkerSyntaxParseService
implements ISyntaxParseService {
    private worker: Worker | undefined;
    private pending: IPendingParse | undefined;
    private nextId = 1;

    constructor(
        private log: (message: string) => void
    ) {}

    get currentUri(): string | undefined {
        return this.pending?.uri;
    }

    parse(
        uri: string,
        source: string,
        lex: IRslLexResult
    ): Promise<IRslParseResult | undefined> {
        if (this.pending) {
            throw new Error(
                `Worker уже разбирает ${this.pending.uri}`
            );
        }

        const worker = this.ensureWorker();
        const id = this.nextId++;

        return new Promise((resolve, reject) => {
            this.pending = {
                id,
                uri,
                lex,
                resolve,
                reject
            };

            try {
                worker.postMessage({ id, source });
            } catch (error) {
                this.pending = undefined;
                reject(error);
            }
        });
    }

    cancel(uri?: string): boolean {
        const pending = this.pending;

        if (!pending || (uri && pending.uri !== uri)) {
            return false;
        }

        this.pending = undefined;

        /*
         * Отмена считается штатным завершением, поэтому undefined,
         * а не reject. Иначе появится ложный Validation failed.
         */
        pending.resolve(undefined);

        const worker = this.worker;
        this.worker = undefined;

        if (worker) {
            void worker.terminate().catch(error => {
                this.log(
                    `Parser worker termination failed: ${errorToString(error)}`
                );
            });
        }

        return true;
    }

    async dispose(): Promise<void> {
        const pending = this.pending;
        this.pending = undefined;
        pending?.resolve(undefined);

        const worker = this.worker;
        this.worker = undefined;

        if (worker) {
            await worker.terminate();
        }
    }

    private ensureWorker(): Worker {
        if (this.worker) {
            return this.worker;
        }

        const workerPath = path.join(
            __dirname,
            "../workers/syntaxParserWorker.js"
        );
        const worker = new Worker(workerPath);

        this.worker = worker;

        worker.on("message", (response: IWorkerResponse) => {
            /*
             * Событие могло прийти от уже отменённого worker.
             */
            if (this.worker !== worker) {
                return;
            }

            const pending = this.pending;

            if (!pending || pending.id !== response.id) {
                return;
            }

            this.pending = undefined;

            if ("error" in response) {
                pending.reject(new Error(response.error));
                return;
            }

            pending.resolve({
                root: response.syntax.root,
                diagnostics: response.syntax.diagnostics,
                tokens: response.syntax.tokens,
                lex: pending.lex
            });
        });

        worker.on("error", error => {
            if (this.worker !== worker) {
                return;
            }

            this.worker = undefined;
            const pending = this.pending;
            this.pending = undefined;

            pending?.reject(error);
        });

        worker.on("exit", code => {
            if (this.worker !== worker) {
                return;
            }

            this.worker = undefined;

            if (code !== 0) {
                const pending = this.pending;
                this.pending = undefined;

                pending?.reject(new Error(
                    `Parser worker завершился с кодом ${code}`
                ));
            }
        });

        return worker;
    }
}

function errorToString(error: unknown): string {
    return error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
}
import { Worker } from "worker_threads";

import { resolveServerOutFile } from "../paths";
import type {
    CompactModulePriority,
    ICompactModuleRequest,
    ICompactModuleResponse
} from "./compactModuleProtocol";

/*
 * Сколько ждать записи кэша при остановке.
 *
 * Остановка сервера не должна зависеть от диска: не успели — потеряем кэш, но
 * не подвесим закрытие редактора.
 */
const FLUSH_TIMEOUT_MS = 2000;

export interface ICompactModuleWorkerOptions {
    log(message: string): void;
    /**
     * Файл постоянного кэша компактных сводок; передаётся worker'у при
     * создании. Без него кэш выключен и чтение работает как раньше.
     */
    cachePath?: string;
}

/**
 * Куда отдать ответ.
 *
 * Ждущих у одного запроса бывает несколько: объединяются только те, кто
 * спросил ровно одно и то же — см. coalescingKey, — поэтому ответ у них общий.
 */
interface IWaiter {
    resolve(response: ICompactModuleResponse): void;
}

interface IPendingRequest {
    request: ICompactModuleRequest;
    waiters: IWaiter[];
    priority: CompactModulePriority;
    resolve(response: ICompactModuleResponse): void;
}

/** Счётчики повторной работы: сколько запросов удалось не делать. */
export interface ICompactModuleWorkerStats {
    /** Сколько раз потребители просили индексацию. */
    requests: number;
    /** Сколько запросов ушло worker'у. */
    dispatched: number;
    /** Сколько запросов присоединились к уже идущему или стоящему в очереди. */
    coalesced: number;
    /** Сколько раз ожидающий запрос повысили в приоритете. */
    promoted: number;
}

/** Ключ объединения: URI и то, что меняет состав ответа. */
function coalescingKey(
    request: Omit<ICompactModuleRequest, "id">
): string {
    /*
     * В ключе всё, от чего зависит СОСТАВ ответа.
     *
     * Адресная проверка экспорта: запрос с expectedExport просит ответ по
     * конкретному имени, и одним вызовом два разных имени не обслужить.
     *
     * Известный отпечаток: с ним worker вправе ответить unchanged, а в таком
     * ответе нет ни объявлений, ни импортов. Присоединить к нему того, кто
     * отпечатка не присылал, значит отдать ему пустоту. Объединять их можно
     * было бы, отправив запрос без отпечатка и дочитав остальным, — но тогда
     * каждый неизменившийся файл сканировался бы заново: 33 мс против 1 мс на
     * файле 550 КБ. Пропуск сканирования дороже редкого объединения.
     */
    return request.uri +
        "|export:" + (request.expectedExport || "") +
        "|print:" + (request.knownFingerprint || "");
}

/**
 * Один worker для компактной индексации внешних файлов.
 *
 * Одного потока достаточно: worker занят чтением и однопроходным
 * сканированием, а не тяжёлым разбором, и параллельные потоки только
 * конкурировали бы за диск и ядра с основным. Запросы обрабатываются по
 * одному, но в трёх очередях: приоритет проставляет загрузчик, потому что
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
     * Три очереди вместо одной: запросы активного документа (Import открытого
     * файла, адресная проверка по Ctrl+Click) обгоняют и обход кандидатов
     * Auto Import, и фоновую индексацию проекта. В одной очереди переход по
     * символу ждал бы все ранее поставленные файлы, до которых пользователю
     * сейчас нет дела; а Auto Import ставит их сразу пачкой (см.
     * CompactModulePriority).
     */
    private foregroundQueue: IPendingRequest[] = [];
    private searchQueue: IPendingRequest[] = [];
    private backgroundQueue: IPendingRequest[] = [];
    private nextId = 1;
    /* Ждущие по ключу объединения: один файл — один запрос worker. */
    private readonly pendingByKey = new Map<string, IPendingRequest>();
    private readonly statsValue: ICompactModuleWorkerStats = {
        requests: 0,
        dispatched: 0,
        coalesced: 0,
        promoted: 0
    };
    private disposed = false;

    constructor(private options: ICompactModuleWorkerOptions) {}

    /**
     * Задаёт файл постоянного кэша.
     *
     * Путь становится известен только на initialize, а сервис создаётся раньше.
     * Уже запущенный поток заменяется: workerData передаётся при создании и
     * задним числом не меняется, а сессия без кэша была бы медленнее ровно
     * там, ради чего кэш и сделан.
     */
    configureCache(cachePath: string | undefined): void {
        const normalized = (cachePath || "").trim() || undefined;

        if (normalized === this.options.cachePath) {
            return;
        }

        this.options = { ...this.options, cachePath: normalized };
        const worker = this.worker;

        if (worker && !this.inFlight) {
            this.worker = undefined;
            void worker.terminate().catch(() => undefined);
        }
    }

    private get queuedCount(): number {
        return this.foregroundQueue.length +
            this.searchQueue.length +
            this.backgroundQueue.length;
    }

    /** Очередь по приоритету запроса; по умолчанию — foreground. */
    private queueFor(priority: CompactModulePriority | undefined) {
        if (priority === "background") {
            return this.backgroundQueue;
        }

        return priority === "search" ? this.searchQueue : this.foregroundQueue;
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

        if (this.disposed) {
            return Promise.resolve({
                id,
                uri: request.uri,
                generation: request.generation,
                status: "failed",
                error: "CompactModuleWorkerService уже остановлен"
            });
        }

        this.statsValue.requests++;

        /*
         * Служебный сброс кэша не объединяется: он не про файл.
         */
        if (request.flushCache) {
            return this.dispatch({ ...request, id }, request.priority);
        }

        const key = coalescingKey(request);
        const waiting = this.pendingByKey.get(key);

        if (waiting) {
            /*
             * Тот же файл уже читается или стоит в очереди.
             *
             * Второй раз его читать и сканировать незачем: ответ придёт один и
             * тот же. Спросивший становится ещё одним ждущим.
             */
            this.statsValue.coalesced++;
            this.promote(waiting, request.priority);

            return new Promise<ICompactModuleResponse>(resolve => {
                waiting.waiters.push({ resolve });
            });
        }

        return this.dispatch({ ...request, id }, request.priority);
    }

    /** Счётчики повторной работы; для лога и проверок. */
    get stats(): ICompactModuleWorkerStats {
        return this.statsValue;
    }

    /**
     * Поставить новый запрос в очередь.
     *
     * Отпечаток из запроса не передаётся worker'у, когда файл может
     * понадобиться другому потребителю целиком: ответ unchanged содержит
     * только отпечаток, и присоединившемуся достанется пустота. Поэтому
     * отпечаток остаётся у ждущего, а сравнивает его уже сервис.
     */
    private dispatch(
        request: ICompactModuleRequest,
        priority: CompactModulePriority | undefined
    ): Promise<ICompactModuleResponse> {
        const key = coalescingKey(request);

        return new Promise<ICompactModuleResponse>(resolve => {
            const entry: IPendingRequest = {
                request,
                priority: priority ?? "foreground",
                waiters: [{ resolve }],
                resolve: response => this.answer(key, entry, response)
            };

            this.statsValue.dispatched++;
            this.pendingByKey.set(key, entry);
            this.queueFor(priority).push(entry);
            this.pump();
        });
    }

    /**
     * Раздать ответ всем, кто его ждал.
     *
     * Тому, чей отпечаток совпал с фактическим, отдаётся unchanged: он просил
     * именно этого, и его код рассчитан на такой ответ.
     */
    private answer(
        key: string,
        entry: IPendingRequest,
        response: ICompactModuleResponse
    ): void {
        if (this.pendingByKey.get(key) === entry) {
            this.pendingByKey.delete(key);
        }

        /*
         * Ответ один на всех: спрашивали они одно и то же — см. coalescingKey.
         */
        for (const waiter of entry.waiters) {
            waiter.resolve(response);
        }
    }

    /** Убрать запрос из объединения: присоединяться к нему больше нельзя. */
    private forgetCoalescing(entry: IPendingRequest): void {
        const key = coalescingKey(entry.request);

        if (this.pendingByKey.get(key) === entry) {
            this.pendingByKey.delete(key);
        }
    }

    /**
     * Поднять ожидающий запрос в очереди повыше.
     *
     * Файл, поставленный фоновой индексацией, не должен заставлять
     * интерактивный запрос ждать всю фоновую очередь.
     */
    private promote(
        entry: IPendingRequest,
        priority: CompactModulePriority | undefined
    ): void {
        const wanted = priority ?? "foreground";

        if (rankOf(wanted) >= rankOf(entry.priority)) {
            return;
        }

        const from = this.queueFor(entry.priority);
        const at = from.indexOf(entry);

        if (at < 0) {
            /*
             * Страховка: до запроса у worker'а отсюда не добраться — он
             * снят с объединения, и присоединиться к нему нельзя.
             */
            return;
        }

        from.splice(at, 1);
        entry.priority = wanted;
        this.queueFor(wanted).push(entry);
        this.statsValue.promoted++;
    }

    async dispose(): Promise<void> {
        /*
         * Отложенный кэш записывается до остановки потока.
         *
         * Просьба уходит по обычной очереди, поэтому попадает после всех уже
         * принятых запросов — то есть сохраняет и их результаты. Ожидание
         * ограничено: остановка сервера не должна зависеть от записи на диск.
         */
        await this.flushWorkerCache();

        this.disposed = true;
        const queued = [
            ...this.foregroundQueue,
            ...this.searchQueue,
            ...this.backgroundQueue
        ];
        const pending = this.inFlight ? [this.inFlight, ...queued] : queued;
        this.inFlight = undefined;
        this.foregroundQueue = [];
        this.searchQueue = [];
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

    /** Просит worker записать кэш; молча уступает по таймауту. */
    private async flushWorkerCache(): Promise<void> {
        if (this.disposed || !this.worker) {
            return;
        }

        const request = this.index({
            uri: "",
            generation: 0,
            priority: "foreground",
            flushCache: true
        });
        const timeout = new Promise<void>(resolve =>
            setTimeout(resolve, FLUSH_TIMEOUT_MS).unref?.()
        );

        await Promise.race([request.then(() => undefined), timeout]);
    }

    private pump(): void {
        if (this.disposed || this.inFlight) {
            return;
        }

        /* Активный документ раньше Auto Import, тот — раньше индексации. */
        const next = this.foregroundQueue.shift() ||
            this.searchQueue.shift() ||
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
        /*
         * Запрос ушёл worker'у и попутчиков больше не берёт.
         *
         * Иначе была гонка: пока файл читается, его успевают изменить, и
         * пришедший следом запрос присоединялся к работе, начатой ДО правки, —
         * получая содержимое, которого на диске уже нет. Проверка поколения у
         * вызывающего от этого не спасает: его запрос начался после сброса, а
         * ответ достался от прежнего чтения.
         *
         * Полезный случай сохраняется целиком: пока запрос стоит в очереди,
         * к нему по-прежнему присоединяются и повышают его в приоритете.
         */
        this.forgetCoalescing(next);

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
                resolveServerOutFile("indexing/compactModuleWorker.js"),
                { workerData: { cachePath: this.options.cachePath } }
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

/** Порядок очередей: меньше — раньше. */
function rankOf(priority: CompactModulePriority): number {
    if (priority === "foreground") {
        return 0;
    }

    return priority === "search" ? 1 : 2;
}

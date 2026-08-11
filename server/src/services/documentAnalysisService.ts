import type { TextDocuments } from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

import { createOpenModuleModel } from "../moduleModel";
import { RslSymbol } from "../symbols/rslSymbol";
import { parseRslSyntax } from "../syntaxParser";
import type { RslSettingsService } from "./settingsService";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

import {
    createFastDocumentSnapshot,
    getFastDocumentSymbols,
    type IFastDocumentSnapshot
} from "./fastDocumentSnapshot";
import type { PerformanceLogger } from "../performanceLogger";

/*
 * Сколько разборов разрешено запустить за один проход очереди.
 *
 * Полный parse синхронный, поэтому "параллельность" здесь — это размер
 * порции в одном тике event loop, а не настоящая конкурентность. Каждая
 * следующая порция уходит через setImmediate (см. scheduleValidationQueue),
 * так что между разборами Node успевает обслужить таймеры и LSP IPC.
 * Значение 1 выбрано намеренно: при 8 файлах по 300КБ в одной порции
 * задержка таймера доходила до 171-398 мс, то есть пользователь платил
 * очередью за файлы, которых даже не видит.
 */
const MAX_VALIDATIONS_PER_TICK = 1;

/*
 * От какого размера разбор идёт фазами с возвратом управления между ними.
 *
 * Ниже порога вся работа (lex + parse + модель) дешевле одного тика, и паузы
 * только откладывали бы готовность модели. Порог соответствует ~50 мс
 * суммарной блокировки на замерах npm run bench.
 */
const PHASED_ANALYSIS_MIN_CHARS = 300_000;

export interface IDocumentAnalysisOptions {
    changeDebounceMs?: number;
    slowParseLogMs?: number;
    initialParseDelayMs?: number;
    inactiveParseDelayMs?: number;
    log(message: string): void;
    performance?: PerformanceLogger;
    invalidateProviderCaches(uri: string): void;
    onParsed(module: IIndexedModule, wasKnown: boolean): void;
    onImports(uri: string, imports: readonly string[]): void;
}

type AnalysisPriority = "foreground" | "background";

interface IValidationTask {
    document: TextDocument;
    generation: number;
    priority: AnalysisPriority;
    promise: Promise<void>;
    resolve(): void;
    reject(error: unknown): void;
}

/**
 * Управляет versioned-разбором документа.
 * Fast snapshot строится сразу; полный parse запускается после короткого
 * приоритетного окна, а изменения текста объединяются.
 */
export class DocumentAnalysisService {
    private parseGeneration = new Map<string, number>();
    private parsedVersions = new Map<string, number>();
    private parseTimers = new Map<string, NodeJS.Timeout>();
    private running = new Map<string, Promise<void>>();
    private foregroundQueue: IValidationTask[] = [];
    private backgroundQueue: IValidationTask[] = [];
    private queued = new Map<string, IValidationTask>();
    private queueScheduled = false;
    /** Идёт разбор: между фазами большого файла управление возвращается. */
    private validationInFlight = false;
    private idleWaiters = new Map<string, Array<() => void>>();
    private fastSnapshots = new Map<string, IFastDocumentSnapshot>();
    private openedVersions = new Map<string, number>();
    private changeDebounceMs: number;
    private slowParseLogMs: number;
    private initialParseDelayMs: number;
    private activeDocumentUri: string | undefined;

    constructor(
        private documents: TextDocuments<TextDocument>,
        private index: WorkspaceIndex,
        private settings: RslSettingsService,
        private options: IDocumentAnalysisOptions
    ) {
        this.changeDebounceMs = options.changeDebounceMs ?? 90;
        this.slowParseLogMs = options.slowParseLogMs ?? 75;
        this.initialParseDelayMs = options.initialParseDelayMs ?? 50;
    }

    get isBusy(): boolean {
        return this.parseTimers.size > 0 ||
            this.running.size > 0 ||
            this.queued.size > 0;
    }

    isBusyFor(uri: string): boolean {
        return this.parseTimers.has(uri) ||
            this.running.has(uri) ||
            this.queued.has(uri);
    }

    /**
     * Fast Snapshot этой версии готов: есть token stream, из которого без
     * полного parse строятся Structure, Folding и список объявлений.
     *
     * Первая фаза анализа. Отвечает на вопрос "можно ли показать структуру",
     * а не "точна ли модель": объявления Fast Snapshot получены сканированием
     * токенов, без разбора выражений и областей видимости.
     */
    isFastReady(document: TextDocument): boolean {
        const snapshot = this.fastSnapshots.get(document.uri);
        return !!snapshot && snapshot.version === document.version;
    }

    /**
     * Полная локальная модель этой версии лежит в индексе: symbolTree, AST и
     * точные области видимости.
     *
     * Вторая фаза. Единственная проверка "актуальна ли модель" для всей
     * службы — раньше это условие повторялось в нескольких местах с чуть
     * разными формулировками.
     */
    isLocalReady(document: TextDocument): boolean {
        const module = this.index.getCurrentModule(
            document.uri,
            document.version
        );

        return this.parsedVersions.get(document.uri) === document.version &&
            module?.kind === "open";
    }

    /**
     * Разрешается сразу, если uri не занят, иначе — при следующем переходе
     * в состояние idle. Заменяет опрос с фиксированной задержкой в
     * DiagnosticsCoordinator прямым ожиданием результата parse.
     */
    whenIdle(uri: string): Promise<void> {
        if (!this.isBusyFor(uri)) {
            return Promise.resolve();
        }

        return new Promise(resolve => {
            const waiters = this.idleWaiters.get(uri) || [];
            waiters.push(resolve);
            this.idleWaiters.set(uri, waiters);
        });
    }

    /**
     * Snapshot и Outline создаются синхронно; полный parser получает короткое
     * окно, чтобы Structure гарантированно была готова раньше Problems.
     *
     * Возвращает false для повторного onDidOpen той же версии. Это позволяет
     * вызывающему коду не дублировать workspace/configuration request.
     */
    open(document: TextDocument): boolean {
        const performance = this.options.performance;
        const span = performance?.enabled
            ? performance.start("document.open", {
                uri: document.uri,
                version: document.version,
                chars: document.getText().length
            })
            : undefined;
        const openedVersion = this.openedVersions.get(document.uri);
        const current = this.fastSnapshots.get(document.uri);

        if (openedVersion === document.version) {
            if (span) {
                performance.end(span, {
                    duplicate: true,
                    outlineReady: current?.symbols !== undefined,
                    topLevelSymbols: current?.symbols?.length ?? 0
                });
            }
            return false;
        }

        this.openedVersions.set(document.uri, document.version);
        const isActive = document.uri === this.activeDocumentUri;
        const snapshot = isActive
            ? this.refreshFastSnapshot(document)
            : undefined;
        if (snapshot) {
            this.prepareOutline(document, snapshot);
            this.scheduleWithDelay(document, this.initialParseDelayMs);
        }
        if (span) {
            performance.end(span, {
                duplicate: false,
                outlineReady: !!snapshot,
                tokens: snapshot?.lex.tokens.length ?? 0,
                topLevelSymbols: snapshot?.symbols?.length ?? 0
            });
        }
        return true;
    }

    /** Частые изменения текста объединяются; snapshot пересоздаётся лениво. */
    changed(document: TextDocument): void {
        const openedVersion = this.openedVersions.get(document.uri);

        /*
         * TextDocuments отправляет onDidChangeContent сразу после onDidOpen.
         * Это не новая версия документа: open() уже построил snapshot и
         * запланировал parse, поэтому повторный lexer здесь не нужен.
         */
        if (openedVersion === document.version) {
            return;
        }

        this.openedVersions.set(document.uri, document.version);
        /*
         * Снапшот предыдущей версии НЕ удаляется здесь: getFastSnapshot()
         * уже проверяет version перед использованием кэша, а
         * refreshFastSnapshot() передаёт именно этот старый снапшот в
         * tryIncrementalRelex() как "previous" для точечного relex.
         * Преждевременное удаление сводило incremental relex к нулю —
         * каждое изменение всегда уходило в полный lexRsl().
         */
        this.options.invalidateProviderCaches(document.uri);
        if (document.uri === this.activeDocumentUri) {
            this.scheduleWithDelay(document, this.changeDebounceMs);
        }
    }

    /** Совместимость со старым API: считается изменением документа. */
    schedule(document: TextDocument): void {
        this.changed(document);
    }

    /**
     * Активный документ получает ближайший parser slot. Остальные открытые
     * вкладки сохраняют готовый Fast Snapshot, но полный AST строят позже.
     */
    setActiveDocument(uri: string | undefined): void {
        const previousActiveUri = this.activeDocumentUri;
        this.activeDocumentUri = uri;

        for (const task of this.foregroundQueue) {
            task.priority = "background";
            this.backgroundQueue.push(task);
        }
        this.foregroundQueue = [];

        if (previousActiveUri && previousActiveUri !== uri) {
            this.interruptPhasedValidation(previousActiveUri);
        }

        /*
         * Восстановленные VS Code вкладки получают быстрый Outline, но не
         * конкурируют с активным файлом за parser slot и память. Полный AST
         * будет построен при активации вкладки или явном LSP-запросе.
         *
         * previousActiveUri исключён из отмены: секцией выше он мог только
         * что перейти из foreground в background в этом же вызове — это
         * файл, который пользователь только что редактировал/просматривал,
         * а не "восстановленная, но не открытая" вкладка. Без этого
         * исключения его queued-задача отменялась бы немедленно, не
         * дождавшись даже фонового parse (baг воспроизводится тестом
         * testActiveDocumentSurvivesStaleWorkerContention).
         */
        for (const candidate of Array.from(this.parseTimers.keys())) {
            if (candidate !== uri) {
                this.cancelTimer(candidate);
                this.notifyIdleIfSettled(candidate);
            }
        }
        for (const [candidate, task] of Array.from(this.queued.entries())) {
            if (
                candidate !== uri &&
                candidate !== previousActiveUri &&
                task.priority === "background"
            ) {
                this.cancelQueued(candidate);
            }
        }

        if (!uri) {
            return;
        }

        const document = this.documents.get(uri);
        if (
            !document ||
            !this.openedVersions.has(uri) ||
            this.isLocalReady(document)
        ) {
            return;
        }

        /* Восстановленная неактивная вкладка до активации не лексировалась. */
        const snapshot = this.getFastSnapshot(document);
        if (snapshot.symbols === undefined) {
            this.prepareOutline(document, snapshot);
        }

        const queued = this.queued.get(uri);
        if (queued) {
            this.promoteValidation(queued);
        } else {
            this.cancelTimer(uri);
            const generation = this.nextGeneration(uri);
            this.startValidation(
                document,
                generation,
                "foreground"
            ).catch(error => {
                this.options.log(
                    `Validation failed: ${uri}\n${errorToString(error)}`
                );
            });
        }
        this.options.performance?.mark?.("analysis.priority", {
            uri,
            priority: "active"
        });
    }


    /** Folding и Outline получают snapshot без ожидания полного parser. */
    getFastSnapshot(document: TextDocument): IFastDocumentSnapshot {
        return this.isFastReady(document)
            ? this.fastSnapshots.get(document.uri)!
            : this.refreshFastSnapshot(document);
    }

    async ensureParsed(document: TextDocument): Promise<RslSymbol | undefined> {
        if (this.isLocalReady(document)) {
            return this.index.getModule(document.uri)?.symbolTree;
        }

        this.cancelTimer(document.uri);
        const active = this.running.get(document.uri);

        if (active) {
            await active;
            if (this.isLocalReady(document)) {
                return this.index.getModule(document.uri)?.symbolTree;
            }
        }

        const generation = this.nextGeneration(document.uri);
        await this.startValidation(document, generation, "foreground");
        return this.index.getModule(document.uri)?.symbolTree;
    }

    close(uri: string): void {
        this.cancelTimer(uri);
        this.cancelQueued(uri);
        this.fastSnapshots.delete(uri);
        this.openedVersions.delete(uri);
        this.parsedVersions.delete(uri);
        this.nextGeneration(uri);
        this.index.compactModule(uri);
        this.notifyIdleIfSettled(uri);
    }

    invalidate(uri: string): void {
        this.cancelQueued(uri);
        this.fastSnapshots.delete(uri);
        this.parsedVersions.delete(uri);
        this.notifyIdleIfSettled(uri);
    }


    private refreshFastSnapshot(
        document: TextDocument
    ): IFastDocumentSnapshot {
        const performance = this.options.performance;
        const span = performance?.enabled
            ? performance.start("analysis.fastSnapshot", {
                uri: document.uri,
                version: document.version,
                chars: document.getText().length
            })
            : undefined;
        const snapshot = createFastDocumentSnapshot(
            document,
            this.fastSnapshots.get(document.uri)
        );
        if (span) {
            performance.end(span, {
                tokens: snapshot.lex.tokens.length
            });
        }
        this.fastSnapshots.set(document.uri, snapshot);
        this.options.invalidateProviderCaches(document.uri);
        return snapshot;
    }

    /**
     * Отдельная presentation-фаза: не строит RslSymbol и не зависит от настроек,
     * Import-графа или диагностики.
     */
    private prepareOutline(
        document: TextDocument,
        snapshot: IFastDocumentSnapshot
    ): void {
        const performance = this.options.performance;
        const span = performance?.enabled
            ? performance.start("analysis.outlineSnapshot", {
                uri: document.uri,
                version: document.version,
                tokens: snapshot.lex.tokens.length
            })
            : undefined;
        const symbols = getFastDocumentSymbols(document, snapshot);

        if (span) {
            performance.end(span, {
                topLevelSymbols: symbols.length
            });
        }
    }

    private scheduleWithDelay(document: TextDocument, delay: number): void {
        const uri = document.uri;
        const version = document.version;
        const generation = this.nextGeneration(uri);
        this.cancelTimer(uri);

        const timer = setTimeout(() => {
            this.parseTimers.delete(uri);
            const current = this.documents.get(uri);

            if (!current || current.version !== version) {
                this.notifyIdleIfSettled(uri);
                return;
            }

            const priority: AnalysisPriority =
                current.uri === this.activeDocumentUri
                    ? "foreground"
                    : "background";
            this.startValidation(current, generation, priority).catch(error => {
                this.options.log(
                    `Validation failed: ${uri}\n${errorToString(error)}`
                );
            });
        }, Math.max(0, delay));

        this.parseTimers.set(uri, timer);
    }

    private startValidation(
        document: TextDocument,
        generation: number,
        priority: AnalysisPriority =
            document.uri === this.activeDocumentUri
                ? "foreground"
                : "background"
    ): Promise<void> {
        const uri = document.uri;
        const existing = this.running.get(uri);

        if (existing) {
            return existing.then(() => {
                const current = this.documents.get(uri);

                if (!current || this.isLocalReady(current)) {
                    return;
                }
                return this.startValidation(
                    current,
                    this.parseGeneration.get(uri) ?? generation,
                    priority
                );
            });
        }

        const queued = this.queued.get(uri);
        if (queued) {
            queued.document = document;
            queued.generation = generation;
            if (priority === "foreground") {
                this.promoteValidation(queued);
            }
            return queued.promise;
        }

        let resolveTask!: () => void;
        let rejectTask!: (error: unknown) => void;
        const promise = new Promise<void>((resolve, reject) => {
            resolveTask = resolve;
            rejectTask = reject;
        });
        const task: IValidationTask = {
            document,
            generation,
            priority,
            promise,
            resolve: resolveTask,
            reject: rejectTask
        };
        this.queued.set(uri, task);
        if (priority === "foreground") {
            this.foregroundQueue.push(task);
        } else {
            this.backgroundQueue.push(task);
        }
        this.scheduleValidationQueue();
        return promise;
    }

    private promoteValidation(task: IValidationTask): void {
        if (task.priority === "foreground") {
            return;
        }

        this.backgroundQueue = this.backgroundQueue.filter(
            item => item !== task
        );
        task.priority = "foreground";
        this.foregroundQueue.push(task);
        this.scheduleValidationQueue();
    }

    private scheduleValidationQueue(): void {
        if (this.queueScheduled) {
            return;
        }

        this.queueScheduled = true;
        setImmediate(() => {
            this.queueScheduled = false;
            this.processValidationQueue();
        });
    }

    /**
     * За один проход запускается не больше MAX_VALIDATIONS_PER_TICK разборов.
     *
     * Раньше foreground-очередь выгружалась целиком, и поскольку parse
     * синхронный, все разборы выполнялись одной цепочкой microtask: между
     * ними Node не возвращался ни к таймерам, ни к LSP IPC. Восемь открытых
     * файлов по 300КБ задерживали таймер на 420 мс — то есть отсутствие
     * лимита не ускоряло ответы, а задерживало их все сразу, включая
     * переключение активного документа.
     *
     * Остаток очереди подхватывает finishValidation() через
     * scheduleValidationQueue(), то есть следующей порцией из setImmediate.
     * Активный документ ставится в начало порции, чтобы за файлами, которых
     * пользователь не видит, не ждал тот, который он смотрит.
     *
     * Одновременно выполняется не больше одного разбора. Раньше это
     * обеспечивалось само: validate() был полностью синхронным. С фазовым
     * разбором больших файлов (PHASED_ANALYSIS_MIN_CHARS) между фазами есть
     * возврат управления, и без явного признака "разбор идёт" следующая
     * порция запустила бы второй разбор параллельно — два больших файла
     * держали бы в памяти два AST и мешали друг другу.
     */
    private processValidationQueue(): void {
        if (this.validationInFlight) {
            return;
        }

        this.hoistActiveDocument();
        let started = 0;

        while (
            this.foregroundQueue.length > 0 &&
            started < MAX_VALIDATIONS_PER_TICK
        ) {
            this.dispatchTask(this.foregroundQueue.shift()!);
            started++;
        }

        /*
         * Пока активный документ ждёт своей очереди по debounce, фон слот не
         * занимает. Иначе задача только что покинутого большого файла
         * успевает уйти в разбор в это окно, и активный документ ждёт её
         * целиком — тот же эффект, что и без прерывания фаз, только через
         * очередь.
         */
        const activeWaitsForDebounce = !!this.activeDocumentUri &&
            this.parseTimers.has(this.activeDocumentUri);

        while (
            !activeWaitsForDebounce &&
            this.backgroundQueue.length > 0 &&
            started < MAX_VALIDATIONS_PER_TICK
        ) {
            this.dispatchTask(this.backgroundQueue.shift()!);
            started++;
        }
    }

    /**
     * Прерывает оставшиеся фазы разбора покинутого документа.
     *
     * Большой файл разбирается частями, и без этого новый активный документ
     * ждал бы все оставшиеся фазы предыдущего — на файле 1,1 МБ это больше
     * ста миллисекунд ожидания того, что пользователь уже не смотрит.
     * Прерывание работает через поколение: следующая же фаза видит, что
     * результат никому не нужен, и выходит.
     *
     * Работа не выбрасывается насовсем — документ возвращается в фоновую
     * очередь и будет разобран, когда активный файл освободит очередь.
     */
    private interruptPhasedValidation(uri: string): void {
        if (!this.running.has(uri)) {
            return;
        }

        const document = this.documents.get(uri);
        const generation = this.nextGeneration(uri);

        if (!document || !this.openedVersions.has(uri)) {
            return;
        }

        this.startValidation(document, generation, "background").catch(
            error => this.options.log(
                `Validation failed: ${uri}\n${errorToString(error)}`
            )
        );
    }

    /**
     * Результат ещё нужен: документ той же версии, поколение не сменилось.
     *
     * Проверяется после каждой паузы фазового разбора: пока управление было
     * у event loop, документ могли изменить или закрыть, и тогда следующая
     * фаза считала бы по устаревшему тексту.
     */
    private stillCurrent(
        uri: string,
        version: number,
        generation: number
    ): boolean {
        return this.parseGeneration.get(uri) === generation &&
            this.documents.get(uri)?.version === version;
    }

    /** Активный документ — первым в порции, остальной порядок сохраняется. */
    private hoistActiveDocument(): void {
        const uri = this.activeDocumentUri;

        if (!uri || this.foregroundQueue.length < 2) {
            return;
        }

        const index = this.foregroundQueue.findIndex(
            task => task.document.uri === uri
        );

        if (index > 0) {
            const [task] = this.foregroundQueue.splice(index, 1);
            this.foregroundQueue.unshift(task);
        }
    }

    private dispatchTask(task: IValidationTask): void {
        const uri = task.document.uri;
        this.queued.delete(uri);
        this.running.set(uri, task.promise);
        this.validationInFlight = true;

        Promise.resolve()
            .then(() => this.validate(task.document, task.generation))
            .then(
                () => this.finishValidation(task, true),
                error => this.finishValidation(task, false, error)
            );
    }

    private finishValidation(
        task: IValidationTask,
        succeeded: boolean,
        error?: unknown
    ): void {
        const uri = task.document.uri;
        this.validationInFlight = false;
        if (this.running.get(uri) === task.promise) {
            this.running.delete(uri);
        }

        if (succeeded) {
            task.resolve();
        } else {
            task.reject(error);
        }
        this.notifyIdleIfSettled(uri);
        this.scheduleValidationQueue();
    }

    private notifyIdleIfSettled(uri: string): void {
        if (this.isBusyFor(uri)) {
            return;
        }

        const waiters = this.idleWaiters.get(uri);
        if (!waiters) {
            return;
        }

        this.idleWaiters.delete(uri);
        waiters.forEach(resolve => resolve());
    }

    private async validate(
        document: TextDocument,
        generation: number
    ): Promise<void> {
        const uri = document.uri;
        const version = document.version;

        if (this.isLocalReady(document)) {
            return;
        }

        const text = document.getText();
        /*
         * Очень большой файл разбирается фазами с возвратом управления между
         * ними: lex, parse и построение модели стоят примерно одинаково, и на
         * 550КБ это 29 + 23 + 23 мс, на 1.1МБ 71 + 45 + 49 мс. Одним куском
         * это блокировка на 75 и 165 мс, то есть именно столько ждут таймеры
         * и все LSP-запросы. Разбить сам parse нельзя без переписывания
         * рекурсивного спуска, а разнести три фазы — можно, и максимальная
         * блокировка становится ценой одной фазы.
         *
         * Для обычных файлов паузы не нужны: там вся работа дешевле одного
         * тика, а лишние возвраты только откладывают готовность модели.
         */
        const phased = text.length >= PHASED_ANALYSIS_MIN_CHARS;
        const fastSnapshot = this.getFastSnapshot(document);

        if (phased && !this.stillCurrent(uri, version, generation)) {
            return;
        }

        const started = Date.now();
        const wasKnown = !!this.index.getModule(uri);
        const performance = this.options.performance;
        const fullSpan = performance?.enabled
            ? performance.start("analysis.full", {
                uri,
                version,
                chars: text.length,
                lexTokens: fastSnapshot.lex.tokens.length
            })
            : undefined;

        /* Один parser/lexer pass на версию документа. */
        const syntaxSpan = performance?.enabled
            ? performance.start("analysis.syntax", {
                uri,
                version,
                chars: text.length,
                lexTokens: fastSnapshot.lex.tokens.length
            })
            : undefined;

        /*
         * Parse выполняется на основном потоке. Вынос в worker_threads был
         * убран (см. историю syntaxParseService.ts): ответ worker'а — это
         * AST, где каждый узел несёт свой срез tokens, а его structured
         * clone распаковывается В ОСНОВНОМ ПОТОКЕ, то есть вынос увеличивал
         * блокировку event loop, ради снижения которой делался. Замеры
         * (Node 20, тот же runtime, что у language server) — parse на месте
         * против одной только распаковки ответа: 150КБ 10 против 55 мс,
         * 300КБ 9 против 96 мс, 550КБ 25 против 192 мс, 1.1МБ 35 против
         * 430 мс. Воспроизвести: npm run bench.
         *
         * Вместо выноса блокировка ограничена порционностью очереди
         * (MAX_VALIDATIONS_PER_TICK), а вынос станет осмысленным только с
         * компактным протоколом (declarations + diagnostics вместо AST) —
         * сейчас AST нужен на основном потоке и diagnostics, и
         * blockNavigation, и codeActions, и references.
         */
        if (phased) {
            await yieldToEventLoop();

            if (!this.stillCurrent(uri, version, generation)) {
                if (syntaxSpan) {
                    performance.end(syntaxSpan, { cancelled: true });
                }
                if (fullSpan) {
                    performance.end(fullSpan, { cancelled: true });
                }
                return;
            }
        }

        const syntax = parseRslSyntax(text, fastSnapshot.lex, {
            buildExpressionTree: false
        });

        if (!syntax) {
            if (syntaxSpan) {
                performance.end(syntaxSpan, {
                    cancelled: true
                });
            }

            if (fullSpan) {
                performance.end(fullSpan, {
                    cancelled: true
                });
            }

            return;
        }
        if (syntaxSpan) {
            performance.end(syntaxSpan, {
                syntaxTokens: syntax.tokens.length,
                parserDiagnostics: syntax.diagnostics.length
            });
        }
        const treeSpan = performance?.enabled
            ? performance.start("analysis.symbolTree", {
                uri,
                version,
                syntaxTokens: syntax.tokens.length
            })
            : undefined;
        if (phased) {
            await yieldToEventLoop();
        }

        if (!this.stillCurrent(uri, version, generation)) {
            if (fullSpan) {
                performance.end(fullSpan, {
                    cancelled: true
                });
            }
            return;
        }

        const model = createOpenModuleModel(text, syntax);
        if (treeSpan) {
            performance.end(treeSpan, {
                topLevelSymbols: model.symbolTree.children.length
            });
        }

        const indexSpan = performance?.enabled
            ? performance.start("analysis.index", {
                uri,
                version
            })
            : undefined;
        const indexed = this.index.updateOpenModuleModel(
            uri,
            model,
            version
        );
        if (indexSpan) {
            performance.end(indexSpan, {
                imports: indexed.imports.length
            });
        }
        this.parsedVersions.set(uri, version);
        /*
         * Folding/Outline уже привязаны к той же версии Fast Snapshot.
         * Повторная инвалидация после parser вызывала мерцание Structure и
         * заставляла заново проходить token stream сразу после Problems.
         */
        this.options.onParsed(indexed, wasKnown);

        const elapsed = Date.now() - started;
        if (fullSpan) {
            performance.end(fullSpan, {
                cancelled: false,
                imports: indexed.imports.length,
                topLevelSymbols: indexed.symbolTree.children.length
            });
        }

        if (elapsed >= this.slowParseLogMs) {
            this.options.log(
                `Slow parse: ${uri}; version=${version}; ` +
                `ms=${elapsed}; symbols=${indexed.symbolTree.children.length}`
            );
        }

        /*
         * Resource-настройки уже находятся в локальном snapshot. Планирование
         * Import не удерживает ensureParsed(), Ctrl+Click, Hover и Semantic
         * Tokens после того, как AST помещён в индекс.
         */
        this.refreshImportsAfterParse(
            uri,
            version,
            generation,
            indexed.imports
        );
    }

    private refreshImportsAfterParse(
        uri: string,
        version: number,
        generation: number,
        imports: readonly string[]
    ): void {
        const performance = this.options.performance;
        const span = performance?.enabled
            ? performance.start("analysis.importSettings", {
                uri,
                version,
                imports: imports.length
            })
            : undefined;

        const settings = this.settings.getAvailable(uri);
        const current = this.index.getCurrentModule(uri, version);
        const isCurrent = !!current &&
            this.parseGeneration.get(uri) === generation;

        if (isCurrent && settings.imports.enabled) {
            this.options.onImports(uri, imports);
        }

        if (span) {
            performance.end(span, {
                current: isCurrent,
                importsEnabled: settings.imports.enabled,
                source: "availableSnapshot"
            });
        }
    }

    private nextGeneration(uri: string): number {
        const generation = (this.parseGeneration.get(uri) || 0) + 1;
        this.parseGeneration.set(uri, generation);
        return generation;
    }

    private cancelTimer(uri: string): void {
        const timer = this.parseTimers.get(uri);

        if (timer) {
            clearTimeout(timer);
            this.parseTimers.delete(uri);
        }
    }

    private cancelQueued(uri: string): void {
        const task = this.queued.get(uri);
        if (!task) {
            return;
        }

        this.foregroundQueue = this.foregroundQueue.filter(
            item => item !== task
        );
        this.backgroundQueue = this.backgroundQueue.filter(
            item => item !== task
        );
        this.queued.delete(uri);
        task.resolve();
        this.notifyIdleIfSettled(uri);
    }
}

function yieldToEventLoop(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

function errorToString(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}\n${error.stack || ""}`;
    }

    return String(error);
}

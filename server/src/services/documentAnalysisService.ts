import type { TextDocuments } from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

import { createOpenModuleModel } from "../moduleModel";
import { monotonicMs } from "../core/timeSlice";
import {
    systemRslClock,
    type IRslClock,
    type IRslTimerHandle
} from "../core/clock";
import { RslSymbol } from "../symbols/rslSymbol";
import type { IRslLexResult } from "../lexer";
import { parseRslSyntax } from "../syntaxParser";
import {
    createRslModelBuild,
    tryUpdateRslParse,
    type IRslModelBuild,
    type IRslModelState
} from "./incrementalModel";
import type { RslSettingsService } from "./settingsService";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

import {
    createFastDocumentSnapshot,
    getFastDocumentSymbols,
    type IFastDocumentSnapshot
} from "./fastDocumentSnapshot";
import type { IRslRelexDecision } from "./incrementalLex";
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
 * Порог стоит там, где НЕразбитая работа ещё укладывается в бюджет блокировки
 * основного потока — около 30-40 мс. Без фаз блокировка равна сумме шагов, с
 * фазами — самому дорогому из них, и это разные величины (замеры на форме
 * «макросы и блоки», медиана из пяти прогонов):
 *
 *   размер    lex   parse  модель    сумма   макс. фаза
 *    100КБ    6мс    10мс     8мс     24мс         10мс
 *    125КБ    7мс    12мс    11мс     31мс         12мс
 *    150КБ   12мс     8мс    14мс     33мс         14мс
 *    200КБ   14мс    17мс    15мс     45мс         17мс
 *    400КБ   47мс    31мс    31мс    110мс         31мс
 *
 * Отсюда 100_000: до порога сумма не превышает ~24 мс, после него в бюджет
 * укладывается каждая отдельная фаза вплоть до 400КБ. Прежние 300_000
 * оставляли файлы 100-300КБ монолитными — то есть от 24 до 75 мс подряд.
 *
 * Ограничение: фазы бьют работу на три части, но не дробят их внутри. На файле
 * заметно больше 400КБ отдельная фаза снова выходит за бюджет, и для этого
 * нужен уже поблочный разбор.
 */
const PHASED_ANALYSIS_MIN_CHARS = 100_000;

/*
 * Сколько прерванных разборов разрешено держать.
 *
 * Каждая запись — это AST большого файла, то есть десятки мегабайт. Нужна она
 * ровно на время одного переключения вкладки: покинутый файл дочитывается в
 * фоне и точку освобождает. Двух хватает на «ушёл и сразу вернулся».
 */
const MAX_PHASE_CHECKPOINTS = 2;

/*
 * Порция сборки модели.
 *
 * Восемь миллисекунд — это половина кадра при 60 Гц: за такую задержку
 * ответ на нажатие клавиши не успевает стать заметным. Порция меньше
 * стоила бы дороже самой работы: между порциями поток идёт в event loop.
 */
const MODEL_SLICE_MS = 8;

export interface IDocumentAnalysisOptions {
    /**
     * Часы службы: задержки и текущее время.
     *
     * По умолчанию системные. Тесты расписания подставляют виртуальные и
     * двигают время сами: настоящее ожидание склейки правок стоило секунд.
     */
    clock?: IRslClock;
    changeDebounceMs?: number;
    slowParseLogMs?: number;
    initialParseDelayMs?: number;
    inactiveParseDelayMs?: number;
    /** Пауза в действиях пользователя, после которой можно работать в фоне. */
    backgroundQuietMs?: number;
    log(message: string): void;
    performance?: PerformanceLogger;
    invalidateProviderCaches(uri: string): void;
    onParsed(module: IIndexedModule, wasKnown: boolean): void;
    onImports(uri: string, imports: readonly string[]): void;
}

type AnalysisPriority = "foreground" | "background";

/**
 * Кто ждёт разбор и вправе ли он торопить его.
 *
 * `force` — запрос от действия пользователя; `scheduled` — запрос, который
 * редактор шлёт сам по ходу набора текста (см. ensureParsed).
 */
export type ParseWaitMode = "force" | "scheduled";

interface IValidationTask {
    document: TextDocument;
    generation: number;
    priority: AnalysisPriority;
    /** Когда задача встала в очередь: разница со стартом — ожидание слота. */
    queuedAtMs: number;
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
    /** Назначенный разбор и версия, ради которой он назначен. */
    private readonly clock: IRslClock;
    /**
     * Прошлое состояние модели открытого файла: основа точечной правки.
     *
     * Хранится одно на документ и заменяется следующей успешной
     * сборкой. Памяти это почти не добавляет: текст и дерево этой
     * версии всё равно держит модель, а неизменившиеся поддеревья и
     * объявления новое состояние берёт у прежнего по ссылке.
     */
    private modelStates = new Map<string, IRslModelState>();
    private parseTimers = new Map<string, {
        timer: IRslTimerHandle;
        version: number;
    }>();
    /** Отложенный прогрев Outline; проверяется на актуальность при старте. */
    private outlineTimers = new Map<string, NodeJS.Immediate>();
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
    /** Отсрочка разбора вкладки, которую покинули, не дождавшись debounce. */
    private inactiveParseDelayMs: number;
    /**
     * До какого момента считать, что пользователь работает.
     *
     * Разбор покинутого файла не выбрасывается, а откладывается — но
     * фиксированная отсрочка означала, что он всё равно стартует посреди
     * работы в другом файле и отбирает у неё процессор. Поэтому фоновая работа
     * ждёт не срок, а паузу: пока идёт ввод или навигация, она переносится.
     */
    private interactiveUntilMs = 0;
    private backgroundQuietMs: number;
    private activeDocumentUri: string | undefined;
    /**
     * Готовые фазы прерванного разбора: uri -> версия и её syntax.
     *
     * Разбор большого файла идёт фазами lex -> parse -> модель, и уход на
     * другую вкладку обрывает его между ними. Раньше вся работа выбрасывалась,
     * и при возвращении файл разбирался с нуля. Теперь дорогая середина
     * сохраняется: продолжение той же версии строит только модель.
     */
    private phaseCheckpoints = new Map<string, {
        version: number;
        syntax: ReturnType<typeof parseRslSyntax>;
        /**
         * Начатая сборка модели этой версии.
         *
         * Без неё продолжение считало модель заново полным путём — то
         * есть прерванная правка теряла всю выгоду точечного пути ровно
         * там, где пользователь и так ждал дольше обычного.
         */
        build: IRslModelBuild;
    }>();

    constructor(
        private documents: TextDocuments<TextDocument>,
        private index: WorkspaceIndex,
        private settings: RslSettingsService,
        private options: IDocumentAnalysisOptions
    ) {
        this.clock = options.clock ?? systemRslClock;
        this.changeDebounceMs = options.changeDebounceMs ?? 90;
        this.slowParseLogMs = options.slowParseLogMs ?? 75;
        this.initialParseDelayMs = options.initialParseDelayMs ?? 50;
        this.inactiveParseDelayMs = options.inactiveParseDelayMs ?? 400;
        this.backgroundQuietMs = options.backgroundQuietMs ?? 1500;
    }

    /**
     * Пользователь что-то сделал: ввод текста, переключение вкладки, запрос.
     *
     * Фоновый разбор после этого ждёт паузы. Активный документ отсрочка не
     * задевает: у него своя очередь и свой приоритет.
     */
    noteInteractiveActivity(): void {
        this.interactiveUntilMs = this.clock.now() + this.backgroundQuietMs;
    }

    /** Сколько ещё ждать тишины; 0 — можно работать. */
    private quietDelayMs(): number {
        return Math.max(0, this.interactiveUntilMs - this.clock.now());
    }

    /**
     * Откладывает готовые фазы, вытесняя самые старые.
     *
     * Контрольная точка держит AST целиком, и без предела их накопилось бы
     * столько, сколько файлов пользователь успел покинуть посреди разбора. Двух
     * достаточно: они нужны на время одного переключения, а не как кэш.
     */
    private rememberCheckpoint(
        uri: string,
        version: number,
        syntax: ReturnType<typeof parseRslSyntax>,
        build: IRslModelBuild
    ): void {
        this.phaseCheckpoints.delete(uri);
        this.phaseCheckpoints.set(uri, { version, syntax, build });

        while (this.phaseCheckpoints.size > MAX_PHASE_CHECKPOINTS) {
            const oldest = this.phaseCheckpoints.keys().next().value;

            if (oldest === undefined) {
                break;
            }
            this.phaseCheckpoints.delete(oldest);
        }
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
        /* Ввод текста — самый частый признак того, что пользователь работает. */
        this.noteInteractiveActivity();
        /*
         * Отложенные фазы относятся к прежней версии текста. Совпадение версий
         * их и так не пропустит, но AST прежней версии незачем держать в
         * памяти до закрытия файла.
         */
        this.phaseCheckpoints.delete(document.uri);
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

    /**
     * Разбор и модель с переиспользованием прошлой версии.
     *
     * Правка внутри тела процедуры меняет одну единицу верхнего уровня:
     * её дерево и объявления считаются заново, остальные берутся
     * готовыми. Любое сомнение — и работает полный путь, потому что
     * неверная модель недопустима.
     */
    private startModelBuild(
        uri: string,
        text: string,
        lex: IRslLexResult,
        version: number
    ): { syntax: ReturnType<typeof parseRslSyntax>; build: IRslModelBuild } {
        const performance = this.options.performance;
        const previous = this.modelStates.get(uri);
        const parsed = previous && tryUpdateRslParse(
            previous,
            text,
            lex,
            decision => performance?.mark?.(
                "analysis.incrementalParse",
                { uri, version, ...decision }
            )
        );

        if (parsed) {
            return {
                syntax: parsed.parse,
                build: createRslModelBuild({
                    text,
                    parse: parsed.parse,
                    lex,
                    previous,
                    splice: parsed.splice
                })
            };
        }

        const syntax = parseRslSyntax(text, lex, {
            buildExpressionTree: false
        });

        return {
            syntax,
            build: createRslModelBuild({ text, parse: syntax, lex })
        };
    }

    /**
     * Сборка модели порциями с возвратом управления.
     *
     * Пользователь чувствует не сумму времени, а самый длинный кусок, в
     * который поток занят непрерывно. Между порциями проверяется, нужна ли
     * ещё эта версия: собранная половина модели наружу не выходит.
     */
    private async finishModelBuild(
        uri: string,
        version: number,
        generation: number,
        build: IRslModelBuild,
        phased: boolean
    ): Promise<ReturnType<typeof createOpenModuleModel> | undefined> {
        while (build.step(MODEL_SLICE_MS)) {
            if (!phased) {
                continue;
            }

            await yieldToEventLoop();

            if (!this.stillCurrent(uri, version, generation)) {
                return undefined;
            }
        }

        const update = build.result();

        this.modelStates.set(uri, update.state);

        return update.model;
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
        /* Переключение вкладки — тоже работа пользователя, а не пауза. */
        this.noteInteractiveActivity();

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
         * Назначенный разбор при этом НЕ выбрасывается, а откладывается.
         * Раньше он снимался совсем, и правка, не дождавшаяся своего debounce,
         * пропадала: `правка в A → Ctrl+Click в B → возврат в A` заставлял
         * разбирать A заново, хотя разбор был уже назначен и оплачен.
         *
         * previousActiveUri исключён из отмены очереди ниже: секцией выше он
         * мог только что перейти из foreground в background в этом же вызове —
         * это файл, который пользователь только что редактировал, а не
         * "восстановленная, но не открытая" вкладка. Без этого исключения его
         * queued-задача отменялась бы немедленно, не дождавшись даже фонового
         * parse (баг воспроизводится тестом
         * testActiveDocumentSurvivesStaleWorkerContention).
         */
        for (const candidate of Array.from(this.parseTimers.keys())) {
            if (candidate === uri) {
                continue;
            }

            const pending = this.documents.get(candidate);
            this.cancelTimer(candidate);

            if (pending && !this.isLocalReady(pending)) {
                this.scheduleWithDelay(pending, this.inactiveParseDelayMs);
                continue;
            }

            this.notifyIdleIfSettled(candidate);
        }

        /*
         * Прогрев Outline покинутых вкладок снимается сразу. Он и сам
         * проверил бы активность при старте, но снятие экономит очередь
         * setImmediate при быстром переключении по многим файлам.
         */
        for (const candidate of Array.from(this.outlineTimers.keys())) {
            if (candidate !== uri) {
                this.cancelOutline(candidate);
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

        /*
         * Восстановленная неактивная вкладка до активации не лексировалась, но
         * подготовка Outline отложена на следующий тик.
         *
         * Раньше она шла здесь же, синхронно, и переключение вкладки стоило
         * полного lexRsl плюс сканирования объявлений. При переключении по
         * Ctrl+Tab это платилось за каждый файл, через который пользователь
         * лишь прошёл: на замере 12 файлов по 200КБ — 12 × ~100 мс основного
         * потока, то есть больше секунды, в которую не отвечали ни таймеры, ни
         * LSP. Отсюда и «структура появляется с задержкой»: очередь тут ни при
         * чём, работа выполнялась прямо в обработчике переключения.
         */
        this.scheduleOutline(document);

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

    /**
     * Разбор запрошен, но debounce не снимается.
     *
     * Так ведёт себя всё, что редактор шлёт сам, без действия пользователя:
     * Semantic Tokens и Inlay Hints приходят сразу за каждым нажатием клавиши.
     * Форсируя разбор, они превращали 90-мс склейку правок в разбор на каждый
     * символ — по замеру 1 мс вместо 107 мс до разбора, то есть debounce не
     * работал вовсе.
     *
     * Если разбор этой версии уже запланирован — не делается ничего: таймер
     * отработает сам. Планирование нужно для неактивной вкладки, где таймера
     * нет и запрос иначе ждал бы разбора, который никто не начнёт.
     */
    requestParse(document: TextDocument): void {
        if (this.isLocalReady(document) || this.hasPendingWorkFor(document)) {
            return;
        }

        this.scheduleWithDelay(document, this.changeDebounceMs);
    }

    /**
     * Готовая модель этой версии.
     *
     * `force` — за запросом стоит действие пользователя (переход к объявлению,
     * переименование, Hover): ждать здесь debounce значит заставить его ждать
     * без причины.
     *
     * `scheduled` — запрос пришёл по ходу набора текста. Он дожидается уже
     * запланированного разбора, но не приближает его: иначе склейка правок
     * снимается тем же запросом, ради которого делается.
     */
    async ensureParsed(
        document: TextDocument,
        mode: ParseWaitMode = "force"
    ): Promise<RslSymbol | undefined> {
        if (this.isLocalReady(document)) {
            return this.index.getModule(document.uri)?.symbolTree;
        }

        if (mode === "scheduled" && this.isBusyFor(document.uri)) {
            await this.whenIdle(document.uri);
            return this.isLocalReady(document)
                ? this.index.getModule(document.uri)?.symbolTree
                : undefined;
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
        this.phaseCheckpoints.delete(uri);
        /* Прошлое состояние модели нужно только открытому файлу. */
        this.modelStates.delete(uri);
        this.fastSnapshots.delete(uri);
        this.openedVersions.delete(uri);
        this.parsedVersions.delete(uri);
        this.nextGeneration(uri);
        this.index.compactModule(uri);
        this.notifyIdleIfSettled(uri);
    }

    invalidate(uri: string): void {
        this.cancelQueued(uri);
        this.cancelOutline(uri);
        this.phaseCheckpoints.delete(uri);
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
        let decision: IRslRelexDecision | undefined;
        const snapshot = createFastDocumentSnapshot(
            document,
            this.fastSnapshots.get(document.uri),
            value => {
                decision = value;
            }
        );
        if (span) {
            performance.end(span, {
                tokens: snapshot.lex.tokens.length,
                /* Почему lex пошёл полным путём, а не точечным. */
                lexReason: decision?.reason,
                editStart: decision?.editStart,
                editLine: decision?.editLine,
                shiftedFraction: decision?.shiftedFraction,
                windowChars: decision?.windowChars
            });
        }
        this.fastSnapshots.set(document.uri, snapshot);
        this.options.invalidateProviderCaches(document.uri);
        return snapshot;
    }

    /**
     * Откладывает подготовку Outline и на старте проверяет, нужна ли она.
     *
     * Если к моменту запуска пользователь ушёл на другую вкладку, работа
     * пропускается: Outline закрытой или покинутой вкладки редактор не
     * показывает, а стоит она полного сканирования файла. Запрос
     * textDocument/documentSymbol в любом случае построит её сам через
     * getFastSnapshot, поэтому это предварительный прогрев, а не обязательство.
     */
    private scheduleOutline(document: TextDocument): void {
        const uri = document.uri;
        const version = document.version;

        if (this.outlineTimers.has(uri)) {
            return;
        }

        const timer = setImmediate(() => {
            this.outlineTimers.delete(uri);
            const current = this.documents.get(uri);

            if (
                !current ||
                current.version !== version ||
                uri !== this.activeDocumentUri
            ) {
                this.options.performance?.mark?.("analysis.outlineSkipped", {
                    uri,
                    version,
                    reason: !current
                        ? "documentClosed"
                        : current.version !== version
                            ? "supersededVersion"
                            : "notActive"
                });
                return;
            }

            const snapshot = this.getFastSnapshot(current);

            if (snapshot.symbols === undefined) {
                this.prepareOutline(current, snapshot);
            }
        });

        this.outlineTimers.set(uri, timer);
    }

    private cancelOutline(uri: string): void {
        const timer = this.outlineTimers.get(uri);

        if (timer) {
            clearImmediate(timer);
            this.outlineTimers.delete(uri);
        }
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

        const timer = this.clock.setTimeout(() => {
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

            /*
             * Фоновая работа переносится, пока пользователь работает.
             *
             * Иначе разбор покинутого файла стартует ровно посреди работы в
             * новом и отбирает у неё процессор — при том, что результат никто
             * не ждёт. Перенос повторяется, поэтому «через 400 мс» превратилось
             * в «на первой же паузе».
             */
            const quiet = priority === "background" ? this.quietDelayMs() : 0;

            if (quiet > 0) {
                this.options.performance?.mark?.("analysis.deferred", {
                    uri,
                    version,
                    reason: "userActive",
                    waitMs: quiet
                });
                this.scheduleWithDelay(current, quiet);
                return;
            }

            this.startValidation(current, generation, priority).catch(error => {
                this.options.log(
                    `Validation failed: ${uri}\n${errorToString(error)}`
                );
            });
        }, Math.max(0, delay));

        this.parseTimers.set(uri, { timer, version });
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
            queuedAtMs: Date.now(),
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

        /*
         * Актуальность задачи проверяется в момент старта, а не только при
         * постановке в очередь.
         *
         * Пока задача стояла в очереди, файл могли закрыть или изменить, и
         * разбор его прежней версии — это чистая блокировка основного потока:
         * до фазового порога (PHASED_ANALYSIS_MIN_CHARS) разбор идёт одним
         * куском и никого не пускает вперёд. Раньше такая проверка стояла
         * только внутри разбора больших файлов, поэтому обычные файлы
         * разбирались до конца, даже когда результат уже никому не нужен.
         *
         * Признак «файл сейчас неактивен» здесь НЕ используется намеренно:
         * ensureParsed вызывают LSP-обработчики для файла, который им нужен
         * прямо сейчас, и он не обязан быть активным. Пропуск по неактивности
         * молча возвращал бы им undefined.
         */
        const stale = this.staleTaskReason(task);

        if (stale) {
            this.options.performance?.mark?.("analysis.skipped", {
                uri,
                version: task.document.version,
                reason: stale
            });
            this.finishValidation(task, true);
            return;
        }

        this.options.performance?.mark?.("analysis.dequeued", {
            uri,
            version: task.document.version,
            priority: task.priority,
            /* Ожидание слота: сколько задача простояла в очереди. */
            queueWaitMs: Date.now() - task.queuedAtMs
        });

        Promise.resolve()
            .then(() => this.validate(task.document, task.generation))
            .then(
                () => this.finishValidation(task, true),
                error => this.finishValidation(task, false, error)
            );
    }

    /** Причина не начинать разбор, либо undefined. */
    private staleTaskReason(task: IValidationTask): string | undefined {
        const uri = task.document.uri;
        const current = this.documents.get(uri);

        if (!current) {
            return "documentClosed";
        }

        if (this.isLocalReady(task.document)) {
            return "alreadyParsed";
        }

        return this.stillCurrent(
            uri,
            task.document.version,
            task.generation
        )
            ? undefined
            : "supersededVersion";
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

        const started = monotonicMs();
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

        /* Отсюда и до следующего возврата управления поток занят непрерывно. */
        let blockingSinceMs = monotonicMs();

        /*
         * Продолжение прерванного разбора: syntax этой версии уже посчитан.
         * Повторять самую дорогую фазу незачем — она не зависит ни от того,
         * какая вкладка активна, ни от того, кто заказал разбор.
         */
        const checkpoint = this.phaseCheckpoints.get(uri);
        const resumed = checkpoint?.version === version;
        const phase = resumed
            ? { syntax: checkpoint!.syntax, build: checkpoint!.build }
            : this.startModelBuild(uri, text, fastSnapshot.lex, version);
        const syntax = phase.syntax;

        if (resumed) {
            performance?.mark?.("analysis.resumed", {
                uri,
                version,
                phase: "symbolTree"
            });
        }

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
                parserDiagnostics: syntax.diagnostics.length,
                resumed,
                blockingMs: blockingMs(blockingSinceMs)
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
            /*
             * Точка, где разбор чаще всего и обрывают: parse позади, модели
             * ещё нет. Результат откладывается ДО паузы — иначе проверка ниже
             * выйдет, и посчитанное пропадёт.
             */
            this.rememberCheckpoint(uri, version, syntax, phase.build);
            await yieldToEventLoop();
            blockingSinceMs = monotonicMs();
        }

        if (!this.stillCurrent(uri, version, generation)) {
            if (fullSpan) {
                performance.end(fullSpan, {
                    cancelled: true,
                    checkpoint: phased
                });
            }
            return;
        }

        /*
         * Модель собирается здесь, а не вместе с разбором: между фазами
         * поток возвращается редактору, и прерванная сборка продолжается с
         * того же места — по контрольной точке.
         */
        const model = await this.finishModelBuild(
            uri,
            version,
            generation,
            phase.build,
            phased
        );

        if (!model) {
            if (fullSpan) {
                performance.end(fullSpan, {
                    cancelled: true,
                    checkpoint: phased
                });
            }

            return;
        }

        this.phaseCheckpoints.delete(uri);
        if (treeSpan) {
            performance.end(treeSpan, {
                topLevelSymbols: model.symbolTree.children.length,
                blockingMs: blockingMs(blockingSinceMs)
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

        const elapsed = monotonicMs() - started;
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
        const pending = this.parseTimers.get(uri);

        if (pending) {
            this.clock.clearTimeout(pending.timer);
            this.parseTimers.delete(uri);
        }
    }

    /**
     * Разбор ИМЕННО ЭТОЙ версии уже назначен, идёт или стоит в очереди.
     *
     * Отличается от isBusyFor тем, что смотрит на версию. Назначенный разбор
     * может относиться к прежнему тексту: вкладку покинули, разбор отложили, а
     * потом файл изменили. Такая занятость не означает, что новую версию
     * кто-то разберёт, — планировать её всё равно нужно.
     */
    private hasPendingWorkFor(document: TextDocument): boolean {
        const uri = document.uri;
        const timer = this.parseTimers.get(uri);

        if (timer) {
            return timer.version === document.version;
        }

        const queued = this.queued.get(uri);

        if (queued) {
            return queued.document.version === document.version;
        }

        return this.running.has(uri);
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

/**
 * Сколько подряд фаза держала основной поток.
 *
 * Именно эта величина видна пользователю как «редактор не отвечает»: сумма
 * длительностей ни о чём не говорит, если между ними управление возвращалось.
 * Считается по времени между возвратами.
 */
function blockingMs(sinceMs: number): number {
    return monotonicMs() - sinceMs;
}

function errorToString(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}\n${error.stack || ""}`;
    }

    return String(error);
}

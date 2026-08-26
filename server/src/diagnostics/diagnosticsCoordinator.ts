import type {
    Connection,
    TextDocuments
} from "vscode-languageserver/node";
import type { Diagnostic } from "vscode-languageserver";
import type { TextDocument } from "vscode-languageserver-textdocument";

import type { RslDiagnosticEngine } from "./diagnosticEngine";
import {
    type IDiagnosticPublication,
    planActiveDocumentDiagnostics,
    planUpdatedDiagnostics,
    resolveActiveDocumentUri
} from "./diagnosticVisibility";
import type { RslSettingsService } from "../services/settingsService";
import type { RslScopeResolver } from "../scopeResolver";
import type { WorkspaceIndex } from "../workspaceIndex";
import {
    normalizeDiagnosticSettings,
    type RslDiagnosticStageObserver
} from "../diagnostics";
import type { PerformanceLogger } from "../performanceLogger";
import type { IRslSettings } from "../interfaces";
import {
    systemRslClock,
    type IRslClock,
    type IRslTimerHandle
} from "../core/clock";

export interface IDiagnosticsCoordinatorOptions {
    isParseBusy(uri: string): boolean;
    /** Разрешается, когда parse для uri перестаёт быть busy. */
    waitForIdle(uri: string): Promise<void>;
    log(message: string): void;
    performance?: PerformanceLogger;
    onImports(uri: string, imports: readonly string[]): void;
    /**
     * Общий resolver сервера.
     *
     * Только у него есть каталог прикладных модулей, а от каталога зависит,
     * считается ли Import-контекст полным.
     */
    resolver?: RslScopeResolver;
    /**
     * Часы службы: задержки и текущее время.
     *
     * По умолчанию системные. Тесты расписания подставляют виртуальные и
     * двигают время сами — иначе проверка склейки правок и пауз стоит
     * секунд реального ожидания на каждый случай.
     */
    clock?: IRslClock;
    localDebounceMs?: number;
    largeLocalDebounceMs?: number;
    workspaceDebounceMs?: number;
    workspaceMaxWaitMs?: number;
    slowDiagnosticsLogMs?: number;
}

/**
 * Двухфазная публикация Problems: local считается по самому файлу,
 * workspace обновляет результат вторым пакетом.
 *
 * «По самому файлу» не значит «независимо от импортов». Проверка
 * необъявленной переменной признаёт объявлением и переменную
 * импортированного модуля, поэтому состояние Import-контекста входит в
 * ключ локальной фазы: пока модуль читается, находки не публикуются, а
 * после чтения ключ меняется и файл пересчитывается. Без этого ложная
 * ошибка держалась до следующей правки, и результат зависел от того,
 * успел ли модуль загрузиться.
 */
/*
 * Срок межфайловой фазы, когда Import-граф уже полон.
 *
 * Ждать нечего: модули прочитаны, и проверки считаются по готовому индексу.
 * Небольшая задержка остаётся только чтобы склеить несколько правок подряд —
 * сам разбор к этому моменту уже отработал свою склейку.
 */
const READY_WORKSPACE_DELAY_MS = 60;

/*
 * Сколько локальная фаза ждёт межфайловую, прежде чем опубликовать своё.
 *
 * Ждать приходится потому, что межфайловые находки после правки нельзя ни
 * показать, ни молча убрать. Показать — значит соврать: `unused-import`
 * зависит от всего текста файла, и добавленный ниже вызов делает находку
 * неверной, хотя её диапазон не сдвинулся. Убрать — значит мигнуть
 * подчёркиванием и вернуть его через мгновение.
 *
 * Поэтому публикация правленого текста ждёт пересчёта — но не дольше этого
 * срока: если межфайловая фаза не успела, список выходит без её находок.
 */
const WORKSPACE_HOLD_MS = 300;

export class DiagnosticsCoordinator {
    private localTimers = new Map<string, IRslTimerHandle>();
    private workspaceTimers = new Map<string, IRslTimerHandle>();
    private workspaceFirstScheduled = new Map<string, number>();
    /** Отложенные публикации, ждущие межфайловую фазу. */
    private workspaceHolds = new Map<string, IRslTimerHandle>();
    private localCache = new Map<string, Diagnostic[]>();
    /**
     * Межфайловый результат вместе с текстом, по которому он посчитан.
     *
     * Текст нужен, чтобы понять, относится ли результат к тому, что сейчас в
     * редакторе. Ответ межфайловых проверок зависит от всего текста файла:
     * `unused-import` перестаёт быть верным от вызова, добавленного в любом
     * месте ниже. Поэтому правленому тексту достаётся не часть прежних
     * находок, а пересчёт.
     */
    private workspaceCache = new Map<string, {
        source: string;
        version: number;
        /** Условия расчёта: настройки, диалект и Import-замыкание. */
        key: string;
        diagnostics: Diagnostic[];
    }>();
    private localKeys = new Map<string, string>();
    private workspaceKeys = new Map<string, string>();
    private publishedSignatures = new Map<string, string>();
    private staleLocal = new Set<string>();
    private staleWorkspace = new Set<string>();
    private maxProblems = new Map<string, number>();
    private activeDocumentUri: string | undefined;
    private localDebounceMs: number;
    private largeLocalDebounceMs: number;
    private workspaceDebounceMs: number;
    private workspaceMaxWaitMs: number;
    private slowDiagnosticsLogMs: number;
    private clock: IRslClock;

    constructor(
        private connection: Connection,
        private documents: TextDocuments<TextDocument>,
        private index: WorkspaceIndex,
        private settings: RslSettingsService,
        private engine: RslDiagnosticEngine,
        private options: IDiagnosticsCoordinatorOptions
    ) {
        this.clock = options.clock ?? systemRslClock;
        this.localDebounceMs = options.localDebounceMs ?? 180;
        this.largeLocalDebounceMs = options.largeLocalDebounceMs ?? 350;
        this.workspaceDebounceMs = options.workspaceDebounceMs ?? 700;
        this.workspaceMaxWaitMs = options.workspaceMaxWaitMs ?? 1800;
        this.slowDiagnosticsLogMs = options.slowDiagnosticsLogMs ?? 100;
    }

    setActiveDocument(uri: string | null | undefined): void {
        const next = resolveActiveDocumentUri(
            this.activeDocumentUri,
            uri,
            this.getOpenUris()
        );

        if (this.activeDocumentUri === next) {
            return;
        }

        const previous = this.activeDocumentUri;
        this.activeDocumentUri = next;

        if (previous && previous !== next) {
            this.cancelLocal(previous);
            this.cancelWorkspaceTimer(previous);
            this.workspaceFirstScheduled.delete(previous);
        }

        if (next) {
            this.publishPlan(planActiveDocumentDiagnostics(
                next,
                this.getOpenUris(),
                this.getCombinedCache()
            ));
            if (!this.localCache.has(next) || this.staleLocal.has(next)) {
                this.scheduleLocal(next, 0);
            }
            if (!this.workspaceCache.has(next) || this.staleWorkspace.has(next)) {
                this.scheduleWorkspace(next, 300);
            }
        } else {
            this.showAllCached();
        }
    }

    /** Совместимый вызов после parse: обе фазы, но с разными сроками. */
    schedule(uri: string): void {
        this.scheduleLocal(uri);
        this.scheduleWorkspace(uri);
    }

    scheduleLocal(uri: string, delay?: number): void {
        /*
         * Проверки выключены: список пустеет сразу, а не после того, как
         * пересчёт дойдёт до этого файла. Заодно освобождается кэш —
         * держать в нём находки, которые никому не покажут, незачем.
         */
        if (this.diagnosticsDisabled(uri)) {
            this.cancel(uri);
            this.localCache.delete(uri);
            this.workspaceCache.delete(uri);
            this.localKeys.delete(uri);
            this.workspaceKeys.delete(uri);
            this.sendIfChanged(uri, []);
            return;
        }

        this.staleLocal.add(uri);
        if (!this.isActive(uri)) {
            this.cancelLocal(uri);
            return;
        }

        this.cancelLocal(uri);
        const actualDelay = delay === undefined
            ? this.getLocalDelay(uri)
            : Math.max(0, delay);
        this.localTimers.set(uri, this.clock.setTimeout(() => {
            this.localTimers.delete(uri);
            this.runLocal(uri).catch(error => this.logFailure("Local", uri, error));
        }, actualDelay));
    }

    scheduleWorkspace(uri: string, delay?: number): void {
        this.staleWorkspace.add(uri);
        if (!this.isActive(uri)) {
            this.cancelWorkspaceTimer(uri);
            return;
        }

        const now = Date.now();
        const first = this.workspaceFirstScheduled.get(uri) ?? now;
        this.workspaceFirstScheduled.set(uri, first);
        const requestedAt = now + Math.max(
            0,
            delay ?? this.getWorkspaceDelay(uri)
        );
        const deadline = first + this.workspaceMaxWaitMs;
        const actualDelay = Math.max(0, Math.min(requestedAt, deadline) - now);

        this.cancelWorkspaceTimer(uri);
        this.workspaceTimers.set(uri, this.clock.setTimeout(() => {
            this.workspaceTimers.delete(uri);
            this.runWorkspace(uri).catch(error =>
                this.logFailure("Workspace", uri, error)
            );
        }, actualDelay));
    }

    cancel(uri: string): void {
        this.cancelLocal(uri);
        this.cancelWorkspaceTimer(uri);
        this.workspaceFirstScheduled.delete(uri);
        /* Отложенная публикация тоже отменяется: ждать больше нечего. */
        this.releaseHold(uri);
    }

    close(uri: string): void {
        this.cancel(uri);
        this.engine.forget(uri);
        this.localCache.delete(uri);
        this.workspaceCache.delete(uri);
        this.localKeys.delete(uri);
        this.workspaceKeys.delete(uri);
        this.staleLocal.delete(uri);
        this.staleWorkspace.delete(uri);
        this.maxProblems.delete(uri);
        this.sendIfChanged(uri, []);
        this.publishedSignatures.delete(uri);

        if (this.activeDocumentUri === uri) {
            this.activeDocumentUri = undefined;
            this.showAllCached();
        }
    }

    refreshAll(): void {
        for (const document of this.documents.all()) {
            this.staleLocal.add(document.uri);
            this.staleWorkspace.add(document.uri);
        }
        if (this.activeDocumentUri) {
            this.scheduleLocal(this.activeDocumentUri, 0);
            this.scheduleWorkspace(this.activeDocumentUri, 250);
        }
    }

    getCached(uri: string): readonly Diagnostic[] | undefined {
        const result = this.combine(uri);
        return result.length > 0 || this.localCache.has(uri) || this.workspaceCache.has(uri)
            ? result
            : undefined;
    }

    private async runLocal(uri: string): Promise<void> {
        await yieldToInteractiveRequests();
        if (this.options.isParseBusy(uri)) {
            await this.options.waitForIdle(uri);
        }

        const state = this.getCurrentState(uri);
        if (!state) {
            return;
        }

        /*
         * Актуальность проверяется на старте задачи, а не только при её
         * постановке: между ними были await, и за это время пользователь мог
         * перейти в другой файл. Расчёт покинутого файла — это чужое время
         * перед тем, которое ждёт пользователь.
         *
         * Результат не теряется: staleLocal остаётся, и при возврате в файл
         * setActiveDocument поставит расчёт заново.
         */
        if (!this.isActive(uri)) {
            this.cancel(uri);

            /*
             * Import сообщаем всё равно: загрузка импортированных модулей
             * нужна независимо от того, на какой файл смотрит пользователь, и
             * отменять её из-за переключения вкладки значило бы каждый раз
             * начинать индексацию заново.
             */
            if (state.settings.imports.enabled) {
                this.options.onImports(uri, state.module.imports);
            }
            return;
        }

        const key = this.localConditionKey(uri, state);
        this.maxProblems.set(uri, state.settings.diagnostics?.maxProblems ?? 200);

        if (this.localKeys.get(uri) !== key || !this.localCache.has(uri)) {
            /*
             * Межфайловый результат остаётся показанным до нового.
             *
             * Прежде он удалялся здесь же: локальная фаза заканчивалась
             * первой, публиковала свой список без него — и актуальная
             * межфайловая ошибка исчезала из Problems на время, пока считалась
             * межфайловая фаза, а потом появлялась снова. Пользователь читает
             * это как «ошибка то есть, то нет».
             *
             * Устаревшим он от правки не становится: правка в одном месте
             * файла не отменяет неиспользуемый Import в другом. Ключ
             * межфайловой фазы всё равно не совпадёт, и она пересчитает его
             * заново — просто не оставив дырки.
             */
            this.workspaceKeys.delete(uri);
            this.staleWorkspace.add(uri);
            const started = Date.now();
            const performance = this.options.performance;
            const span = performance?.enabled
                ? performance.start("diagnostics.local", {
                    uri,
                    version: state.module.version,
                    chars: state.module.sourceLength
                })
                : undefined;
            const importKey = this.importContextKey(uri);
            const isCancelled = this.cancelWhenLeftBehind(
                uri,
                state.module.version,
                importKey
            );
            const stages = this.watchStages(span !== undefined);
            const diagnostics = await this.engine.buildLocalAsync(
                state.module,
                this.index,
                state.settings.diagnostics,
                isCancelled,
                this.options.resolver,
                stages.observer
            );

            /*
             * Расчёт шёл порциями, и за это время файл могли покинуть или
             * изменить. Результат прерванного расчёта неполон, поэтому в кэш он
             * не попадает: staleLocal остаётся, и при возврате в файл расчёт
             * начнётся заново.
             *
             * Import при этом сообщается всё равно — как и при отмене до начала
             * расчёта: загрузка импортированных модулей нужна независимо от
             * того, на какой файл смотрит пользователь.
             */
            if (isCancelled()) {
                if (span) {
                    performance.end(span, { diagnostics: 0 });
                }
                if (state.settings.imports.enabled) {
                    this.options.onImports(uri, state.module.imports);
                }

                /*
                 * Отмена из-за дочитанных импортов — единственная, у которой
                 * нет своего повода вернуться: файл не менялся и не покинут.
                 * Ставим расчёт заново сами, иначе Problems остались бы от
                 * прошлого состояния графа модулей до следующей правки.
                 */
                if (this.importContextKey(uri) !== importKey) {
                    this.staleLocal.add(uri);
                    this.scheduleLocal(uri, 0);
                }

                return;
            }
            if (span) {
                performance.end(span, {
                    diagnostics: diagnostics.length,
                    ...stages.fields()
                });
            }
            /*
             * Условия проверяются ещё раз перед записью: между началом и
             * концом порционной работы импорты могли дочитаться, и тогда
             * этот результат посчитан по прошлому состоянию.
             */
            if (this.localConditionKey(uri, state) !== key) {
                this.staleLocal.add(uri);
                this.scheduleLocal(uri, 0);
                return;
            }

            this.localCache.set(uri, diagnostics);
            this.localKeys.set(uri, key);
            this.logSlow("local", uri, state.module.version, started);
        }

        this.staleLocal.delete(uri);

        if (this.workspaceResultIsStale(uri)) {
            /*
             * Межфайловые находки прошлого текста показывать нельзя, а
             * публиковать список без них — значит погасить подчёркивание и
             * зажечь его снова. Публикация ждёт пересчёта.
             */
            this.holdForWorkspace(uri);
        } else {
            await this.publishWhenStillActive(uri);
        }

        if (state.settings.imports.enabled) {
            this.options.onImports(uri, state.module.imports);
        }
    }

    private async runWorkspace(uri: string): Promise<void> {
        await yieldToInteractiveRequests();
        if (this.options.isParseBusy(uri)) {
            await this.options.waitForIdle(uri);
        }

        const state = this.getCurrentState(uri);
        if (!state) {
            return;
        }

        /*
         * Межфайловая фаза дороже локальной, и отменять её для покинутого файла
         * тем важнее: именно она заставляет ждать активный документ.
         */
        if (!this.isActive(uri)) {
            this.cancel(uri);
            return;
        }

        const key = this.workspaceConditionKey(
            uri,
            state.module.version
        );
        this.maxProblems.set(uri, state.settings.diagnostics?.maxProblems ?? 200);

        if (this.workspaceKeys.get(uri) !== key || !this.workspaceCache.has(uri)) {
            const started = Date.now();
            const performance = this.options.performance;
            const span = performance?.enabled
                ? performance.start("diagnostics.workspace", {
                    uri,
                    version: state.module.version,
                    chars: state.module.sourceLength
                })
                : undefined;
            const isCancelled = this.cancelWhenLeftBehind(
                uri,
                state.module.version
            );
            const stages = this.watchStages(span !== undefined);
            const diagnostics = await this.engine.buildWorkspaceAsync(
                state.module,
                this.index,
                state.settings.diagnostics,
                isCancelled,
                this.options.resolver,
                stages.observer
            );

            /* Неполный результат прерванной фазы в кэш не попадает. */
            if (isCancelled()) {
                if (span) {
                    performance.end(span, {
                        diagnostics: 0,
                        indexedModules: this.index.size
                    });
                }
                return;
            }
            if (span) {
                performance.end(span, {
                    diagnostics: diagnostics.length,
                    indexedModules: this.index.size,
                    ...stages.fields()
                });
            }
            this.workspaceCache.set(uri, {
                source: state.module.source,
                version: state.module.version,
                key,
                diagnostics
            });
            this.workspaceKeys.set(uri, key);
            this.logSlow("workspace", uri, state.module.version, started);
        }

        this.workspaceFirstScheduled.delete(uri);
        this.staleWorkspace.delete(uri);
        this.releaseHold(uri);
        await this.publishWhenStillActive(uri);
    }

    /**
     * Публикует результат, дав сначала разобрать накопившиеся сообщения LSP.
     *
     * Расчёт диагностики синхронный, поэтому уведомление о смене активного
     * файла всё это время лежит в очереди событий необработанным. Без возврата
     * управления публикация успевала пройти раньше него, и Problems покинутого
     * файла всплывали в панели, а через мгновение гасились уже обработанным
     * переключением — заметное мигание чужого списка перед нужным.
     *
     * Возврат управления делает публикацию согласованной: если переключение
     * уже пришло, planUpdatedDiagnostics отдаст по этому файлу пустой список,
     * а сам результат останется в кэше до возвращения в файл.
     */
    /**
     * Условие «расчёт больше не нужен» для этапов диагностики.
     *
     * Причин три: пользователь ушёл в другой файл, документ изменился
     * либо во время порционного расчёта дочитались импорты (importKey).
     * В последнем случае результат посчитан по промежуточному состоянию:
     * опубликовать его — значит показать ошибку, которой в готовом графе
     * модулей уже нет, и убрать её только следующим расчётом.
     *
     * Проверка обязана быть дешёвой: она вызывается между каждыми двумя
     * этапами. Ключ импортов — строка из ревизий, и она кэширована.
     */
    private cancelWhenLeftBehind(
        uri: string,
        version: number,
        importKey?: string
    ): () => boolean {
        return () => !this.isActive(uri) ||
            this.documents.get(uri)?.version !== version ||
            (importKey !== undefined &&
                this.importContextKey(uri) !== importKey);
    }

    private async publishWhenStillActive(uri: string): Promise<void> {
        await yieldToInteractiveRequests();
        this.publishCombined(uri);
    }

    private getCurrentState(uri: string): {
        document: TextDocument;
        module: NonNullable<ReturnType<WorkspaceIndex["getModule"]>>;
        settings: IRslSettings;
    } | undefined {
        const document = this.documents.get(uri);
        const module = document &&
            this.index.getCurrentModule(uri, document.version);
        if (!document || !module) {
            return undefined;
        }
        return {
            document,
            module,
            settings: this.settings.getAvailable(uri)
        };
    }

    private publishCombined(uri: string): void {
        const diagnostics = this.combine(uri);
        this.publishPlan(planUpdatedDiagnostics(
            this.activeDocumentUri,
            uri,
            diagnostics,
            this.getOpenUris()
        ));
    }

    private combine(uri: string): Diagnostic[] {
        const limit = Math.max(0, this.maxProblems.get(uri) ?? 200);
        if (limit === 0) {
            return [];
        }
        const result: Diagnostic[] = [];
        const seen = new Set<string>();
        for (const item of [
            ...(this.localCache.get(uri) || []),
            ...this.transferableWorkspaceDiagnostics(uri)
        ]) {
            const key = diagnosticItemKey(item);
            if (!seen.has(key)) {
                seen.add(key);
                result.push(item);
                if (result.length >= limit) {
                    break;
                }
            }
        }
        return result;
    }

    private getCombinedCache(): Map<string, Diagnostic[]> {
        const result = new Map<string, Diagnostic[]>();
        for (const document of this.documents.all()) {
            if (this.localCache.has(document.uri) || this.workspaceCache.has(document.uri)) {
                result.set(document.uri, this.combine(document.uri));
            }
        }
        return result;
    }

    /**
     * Срок межфайловой фазы: короткий, когда ждать больше нечего.
     *
     * Длинная задержка нужна ровно для одного — не считать межфайловые
     * проверки по недочитанному Import-графу, пока модули догружаются. Когда
     * граф уже полон, ждать нечего: проверки по готовому индексу считаются
     * сразу, и ошибка исчезает из Problems сразу за правкой, а не через
     * секунду.
     */
    private getWorkspaceDelay(uri: string): number {
        const state = this.options.resolver?.getImportContextState(uri);

        if (state && state.completeness === "complete") {
            return Math.min(this.workspaceDebounceMs, READY_WORKSPACE_DELAY_MS);
        }

        return this.workspaceDebounceMs;
    }

    private getLocalDelay(uri: string): number {
        const length = this.index.getModule(uri)?.sourceLength || 0;
        return length >= 150000 ? this.largeLocalDebounceMs : this.localDebounceMs;
    }

    private showAllCached(): void {
        for (const document of this.documents.all()) {
            const diagnostics = this.getCached(document.uri);
            if (diagnostics) {
                this.sendIfChanged(document.uri, diagnostics.slice());
            }
        }
    }

    /**
     * Межфайловые находки, которые можно показать вместе с текущим текстом.
     *
     * Только посчитанные по этому самому тексту. Перенос «по неизменившемуся
     * началу файла» сохранял бы диапазон, но не смысл: `unused-import`,
     * `redundant-import` и проверки необъявленных имён смотрят на весь файл,
     * и добавленный ниже вызов делает прежнюю находку неверной, ничего в её
     * диапазоне не сдвинув.
     *
     * Мерцание при этом закрывается не переносом, а ожиданием: см.
     * holdForWorkspace.
     */
    private transferableWorkspaceDiagnostics(
        uri: string
    ): readonly Diagnostic[] {
        const entry = this.workspaceCache.get(uri);

        if (!entry) {
            return [];
        }

        const module = this.index.getModule(uri);

        if (!module) {
            return entry.diagnostics;
        }

        /*
         * Показывать можно только результат, посчитанный по этому тексту И
         * при этих условиях. Настройки проверок, диалект и состав
         * Import-замыкания меняют ответ так же, как правка: снятая галочка
         * иначе оставляла бы `unused-import` висеть до следующего
         * пересчёта.
         */
        return module.source === entry.source &&
            this.workspaceConditionKey(uri, module.version) === entry.key
            ? entry.diagnostics
            : [];
    }

    /** Условия расчёта межфайловой фазы: версия, замыкание, настройки. */
    private workspaceConditionKey(uri: string, version: number): string {
        return [
            version,
            this.index.getImportClosureKey(uri),
            diagnosticsSettingsKey(this.settings.getAvailable(uri))
        ].join(":");
    }

    /** Условия расчёта локальной фазы: версия, импорты, настройки. */
    private localConditionKey(
        uri: string,
        state: { module: { version: number }; settings: IRslSettings }
    ): string {
        return [
            state.module.version,
            this.importContextKey(uri),
            diagnosticsSettingsKey(state.settings)
        ].join(":");
    }

    /**
     * Состояние импортов файла одной строкой.
     *
     * Замыкание .mac плюс ревизия каталога прикладных модулей: состав
     * модуля читается отдельно от файлов проекта, и без ревизии его
     * появление ключ не меняло бы.
     */
    private importContextKey(uri: string): string {
        return this.options.resolver
            ? this.options.resolver.getImportContextKey(uri)
            : this.index.getImportClosureKey(uri);
    }

    /** Есть ли межфайловый результат, посчитанный по прошлому тексту. */
    private workspaceResultIsStale(uri: string): boolean {
        const entry = this.workspaceCache.get(uri);
        const current = this.index.getModule(uri)?.source;

        return entry !== undefined &&
            current !== undefined &&
            current !== entry.source &&
            entry.diagnostics.length > 0;
    }

    /**
     * Отложить публикацию до пересчёта межфайловой фазы.
     *
     * Пересчёт запускается немедленно, а не по обычной задержке: его и ждут.
     * Если он не успел за отведённый срок — был отменён, файл покинут, поток
     * занят — список выходит без межфайловых находок: лучше их отсутствие,
     * чем неверная подсказка.
     */
    private holdForWorkspace(uri: string): void {
        this.scheduleWorkspace(uri, 0);

        if (this.workspaceHolds.has(uri)) {
            return;
        }

        this.workspaceHolds.set(uri, this.clock.setTimeout(() => {
            this.workspaceHolds.delete(uri);
            this.publishCombined(uri);
        }, WORKSPACE_HOLD_MS));
    }

    private releaseHold(uri: string): void {
        const timer = this.workspaceHolds.get(uri);

        if (timer) {
            this.clock.clearTimeout(timer);
            this.workspaceHolds.delete(uri);
        }
    }

    private diagnosticsDisabled(uri: string): boolean {
        const settings = this.settings.getAvailable(uri);

        return settings.diagnostics?.enabled === false;
    }

    private getOpenUris(): string[] {
        return this.documents.all().map(document => document.uri);
    }

    private publishPlan(publications: IDiagnosticPublication[]): void {
        for (const publication of publications) {
            this.sendIfChanged(publication.uri, publication.diagnostics);
        }
    }

    /**
     * Публикация с версией документа.
     *
     * Версия нужна и клиенту, и самой дедупликации. Клиент по ней отбрасывает
     * список, посчитанный для уже изменённого текста. А дедупликация без версии
     * пропускала повторную публикацию того же по составу списка после правки —
     * и у клиента оставалась его собственная, сдвинутая копия подчёркиваний.
     */
    private sendIfChanged(uri: string, diagnostics: Diagnostic[]): void {
        const version = this.documents.get(uri)?.version;
        const signature = (version ?? "нет") + " " +
            diagnosticSignature(diagnostics);

        if (this.publishedSignatures.get(uri) === signature) {
            return;
        }
        this.publishedSignatures.set(uri, signature);
        this.connection.sendDiagnostics({ uri, version, diagnostics });
    }

    private isActive(uri: string): boolean {
        return this.activeDocumentUri === uri;
    }

    private cancelLocal(uri: string): void {
        const timer = this.localTimers.get(uri);
        if (timer) {
            this.clock.clearTimeout(timer);
            this.localTimers.delete(uri);
        }
    }

    private cancelWorkspaceTimer(uri: string): void {
        const timer = this.workspaceTimers.get(uri);
        if (timer) {
            this.clock.clearTimeout(timer);
            this.workspaceTimers.delete(uri);
        }
    }

    private logSlow(
        phase: string,
        uri: string,
        version: number,
        started: number
    ): void {
        const elapsed = Date.now() - started;
        if (elapsed >= this.slowDiagnosticsLogMs) {
            this.options.log(
                `Slow ${phase} diagnostics: ${uri}; version=${version}; ms=${elapsed}`
            );
        }
    }

    /**
     * Следит, какая порция расчёта заняла поток дольше всех.
     *
     * Из суммарного времени фазы этого не видно: между порциями управление
     * возвращается редактору, а внутри порции — нет, поэтому именно самая долгая
     * порция и есть задержка, которую видит запрос пользователя. Записывается
     * она полем к записи фазы, а не отдельной строкой на каждую порцию: их на
     * один файл десятки.
     */
    private watchStages(enabled: boolean): {
        observer: RslDiagnosticStageObserver | undefined;
        fields(): Record<string, string | number>;
    } {
        if (!enabled) {
            return { observer: undefined, fields: () => ({}) };
        }

        let worst = 0;
        let worstName = "";

        return {
            observer: (name, milliseconds) => {
                if (milliseconds > worst) {
                    worst = milliseconds;
                    worstName = name;
                }
            },
            fields: () => ({ worstStage: worstName, worstStageMs: worst })
        };
    }

    private logFailure(phase: string, uri: string, error: unknown): void {
        this.options.log(
            `${phase} diagnostics failed: ${uri}\n${errorToString(error)}`
        );
    }
}

/**
 * Ключ настроек: весь нормализованный набор, а не выписанные вручную поля.
 *
 * Списки полей отставали от настроек. Появлялась проверка — её настройка в
 * ключ не попадала, и переключение галочки не пересчитывало ничего: результат
 * брался из кэша, посчитанного при прежнем значении. Нормализация уже
 * приводит настройки к полному набору со значениями по умолчанию, поэтому
 * достаточно взять её целиком. Лишний пересчёт при смене чужой настройки
 * дешевле молча устаревшего ответа, а меняются настройки редко.
 */
function diagnosticsSettingsKey(settings: IRslSettings): string {
    return JSON.stringify(
        normalizeDiagnosticSettings({
            ...(settings.diagnostics || {}),
            dialect: settings.language?.dialect
        })
    );
}

function diagnosticItemKey(item: Diagnostic): string {
    return [
        item.code || "",
        item.range.start.line,
        item.range.start.character,
        item.range.end.line,
        item.range.end.character,
        item.message
    ].join(":");
}

function diagnosticSignature(diagnostics: readonly Diagnostic[]): string {
    return diagnostics.map(diagnosticItemKey).join("\u0001");
}

function yieldToInteractiveRequests(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

function errorToString(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}\n${error.stack || ""}`;
    }
    return String(error);
}

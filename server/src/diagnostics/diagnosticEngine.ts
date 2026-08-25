import type { Diagnostic } from "vscode-languageserver";

import { applyProjectDiagnosticRules } from "./diagnosticPostProcessor";
import {
    buildLocalRslDiagnostics,
    buildLocalRslDiagnosticsChunked,
    buildWorkspaceRslDiagnostics,
    buildWorkspaceRslDiagnosticsChunked,
    normalizeDiagnosticSettings
} from "../diagnostics";
import {
    createWorkSlice,
    type IRslWorkSlice
} from "../core/timeSlice";
import {
    collectRslUndeclaredAssignments,
    collectRslUndeclaredAssignmentsChunked
} from "./undeclaredAssignmentDiagnostics";
import { buildImportResolutionDiagnostics } from "./importResolutionDiagnostics";
import { buildCyclicImportDiagnostics } from "./cyclicImportDiagnostics";
import {
    collectUnknownVariables,
    collectUnknownVariablesChunked,
    normalizeUnknownVariablesMode,
    type IRslUnknownVariableFinding,
    type IRslUnknownVariableOptions
} from "./unknownVariableDiagnostics";
import type { RslDiagnosticStageObserver } from "../diagnostics";
import type { IRslDiagnosticSettings } from "../interfaces";
import { RslUnitDiagnosticsCache } from "./unitDiagnosticsCache";
import { RslScopeResolver } from "../scopeResolver";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

export type DiagnosticPhase = "local" | "workspace";

export interface IRslDiagnosticContext {
    module: IIndexedModule;
    index: WorkspaceIndex;
    settings: IRslDiagnosticSettings | undefined;
    /**
     * Расчёт больше не нужен: файл покинули или изменили.
     *
     * Проверяется и между правилами, и внутри них — на файле 100 КБ одна
     * локальная фаза занимает больше сотни миллисекунд, и это время отнимается
     * у файла, который пользователь ждёт.
     */
    isCancelled?(): boolean;
    /**
     * Общий resolver сервера, если он есть.
     *
     * Отличается от собственного не только кэшами: только у общего есть каталог
     * прикладных модулей, а от него зависит, полон ли Import-контекст.
     */
    resolver?: RslScopeResolver;
    /**
     * Длительность отдельной порции расчёта.
     *
     * Между порциями управление возвращается редактору, а внутри — нет, поэтому
     * самая долгая порция и есть та задержка, которую видит запрос
     * пользователя. По суммарному времени фазы этого не видно.
     */
    onStage?: RslDiagnosticStageObserver;
}

export interface IRslDiagnosticRule {
    id: string;
    phase?: DiagnosticPhase;
    run(context: IRslDiagnosticContext): Diagnostic[];
    /**
     * Порционный вариант правила.
     *
     * Движок предпочитает его, когда расчёт идёт порциями: правило само отдаёт
     * управление event loop внутри себя и потому прерывается не только на своей
     * границе. У основных правил внутри десяток этапов, и без этого одно правило
     * оставалось неделимым куском в сотню миллисекунд.
     */
    runChunked?(
        context: IRslDiagnosticContext,
        slice: IRslWorkSlice
    ): Promise<Diagnostic[]>;
}

/**
 * Двухфазный реестр диагностик.
 * Локальные ошибки публикуются без ожидания Import; workspace-проверки приходят позже.
 */
export interface IRslDiagnosticEngineOptions {
    /**
     * Приёмник audit-отчёта о необъявленных переменных.
     *
     * Отчёт вместо Problems: правило прогоняется на репозитории, а не включается
     * сразу. Запись файла — дело сервера, движок сюда только передаёт находки.
     */
    audit?(auditFile: string, findings: readonly IRslUnknownVariableFinding[]): void;
}

/**
 * Что нужно audit-прогону, или undefined, если он не запрошен.
 *
 * Общее для синхронного и порционного вариантов правила: решение «запускать
 * или нет» обязано быть одним, иначе режимы разойдутся.
 *
 * Режим выбирает состав отчёта так же, как состав Problems: необъявленные
 * переменные слева от «=» входят в оба режима, strict добавляет к ним
 * остальные неразрешённые имена. Пока отчёт strict собирался одним вторым
 * обходом, он занижал число ошибок: тот обход намеренно пропускает простые
 * цели присваивания, полагаясь на первую проверку.
 */
function auditRequest(context: IRslDiagnosticContext): {
    auditFile: string;
    module: IIndexedModule;
    resolver: RslScopeResolver;
    options: IRslUnknownVariableOptions;
} | undefined {
    const mode = normalizeUnknownVariablesMode(
        context.settings?.unknownVariables
    );
    const auditFile = context.settings?.unknownVariablesAuditFile || "";

    if (mode === "off" || !auditFile) {
        return undefined;
    }

    return {
        auditFile,
        module: context.module,
        resolver: context.resolver || new RslScopeResolver(context.index),
        options: {
            mode,
            /*
             * Лимита нет намеренно: отчёт для того и существует, чтобы увидеть
             * полную картину по репозиторию. Отмена при этом соблюдается —
             * прогон покинутого файла никому не нужен.
             */
            knownGlobalsFile:
                context.settings?.unknownVariablesKnownGlobalsFile,
            isCancelled: context.isCancelled
        }
    };
}

export class RslDiagnosticEngine {
    private rules: IRslDiagnosticRule[] = [];
    /**
     * Кэш диагностик по единицам документа.
     *
     * Принадлежит движку, а не модулю: он удерживает исходный текст открытых
     * файлов, и его время жизни обязано совпадать со временем жизни сервера, а
     * записи — уходить вместе с закрытыми документами.
     */
    private readonly unitCache = new RslUnitDiagnosticsCache();

    constructor(private options: IRslDiagnosticEngineOptions = {}) {
        this.register({
            id: "core-local",
            phase: "local",
            run: context => buildLocalRslDiagnostics(
                context.module,
                context.index,
                context.settings,
                context.isCancelled,
                context.resolver,
                this.unitCache
            ),
            runChunked: (context, slice) => buildLocalRslDiagnosticsChunked(
                context.module,
                context.index,
                context.settings,
                context.isCancelled,
                slice,
                context.onStage,
                context.resolver,
                this.unitCache
            )
        });
        this.register({
            id: "core-workspace",
            phase: "workspace",
            run: context => buildWorkspaceRslDiagnostics(
                context.module,
                context.index,
                context.settings,
                context.isCancelled,
                context.resolver
            ),
            runChunked: (context, slice) => buildWorkspaceRslDiagnosticsChunked(
                context.module,
                context.index,
                context.settings,
                context.isCancelled,
                context.resolver,
                slice,
                context.onStage
            )
        });
        this.register({
            id: "unknown-variables-audit",
            phase: "workspace",
            run: context => {
                const audit = this.options.audit;
                const request = audit && auditRequest(context);

                if (!audit || !request) {
                    return [];
                }

                audit(request.auditFile, [
                    ...collectRslUndeclaredAssignments(
                        request.module,
                        request.resolver,
                        { ...request.options, includePending: true }
                    ),
                    ...(request.options.mode === "strict"
                        ? collectUnknownVariables(
                            request.module,
                            request.resolver,
                            request.options
                        )
                        : [])
                ]);
                /* Audit не публикует Problems — в этом и смысл режима. */
                return [];
            },
            runChunked: async (context, slice) => {
                const audit = this.options.audit;
                const request = audit && auditRequest(context);

                if (!audit || !request) {
                    return [];
                }

                audit(request.auditFile, [
                    ...await collectRslUndeclaredAssignmentsChunked(
                        request.module,
                        request.resolver,
                        { ...request.options, includePending: true },
                        slice
                    ),
                    ...(request.options.mode === "strict"
                        ? await collectUnknownVariablesChunked(
                            request.module,
                            request.resolver,
                            request.options,
                            slice
                        )
                        : [])
                ]);
                return [];
            }
        });
        this.register({
            id: "import-resolution",
            phase: "workspace",
            run: context => buildImportResolutionDiagnostics(
                context.module,
                context.index,
                context.settings
            )
        });
        this.register({
            id: "cyclic-import",
            phase: "workspace",
            run: context => buildCyclicImportDiagnostics(
                context.module,
                context.index,
                context.settings
            )
        });
    }

    register(rule: IRslDiagnosticRule): void {
        if (this.rules.some(item => item.id === rule.id)) {
            throw new Error(`Diagnostic rule already registered: ${rule.id}`);
        }
        this.rules.push({ ...rule, phase: rule.phase || "local" });
    }

    buildLocal(
        module: IIndexedModule,
        index: WorkspaceIndex,
        settings?: IRslDiagnosticSettings,
        isCancelled?: () => boolean,
        resolver?: RslScopeResolver
    ): Diagnostic[] {
        return this.buildPhase(
            "local",
            module,
            index,
            settings,
            isCancelled,
            resolver
        );
    }

    buildWorkspace(
        module: IIndexedModule,
        index: WorkspaceIndex,
        settings?: IRslDiagnosticSettings,
        isCancelled?: () => boolean,
        resolver?: RslScopeResolver
    ): Diagnostic[] {
        return this.buildPhase(
            "workspace",
            module,
            index,
            settings,
            isCancelled,
            resolver
        );
    }

    /**
     * Локальная фаза порциями.
     *
     * Между правилами — и внутри правил, которые это умеют — расчёт возвращает
     * управление event loop. Только после этого проверка версии документа,
     * активного URI и отмены имеет смысл: до паузы соответствующие сообщения до
     * сервера просто не доходят.
     */
    /**
     * Документ закрыт: его текст и находки удерживать больше незачем.
     *
     * Кэш единиц хранит исходник целиком, и на крупных модулях это мегабайты
     * на файл. Без явной очистки они жили бы до вытеснения по границе, то есть
     * произвольно долго после закрытия вкладки.
     */
    forget(uri: string): void {
        this.unitCache.forget(uri);
    }

    /** Сколько удерживает кэш единиц: для тестов и профиля. */
    get unitCacheStats(): { entries: number; bytes: number } {
        return { entries: this.unitCache.size, bytes: this.unitCache.bytes };
    }

    buildLocalAsync(
        module: IIndexedModule,
        index: WorkspaceIndex,
        settings?: IRslDiagnosticSettings,
        isCancelled?: () => boolean,
        resolver?: RslScopeResolver,
        onStage?: RslDiagnosticStageObserver
    ): Promise<Diagnostic[]> {
        return this.buildPhaseAsync(
            "local",
            module,
            index,
            settings,
            isCancelled,
            resolver,
            onStage
        );
    }

    buildWorkspaceAsync(
        module: IIndexedModule,
        index: WorkspaceIndex,
        settings?: IRslDiagnosticSettings,
        isCancelled?: () => boolean,
        resolver?: RslScopeResolver,
        onStage?: RslDiagnosticStageObserver
    ): Promise<Diagnostic[]> {
        return this.buildPhaseAsync(
            "workspace",
            module,
            index,
            settings,
            isCancelled,
            resolver,
            onStage
        );
    }

    /** Совместимый полный результат для тестов и прямых вызовов. */
    build(
        module: IIndexedModule,
        index: WorkspaceIndex,
        settings?: IRslDiagnosticSettings
    ): Diagnostic[] {
        const options = normalizeDiagnosticSettings(settings);
        if (!options.enabled || options.maxProblems === 0) {
            return [];
        }
        const local = this.buildLocal(module, index, settings);
        const remaining = Math.max(0, options.maxProblems - local.length);
        const workspace = remaining > 0
            ? this.buildWorkspace(module, index, {
                ...(settings || {}),
                maxProblems: remaining
            })
            : [];
        return deduplicate([...local, ...workspace]).slice(0, options.maxProblems);
    }

    private buildPhase(
        phase: DiagnosticPhase,
        module: IIndexedModule,
        index: WorkspaceIndex,
        settings?: IRslDiagnosticSettings,
        isCancelled?: () => boolean,
        resolver?: RslScopeResolver
    ): Diagnostic[] {
        const options = normalizeDiagnosticSettings(settings);
        if (!options.enabled || options.maxProblems === 0) {
            return [];
        }

        const diagnostics: Diagnostic[] = [];
        for (const rule of this.rules) {
            if ((rule.phase || "local") !== phase) {
                continue;
            }
            const remaining = options.maxProblems - diagnostics.length;
            if (remaining <= 0) {
                break;
            }
            /* Граница правил — вторая точка прерывания, кроме этапов внутри. */
            if (isCancelled?.()) {
                break;
            }
            diagnostics.push(...rule.run({
                module,
                index,
                settings: {
                    ...(settings || {}),
                    maxProblems: remaining
                },
                isCancelled,
                resolver
            }).slice(0, remaining));
        }

        return this.completePhase(module, diagnostics, options.maxProblems);
    }

    private async buildPhaseAsync(
        phase: DiagnosticPhase,
        module: IIndexedModule,
        index: WorkspaceIndex,
        settings?: IRslDiagnosticSettings,
        isCancelled?: () => boolean,
        resolver?: RslScopeResolver,
        onStage?: RslDiagnosticStageObserver
    ): Promise<Diagnostic[]> {
        const options = normalizeDiagnosticSettings(settings);
        if (!options.enabled || options.maxProblems === 0) {
            return [];
        }

        const slice = createWorkSlice();
        const diagnostics: Diagnostic[] = [];

        for (const rule of this.rules) {
            if ((rule.phase || "local") !== phase) {
                continue;
            }
            const remaining = options.maxProblems - diagnostics.length;
            if (remaining <= 0) {
                break;
            }

            /*
             * Пауза перед правилом, проверка отмены — после паузы. Обратный
             * порядок ничего не давал бы: проверять состояние, которое ещё не
             * успело измениться, значит проверять его зря.
             */
            await slice.yieldIfNeeded();

            if (isCancelled?.()) {
                break;
            }

            const context: IRslDiagnosticContext = {
                module,
                index,
                settings: {
                    ...(settings || {}),
                    maxProblems: remaining
                },
                isCancelled,
                resolver,
                onStage
            };
            const produced = rule.runChunked
                ? await rule.runChunked(context, slice)
                : rule.run(context);

            /*
             * Правило могло идти долго и с паузами: за это время файл могли
             * покинуть или изменить, и его результат уже никому не нужен.
             */
            if (isCancelled?.()) {
                break;
            }
            diagnostics.push(...produced.slice(0, remaining));
        }

        return this.completePhase(module, diagnostics, options.maxProblems);
    }

    private completePhase(
        module: IIndexedModule,
        diagnostics: Diagnostic[],
        maxProblems: number
    ): Diagnostic[] {
        const processed = applyProjectDiagnosticRules(module, diagnostics);
        const filtered = filterClosedOutputFormDiagnostics(module, processed);
        return deduplicate(filtered).slice(0, maxProblems);
    }
}


/**
 * Core diagnostics historically validates every square token using SQL rules.
 * In an output form a line beginning with "--" is literal form text, not an
 * SQL comment. Therefore a separator like "----------------]" must not hide
 * the closing bracket from diagnostics.
 */
export function filterClosedOutputFormDiagnostics(
    module: IIndexedModule,
    diagnostics: readonly Diagnostic[]
): Diagnostic[] {
    const closedOutputRanges = new Set<string>();

    for (const token of module.lex.tokens) {
        if (
            token.kind === "square" &&
            token.squareKind === "output" &&
            token.raw.endsWith("]")
        ) {
            closedOutputRanges.add([
                token.line,
                token.character,
                token.endLine,
                token.endCharacter
            ].join(":"));
        }
    }

    if (closedOutputRanges.size === 0) {
        return diagnostics.slice();
    }

    return diagnostics.filter(diagnostic => {
        if (String(diagnostic.code || "") !== "unclosed-square-block") {
            return true;
        }

        const key = [
            diagnostic.range.start.line,
            diagnostic.range.start.character,
            diagnostic.range.end.line,
            diagnostic.range.end.character
        ].join(":");

        return !closedOutputRanges.has(key);
    });
}


function deduplicate(items: Diagnostic[]): Diagnostic[] {
    const result: Diagnostic[] = [];
    const seen = new Set<string>();

    for (const item of items) {
        const key = [
            item.code || "",
            item.range.start.line,
            item.range.start.character,
            item.range.end.line,
            item.range.end.character,
            item.message
        ].join(":");
        if (!seen.has(key)) {
            seen.add(key);
            result.push(item);
        }
    }
    return result;
}

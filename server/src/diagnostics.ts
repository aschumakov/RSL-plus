/*
 * Планирование расчёта диагностик.
 *
 * Здесь собираются планы двух фаз — локальной и межфайловой — из проверок,
 * которые живут в модулях рядом: syntaxChecks, declarationChecks, importChecks,
 * setParmChecks. Исполнение плана в stages, перевод находок в протокол LSP в
 * diagnosticFactory, описание самих проверок в ruleRegistry.
 *
 * Раньше всё это было одним файлом на 3900 строк, и знание о проверке было
 * размазано по нему: включённость в таблице этапов, кэшируемость в отдельном
 * множестве имён, отпечаток настроек в выписанном вручную списке полей.
 */

import {
    CompletionItemKind,
    Diagnostic
} from "vscode-languageserver";
import {
    applyRslRuleSeverity,
    normalizeRslRuleSeverity,
    type RslRuleSeverityMap
} from "./diagnostics/ruleSeverity";

import { RslSymbol } from "./symbols/rslSymbol";
import type {
    IRslDocumentUnit
} from "./analysis/documentUnits";
import {
    runRslUnitDiagnosticsWithoutCache,
    tokensOfRslUnits,
    type IRslUnitDiagnosticsRun,
    type RslUnitDiagnosticsCache
} from "./diagnostics/unitDiagnosticsCache";
import {
    checkRslConditions,
    createRslStatementScanner,
    type IRslStatementScanner
} from "./diagnostics/statementChecks";
import type { IRslDiagnosticStage } from "./diagnostics/stages";
import {
    rslUnitCacheFingerprint,
    rslUnitCacheLane,
    rslUnitCacheLaneRules,
    type RslUnitCacheLane
} from "./diagnostics/ruleRegistry";
import {
    RslScopeResolver
} from "./scopeResolver";
import {
    createImportReferenceScanner,
    type IRslImportReferenceScanner
} from "./execMacroDefinition";
import {
    IRslDiagnosticSettings
} from "./interfaces";
import {
    buildUnknownVariableDiagnostics,
    normalizeUnknownVariablesMode
} from "./diagnostics/unknownVariableDiagnostics";
import {
    buildRedundantImportDiagnostics
} from "./diagnostics/redundantImportDiagnostics";
import {
    addScalarMemberDiagnostic,
    isScalarMemberCandidate
} from "./diagnostics/scalarMemberDiagnostics";
import {
    createUnreachableCodeScanner
} from "./diagnostics/unreachableCodeDiagnostics";
import {
    createWorkSlice,
    type IRslWorkSlice
} from "./core/timeSlice";
import {
    cachedSignificantTokens,
    createSignificantTokenFilter,
    IRslToken,
    normalizeIdentifier
} from "./lexer";
import {
    buildSpecialVariableDiagnostics,
    normalizeSpecialVariablesMode
} from "./diagnostics/specialVariableDiagnostics";
import {
    IIndexedModule,
    WorkspaceIndex
} from "./workspaceIndex";
import {
    type IDeclarationInfo,
    type ILocalDiagnosticFacts,
    VARIABLE_KINDS,
    addAmbiguousReferenceDiagnostics,
    addDuplicateDeclarationDiagnostics,
    addToIdentifierIndex,
    addUnusedDeclarationDiagnostics,
    collectDeclarations,
    createConstantAssignmentStage,
    createDeclarationFactsStage,
    createLocalVisibilityStage,
    createUndeclaredAssignmentStage,
    createUseBeforeDeclarationStage
} from "./diagnostics/declarationChecks";
import {
    deduplicateDiagnostics,
    offsetRangeKey
} from "./diagnostics/diagnosticFactory";
import {
    addBasicImportDiagnostics,
    addSelfImportDiagnostics,
    createUnusedImportStage
} from "./diagnostics/importChecks";
import {
    type IRslDiagnosticPlan,
    type IRslDiagnosticStageEntry,
    type RslDiagnosticStageObserver,
    createResolverScanStage,
    createScanStage,
    createScopeScanStage,
    emptyPlan,
    enabledStages,
    runDiagnosticPlan,
    runDiagnosticPlanChunked
} from "./diagnostics/stages";
import {
    addCoreDialectDiagnostics,
    addDebugBreakDiagnostic,
    addDeprecatedDeclarationDiagnostic,
    addDocumentedLimitDiagnostic,
    addFileNameLimitDiagnostic,
    addImportPlacementDiagnostics,
    addReferenceArgumentDiagnostics,
    addSyntaxParserDiagnostics,
    addUnterminatedTokenDiagnostic,
    createBracketScanner,
    createEndScanner
} from "./diagnostics/syntaxChecks";

/*
 * Точка входа диагностик.
 *
 * Проверки живут в модулях рядом, а этот файл собирает из них планы двух фаз.
 * Тип наблюдателя за этапами переэкспортируется: он часть внешнего договора,
 * и переносить его вместе с исполнением плана значило бы менять все места, где
 * он назван.
 */
export type { RslDiagnosticStageObserver } from "./diagnostics/stages";

export const DEFAULT_DIAGNOSTIC_SETTINGS: Required<IRslDiagnosticSettings> = {
    enabled: true,
    deprecatedDeclarations: true,
    structure: true,
    unusedVariables: true,
    unusedImports: true,
    debugBreak: true,
    selfAssignment: true,
    selfComparison: true,
    constantCondition: true,
    duplicateBranchCondition: true,
    unusedExpression: true,
    useBeforeDeclaration: true,
    ambiguousReferences: true,
    /*
     * Необъявленные переменные проверяются в безопасном режиме: только имя
     * слева от знака присваивания — так в RSL появляется переменная без VAR, и
     * опечатка в её имени видна наверняка. Чтения имён не проверяются: имя
     * может прийти оттуда, куда сервер не видит. Подробнее —
     * unknownVariableDiagnostics.
     *
     * Лишний транзитивный Import — включено с severity Information: это
     * подсказка, а не ошибка, и убирать такой Import или оставлять его
     * страховкой решает автор кода.
     */
    redundantImports: true,
    unknownVariables: "safe",
    unknownMembers: true,
    unknownSpecialVariables: "all",
    unknownVariablesKnownGlobalsFile: "",
    unknownVariablesAuditFile: "",
    dialect: "rsBank",
    maxProblems: 200,
    /* Уровни правил по умолчанию не переопределяются. */
    rules: {}
};

export function normalizeDiagnosticSettings(
    settings?: IRslDiagnosticSettings
): Required<IRslDiagnosticSettings> {
    return {
        enabled: settings?.enabled !== false,
        deprecatedDeclarations:
            settings?.deprecatedDeclarations !== false,
        structure: settings?.structure !== false,
        unusedVariables: settings?.unusedVariables !== false,
        unusedImports: settings?.unusedImports !== false,
        debugBreak: settings?.debugBreak !== false,
        selfAssignment: settings?.selfAssignment !== false,
        selfComparison: settings?.selfComparison !== false,
        constantCondition: settings?.constantCondition !== false,
        duplicateBranchCondition:
            settings?.duplicateBranchCondition !== false,
        unusedExpression: settings?.unusedExpression !== false,
        useBeforeDeclaration:
            settings?.useBeforeDeclaration !== false,
        ambiguousReferences:
            settings?.ambiguousReferences !== false,
        redundantImports: settings?.redundantImports !== false,
        unknownVariables: normalizeUnknownVariablesMode(
            settings?.unknownVariables
        ),
        unknownMembers: settings?.unknownMembers !== false,
        unknownSpecialVariables: normalizeSpecialVariablesMode(
            settings?.unknownSpecialVariables
        ),
        unknownVariablesKnownGlobalsFile:
            settings?.unknownVariablesKnownGlobalsFile || "",
        unknownVariablesAuditFile:
            settings?.unknownVariablesAuditFile || "",
        dialect: settings?.dialect === "coreRsl" ? "coreRsl" : "rsBank",
        maxProblems:
            typeof settings?.maxProblems === "number"
                ? Math.max(0, Math.floor(settings.maxProblems))
                : DEFAULT_DIAGNOSTIC_SETTINGS.maxProblems,
        rules: settings?.rules || {}
    };
}

/**
 * Единая точка построения диагностик RSL.
 * Проверки используют уже готовые lexer/AST/workspace index и не читают файлы.
 */
export function buildLocalRslDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    settings?: IRslDiagnosticSettings,
    /*
     * Отмена проверяется между этапами: доводить расчёт до конца для файла,
     * который пользователь покинул, значит задержать тот, который он ждёт.
     */
    isCancelled?: () => boolean,
    /*
     * Общий resolver сервера, если он есть.
     *
     * Свой resolver на каждый пересчёт означал бы холодные кэши на каждую
     * правку: на файле 700 КБ первое разрешение имени строит внутренние
     * индексы модуля и стоит около пятнадцати миллисекунд, а всего разрешений
     * там больше сотни миллисекунд. Общий resolver сбрасывает кэши сам — по
     * ревизии индекса и версии модуля.
     */
    sharedResolver?: RslScopeResolver,
    /*
     * Кэш диагностик по единицам документа, если он есть.
     *
     * Кэш принадлежит движку и живёт вместе с открытыми документами. Без него
     * файл считается целиком: у одиночного вызова владельца нет, и общий кэш
     * на модуль делил бы состояние между несвязанными расчётами.
     */
    unitCache?: RslUnitDiagnosticsCache
): Diagnostic[] {
    return runDiagnosticPlan(
        planLocalRslDiagnostics(
            module,
            index,
            settings,
            sharedResolver,
            unitCache
        ),
        isCancelled
    );
}

/**
 * Тот же расчёт порциями.
 *
 * Между этапами управление возвращается event loop, и только поэтому проверка
 * отмены имеет смысл: без паузы уведомление о смене активной вкладки до сервера
 * ещё не дошло и проверять было бы нечего.
 */
export async function buildLocalRslDiagnosticsChunked(
    module: IIndexedModule,
    index: WorkspaceIndex,
    settings?: IRslDiagnosticSettings,
    isCancelled?: () => boolean,
    slice: IRslWorkSlice = createWorkSlice(),
    /* Длительность порций: по ней видно, какая проверка держит поток. */
    onStage?: RslDiagnosticStageObserver,
    /* См. buildLocalRslDiagnostics. */
    sharedResolver?: RslScopeResolver,
    unitCache?: RslUnitDiagnosticsCache
): Promise<Diagnostic[]> {
    return runDiagnosticPlanChunked(
        planLocalRslDiagnostics(
            module,
            index,
            settings,
            sharedResolver,
            unitCache
        ),
        isCancelled,
        slice,
        onStage
    );
}

function planLocalRslDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    settings?: IRslDiagnosticSettings,
    sharedResolver?: RslScopeResolver,
    unitCache?: RslUnitDiagnosticsCache
): IRslDiagnosticPlan {
    const options = normalizeDiagnosticSettings(settings);

    if (!options.enabled || options.maxProblems === 0) {
        return emptyPlan();
    }

    const result: Diagnostic[] = [];
    /*
     * Расчёт идёт дальше предела публикации.
     *
     * Прежде расчёт обрывался на двухсотом сообщении, и это отменяло запись в
     * кэш: неполный результат запоминать нельзя. Файл, набравший предел, из-за
     * этого пересчитывался целиком на каждую правку — и обрыв обходился
     * дороже полного расчёта. На printdog.mac полный расчёт стоит 71 мс против
     * 92 мс с обрывом, на taxoutmesBody.mac 49 против 73: с обрывом каждый
     * расчёт холодный, без обрыва второй берёт единицы из кэша.
     *
     * Предел публикации остался на месте — он применяется к готовому ответу.
     * Предел расчёта нужен только как страховка от файла, который найдёт
     * сообщений на порядки больше: у самого шумного файла проверенного проекта
     * их 2409.
     */
    const computeLimit = Math.max(options.maxProblems, MAX_COMPUTED_PROBLEMS);
    const hasCapacity = (): boolean => result.length < computeLimit;
    let resolver: RslScopeResolver | undefined = sharedResolver;
    const getResolver = (): RslScopeResolver => {
        if (!resolver) {
            resolver = new RslScopeResolver(index);
        }

        return resolver;
    };
    /*
     * Справочник объявлений собирается двумя этапами, а не одним ленивым
     * вызовом.
     *
     * Обход дерева и обход всех идентификаторов файла — это две разные работы по
     * несколько миллисекунд каждая, и вместе они складывались в самую долгую
     * порцию расчёта. Индекс идентификаторов вдобавок наполняется порциями:
     * Map живёт здесь и переживает паузы.
     */
    let localFacts: ILocalDiagnosticFacts | undefined;
    const identifierIndex = new Map<string, IRslToken[]>();
    /* Заполняется этапом declarationFacts; иначе считается на месте. */
    let collectedDeclarations: IDeclarationInfo[] | undefined;
    const getLocalFacts = (): ILocalDiagnosticFacts => {
        if (!localFacts) {
            const declarations = collectedDeclarations || collectDeclarations(
                module,
                module.syntax.tokens
            );
            localFacts = {
                declarations,
                identifierIndex,
                declarationRangeKeys: new Set(
                    declarations.map(item => offsetRangeKey(
                        item.symbol.range.start,
                        item.symbol.range.end
                    ))
                )
            };
        }

        return localFacts;
    };

    /*
     * Пересчитывается не весь файл, а изменившиеся единицы документа.
     *
     * Правка задевает одну единицу из нескольких десятков, а проверки, чей
     * результат зависит ровно от своей единицы, для остальных остаются
     * прежними — им нужен перенос смещений, а не пересчёт. Проверки,
     * смотрящие за пределы единицы, по-прежнему считаются целиком.
     */
    const unitRun = unitCache
        ? unitCache.begin(
            module,
            "text",
            unitDiagnosticsFingerprint("text", options)
        )
        : runRslUnitDiagnosticsWithoutCache(module);
    /*
     * Проверки, читающие импорты, живут в своей ленте.
     *
     * Дочитанный или правленый Import обнуляет её, а лента текста
     * остаётся: раньше любое изменение графа модулей пересчитывало всю
     * локальную фазу, включая проверки, которые импортов не читают.
     */
    let importRunValue: IRslUnitDiagnosticsRun | undefined;
    /*
     * Лента создаётся по первому обращению.
     *
     * Разбиение файла на единицы и отпечаток имён стоят времени, а проверка
     * присваиваний бывает выключена настройкой или молчит, не дочитав импорты.
     * Тогда ленты нет вовсе — и в кэше не появляется пустая запись.
     */
    const importRun = (): IRslUnitDiagnosticsRun => {
        if (!importRunValue) {
            importRunValue = unitCache
                ? unitCache.begin(
                    module,
                    "imports",
                    unitDiagnosticsFingerprint("imports", options) + "@" +
                        importedContextKeyOf(
                            index,
                            sharedResolver,
                            module.uri
                        ) +
                        "@" + moduleWideNamesFingerprint(module)
                )
                : runRslUnitDiagnosticsWithoutCache(module);
        }

        return importRunValue;
    };
    /* Диагностики единиц собираются отдельно: их и запоминает кэш. */
    const unitResult: Diagnostic[] = [];
    const importResult: Diagnostic[] = [];
    const unitTokens = (): readonly IRslToken[] => unitRun.full
        ? module.lex.tokens
        : tokensOfRslUnits(module.lex.tokens, unitRun.stale);
    const importUnitTokens = (): readonly IRslToken[] => importRun().full
        ? module.syntax.tokens
        : tokensOfRslUnits(module.syntax.tokens, importRun().stale);
    /*
     * Сколько кэшируемых проверок дошло до конца.
     *
     * Запоминать результат можно, только если каждая из них прошла файл
     * целиком: расчёт прерывается и отменой, и лимитом Problems, и оборванная
     * проверка нашла не всё, что нашла бы.
     */
    let finishedUnitStages = 0;
    const countUnitStage = (): void => {
        finishedUnitStages++;
    };
    let finishedImportStages = 0;
    const countImportStage = (): void => {
        finishedImportStages++;
    };

    /*
     * Этапы перечислены таблицей, а не цепочкой if.
     *
     * Так между ними есть одна общая точка, где проверяется и лимит
     * maxProblems, и отмена: расчёт для файла, который пользователь уже
     * покинул или успел изменить, прекращается на ближайшей границе, а не
     * доводится до конца. Порядок значим — ошибки идут раньше предупреждений,
     * чтобы maxProblems не скрывал более важные сообщения.
     */
    const stages: readonly IRslDiagnosticStageEntry[] = [
        ["parser", true, () => addSyntaxParserDiagnostics(module, result)],
        /*
         * Проверки, идущие по всему потоку токенов, объявлены возобновляемыми:
         * их порция ограничена временем, а не числом токенов. Состояние живёт в
         * замыкании createScanStage, поэтому пауза ничего не теряет.
         */
        [
            "limits",
            true,
            createScanStage(
                unitTokens,
                token => addDocumentedLimitDiagnostic(module, token, unitResult),
                () => {
                    addFileNameLimitDiagnostic(module, result);
                    countUnitStage();
                }
            )
        ],
        [
            "unterminated",
            options.structure,
            createScanStage(
                unitTokens,
                token => addUnterminatedTokenDiagnostic(module, token, unitResult),
                countUnitStage
            )
        ],

        [
            "brackets",
            options.structure,
            (() => {
                const scanner = createBracketScanner(result);

                return createScanStage(
                    () => module.syntax.tokens,
                    token => scanner.step(token),
                    () => scanner.finish()
                );
            })()
        ],
        [
            "end",
            options.structure,
            (() => {
                const scanner = createEndScanner(module, result);

                return createScanStage(
                    () => module.syntax.tokens,
                    token => scanner.step(token),
                    () => scanner.finish()
                );
            })()
        ],
        [
            "unreachable",
            options.structure,
            (() => {
                /* Состояние обхода живёт между порциями: см. createScanStage. */
                const scanner = createUnreachableCodeScanner(module, result);

                return createScanStage(
                    () => module.syntax.tokens,
                    token => scanner.step(token),
                    () => scanner.finish()
                );
            })()
        ],
        [
            "duplicates",
            options.structure,
            createScopeScanStage(
                module.symbolTree,
                scope => addDuplicateDeclarationDiagnostics(
                    module,
                    scope,
                    result
                )
            )
        ],
        /*
         * Отбор значимых токенов — отдельный этап.
         *
         * Он линейный по файлу и нужен почти всем последующим проверкам, а
         * считался внутри первой из них: её собственное время складывалось с
         * этим отбором в один неделимый кусок. На файле 700 КБ отбор занимает
         * около пяти миллисекунд.
         */
        [
            "significantTokens",
            options.structure,
            (() => {
                const filter = createSignificantTokenFilter(module.lex.tokens);

                return createScanStage(
                    () => module.lex.tokens,
                    token => filter.step(token),
                    () => {
                        filter.finish();
                    }
                );
            })()
        ],
        /*
         * Поиск самих директив Import — тоже отдельный этап: обход потока
         * значимых токенов стоит столько же, сколько их отбор.
         */
        [
            "importReferences",
            options.structure,
            (() => {
                let scanner: IRslImportReferenceScanner | undefined;
                /* Сканер создаётся при первом шаге: план строится заранее. */
                const ensure = (): IRslImportReferenceScanner => {
                    if (!scanner) {
                        scanner = createImportReferenceScanner(
                            module.lex.tokens
                        );
                    }

                    return scanner;
                };

                return createScanStage(
                    () => cachedSignificantTokens(module.lex.tokens),
                    (token, index) => ensure().step(token, index),
                    () => {
                        ensure().finish();
                    }
                );
            })()
        ],
        [
            "imports",
            options.structure,
            () => addBasicImportDiagnostics(module, result)
        ],
        [
            "importPlacement",
            options.structure,
            () => addImportPlacementDiagnostics(module, result)
        ],
        /*
         * Первое обращение к резолверу — отдельный этап.
         *
         * Оно строит его внутренние кэши и на файле 700 КБ стоит около шести
         * миллисекунд неделимо. Складываясь с обходом следующей проверки, эти
         * шесть превращали её первую порцию в пятнадцать миллисекунд занятого
         * потока. Результат разрешения не нужен: важно, что кэши построены.
         */
        [
            "resolverWarmup",
            options.structure,
            () => {
                const first = module.syntax.tokens[0];

                if (first) {
                    getResolver().resolveAt(
                        module.uri,
                        module.symbolTree,
                        first.start
                    );
                }
            }
        ],
        [
            "constantAssignment",
            options.structure,
            createConstantAssignmentStage(module, getResolver, result)
        ],
        [
            "localVisibility",
            options.structure,
            createLocalVisibilityStage(module, getResolver, result)
        ],
        [
            "scalarMembers",
            options.structure,
            createResolverScanStage(
                () => module.syntax.tokens,
                (tokens, index) => isScalarMemberCandidate(tokens, index),
                (tokens, index) => addScalarMemberDiagnostic(
                    module,
                    getResolver(),
                    tokens,
                    index,
                    result
                )
            )
        ],
        [
            "coreDialect",
            options.structure && options.dialect === "coreRsl",
            () => {
                addCoreDialectDiagnostics(module, getResolver(), result);
                addReferenceArgumentDiagnostics(module, getResolver(), result);
            }
        ],
        /*
         * Справочник объявлений строится отдельными этапами.
         *
         * Он нужен двум последним проверкам, а строился ленивым вызовом внутри
         * первой из них — и его время складывалось с её собственным в один
         * неделимый кусок.
         */
        [
            "identifierIndex",
            options.useBeforeDeclaration || options.unusedVariables,
            createScanStage(
                () => module.syntax.tokens,
                token => addToIdentifierIndex(identifierIndex, token)
            )
        ],
        [
            "declarationFacts",
            options.useBeforeDeclaration || options.unusedVariables,
            createDeclarationFactsStage(module, items => {
                collectedDeclarations = items;
                getLocalFacts();
            })
        ],
        [
            "useBeforeDeclaration",
            options.useBeforeDeclaration,
            createUseBeforeDeclarationStage(
                module,
                getResolver,
                getLocalFacts,
                result,
                options.maxProblems
            )
        ],
        /*
         * Пять проверок одного оператора идут одним обходом.
         *
         * Каждая включается своей настройкой, но поток токенов у них
         * общий: пять отдельных обходов файла стоили бы впятеро дороже
         * ради работы, которая вся помещается в один.
         */
        [
            "statements",
            statementChecksEnabled(options),
            createStatementStage(
                module,
                options,
                unitResult,
                () => unitRun.full
                    ? undefined
                    : unitRun.stale,
                countUnitStage
            )
        ],
        [
            "deprecated",
            options.deprecatedDeclarations,
            createScanStage(
                unitTokens,
                token => addDeprecatedDeclarationDiagnostic(module, token, unitResult),
                countUnitStage
            )
        ],
        [
            "debugBreak",
            options.debugBreak,
            createScanStage(
                unitTokens,
                token => addDebugBreakDiagnostic(module, token, unitResult),
                countUnitStage
            )
        ],
        [
            "unused",
            options.unusedVariables,
            () => addUnusedDeclarationDiagnostics(
                module,
                getResolver(),
                getLocalFacts(),
                result,
                options.maxProblems
            )
        ],
        /*
         * Необъявленная переменная слева от «=».
         *
         * Локальная фаза, а не межфайловая: вопрос о том, объявлена ли
         * переменная В ЭТОЙ области, решается по самому файлу. Раньше
         * эта проверка была режимом проверки неразрешённых имён и
         * выключалась целиком, стоило файлу сослаться на неизвестный
         * RSM- или DLM-модуль.
         *
         * Работает в обоих режимах: strict обязан находить всё, что
         * находит safe. Иначе строгий режим ТЕРЯЛ находки — `Target =
         * value` он разрешал как процедуру и молчал, тогда как safe
         * сообщал о необъявленной переменной.
         */
        [
            "undeclaredAssignments",
            options.unknownVariables !== "off" &&
                !options.unknownVariablesAuditFile,
            createUndeclaredAssignmentStage(
                module,
                getResolver,
                options,
                importResult,
                importUnitTokens,
                countImportStage
            )
        ]
    ];

    const enabled = enabledStages(stages);
    const expectedUnitStages = enabled.filter(stage =>
        CACHEABLE_UNIT_STAGES.get(stage.name) === "text"
    ).length;
    const expectedImportStages = enabled.filter(stage =>
        CACHEABLE_UNIT_STAGES.get(stage.name) === "imports"
    ).length;

    return {
        stages: enabled,
        hasCapacity,
        finish: (complete: boolean) => {
            /*
             * Результат запоминается, только если расчёт дошёл до конца и все
             * кэшируемые проверки прошли файл целиком. В остальных случаях
             * прежняя запись остаётся нетронутой: неполный результат,
             * запомненный как полный, «переиспользовался» бы на следующей
             * правке — и находки, которые не искали, исчезали бы из Problems.
             */
            if (complete && finishedUnitStages === expectedUnitStages) {
                unitRun.commit(unitResult);
            } else {
                unitRun.abort();
            }

            if (
                expectedImportStages > 0 &&
                complete &&
                finishedImportStages === expectedImportStages
            ) {
                importRun().commit(importResult);
            } else {
                importRunValue?.abort();
            }

            return finishRslDiagnostics(
                deduplicateDiagnostics([
                    ...result,
                    ...unitResult,
                    ...unitRun.reused,
                    ...importResult,
                    ...(importRunValue?.reused || [])
                ]),
                options.maxProblems,
                normalizeRslRuleSeverity(options.rules)
            );
        }
    };
}

/** Workspace-фаза не запускает parser/local rules повторно. */
export function buildWorkspaceRslDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    settings?: IRslDiagnosticSettings,
    isCancelled?: () => boolean,
    /**
     * Общий resolver сервера.
     *
     * Для правила о необъявленных переменных он обязателен по существу: только
     * общий resolver знает про каталог прикладных модулей, а без каталога любой
     * `Import CommonInter` делал бы контекст непрозрачным — то есть правило
     * молчало бы всегда.
     */
    sharedResolver?: RslScopeResolver
): Diagnostic[] {
    return runDiagnosticPlan(
        planWorkspaceRslDiagnostics(module, index, settings, sharedResolver),
        isCancelled
    );
}

/** Межфайловая фаза порциями: см. buildLocalRslDiagnosticsChunked. */
export async function buildWorkspaceRslDiagnosticsChunked(
    module: IIndexedModule,
    index: WorkspaceIndex,
    settings?: IRslDiagnosticSettings,
    isCancelled?: () => boolean,
    sharedResolver?: RslScopeResolver,
    slice: IRslWorkSlice = createWorkSlice(),
    onStage?: RslDiagnosticStageObserver
): Promise<Diagnostic[]> {
    return runDiagnosticPlanChunked(
        planWorkspaceRslDiagnostics(module, index, settings, sharedResolver),
        isCancelled,
        slice,
        onStage
    );
}

function planWorkspaceRslDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    settings?: IRslDiagnosticSettings,
    sharedResolver?: RslScopeResolver
): IRslDiagnosticPlan {
    const options = normalizeDiagnosticSettings(settings);
    if (!options.enabled || options.maxProblems === 0) {
        return emptyPlan();
    }
    const result: Diagnostic[] = [];
    const resolver = sharedResolver || new RslScopeResolver(index);
    const stages: readonly IRslDiagnosticStageEntry[] = [
        /*
         * Ссылки Import собираются отдельным этапом — как и в локальной фазе.
         *
         * Их спрашивают почти все проверки этой фазы, а сам сбор — проход по
         * всему потоку токенов: на модуле 700 КБ он занимал поток на семнадцать
         * миллисекунд внутри первой же проверки. Результат запоминается на
         * версию потока токенов, поэтому дальше он бесплатен.
         */
        [
            "importReferences",
            options.structure || options.unusedImports,
            (() => {
                let scanner: ReturnType<
                    typeof createImportReferenceScanner
                > | undefined;
                const ensure = (): NonNullable<typeof scanner> => {
                    if (!scanner) {
                        scanner = createImportReferenceScanner(
                            module.lex.tokens
                        );
                    }

                    return scanner;
                };

                return createScanStage(
                    () => module.lex.tokens,
                    (token, tokenIndex) => ensure().step(token, tokenIndex),
                    () => {
                        ensure().finish();
                    }
                );
            })()
        ],
        [
            "selfImport",
            options.structure,
            () => addSelfImportDiagnostics(module, index, result)
        ],
        [
            "ambiguousReferences",
            options.ambiguousReferences,
            () => addAmbiguousReferenceDiagnostics(module, index, result)
        ],
        [
            "unusedImports",
            options.unusedImports,
            createUnusedImportStage(module, index, resolver, result)
        ],
        [
            "redundantImports",
            options.redundantImports,
            () => {
                result.push(...buildRedundantImportDiagnostics(
                    module,
                    index,
                    resolver
                ));
            }
        ],
        [
            "specialVariables",
            options.unknownSpecialVariables !== "off",
            () => {
                result.push(...buildSpecialVariableDiagnostics(
                    module,
                    resolver,
                    {
                        mode: options.unknownSpecialVariables,
                        knownGlobalsFile:
                            options.unknownVariablesKnownGlobalsFile,
                        limit: Math.max(
                            0,
                            options.maxProblems - result.length
                        )
                    }
                ));
            }
        ],
        [
            "unknownVariables",
            (options.unknownVariables === "strict" ||
                options.unknownMembers) &&
                !options.unknownVariablesAuditFile,
            isCancelled => {
                result.push(...buildUnknownVariableDiagnostics(
                    module,
                    resolver,
                    {
                        mode: options.unknownVariables,
                        checkMembers: options.unknownMembers,
                        knownGlobalsFile:
                            options.unknownVariablesKnownGlobalsFile,
                        /*
                         * Больше остатка лимита Problems искать незачем: лишнее
                         * всё равно отбросится, а на большом файле поиск
                         * лишнего — это сотни миллисекунд.
                         */
                        limit: Math.max(
                            0,
                            options.maxProblems - result.length
                        ),
                        isCancelled
                    }
                ));
            }
        ]
    ];

    return {
        stages: enabledStages(stages),
        hasCapacity: () => result.length <
            Math.max(options.maxProblems, MAX_COMPUTED_PROBLEMS),
        finish: () =>
            finishRslDiagnostics(
                deduplicateDiagnostics(result),
                options.maxProblems,
                normalizeRslRuleSeverity(options.rules)
            )
    };
}

/**
 * Проверки, результат которых зависит ровно от текста своей единицы.
 *
 * Только они переиспользуются между правками, и только их завершение решает,
 * можно ли запомнить результат.
 */
/*
 * Сколько сообщений расчёт вправе найти, прежде чем остановиться.
 *
 * Это страховка, а не рабочий предел: у самого шумного файла проверенного
 * проекта 2409 сообщений. Остановка по этому порогу означает, что результат
 * неполон, и запоминать его нельзя — как и всякий оборванный расчёт.
 */
const MAX_COMPUTED_PROBLEMS = 20_000;

/**
 * Порядок ответа перед обрезкой по пределу публикации.
 *
 * Сначала важность: предел не имеет права спрятать ошибку ради
 * предупреждения. Потом положение в файле, потом код — чтобы порядок был один
 * и тот же при любом составе ответа.
 *
 * Без этого состав опубликованных Problems зависел от того, какие единицы
 * пришли из кэша: находки пересчитанной единицы шли впереди переиспользованных
 * независимо от того, где они в файле, и у файла с избытком сообщений список
 * менялся от правки к правке, ничего не меняющей по существу.
 */
export function compareRslDiagnostics(
    left: Diagnostic,
    right: Diagnostic
): number {
    const bySeverity = (left.severity ?? 1) - (right.severity ?? 1);

    if (bySeverity !== 0) {
        return bySeverity;
    }

    const byLine = left.range.start.line - right.range.start.line;

    if (byLine !== 0) {
        return byLine;
    }

    const byCharacter = left.range.start.character -
        right.range.start.character;

    if (byCharacter !== 0) {
        return byCharacter;
    }

    return String(left.code ?? "").localeCompare(String(right.code ?? ""));
}

/** Готовый ответ: тот же порядок и тот же предел, откуда бы он ни собрался. */
export function finishRslDiagnostics(
    diagnostics: readonly Diagnostic[],
    maxProblems: number,
    /* Настроенные уровни правил, если они заданы. */
    rules?: RslRuleSeverityMap
): Diagnostic[] {
    return applyRslRuleSeverity(diagnostics, rules)
        .sort(compareRslDiagnostics)
        .slice(0, maxProblems);
}

const CACHEABLE_UNIT_STAGES = new Map<string, RslUnitCacheLane>(
    rslUnitCacheLaneRules("text")
        .map(rule => [rule.id, rslUnitCacheLane(rule)] as const)
        .concat(
            rslUnitCacheLaneRules("imports")
                .map(rule => [rule.id, rslUnitCacheLane(rule)] as const)
        )
);

/**
 * Отпечаток ленты кэша.
 *
 * Настройки берутся из реестра проверок этой ленты, а не выписываются
 * заново: выписанный список отставал от таблицы этапов молча.
 */
function unitDiagnosticsFingerprint(
    lane: RslUnitCacheLane,
    options: ReturnType<typeof normalizeDiagnosticSettings>
): string {
    return rslUnitCacheFingerprint(
        lane,
        options as unknown as Record<string, unknown>
    );
}

/**
 * Отпечаток имён, видимых за пределами своей единицы.
 *
 * Проверка присваиваний кэшируется по единицам, но её ответ зависит не
 * только от своей единицы: `parm = 1` в одном Macro перестаёт быть находкой,
 * стоит объявить `Var parm` на уровне модуля или полем класса. Такие имена
 * входят в отпечаток — их правка пересчитывает ленту целиком, а правка тела
 * процедуры не пересчитывает.
 *
 * Входит и признак «в файле есть хоть одно объявление переменной»:
 * проверка молчит в файле, где нет ни одного Var, и первое же объявление
 * обязано включить её во всех единицах. Именно признак, а не число:
 * иначе каждый локальный `Var` внутри процедуры сбрасывал бы ленту
 * целиком — то есть при обычном наборе текста лента не работала бы вовсе.
 */
function moduleWideNamesFingerprint(module: IIndexedModule): string {
    const names: string[] = [];
    let hasVariable = false;

    const walk = (symbol: RslSymbol, prefix: string): void => {
        for (const child of symbol.children) {
            if (VARIABLE_KINDS.has(child.kind)) {
                hasVariable = true;

                if (prefix !== undefined && prefix !== "\u0000") {
                    names.push(prefix + normalizeIdentifier(child.name));
                }

                continue;
            }

            if (child.kind === CompletionItemKind.Class) {
                names.push(
                    "class " + normalizeIdentifier(child.name) +
                    ":" + normalizeIdentifier(child.baseClassName || "")
                );
                walk(child, normalizeIdentifier(child.name) + ".");
                continue;
            }

            /* Внутрь процедур не идём: их переменные видны только там. */
            walk(child, "\u0000");
        }
    };

    walk(module.symbolTree, "");

    return names.sort().join(",") + "#" + hasVariable;
}

/**
 * Ключ замыкания Import.
 *
 * Резолвер знает о нём больше индекса: он видит, какие модули уже дочитаны, а
 * какие ещё нет. Без резолвера остаётся ключ замыкания индекса.
 */
/**
 * Ключ окружения файла: что сервер знает о других модулях.
 *
 * Без самого документа — намеренно. Прежде здесь стоял полный ключ, и он
 * содержал версию открытого файла: лента imports обнулялась на каждой правке
 * и не давала ни одного попадания на всём проекте макросов. Собственное
 * содержимое файла закрывает moduleWideNamesFingerprint, который идёт в тот же
 * отпечаток: новая переменная модуля или новый класс ленту обнуляют, а пробел
 * в теле процедуры — нет.
 */
function importedContextKeyOf(
    index: WorkspaceIndex,
    resolver: RslScopeResolver | undefined,
    uri: string
): string {
    return resolver
        ? resolver.getImportedContextKey(uri)
        : index.getDeclaredImportsKey(uri) + "|" +
            index.getImportedClosureKey(uri);
}

/** Включена ли хоть одна проверка оператора. */
function statementChecksEnabled(
    options: Required<IRslDiagnosticSettings>
): boolean {
    return options.selfAssignment ||
        options.selfComparison ||
        options.constantCondition ||
        options.duplicateBranchCondition ||
        options.unusedExpression;
}

/**
 * Проверки оператора: возобновляемый обход потока и разбор условий.
 *
 * Условия берутся из дерева — там заголовок ветвления лежит целиком, —
 * а операторы из потока: их узлов в дереве нет. Обход один, и он
 * прерывается по бюджету, как и остальные.
 */
function createStatementStage(
    module: IIndexedModule,
    options: Required<IRslDiagnosticSettings>,
    result: Diagnostic[],
    staleUnits: () => readonly IRslDocumentUnit[] | undefined,
    onComplete: () => void
): IRslDiagnosticStage {
    const checkOptions = {
        selfAssignment: options.selfAssignment,
        selfComparison: options.selfComparison,
        constantCondition: options.constantCondition,
        duplicateBranchCondition: options.duplicateBranchCondition,
        unusedExpression: options.unusedExpression,
        maxProblems: options.maxProblems
    };
    /*
     * Обход идёт по изменившимся единицам, а не по всему файлу.
     *
     * Оператор и условие целиком лежат в своей единице, поэтому
     * результат правил зависит ровно от её текста — и переносится на
     * новую версию сдвигом, как у остальных проверок этой ленты.
     */
    let scanned: readonly IRslToken[] | undefined;
    let scanner: IRslStatementScanner | undefined;
    const tokens = (): readonly IRslToken[] => {
        if (!scanned) {
            const stale = staleUnits();

            scanned = stale === undefined
                ? module.syntax.tokens
                : tokensOfRslUnits(module.syntax.tokens, stale);
            scanner = createRslStatementScanner(
                module,
                checkOptions,
                result,
                scanned
            );
        }

        return scanned;
    };

    return createScanStage(
        tokens,
        (token, index) => scanner?.accept(token, index),
        () => {
            const stale = staleUnits();

            checkRslConditions(
                module,
                checkOptions,
                result,
                stale === undefined
                    ? undefined
                    : stale.flatMap(unit => unit.ranges)
            );
            onComplete();
        }
    );
}

/** Полный результат для unit-тестов и batch-клиентов. */
export function buildRslDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    settings?: IRslDiagnosticSettings
): Diagnostic[] {
    const options = normalizeDiagnosticSettings(settings);
    const local = buildLocalRslDiagnostics(module, index, settings);
    const remaining = Math.max(0, options.maxProblems - local.length);
    const workspace = remaining > 0
        ? buildWorkspaceRslDiagnostics(module, index, {
            ...(settings || {}),
            maxProblems: remaining
        })
        : [];
    return deduplicateDiagnostics([...local, ...workspace])
        .slice(0, options.maxProblems);
}

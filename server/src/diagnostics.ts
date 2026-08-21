import * as path from "path";
import { fileURLToPath } from "url";

import {
    CompletionItemKind,
    Diagnostic,
    DiagnosticSeverity,
    DiagnosticTag
} from "vscode-languageserver";

import { RslSymbol } from "./symbols/rslSymbol";
import {
    runRslUnitDiagnosticsWithoutCache,
    tokensOfRslUnits,
    type RslUnitDiagnosticsCache
} from "./diagnostics/unitDiagnosticsCache";
import {
    BLOCK_START_KEYWORDS,
    DECLARATION_MODIFIERS,
    deprecatedConstructMessage,
    END_KEYWORD,
    isRslKeyword,
    isRslSystemConstant,
    isRslType
} from "./language/rslLanguageReference";
import { getScopeChain, RslScopeResolver } from "./scopeResolver";
import {
    GetDynamicMacroReferencesFromTokens,
    GetImportDefinitionTargetsFromTokens,
    IImportDefinitionTarget,
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
    normalizeIdentifier,
    normalizeReferenceIdentifier,
    type RslSquareKind
} from "./lexer";
import {
    buildSpecialVariableDiagnostics,
    normalizeSpecialVariablesMode
} from "./diagnostics/specialVariableDiagnostics";
import {
    isRslSpecialVariableReference,
    isRslSystemSpecialVariableName
} from "./systemSpecialVariables";
import {
    IIndexedModule,
    WorkspaceIndex
} from "./workspaceIndex";

interface IBlockEntry {
    keyword: string;
    token: IRslToken;
    hasElse: boolean;
}

interface IDeclarationInfo {
    symbol: RslSymbol;
    scope: RslSymbol;
    parameter: boolean;
}

interface ILocalDiagnosticFacts {
    declarations: IDeclarationInfo[];
    identifierIndex: Map<string, IRslToken[]>;
    declarationRangeKeys: Set<string>;
}

interface IDiagnosticData {
    start?: number;
    end?: number;
    name?: string;
    parameter?: boolean;
    moduleName?: string;
    replacement?: string;
}

const BLOCK_START = new Set(BLOCK_START_KEYWORDS);
const MODIFIERS = new Set(DECLARATION_MODIFIERS);
const VARIABLE_KINDS = new Set<number>([
    CompletionItemKind.Variable,
    CompletionItemKind.Constant
]);

export const DEFAULT_DIAGNOSTIC_SETTINGS: Required<IRslDiagnosticSettings> = {
    enabled: true,
    deprecatedDeclarations: true,
    structure: true,
    unusedVariables: true,
    unusedImports: true,
    debugBreak: true,
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
    maxProblems: 200
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
                : DEFAULT_DIAGNOSTIC_SETTINGS.maxProblems
    };
}

/**
 * Этап расчёта диагностик.
 *
 * Этапы объявляются списком, а исполняются двумя разными способами: синхронно
 * (тесты, batch-клиенты) и порциями с возвратом в event loop (сервер). Список
 * при этом один — иначе прерываемый расчёт проверял бы не то же самое, что
 * непрерываемый.
 */
export interface IRslDiagnosticPlan {
    /**
     * Этапы получают признак отмены от драйвера.
     *
     * Большинству он не нужен: этап короткий и прерывается на своей границе. Но
     * проверка, обходящая весь поток токенов, обязана спрашивать сама — иначе
     * один этап становится неделимым куском в сотни миллисекунд.
     */
    stages: readonly IRslNamedDiagnosticStage[];
    /** Не пора ли остановиться: лимит Problems исчерпан. */
    hasCapacity(): boolean;
    /**
     * Итог расчёта; complete отвечает, дошли ли до конца.
     *
     * Отменённый расчёт и расчёт, упёршийся в лимит Problems, дают неполный
     * ответ: показать его можно, а запоминать нельзя. Признак передаёт
     * драйвер — только он знает, сам ли план дошёл до последнего этапа.
     */
    finish(complete: boolean): Diagnostic[];
}

/**
 * Этап с именем.
 *
 * Имя нужно не для порядка: без него замер длительности порций отвечал «самая
 * долгая — двадцать вторая», и приходилось пересчитывать этапы вручную, чтобы
 * понять, какую проверку смотреть.
 */
export interface IRslNamedDiagnosticStage {
    name: string;
    run: IRslDiagnosticStage;
}

/** Строка таблицы этапов: имя, признак включённости, работа. */
type IRslDiagnosticStageEntry = [string, boolean, IRslDiagnosticStage];

/** Кому сообщать длительность порции: см. IRslNamedDiagnosticStage. */
export type RslDiagnosticStageObserver = (
    name: string,
    milliseconds: number
) => void;

/**
 * Этап расчёта; true в ответе означает «работа не окончена».
 *
 * Обходы, которые идут по всему файлу, на большом модуле занимают поток на
 * десятки миллисекунд подряд, а управление возвращается event loop только МЕЖДУ
 * этапами — значит такой обход целиком стоит в очереди перед запросом
 * пользователя. Возвращая true, этап отдаёт управление и продолжает с того же
 * места при следующем вызове.
 *
 * Когда прерваться, решает shouldYield — то есть время, а не число элементов.
 * Порция фиксированного размера ничего не гарантирует: «6000 токенов» на
 * загруженной машине выполняются сколько угодно долго, и именно это и
 * наблюдалось — отдельные порции по 19–36 мс.
 *
 * Способ один для обоих режимов: синхронный драйвер не даёт shouldYield вовсе,
 * и этап идёт до конца одним вызовом; порционный передаёт бюджет и делает паузу
 * между вызовами. Иначе прерываемый расчёт проверял бы не то же самое, что
 * непрерываемый.
 */
export type IRslDiagnosticStage = (
    isCancelled?: () => boolean,
    shouldYield?: () => boolean
) => void | boolean;

/*
 * Через сколько элементов сверяться с бюджетом.
 *
 * Date.now() на каждом токене заметен на горячем пути, а раз в 64 — нет: при
 * бюджете 8 мс это доли процента от порции, зато перерасход ограничен временем
 * обработки 64 элементов.
 */
const BUDGET_CHECK_INTERVAL = 64;


/** Пора ли прерваться: бюджет проверяется не на каждом элементе. */
function budgetExpired(
    processed: number,
    shouldYield: (() => boolean) | undefined,
    interval: number = BUDGET_CHECK_INTERVAL
): boolean {
    return shouldYield !== undefined &&
        processed % interval === 0 &&
        processed > 0 &&
        shouldYield();
}

/*
 * Шаг сверки бюджета по областям видимости.
 *
 * На область приходится либо поиск границ её сигнатуры, либо разбор её
 * объявлений — работа не на токен, а на область, поэтому шаг мелкий.
 */
const SCOPE_CHECK_INTERVAL = 4;

/**
 * Возобновляемый обход областей видимости.
 *
 * Дерево символов обходится один раз, до первой паузы: сам обход дешёвый,
 * дорога работа на области. Дальше области перебираются по порядку, и между
 * ними расчёт волен вернуть управление редактору.
 */
function createScopeScanStage(
    tree: RslSymbol,
    step: (scope: RslSymbol) => void,
    finish?: () => void
): IRslDiagnosticStage {
    let scopes: RslSymbol[] | undefined;
    let cursor = 0;

    return (_isCancelled, shouldYield) => {
        /* Бюджет уже израсходован соседним этапом: см. createScanStage. */
        if (shouldYield?.() === true) {
            return true;
        }

        if (!scopes) {
            const list: RslSymbol[] = [];
            walkScopes(tree, scope => {
                list.push(scope);
            });
            scopes = list;
        }

        while (cursor < scopes.length) {
            if (budgetExpired(cursor, shouldYield, SCOPE_CHECK_INTERVAL)) {
                return true;
            }

            step(scopes[cursor]);
            cursor++;
        }

        finish?.();

        return false;
    };
}

/**
 * Возобновляемый обход токенов для проверок с обращением к резолверу.
 *
 * Такие проверки состоят из дешёвого отбора и дорогой части: разрешение имени
 * стоит от десятков микросекунд на знакомом имени до нескольких миллисекунд на
 * первом обращении в файле. Поэтому бюджет сверяется по-разному: на просмотре —
 * изредка, перед дорогой частью — каждый раз. Сама сверка стоит десятки
 * наносекунд, то есть рядом с разрешением имени она бесплатна.
 *
 * prepare выполняется один раз перед обходом и может отменить его целиком:
 * например, когда в файле нет ни одного local-объявления, проверять нечего.
 */
function createResolverScanStage(
    items: () => readonly IRslToken[],
    isCandidate: (tokens: readonly IRslToken[], index: number) => boolean,
    inspect: (tokens: readonly IRslToken[], index: number) => void,
    prepare?: () => boolean
): IRslDiagnosticStage {
    let cursor = 0;
    let prepared = false;
    let skip = false;

    return (_isCancelled, shouldYield) => {
        /* Бюджет уже израсходован соседним этапом: см. createScanStage. */
        if (shouldYield?.() === true) {
            return true;
        }

        if (!prepared) {
            skip = prepare !== undefined && prepare() === false;
            prepared = true;
        }

        if (skip) {
            return false;
        }

        const tokens = items();
        let processed = 0;

        while (cursor < tokens.length) {
            const candidate = isCandidate(tokens, cursor);

            if (
                candidate
                    ? shouldYield?.() === true
                    : budgetExpired(processed, shouldYield)
            ) {
                return true;
            }

            if (candidate) {
                inspect(tokens, cursor);
            }

            cursor++;
            processed++;
        }

        return false;
    };
}

/**
 * Возобновляемый обход последовательности.
 *
 * Состояние проверки живёт в замыкании вызывающего и переживает паузы, поэтому
 * обход, разорванный на порции, видит ровно то же, что видел бы целиком: стек
 * скобок, предыдущий токен, текущая строка — всё продолжается с того же места.
 *
 * finish вызывается один раз после последнего элемента: там, где проверка
 * сообщает о незакрытом до конца файла — например о непарной скобке.
 */
function createScanStage<T>(
    items: () => readonly T[],
    step: (item: T, index: number) => void,
    finish?: () => void
): IRslDiagnosticStage {
    let cursor = 0;
    let finished = false;

    return (_isCancelled, shouldYield) => {
        /*
         * Бюджет мог быть израсходован предыдущим этапом этой же порции. Начать
         * работу сейчас значит превысить бюджет на всю свою длительность,
         * поэтому этап отдаёт управление, ничего не сделав: драйвер сделает
         * паузу, и этап продолжит с того же места в следующей порции.
         */
        if (shouldYield?.() === true) {
            return true;
        }

        const list = items();
        let processed = 0;

        while (cursor < list.length) {
            if (budgetExpired(processed, shouldYield)) {
                return true;
            }

            step(list[cursor], cursor);
            cursor++;
            processed++;
        }

        if (!finished) {
            finished = true;
            finish?.();
        }

        return false;
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

function runDiagnosticPlan(
    plan: IRslDiagnosticPlan,
    isCancelled?: () => boolean
): Diagnostic[] {
    for (const stage of plan.stages) {
        let unfinished = true;

        while (unfinished) {
            if (!plan.hasCapacity() || isCancelled?.()) {
                return plan.finish(false);
            }
            /* Без паузы порции идут подряд: работа та же, что и одним куском. */
            unfinished = stage.run(isCancelled) === true;
        }
    }

    return plan.finish(true);
}

async function runDiagnosticPlanChunked(
    plan: IRslDiagnosticPlan,
    isCancelled: (() => boolean) | undefined,
    slice: IRslWorkSlice,
    onStage?: RslDiagnosticStageObserver
): Promise<Diagnostic[]> {
    for (const stage of plan.stages) {
        let unfinished = true;

        while (unfinished) {
            /*
             * Проверка ПОСЛЕ паузы, а не только до неё: за время паузы могли
             * прийти и смена версии документа, и смена активной вкладки, и
             * отмена запроса.
             */
            await slice.yieldIfNeeded();

            if (!plan.hasCapacity() || isCancelled?.()) {
                return plan.finish(false);
            }

            const started = onStage ? performance.now() : 0;
            unfinished = stage.run(
                isCancelled,
                () => slice.shouldYield()
            ) === true;
            onStage?.(stage.name, performance.now() - started);
        }
    }

    return plan.finish(true);
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
    const hasCapacity = (): boolean =>
        result.length < options.maxProblems;
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
        ? unitCache.begin(module, unitDiagnosticsFingerprint(options))
        : runRslUnitDiagnosticsWithoutCache(module);
    /* Диагностики единиц собираются отдельно: их и запоминает кэш. */
    const unitResult: Diagnostic[] = [];
    const unitTokens = (): readonly IRslToken[] => unitRun.full
        ? module.lex.tokens
        : tokensOfRslUnits(module.lex.tokens, unitRun.stale);
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
        ]
    ];

    const enabled = enabledStages(stages);
    const expectedUnitStages = enabled.filter(stage =>
        CACHEABLE_UNIT_STAGES.has(stage.name)
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

            return deduplicateDiagnostics([
                ...result,
                ...unitResult,
                ...unitRun.reused
            ]).slice(0, options.maxProblems);
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
            (options.unknownVariables !== "off" ||
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
        hasCapacity: () => result.length < options.maxProblems,
        finish: () =>
            deduplicateDiagnostics(result).slice(0, options.maxProblems)
    };
}

function enabledStages(
    stages: readonly IRslDiagnosticStageEntry[]
): readonly IRslNamedDiagnosticStage[] {
    return stages
        .filter(([, enabled]) => enabled)
        .map(([name, , run]) => ({ name, run }));
}

/** План выключенной фазы: этапов нет, результат пуст. */
function emptyPlan(): IRslDiagnosticPlan {
    return {
        stages: [],
        hasCapacity: () => false,
        finish: () => []
    };
}

/**
 * Проверки, результат которых зависит ровно от текста своей единицы.
 *
 * Только они переиспользуются между правками, и только их завершение решает,
 * можно ли запомнить результат.
 */
const CACHEABLE_UNIT_STAGES = new Set([
    "limits",
    "unterminated",
    "deprecated",
    "debugBreak"
]);

/**
 * Отпечаток настроек кэшируемых проверок.
 *
 * В него входят ровно те настройки, от которых зависит результат единицы:
 * включённость проверок, лимит Problems и диалект. При несовпадении прошлая
 * запись не годится — считается весь файл.
 */
function unitDiagnosticsFingerprint(
    options: ReturnType<typeof normalizeDiagnosticSettings>
): string {
    return [
        options.enabled,
        options.structure,
        options.deprecatedDeclarations,
        options.debugBreak,
        options.dialect,
        options.maxProblems
    ].join("|");
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


function addSyntaxParserDiagnostics(
    module: IIndexedModule,
    result: Diagnostic[]
): void {
    module.syntax.diagnostics.forEach(item => {
        result.push(createOffsetDiagnostic(
            module,
            item.start,
            item.end,
            item.severity === "warning"
                ? DiagnosticSeverity.Warning
                : DiagnosticSeverity.Error,
            item.message,
            item.code
        ));
    });
}

/** Ограничения из сводки синтаксиса, проверяемые без построения новых AST. */
/* Ограничения RSL: длина идентификатора и строкового литерала в символах. */
const IDENTIFIER_LIMIT = 80;
const STRING_LIMIT = 2047;
const FILE_STEM_LIMIT = 24;

/**
 * Число символов, а не единиц UTF-16.
 *
 * Считается перебором без создания массива: вызывается на каждом токене, длина
 * которого дошла до предела, а таких в обычном файле нет вовсе.
 */
function countCharacters(value: string): number {
    let count = 0;

    for (const _character of value) {
        count++;
    }

    return count;
}

function addDocumentedLimitDiagnostic(
    _module: IIndexedModule,
    token: IRslToken,
    result: Diagnostic[]
): void {
    if (
        token.kind === "identifier" &&
        /*
         * Дешёвая проверка идёт первой. Число символов может быть только
         * меньше числа единиц UTF-16, поэтому короткое по единицам имя
         * заведомо короткое и по символам — а перебор символов через
         * Array.from создавал массив на каждый идентификатор файла.
         */
        token.value.length > IDENTIFIER_LIMIT &&
        !isSpecialName(token.value) &&
        countCharacters(token.value) > IDENTIFIER_LIMIT
    ) {
        result.push(createTokenDiagnostic(
            token,
            DiagnosticSeverity.Error,
            "Имя идентификатора длиннее допустимых 80 символов",
            "identifier-too-long"
        ));
    } else if (
        token.kind === "string" &&
        token.value.length > STRING_LIMIT &&
        countCharacters(token.value) > STRING_LIMIT
    ) {
        result.push(createTokenDiagnostic(
            token,
            DiagnosticSeverity.Error,
            "Строковый литерал длиннее допустимых 2047 символов",
            "string-literal-too-long",
            false,
            {
                start: token.start,
                end: token.end,
                replacement: splitLongStringLiteral(token.raw)
            }
        ));
    } else if (
        token.kind === "number" &&
        token.raw.startsWith("$") &&
        !/[0-9]/.test(token.raw)
    ) {
        result.push(createTokenDiagnostic(
            token,
            DiagnosticSeverity.Error,
            "Неверная денежная константа",
            "invalid-money-constant"
        ));
    }
}

/** Ограничение на длину имени самого файла: проверяется один раз. */
function addFileNameLimitDiagnostic(
    module: IIndexedModule,
    result: Diagnostic[]
): void {
    const fileName = moduleFileName(module.uri);
    const extension = path.extname(fileName);
    const stem = path.basename(fileName, extension);
    if (
        /^\.mac$/iu.test(extension) &&
        countCharacters(stem) > FILE_STEM_LIMIT
    ) {
        result.push(createOffsetDiagnostic(
            module,
            0,
            Math.min(module.source.length, 1),
            /*
             * "Длина имени макрофайла не должна превышать 24 символа" —
             * та же нормативная формулировка, что и для длины идентификатора
             * (там Error), поэтому здесь тоже Error, а не рекомендация.
             */
            DiagnosticSeverity.Error,
            "Имя macro-файла длиннее допустимых 24 символов",
            "macro-file-name-too-long"
        ));
    }
}

function addImportPlacementDiagnostics(
    module: IIndexedModule,
    result: Diagnostic[]
): void {
    for (const reference of GetImportDefinitionTargetsFromTokens(
        module.lex.tokens
    )) {
        const scope = getScopeChain(module.symbolTree, reference.start);
        const callable = scope.find(item =>
            item.kind === CompletionItemKind.Function ||
            item.kind === CompletionItemKind.Method
        );
        if (!callable) {
            continue;
        }
        result.push(createImportDiagnostic(
            module,
            reference,
            DiagnosticSeverity.Error,
            "IMPORT допустим только вне MACRO",
            "import-inside-macro"
        ));
    }
}

/**
 * Проверка присваивания константам — возобновляемым этапом.
 *
 * Проверка спрашивает у resolver каждое присваивание в файле, и на модуле в
 * 700 КБ это был самый долгий этап расчёта: около 30 мс непрерывной занятости
 * потока.
 */
function createConstantAssignmentStage(
    module: IIndexedModule,
    getResolver: () => RslScopeResolver,
    result: Diagnostic[]
): IRslDiagnosticStage {
    /* Общее для всех порций считается один раз — на первой из них. */
    let declarationStarts = new Set<number>();

    return createResolverScanStage(
        () => cachedSignificantTokens(module.lex.tokens),
        (tokens, index) => index + 1 < tokens.length &&
            isConstantAssignmentCandidate(
                declarationStarts,
                tokens[index],
                tokens[index + 1]
            ),
        (tokens, index) => addConstantAssignmentDiagnostic(
            module,
            getResolver(),
            tokens[index],
            result
        ),
        () => {
            const starts = new Set<number>();
            walkScopes(module.symbolTree, scope => {
                for (const child of scope.children) {
                    if (child.kind === CompletionItemKind.Constant) {
                        starts.add(findObjectNameRange(module, child).start);
                    }
                }
            });
            declarationStarts = starts;

            return true;
        }
    );
}

/** Похоже ли на присваивание константе: проверка без резолвера. */
function isConstantAssignmentCandidate(
    declarationStarts: ReadonlySet<number>,
    token: IRslToken,
    next: IRslToken
): boolean {
    return token.kind === "identifier" &&
        next.kind === "symbol" &&
        next.raw === "=" &&
        !declarationStarts.has(token.start);
}

function addConstantAssignmentDiagnostic(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    token: IRslToken,
    result: Diagnostic[]
): void {
    const resolved = resolver.resolveAt(
        module.uri,
        module.symbolTree,
        token.start
    );

    if (resolved?.symbol.kind !== CompletionItemKind.Constant) {
        return;
    }

    result.push(createTokenDiagnostic(
        token,
        DiagnosticSeverity.Error,
        `Константе ${token.value} нельзя присваивать новое значение`,
        "assignment-to-constant"
    ));
}

/*
 * LOCAL модуля виден только процедуре инициализации модуля и local-процедурам
 * этого же модуля (стр. 43-44 руководства); LOCAL свойство класса видно
 * только конструктору класса и local-методам того же класса. Обращение из
 * любой другой (не-local) процедуры/метода того же файла — ошибка.
 * Кросс-модульная видимость LOCAL уже исключена отдельно (RslSymbol.isPrivate
 * фильтрует local наравне с private при экспорте/поиске из других файлов) —
 * эта проверка касается только ссылок внутри одного файла.
 */
function createLocalVisibilityStage(
    module: IIndexedModule,
    getResolver: () => RslScopeResolver,
    result: Diagnostic[]
): IRslDiagnosticStage {
    const ownerOf = new Map<RslSymbol, RslSymbol>();
    const localDeclarations = new Set<RslSymbol>();
    const declarationStarts = new Set<number>();

    return createResolverScanStage(
        () => cachedSignificantTokens(module.lex.tokens),
        (tokens, index) => tokens[index].kind === "identifier" &&
            !declarationStarts.has(tokens[index].start),
        (tokens, index) => addLocalVisibilityDiagnostic(
            module,
            getResolver(),
            { ownerOf, localDeclarations },
            tokens[index],
            result
        ),
        () => {
            prepareLocalVisibility(
                module,
                ownerOf,
                localDeclarations,
                declarationStarts
            );

            /* Нет local-объявлений — нет и проверки: обходить нечего. */
            return localDeclarations.size > 0;
        }
    );
}

/** Владельцы объявлений и позиции их имён: считается один раз на файл. */
function prepareLocalVisibility(
    module: IIndexedModule,
    ownerOf: Map<RslSymbol, RslSymbol>,
    localDeclarations: Set<RslSymbol>,
    declarationStarts: Set<number>
): void {
    walkScopes(module.symbolTree, scope => {
        for (const child of scope.children) {
            ownerOf.set(child, scope);
        }
    });

    /*
     * visibility === "local" также используется отдельно для параметров
     * (не имеет отношения к модификатору LOCAL) — у них владелец всегда
     * MACRO/METHOD. Модификатор LOCAL по документации применим только на
     * уровне модуля или конструктора класса, поэтому здесь учитываются
     * только "local"-символы, чей владелец — Unit (модуль) или Class.
     *
     * Набор символов собирается наравне с их позициями и проверяется потом на
     * каждой ссылке. Одного visibility там недостаточно: параметр Macro,
     * использованный во вложенном в этот Macro Macro, имеет ровно ту же
     * visibility, и правило про LOCAL модуля объявляло его недоступным —
     * сообщением про процедуру инициализации модуля, к которой он не имеет
     * отношения.
     */
    for (const [symbol, owner] of ownerOf) {
        if (
            symbol.visibility === "local" &&
            (owner.kind === CompletionItemKind.Unit ||
                owner.kind === CompletionItemKind.Class)
        ) {
            localDeclarations.add(symbol);
            declarationStarts.add(findObjectNameRange(module, symbol).start);
        }
    }
}

/** Одна ссылка: доступен ли ей local-объект, на который она указывает. */
function addLocalVisibilityDiagnostic(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    facts: {
        ownerOf: Map<RslSymbol, RslSymbol>;
        localDeclarations: Set<RslSymbol>;
    },
    token: IRslToken,
    result: Diagnostic[]
): void {
    {
        const resolved = resolver.resolveAt(
            module.uri,
            module.symbolTree,
            token.start
        );

        if (!resolved || !facts.localDeclarations.has(resolved.symbol)) {
            return;
        }

        const owner = facts.ownerOf.get(resolved.symbol);

        if (!owner) {
            return;
        }

        const refChain = getScopeChain(module.symbolTree, token.start);
        const ownerIndex = refChain.indexOf(owner);
        const allowed = ownerIndex !== -1 && (
            refChain.length === ownerIndex + 1 ||
            (
                refChain.length === ownerIndex + 2 &&
                refChain[ownerIndex + 1].visibility === "local"
            )
        );

        if (allowed) {
            return;
        }

        const ownerLabel = owner.kind === CompletionItemKind.Class
            ? `конструктора класса ${owner.name}`
            : "процедуры инициализации модуля";
        result.push(createTokenDiagnostic(
            token,
            DiagnosticSeverity.Error,
            `${resolved.symbol.name} — локальный объект ${ownerLabel}; ` +
                "доступен только внутри неё и local-процедур того же уровня",
            "local-visibility-violation"
        ));
    }
}

/*
 * Руководство формулирует запрет доступа к PRIVATE через THIS безусловно
 * (стр. 43), но эта проверка включается только под dialect === "coreRsl"
 * (по умолчанию — "rsBank"). Это осознанное решение: настройка
 * rslPlus.language.dialect описывает rsBank как допускающий расширения
 * платформы сверх базового RSL, а тесты (extended-language-features)
 * явно проверяют, что под rsBank это не ошибка. Включение проверки по
 * умолчанию сгенерировало бы ложные ошибки на распространённом в RS-Bank
 * коде паттерне — поэтому gating оставлен как есть.
 */
function addCoreDialectDiagnostics(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    result: Diagnostic[]
): void {
    const tokens = cachedSignificantTokens(module.lex.tokens);
    for (let index = 0; index + 2 < tokens.length; index++) {
        const owner = tokens[index];
        const dot = tokens[index + 1];
        const member = tokens[index + 2];
        if (
            owner.kind !== "identifier" ||
            normalizeIdentifier(owner.value) !== "this" ||
            dot.kind !== "symbol" ||
            dot.raw !== "." ||
            member.kind !== "identifier"
        ) {
            continue;
        }
        const resolved = resolver.resolveAt(
            module.uri,
            module.symbolTree,
            member.start
        );
        if (!resolved?.symbol.isPrivate) {
            continue;
        }
        result.push(createTokenDiagnostic(
            member,
            DiagnosticSeverity.Error,
            "В базовом RSL PRIVATE-член нельзя вызывать через THIS",
            "core-private-member-through-this"
        ));
    }
}

function addReferenceArgumentDiagnostics(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    result: Diagnostic[]
): void {
    const tokens = cachedSignificantTokens(module.lex.tokens);
    const declarationStarts = new Set<number>();
    walkScopes(module.symbolTree, scope => {
        for (const child of scope.children) {
            if (
                child.kind === CompletionItemKind.Function ||
                child.kind === CompletionItemKind.Method
            ) {
                declarationStarts.add(findObjectNameRange(module, child).start);
            }
        }
    });
    for (let index = 0; index + 1 < tokens.length; index++) {
        const callee = tokens[index];
        const open = tokens[index + 1];
        if (
            callee.kind !== "identifier" ||
            open.kind !== "symbol" ||
            open.raw !== "("
        ) {
            continue;
        }
        if (declarationStarts.has(callee.start)) {
            continue;
        }
        const resolved = resolver.resolveAt(
            module.uri,
            module.symbolTree,
            callee.start
        );
        const references = referenceParameterIndexes(
            resolved?.symbol.parameterText || ""
        );
        if (references.size === 0) {
            continue;
        }
        for (const argument of callArguments(tokens, index + 1)) {
            if (!references.has(argument.index) || argument.tokens.length === 0) {
                continue;
            }
            const first = argument.tokens[0];
            if (first.kind === "symbol" && first.raw === "@") {
                continue;
            }
            result.push(createTokenDiagnostic(
                first,
                DiagnosticSeverity.Error,
                `Параметр ${argument.index + 1} передаётся по ссылке; ` +
                    "перед аргументом требуется @",
                "missing-reference-argument"
            ));
        }
    }
}

function referenceParameterIndexes(parameterText: string): Set<number> {
    const body = parameterText.trim().replace(/^\(/u, "").replace(/\)$/u, "");
    const result = new Set<number>();
    splitTopLevel(body).forEach((parameter, index) => {
        if (/(?:^|:)\s*@/u.test(parameter)) {
            result.add(index);
        }
    });
    return result;
}

function callArguments(
    tokens: readonly IRslToken[],
    openIndex: number
): Array<{ index: number; tokens: IRslToken[] }> {
    const result: Array<{ index: number; tokens: IRslToken[] }> = [];
    let current: IRslToken[] = [];
    let depth = 0;
    for (let index = openIndex + 1; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind === "symbol" && token.raw === "(") {
            depth++;
        } else if (token.kind === "symbol" && token.raw === ")") {
            if (depth === 0) {
                if (current.length > 0) {
                    result.push({ index: result.length, tokens: current });
                }
                break;
            }
            depth--;
        } else if (
            token.kind === "symbol" &&
            token.raw === "," &&
            depth === 0
        ) {
            result.push({ index: result.length, tokens: current });
            current = [];
            continue;
        }
        current.push(token);
    }
    return result;
}

function splitTopLevel(value: string): string[] {
    const result: string[] = [];
    let start = 0;
    let depth = 0;
    for (let index = 0; index < value.length; index++) {
        const char = value.charAt(index);
        if (char === "(" || char === "[" || char === "{") depth++;
        else if (char === ")" || char === "]" || char === "}") depth--;
        else if (char === "," && depth === 0) {
            result.push(value.slice(start, index));
            start = index + 1;
        }
    }
    result.push(value.slice(start));
    return result;
}

function moduleFileName(uri: string): string {
    try {
        return path.basename(fileURLToPath(uri));
    } catch {
        return path.basename(uri);
    }
}

function isSpecialName(value: string): boolean {
    return /^\{[^}\r\n]+\}$/u.test(value);
}

function splitLongStringLiteral(raw: string): string | undefined {
    if (raw.length < 2050 || (raw[0] !== "\"" && raw[0] !== "'")) {
        return undefined;
    }
    const quote = raw[0];
    const body = raw.slice(1, raw.endsWith(quote) ? -1 : undefined);
    const parts: string[] = [];
    let start = 0;
    while (body.length - start > 1800) {
        let end = start + 1800;
        while (end > start && body.charAt(end - 1) === "\\") end--;
        if (end === start) return undefined;
        parts.push(body.slice(start, end));
        start = end;
    }
    parts.push(body.slice(start));
    return parts.map(part => `${quote}${part}${quote}`).join(" +\n");
}

function addDeprecatedDeclarationDiagnostic(
    _module: IIndexedModule,
    token: IRslToken,
    result: Diagnostic[]
): void {

    if (token.kind !== "identifier") {
        return;
    }

    const message = deprecatedConstructMessage(token.value);

    if (!message) {
        return;
    }

    result.push(createTokenDiagnostic(
        token,
        DiagnosticSeverity.Information,
        message,
        "deprecated-declaration"
    ));
}

function addDebugBreakDiagnostic(
    _module: IIndexedModule,
    token: IRslToken,
    result: Diagnostic[]
): void {

    if (
        token.kind !== "identifier" ||
        normalizeIdentifier(token.value) !== "debugbreak"
    ) {
        return;
    }

    result.push(createTokenDiagnostic(
        token,
        DiagnosticSeverity.Warning,
        "В коде оставлен DEBUGBREAK",
        "debugbreak",
        false,
        {
            start: token.start,
            end: token.end
        }
    ));
}


function addUnterminatedTokenDiagnostic(
    _module: IIndexedModule,
    token: IRslToken,
    result: Diagnostic[]
): void {
    if (token.kind === "string" && !isClosedString(token.raw)) {
        result.push(createTokenDiagnostic(
            token,
            DiagnosticSeverity.Error,
            "Строковый литерал не закрыт",
            "unclosed-string"
        ));
    } else if (
        token.kind === "comment" &&
        token.raw.startsWith("/*") &&
        !token.raw.endsWith("*/")
    ) {
        result.push(createTokenDiagnostic(
            token,
            DiagnosticSeverity.Error,
            "Многострочный комментарий не закрыт",
            "unclosed-comment"
        ));
    } else if (
        token.kind === "square" &&
        !isClosedSquareBlock(token.raw, token.squareKind)
    ) {
        result.push(createTokenDiagnostic(
            token,
            DiagnosticSeverity.Error,
            "Блок [ ... ] не закрыт символом ]",
            "unclosed-square-block"
        ));
    }
}


/**
 * Проверка скобок порциями.
 *
 * Стек открытых скобок живёт в замыкании и переживает паузу, поэтому обход,
 * разорванный на порции, видит ровно то же, что видел бы целиком. Прежде обход
 * шёл одним куском: на файле 700 КБ это до 31 мс непрерывной работы.
 */
function createBracketScanner(
    result: Diagnostic[]
): { step(token: IRslToken): void; finish(): void } {
    const stacks: { [close: string]: IRslToken[] } = {
        ")": [],
        "}": []
    };
    const pair: { [open: string]: string } = {
        "(": ")",
        "{": "}"
    };
    const openingFor: { [close: string]: string } = {
        ")": "(",
        "}": "{"
    };

    const step = (token: IRslToken): void => {
        if (token.kind !== "symbol") {
            return;
        }

        const close = pair[token.raw];

        if (close) {
            stacks[close].push(token);
            return;
        }

        if (!stacks[token.raw]) {
            return;
        }

        const opening = stacks[token.raw].pop();

        if (!opening) {
            result.push(createTokenDiagnostic(
                token,
                DiagnosticSeverity.Error,
                `Лишняя закрывающая скобка ${token.raw}`,
                "extra-closing-bracket",
                false,
                {
                    start: token.start,
                    end: token.end
                }
            ));
        }
    };

    /* Незакрытые скобки видны только после последнего токена файла. */
    const finish = (): void => {
        Object.keys(stacks).forEach(close => {
            stacks[close].forEach(opening => {
                result.push(createTokenDiagnostic(
                    opening,
                    DiagnosticSeverity.Error,
                    `Для скобки ${openingFor[close]} не найдена закрывающая ` +
                        close,
                    "missing-closing-bracket"
                ));
            });
        });
    };

    return { step, finish };
}

/**
 * Проверка блоков порциями.
 *
 * Стек открытых блоков, признак начала предложения и текущая строка живут в
 * замыкании и переживают паузу: обход, разорванный на порции, видит то же, что
 * видел бы целиком. Прежде он шёл одним куском — на крупном файле до 12 мс.
 */
function createEndScanner(
    module: IIndexedModule,
    result: Diagnostic[]
): { step(token: IRslToken): void; finish(): void } {
    const stack: IBlockEntry[] = [];
    const onErrorOwners = new Set<string>();
    const unitEndStarts = new Set(
        module.syntax.root.tokens
            .filter(token =>
                token.kind === "identifier" &&
                normalizeIdentifier(token.value) === END_KEYWORD
            )
            .map(token => token.start)
    );
    let canStartBlock = true;
    let currentLine = -1;
    /* END единицы документа заканчивает обход: дальше проверять нечего. */
    let stopped = false;

    const step = (token: IRslToken): void => {
        if (stopped) {
            return;
        }

        if (token.line !== currentLine) {
            currentLine = token.line;
            canStartBlock = true;
        }

        if (token.kind !== "identifier") {
            if (token.kind === "symbol" && token.raw === ";") {
                canStartBlock = true;
            } else {
                canStartBlock = false;
            }
            return;
        }

        const word = normalizeIdentifier(token.value);

        if (word === END_KEYWORD) {
            if (unitEndStarts.has(token.start)) {
                stopped = true;
                return;
            }

            if (stack.length === 0) {
                result.push(createTokenDiagnostic(
                    token,
                    DiagnosticSeverity.Error,
                    "Лишний END: нет открытого блока",
                    "extra-end",
                    false,
                    {
                        start: token.start,
                        end: token.end
                    }
                ));
            } else {
                stack.pop();
            }

            canStartBlock = true;
            return;
        }

        if (canStartBlock && (word === "elif" || word === "else")) {
            const currentIf = stack.length > 0
                ? stack[stack.length - 1]
                : undefined;

            if (!currentIf || currentIf.keyword !== "if") {
                result.push(createTokenDiagnostic(
                    token,
                    DiagnosticSeverity.Error,
                    `${word.toUpperCase()} используется без соответствующего IF`,
                    "branch-without-if"
                ));
            } else if (word === "else") {
                if (currentIf.hasElse) {
                    result.push(createTokenDiagnostic(
                        token,
                        DiagnosticSeverity.Error,
                        "Повторный ELSE в одном блоке IF",
                        "duplicate-else",
                        false,
                        {
                            start: token.start,
                            end: token.end
                        }
                    ));
                } else {
                    currentIf.hasElse = true;
                }
            } else if (currentIf.hasElse) {
                result.push(createTokenDiagnostic(
                    token,
                    DiagnosticSeverity.Error,
                    "ELIF не может располагаться после ELSE",
                    "elif-after-else"
                ));
            }

            canStartBlock = false;
            return;
        }

        /* ONERROR открывает обработчик до END родительского MACRO или EOF. */
        if (canStartBlock && word === "onerror") {
            const owner = stack.length > 0
                ? stack[stack.length - 1]
                : undefined;

            if (
                owner &&
                owner.keyword !== "macro" &&
                owner.keyword !== "class"
            ) {
                result.push(createTokenDiagnostic(
                    token,
                    DiagnosticSeverity.Error,
                    "ONERROR допустим только на уровне файла, MACRO или CLASS",
                    "invalid-onerror-context"
                ));
            } else {
                const ownerKey = owner
                    ? `${owner.keyword}:${owner.token.start}`
                    : "unit";

                if (onErrorOwners.has(ownerKey)) {
                    result.push(createTokenDiagnostic(
                        token,
                        DiagnosticSeverity.Error,
                        "Для одной области допускается только один ONERROR",
                        "duplicate-onerror"
                    ));
                } else {
                    onErrorOwners.add(ownerKey);
                }
            }
            canStartBlock = false;
            return;
        }

        if (!canStartBlock) {
            return;
        }

        if (MODIFIERS.has(word)) {
            return;
        }

        canStartBlock = false;

        if (BLOCK_START.has(word)) {
            stack.push({
                keyword: word,
                token,
                hasElse: false
            });
        }
    };

    /* Незакрытые блоки видны только после последнего токена файла. */
    const finish = (): void => {
        stack.reverse().forEach(block => {
            result.push(createTokenDiagnostic(
                block.token,
                DiagnosticSeverity.Error,
                `Для блока ${block.keyword.toUpperCase()} не найден ` +
                    "закрывающий END",
                "missing-end"
            ));
        });
    };

    return { step, finish };
}

function addUnusedDeclarationDiagnostics(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    facts: ILocalDiagnosticFacts,
    result: Diagnostic[],
    maxProblems: number
): void {
    for (const declaration of facts.declarations) {
        if (result.length >= maxProblems) {
            break;
        }

        const symbol = declaration.symbol;
        const scope = declaration.scope;
        const isLocal = scope.kind === CompletionItemKind.Function ||
            scope.kind === CompletionItemKind.Method;
        const isPrivateModuleDeclaration =
            scope.kind === CompletionItemKind.Unit && symbol.isPrivate;

        /*
         * Публичные глобальные объекты и свойства класса могут использоваться
         * внешней средой или импортирующими файлами.
         */
        if (!isLocal && !isPrivateModuleDeclaration) {
            continue;
        }

        const name = normalizeIdentifier(symbol.name);
        const occurrences = facts.identifierIndex.get(name) || [];
        const used = someTokenInRange(
            occurrences,
            scope.range.start,
            scope.range.end,
            token => {
                if (
                    token.end > scope.range.end ||
                    facts.declarationRangeKeys.has(offsetRangeKey(
                        token.start,
                        token.end
                    ))
                ) {
                    return false;
                }

                const resolved = resolver.resolveAt(
                    module.uri,
                    module.symbolTree,
                    token.start
                );

                return !!resolved &&
                    resolved.uri === module.uri &&
                    resolved.symbol === symbol;
            }
        );

        if (used) {
            continue;
        }

        const kind = declaration.parameter
            ? "Параметр"
            : symbol.kind === CompletionItemKind.Constant
                ? "Константа"
                : "Переменная";
        const declared = kind === "Параметр" ? "объявлен" : "объявлена";
        const range = findObjectNameRange(module, symbol);

        result.push(createOffsetDiagnostic(
            module,
            range.start,
            range.end,
            DiagnosticSeverity.Warning,
            `${kind} ${symbol.name} ${declared}, но не используется`,
            "unused-declaration",
            true,
            {
                start: range.start,
                end: range.end,
                name: symbol.name,
                parameter: declaration.parameter
            }
        ));
    }
}

/*
 * Сколько вхождений имени просматривать между сверками с бюджетом.
 *
 * Резать пришлось именно по вхождениям, а не по объявлениям: на файле 700 КБ
 * все 25 мс этапа уходили на ОДНО объявление, имя которого встречается в модуле
 * тысячи раз, — по числу объявлений такой этап не делится вовсе.
 */
const USE_BEFORE_DECLARATION_CHUNK = 16;

/**
 * Использование до объявления — возобновляемым этапом.
 *
 * Для каждого объявления проверка обходит вхождения его имени выше по тексту и
 * на сомнительных спрашивает resolver. На большом модуле это был самый долгий
 * этап расчёта.
 */
function createUseBeforeDeclarationStage(
    module: IIndexedModule,
    getResolver: () => RslScopeResolver,
    getLocalFacts: () => ILocalDiagnosticFacts,
    result: Diagnostic[],
    maxProblems: number
): IRslDiagnosticStage {
    /* Оба справочника переживают порции: считать их заново незачем. */
    let memberNameStarts: Set<number> | undefined;
    const nestedScopesByScope = new Map<RslSymbol, RslSymbol[]>();
    let declarationIndex = 0;
    /* Сколько вхождений текущего объявления уже просмотрено. */
    let occurrenceIndex = 0;

    return (_isCancelled, shouldYield) => {
        if (shouldYield?.() === true) {
            return true;
        }

        const facts = getLocalFacts();
        const resolver = getResolver();

        if (!memberNameStarts) {
            memberNameStarts = collectMemberNameStarts(module.syntax.tokens);
        }

        while (declarationIndex < facts.declarations.length) {
            if (result.length >= maxProblems) {
                return false;
            }

            /*
             * Бюджет сверяется между порциями вхождений: одно объявление с
             * тысячами вхождений иначе прошло бы целиком за один вызов.
             */
            if (shouldYield?.()) {
                return true;
            }

            const step = addUseBeforeDeclarationDiagnostic(
                module,
                resolver,
                facts,
                memberNameStarts,
                nestedScopesByScope,
                facts.declarations[declarationIndex],
                occurrenceIndex,
                USE_BEFORE_DECLARATION_CHUNK,
                result
            );

            if (step.finished) {
                declarationIndex++;
                occurrenceIndex = 0;
            } else {
                occurrenceIndex = step.nextOccurrence;
            }
        }

        return false;
    };
}

/** Сколько вхождений просмотрено и дошло ли дело до конца объявления. */
interface IUseBeforeDeclarationStep {
    examined: number;
    finished: boolean;
    nextOccurrence: number;
}

function addUseBeforeDeclarationDiagnostic(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    facts: ILocalDiagnosticFacts,
    memberNameStarts: ReadonlySet<number>,
    nestedScopesByScope: Map<RslSymbol, RslSymbol[]>,
    declaration: IDeclarationInfo,
    /* С какого вхождения продолжать: предыдущая порция кончилась на нём. */
    fromOccurrence: number,
    budget: number,
    result: Diagnostic[]
): IUseBeforeDeclarationStep {
    const done: IUseBeforeDeclarationStep = {
        examined: 1,
        finished: true,
        nextOccurrence: 0
    };
    const scope = declaration.scope;

    if (
        declaration.parameter ||
        (
            scope.kind !== CompletionItemKind.Function &&
            scope.kind !== CompletionItemKind.Method
        )
    ) {
        return done;
    }

    const symbol = declaration.symbol;

    /*
     * Повреждённое или неоднозначное дерево не должно превращать
     * служебные слова RSL (IF, VAR и т. п.) в объявления переменных.
     */
    if (isReservedIdentifier(symbol.name)) {
        return done;
    }

    const name = normalizeIdentifier(symbol.name);
    let nestedScopes = nestedScopesByScope.get(scope);

    if (!nestedScopes) {
        nestedScopes = scope.children
            .filter(child => child.isContainer);
        nestedScopesByScope.set(scope, nestedScopes);
    }

    const occurrences = facts.identifierIndex.get(name) || [];
    const first = Math.max(
        fromOccurrence,
        lowerBoundTokenStart(occurrences, scope.range.start)
    );
    const limit = Math.min(occurrences.length, first + budget);
    let index = first;

    for (; index < limit; index++) {
        const token = occurrences[index];

        if (token.start >= symbol.range.start) {
            /* Вхождения дальше объявления к «до объявления» не относятся. */
            break;
        }

        if (
            facts.declarationRangeKeys.has(offsetRangeKey(
                token.start,
                token.end
            )) ||
            memberNameStarts.has(token.start) ||
            nestedScopes.some(child =>
                child !== scope &&
                child.range.start <= token.start &&
                token.end <= child.range.end
            )
        ) {
            continue;
        }

        if (resolver.resolveAt(module.uri, module.symbolTree, token.start)) {
            continue;
        }

        result.push(createTokenDiagnostic(
            token,
            DiagnosticSeverity.Error,
            `Переменная ${symbol.name} используется до объявления`,
            "use-before-declaration",
            false,
            {
                start: token.start,
                end: token.end,
                name: symbol.name
            }
        ));

        /* Сообщение на объявление одно: первое использование и есть ответ. */
        return { examined: index - first + 1, finished: true, nextOccurrence: 0 };
    }

    const examined = Math.max(1, index - first);
    /* Дошли до предела бюджета, а не до конца — продолжим со следующей порции. */
    const finished = index >= occurrences.length ||
        occurrences[index].start >= symbol.range.start;

    return {
        examined,
        finished,
        nextOccurrence: finished ? 0 : index
    };
}

/** Повторные имена внутри одной области видимости. */
function addDuplicateDeclarationDiagnostics(
    module: IIndexedModule,
    scope: RslSymbol,
    result: Diagnostic[]
): void {
    const byName = new Map<string, RslSymbol[]>();

    for (const child of scope.children) {
        const name = normalizeIdentifier(child.name);

        if (!name) {
            continue;
        }

        const list = byName.get(name) || [];
        list.push(child);
        byName.set(name, list);
    }

    byName.forEach(items => {
        if (items.length < 2) {
            return;
        }

        items.slice(1).forEach(item => {
            const nameRange = findObjectNameRange(module, item);
            result.push(createOffsetDiagnostic(
                module,
                nameRange.start,
                nameRange.end,
                DiagnosticSeverity.Warning,
                `Имя ${item.name} повторно объявлено в той же области видимости`,
                "duplicate-declaration"
            ));
        });
    });
}

/**
 * Повторный и конфликтующий по расширению Import.
 *
 * Строго локальная проверка: смотрит только на текст Import текущего файла и
 * не обращается к индексу, поэтому её результат не зависит от готовности
 * обхода workspace (см. addSelfImportDiagnostics).
 */
function addBasicImportDiagnostics(
    module: IIndexedModule,
    result: Diagnostic[]
): void {
    const references = GetImportDefinitionTargetsFromTokens(module.lex.tokens);
    const seenImports = new Set<string>();
    const importedByStem = new Map<string, string>();

    for (const reference of references) {
        const normalizedImport = normalizeModuleReference(reference.moduleName);

        if (seenImports.has(normalizedImport)) {
            result.push(createImportDiagnostic(
                module,
                reference,
                DiagnosticSeverity.Information,
                `Модуль ${reference.moduleName} импортирован повторно`,
                "duplicate-import",
                true,
                {
                    start: reference.start,
                    end: reference.end,
                    moduleName: reference.moduleName
                }
            ));
        } else {
            seenImports.add(normalizedImport);
        }

        const stem = normalizedImport
            .replace(/^.*\//u, "")
            /* Resolver добавляет .mac к неизвестному расширению. */
            .replace(/\.(?:mac|rsm|d32|dlm)$/iu, "")
            .replace(/\.(?:mac|rsm|d32|dlm)$/iu, "");
        const previous = importedByStem.get(stem);
        if (previous && previous !== normalizedImport) {
            result.push(createImportDiagnostic(
                module,
                reference,
                DiagnosticSeverity.Error,
                "Нельзя импортировать файлы с одинаковым именем и " +
                    "разными расширениями",
                "duplicate-import-basename"
            ));
        } else if (stem) {
            importedByStem.set(stem, normalizedImport);
        }

        /*
         * Отсутствие файла в workspace не является ошибкой:
         * модуль может входить в базовую поставку RS-Bank.
         */
    }
}

/**
 * Файл импортирует сам себя.
 *
 * Проверка workspace-фазы, а не локальной: имя из Import сопоставляется с
 * файлом через каталог workspace и загруженные модули, то есть результат
 * зависит от готовности индекса. В локальной фазе она молча пропадала бы на
 * файлах, открытых до завершения обхода workspace — ключ локального кэша
 * состояние индекса не учитывает и пересчёта бы не случилось.
 */
function addSelfImportDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    result: Diagnostic[]
): void {
    for (const reference of GetImportDefinitionTargetsFromTokens(
        module.lex.tokens
    )) {
        const imported = index.findModuleByName(reference.moduleName);
        const workspaceUri = index.findWorkspaceFileUri(reference.moduleName);

        if (
            (imported && imported.uri === module.uri) ||
            workspaceUri === module.uri
        ) {
            result.push(createImportDiagnostic(
                module,
                reference,
                DiagnosticSeverity.Warning,
                `Файл импортирует сам себя: ${reference.moduleName}`,
                "self-import"
            ));
        }
    }
}

interface IUnusedImportContext {
    references: readonly IImportDefinitionTarget[];
    importInfos: Array<{
        reference: IImportDefinitionTarget;
        closureUris: Set<string>;
        publicNames: Set<string>;
    }>;
    allPublicNames: Set<string>;
    usedImportedUris: Set<string>;
}

/**
 * Неиспользуемые Import — порциями.
 *
 * Проверка идёт по всем идентификаторам файла и для похожих на импортированное
 * имя обращается к резолверу. Одним куском на модуле 700 КБ это занимало поток
 * на двадцать миллисекунд; теперь бюджет сверяется перед каждым обращением, а
 * дешёвый просмотр — изредка, как и в остальных таких проверках.
 *
 * Резолвер берётся общий: свой означал бы холодные кэши на каждый пересчёт.
 */
function createUnusedImportStage(
    module: IIndexedModule,
    index: WorkspaceIndex,
    resolver: RslScopeResolver,
    result: Diagnostic[]
): IRslDiagnosticStage {
    let context: IUnusedImportContext | undefined;
    let cursor = 0;

    return (_isCancelled, shouldYield) => {
        /* Бюджет уже израсходован соседним этапом: см. createScanStage. */
        if (shouldYield?.() === true) {
            return true;
        }

        if (!context) {
            context = prepareUnusedImports(module, index);
        }

        const tokens = module.lex.tokens;
        let processed = 0;

        while (cursor < tokens.length) {
            const token = tokens[cursor];
            const candidate = token.kind === "identifier" &&
                context.allPublicNames.has(
                    normalizeIdentifier(token.value)
                ) &&
                !context.references.some(reference =>
                    reference.start <= token.start && token.end <= reference.end
                );

            if (
                candidate
                    ? shouldYield?.() === true
                    : budgetExpired(processed, shouldYield)
            ) {
                return true;
            }

            if (candidate) {
                markUsedImport(module, index, resolver, token, context);
            }

            cursor++;
            processed++;
        }

        reportUnusedImports(module, context, result);

        return false;
    };
}

/** Что импортировано и какие имена оттуда видны: считается один раз. */
function prepareUnusedImports(
    module: IIndexedModule,
    index: WorkspaceIndex
): IUnusedImportContext {
    const references = GetImportDefinitionTargetsFromTokens(module.lex.tokens);
    const dynamicMacroNames = GetDynamicMacroReferencesFromTokens(module.lex.tokens);
    const importInfos: IUnusedImportContext["importInfos"] = [];

    for (const reference of references) {
        const imported = index.findModuleByName(reference.moduleName);

        /* Проверяем только модули, известные текущему проекту. */
        if (!imported || imported.uri === module.uri) {
            continue;
        }

        const closure = [
            imported,
            ...index.getImportedModules(imported.uri)
        ];
        const closureUris = new Set(closure.map(item => item.uri));
        const publicNames = new Set<string>();

        closure.forEach(item => {
            item.symbolTree.children
                .filter(child => !child.isPrivate)
                .filter(child =>
                    child.kind === CompletionItemKind.Variable ||
                    child.kind === CompletionItemKind.Constant ||
                    child.kind === CompletionItemKind.Function ||
                    child.kind === CompletionItemKind.Class
                )
                .forEach(child =>
                    publicNames.add(normalizeIdentifier(child.name))
                );
        });

        importInfos.push({
            reference,
            closureUris,
            publicNames
        });
    }

    const allPublicNames = new Set<string>();
    importInfos.forEach(info =>
        info.publicNames.forEach(name => allPublicNames.add(name))
    );

    const usedImportedUris = new Set<string>();

    /*
     * Динамические вызовы учитываются сразу: их немного, и они не зависят от
     * обхода токенов.
     */
    dynamicMacroNames.forEach(name => {
        index.findImportedSymbols(module.uri, name)
            .forEach(resolved => usedImportedUris.add(resolved.uri));
    });

    return { references, importInfos, allPublicNames, usedImportedUris };
}

/** Одна ссылка: из какого импортированного модуля пришло это имя. */
function markUsedImport(
    module: IIndexedModule,
    index: WorkspaceIndex,
    resolver: RslScopeResolver,
    token: IRslToken,
    context: IUnusedImportContext
): void {
    const candidates = index.findImportedSymbols(module.uri, token.value);

    if (candidates.length > 1) {
        candidates.forEach(candidate =>
            context.usedImportedUris.add(candidate.uri)
        );

        return;
    }

    const resolved = resolver.resolveAt(
        module.uri,
        module.symbolTree,
        token.start
    );

    if (resolved && resolved.uri !== module.uri) {
        context.usedImportedUris.add(resolved.uri);
    }
}

/** Итог обхода: какие Import остались невостребованными. */
function reportUnusedImports(
    module: IIndexedModule,
    context: IUnusedImportContext,
    result: Diagnostic[]
): void {
    const { importInfos, usedImportedUris } = context;

    importInfos.forEach(info => {
        /* Модуль без публичных объявлений может импортироваться ради side effects. */
        if (info.publicNames.size === 0) {
            return;
        }

        const used = Array.from(info.closureUris)
            .some(uri => usedImportedUris.has(uri));

        if (used) {
            return;
        }

        result.push(createImportDiagnostic(
            module,
            info.reference,
            DiagnosticSeverity.Warning,
            `Импорт ${info.reference.moduleName}, возможно, не используется`,
            "unused-import",
            true,
            {
                start: info.reference.start,
                end: info.reference.end,
                moduleName: info.reference.moduleName
            }
        ));
    });
}

function addAmbiguousReferenceDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    result: Diagnostic[]
): void {
    const importedModules = index.getImportedModules(module.uri);
    const byName = new Map<string, Array<{ uri: string; symbol: RslSymbol }>>();

    importedModules.forEach(imported => {
        imported.symbolTree.children
            .filter(child => !child.isPrivate)
            .forEach(child => {
                const name = normalizeIdentifier(child.name);
                const list = byName.get(name) || [];

                if (!list.some(item =>
                    item.uri === imported.uri && item.symbol === child
                )) {
                    list.push({
                        uri: imported.uri,
                        symbol: child
                    });
                }

                byName.set(name, list);
            });
    });

    const ambiguous = new Map<string, Array<{ uri: string; symbol: RslSymbol }>>();
    byName.forEach((items, name) => {
        if (items.length > 1) {
            ambiguous.set(name, items);
        }
    });

    if (ambiguous.size === 0) {
        return;
    }

    const code = module.syntax.tokens;
    const resolver = new RslScopeResolver(index);
    const importReferences = GetImportDefinitionTargetsFromTokens(module.lex.tokens);
    const declarationRangeKeys = new Set(
        collectAllObjectRanges(module.symbolTree).map(range =>
            offsetRangeKey(range.start, range.end)
        )
    );
    const memberNameStarts = collectMemberNameStarts(code);

    for (let tokenIndex = 0; tokenIndex < code.length; tokenIndex++) {
        const token = code[tokenIndex];

        if (token.kind !== "identifier") {
            continue;
        }

        const name = normalizeIdentifier(token.value);
        const candidates = ambiguous.get(name);

        if (
            !candidates ||
            isReservedIdentifier(name) ||
            isRslSystemSpecialVariableReference(code, tokenIndex) ||
            declarationRangeKeys.has(offsetRangeKey(
                token.start,
                token.end
            )) ||
            importReferences.some(reference =>
                reference.start <= token.start && token.end <= reference.end
            ) ||
            memberNameStarts.has(token.start) ||
            resolver.resolveInScopeChain(
                module.symbolTree,
                token.value,
                token.start
            )
        ) {
            continue;
        }

        const moduleNames = candidates
            .map(candidate => formatModuleName(candidate.uri))
            .filter((value, position, all) => all.indexOf(value) === position)
            .sort();

        result.push(createTokenDiagnostic(
            token,
            DiagnosticSeverity.Error,
            `Ссылка ${token.value} неоднозначна: ` +
                `символ объявлен в ${moduleNames.join(", ")}`,
            "ambiguous-reference",
            false,
            {
                start: token.start,
                end: token.end,
                name: token.value
            }
        ));
    }
}

function collectDeclarations(
    module: IIndexedModule,
    codeTokens: IRslToken[]
): IDeclarationInfo[] {
    const result: IDeclarationInfo[] = [];
    const signatureRanges = new Map<
        RslSymbol,
        { start: number; end: number } | undefined
    >();

    walkScopes(module.symbolTree, scope => {
        collectScopeDeclarations(
            codeTokens,
            scope,
            signatureRanges,
            result
        );
    });

    return result;
}

/** Объявления одной области: единица работы порционного сбора. */
function collectScopeDeclarations(
    codeTokens: IRslToken[],
    scope: RslSymbol,
    signatureRanges: Map<RslSymbol, { start: number; end: number } | undefined>,
    result: IDeclarationInfo[]
): void {
    if (
        scope.kind === CompletionItemKind.Function ||
        scope.kind === CompletionItemKind.Method
    ) {
        signatureRanges.set(scope, findSignatureRange(codeTokens, scope));
    }

    for (const child of scope.children) {
        if (
            !VARIABLE_KINDS.has(child.kind) ||
            isReservedIdentifier(child.name)
        ) {
            continue;
        }

        const signature = signatureRanges.get(scope);

        result.push({
            symbol: child,
            scope,
            parameter: !!signature &&
                signature.start < child.range.start &&
                child.range.end <= signature.end
        });
    }
}

/**
 * Справочник объявлений порциями.
 *
 * Раньше он собирался одним куском: обход дерева с поиском границ сигнатуры у
 * каждой процедуры — это в сумме проход по всему файлу, и на модуле 470 КБ он
 * занимал поток на тринадцать миллисекунд подряд. Область — естественная
 * единица работы: её сигнатура ищется целиком, между областями состояние
 * хранить не нужно.
 */
function createDeclarationFactsStage(
    module: IIndexedModule,
    finished: (declarations: IDeclarationInfo[]) => void
): IRslDiagnosticStage {
    const result: IDeclarationInfo[] = [];
    const signatureRanges = new Map<
        RslSymbol,
        { start: number; end: number } | undefined
    >();

    return createScopeScanStage(
        module.symbolTree,
        scope => collectScopeDeclarations(
            module.syntax.tokens,
            scope,
            signatureRanges,
            result
        ),
        () => finished(result)
    );
}

/**
 * Добавляет один токен в индекс вхождений имён.
 *
 * Индекс наполняется порциями, поэтому он передаётся снаружи, а не создаётся
 * здесь: между порциями расчёт возвращает управление редактору, и накопленное
 * обязано сохраниться.
 */
function addToIdentifierIndex(
    index: Map<string, IRslToken[]>,
    token: IRslToken
): void {
    if (token.kind !== "identifier") {
        return;
    }

    const name = normalizeReferenceIdentifier(token.value);

    if (isReservedIdentifier(name)) {
        return;
    }

    const list = index.get(name);

    if (list) {
        list.push(token);
    } else {
        index.set(name, [token]);
    }
}

function isRslSystemSpecialVariableReference(
    tokens: IRslToken[],
    index: number
): boolean {
    const token = tokens[index];
    const previous = tokens[index - 1];
    const next = tokens[index + 1];

    /*
     * Скобки делают именем всё, что внутри: одноимённая переменная модуля к
     * {oper} отношения не имеет, каким бы ни было имя в скобках.
     */
    return token?.kind === "identifier" &&
        (
            isRslSpecialVariableReference(token.raw) ||
            (
                isRslSystemSpecialVariableName(token.value) &&
                previous?.kind === "symbol" &&
                previous.raw === "{" &&
                next?.kind === "symbol" &&
                next.raw === "}"
            )
        );
}

function someTokenInRange(
    tokens: IRslToken[],
    start: number,
    end: number,
    predicate: (token: IRslToken) => boolean
): boolean {
    return findTokenInRange(tokens, start, end, predicate) !== undefined;
}

function findTokenInRange(
    tokens: IRslToken[],
    start: number,
    end: number,
    predicate: (token: IRslToken) => boolean
): IRslToken | undefined {
    for (
        let index = lowerBoundTokenStart(tokens, start);
        index < tokens.length && tokens[index].start < end;
        index++
    ) {
        if (predicate(tokens[index])) {
            return tokens[index];
        }
    }

    return undefined;
}

function lowerBoundTokenStart(tokens: IRslToken[], start: number): number {
    let low = 0;
    let high = tokens.length;

    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);

        if (tokens[middle].start < start) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    return low;
}

function isReservedIdentifier(value: string): boolean {
    const normalized = normalizeIdentifier(value);

    if (!normalized) {
        return true;
    }

    return isRslKeyword(normalized) ||
        isRslType(normalized) ||
        isRslSystemConstant(normalized);
}


function findSignatureRange(
    tokens: IRslToken[],
    scope: RslSymbol
): { start: number; end: number } | undefined {
    let start = -1;
    let depth = 0;
    const firstIndex = lowerBoundByStart(tokens, scope.range.start);

    for (let index = firstIndex; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.start > scope.range.end) {
            break;
        }

        if (token.kind !== "symbol") {
            continue;
        }

        if (token.raw === "(") {
            if (start < 0) {
                start = token.start;
            }

            depth++;
            continue;
        }

        if (token.raw === ")" && start >= 0 && depth > 0) {
            depth--;

            if (depth === 0) {
                return {
                    start,
                    end: token.end
                };
            }
        }
    }

    return undefined;
}

function walkScopes(root: RslSymbol, action: (scope: RslSymbol) => void): void {
    action(root);

    root.children.forEach(child => {
        if (child.isContainer) {
            walkScopes(child, action);
        }
    });
}

function collectAllObjectRanges(
    root: RslSymbol
): Array<{ start: number; end: number }> {
    const result: Array<{ start: number; end: number }> = [];

    walkScopes(root, scope => {
        scope.children.forEach(child => {
            result.push(child.range);
        });
    });

    return result;
}

function collectMemberNameStarts(tokens: IRslToken[]): Set<number> {
    const result = new Set<number>();

    for (let index = 1; index < tokens.length; index++) {
        const previous = tokens[index - 1];
        const token = tokens[index];

        if (
            token.kind === "identifier" &&
            previous.kind === "symbol" &&
            previous.raw === "."
        ) {
            result.add(token.start);
        }
    }

    return result;
}

function lowerBoundByStart(tokens: IRslToken[], offset: number): number {
    let left = 0;
    let right = tokens.length;

    while (left < right) {
        const middle = Math.floor((left + right) / 2);

        if (tokens[middle].start < offset) {
            left = middle + 1;
        } else {
            right = middle;
        }
    }

    return left;
}

function offsetRangeKey(start: number, end: number): string {
    return `${start}:${end}`;
}

// "--" — комментарий только внутри SQL-блока (обычное соглашение SQL).
// У самого RSL комментарии — только двойной слэш и парный блочный, поэтому
// в output-form блоке "--" — это просто декоративная рамка шаблона
// (например, "----------------]"), а не начало комментария, и не должна
// прятать от сканера настоящий закрывающий "]" после неё.
function isClosedSquareBlock(
    raw: string,
    squareKind?: RslSquareKind
): boolean {
    const dashStartsComment = squareKind === "sql";
    let depth = 0;
    let quote = "";

    for (let index = 0; index < raw.length; index++) {
        const char = raw.charAt(index);
        const next = raw.charAt(index + 1);

        if (quote) {
            if (char === quote) {
                if (next === quote) {
                    index++;
                } else {
                    quote = "";
                }
            }
            continue;
        }

        if (char === "'" || char === "\"") {
            quote = char;
            continue;
        }

        if (
            (dashStartsComment && char === "-" && next === "-") ||
            (char === "/" && next === "/")
        ) {
            while (
                index < raw.length &&
                raw.charAt(index) !== "\r" &&
                raw.charAt(index) !== "\n"
            ) {
                index++;
            }
            continue;
        }

        if (char === "/" && next === "*") {
            index += 2;
            while (
                index < raw.length - 1 &&
                !(raw.charAt(index) === "*" && raw.charAt(index + 1) === "/")
            ) {
                index++;
            }
            index++;
            continue;
        }

        if (char === "[") {
            depth++;
        } else if (char === "]") {
            depth--;
            if (depth === 0) {
                return true;
            }
        }
    }

    return false;
}

function normalizeModuleReference(value: string): string {
    return (value || "")
        .trim()
        .replace(/\\/g, "/")
        .toLowerCase();
}

function formatModuleName(uri: string): string {
    try {
        return path.basename(fileURLToPath(uri));
    } catch (_error) {
        return path.posix.basename(uri.replace(/\\/g, "/"));
    }
}

function isClosedString(raw: string): boolean {
    if (raw.length < 2) {
        return false;
    }

    const quote = raw.charAt(0);

    if (raw.charAt(raw.length - 1) !== quote) {
        return false;
    }

    let backslashes = 0;

    for (
        let index = raw.length - 2;
        index >= 0 && raw.charAt(index) === "\\";
        index--
    ) {
        backslashes++;
    }

    return backslashes % 2 === 0;
}

function findObjectNameRange(
    module: IIndexedModule,
    symbol: RslSymbol
): { start: number; end: number } {
    const normalized = normalizeIdentifier(symbol.name);
    const tokens = module.syntax.tokens;
    const firstIndex = lowerBoundByStart(tokens, symbol.range.start);

    for (let index = firstIndex; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.start > symbol.range.end) {
            break;
        }

        if (
            token.kind === "identifier" &&
            normalizeIdentifier(token.value) === normalized
        ) {
            return { start: token.start, end: token.end };
        }
    }

    return symbol.range;
}

function createImportDiagnostic(
    module: IIndexedModule,
    reference: IImportDefinitionTarget,
    severity: DiagnosticSeverity,
    message: string,
    code: string,
    unnecessary: boolean = false,
    data?: IDiagnosticData
): Diagnostic {
    return createOffsetDiagnostic(
        module,
        reference.start,
        reference.end,
        severity,
        message,
        code,
        unnecessary,
        data
    );
}

function createTokenDiagnostic(
    token: IRslToken,
    severity: DiagnosticSeverity,
    message: string,
    code: string,
    unnecessary: boolean = false,
    data?: IDiagnosticData
): Diagnostic {
    const diagnostic: Diagnostic = {
        severity,
        range: {
            start: {
                line: token.line,
                character: token.character
            },
            end: {
                line: token.endLine,
                character: token.endCharacter
            }
        },
        message,
        source: "RSL parser",
        code,
        data
    };

    if (unnecessary) {
        diagnostic.tags = [DiagnosticTag.Unnecessary];
    }

    return diagnostic;
}

function createOffsetDiagnostic(
    module: IIndexedModule,
    start: number,
    end: number,
    severity: DiagnosticSeverity,
    message: string,
    code: string,
    unnecessary: boolean = false,
    data?: IDiagnosticData
): Diagnostic {
    const diagnostic: Diagnostic = {
        severity,
        range: {
            start: positionAt(module, start),
            end: positionAt(module, Math.max(start + 1, end))
        },
        message,
        source: "RSL parser",
        code,
        data
    };

    if (unnecessary) {
        diagnostic.tags = [DiagnosticTag.Unnecessary];
    }

    return diagnostic;
}

function positionAt(
    module: IIndexedModule,
    offset: number
): { line: number; character: number } {
    const starts = module.lex.lineStarts;
    let left = 0;
    let right = starts.length - 1;
    let line = 0;

    while (left <= right) {
        const middle = Math.floor((left + right) / 2);

        if (starts[middle] <= offset) {
            line = middle;
            left = middle + 1;
        } else {
            right = middle - 1;
        }
    }

    return {
        line,
        character: Math.max(0, offset - starts[line])
    };
}

function deduplicateDiagnostics(items: Diagnostic[]): Diagnostic[] {
    const result: Diagnostic[] = [];
    const seen = new Set<string>();

    for (const item of items) {
        const key = [
            item.code,
            item.range.start.line,
            item.range.start.character,
            item.range.end.line,
            item.range.end.character
        ].join(":");

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(item);
    }

    return result;
}

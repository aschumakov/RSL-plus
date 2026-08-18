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
    IImportDefinitionTarget
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
    buildScalarMemberDiagnostics
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
    findUnrecognizedEscapes,
    IRslToken,
    normalizeIdentifier,
    normalizeReferenceIdentifier,
    type RslSquareKind
} from "./lexer";
import {
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
     * Правило о необъявленных переменных выключено: см.
     * unknownVariableDiagnostics. Лишний транзитивный Import — включено с
     * severity Information: это подсказка, а не ошибка, и убирать такой Import
     * или оставлять его страховкой решает автор кода.
     */
    redundantImports: true,
    unknownVariables: "off",
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
    finish(): Diagnostic[];
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

/*
 * Там, где на каждый элемент приходится обращение к resolver, шаг сверки меньше:
 * одно разрешение имени стоит порядка десятка микросекунд, а первое в файле —
 * заметно больше, и 64 таких элемента уже выносят порцию за бюджет.
 */
const RESOLVER_CHECK_INTERVAL = 8;

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
    isCancelled?: () => boolean
): Diagnostic[] {
    return runDiagnosticPlan(
        planLocalRslDiagnostics(module, index, settings),
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
    onStage?: RslDiagnosticStageObserver
): Promise<Diagnostic[]> {
    return runDiagnosticPlanChunked(
        planLocalRslDiagnostics(module, index, settings),
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
                return plan.finish();
            }
            /* Без паузы порции идут подряд: работа та же, что и одним куском. */
            unfinished = stage.run(isCancelled) === true;
        }
    }

    return plan.finish();
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
                return plan.finish();
            }

            const started = onStage ? Date.now() : 0;
            unfinished = stage.run(
                isCancelled,
                () => slice.shouldYield()
            ) === true;
            onStage?.(stage.name, Date.now() - started);
        }
    }

    return plan.finish();
}

function planLocalRslDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    settings?: IRslDiagnosticSettings
): IRslDiagnosticPlan {
    const options = normalizeDiagnosticSettings(settings);

    if (!options.enabled || options.maxProblems === 0) {
        return emptyPlan();
    }

    const result: Diagnostic[] = [];
    const hasCapacity = (): boolean =>
        result.length < options.maxProblems;
    let resolver: RslScopeResolver | undefined;
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
    const getLocalFacts = (): ILocalDiagnosticFacts => {
        if (!localFacts) {
            const declarations = collectDeclarations(
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
                () => module.lex.tokens,
                token => addDocumentedLimitDiagnostic(module, token, result),
                () => addFileNameLimitDiagnostic(module, result)
            )
        ],
        [
            "unterminated",
            options.structure,
            createScanStage(
                () => module.lex.tokens,
                token => addUnterminatedTokenDiagnostic(module, token, result)
            )
        ],
        [
            "escapes",
            options.structure,
            createScanStage(
                () => module.lex.tokens,
                token => addUnrecognizedEscapeDiagnostic(module, token, result)
            )
        ],
        [
            "brackets",
            options.structure,
            () => addBracketDiagnostics(module, result)
        ],
        ["end", options.structure, () => addEndDiagnostics(module, result)],
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
            () => addDuplicateDeclarationDiagnostics(module, result)
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
        [
            "constantAssignment",
            options.structure,
            createConstantAssignmentStage(module, getResolver, result)
        ],
        [
            "localVisibility",
            options.structure,
            () => addLocalVisibilityDiagnostics(module, getResolver(), result)
        ],
        [
            "scalarMembers",
            options.structure,
            () => result.push(...buildScalarMemberDiagnostics(
                module,
                getResolver()
            ))
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
            () => {
                getLocalFacts();
            }
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
                () => module.lex.tokens,
                token => addDeprecatedDeclarationDiagnostic(module, token, result)
            )
        ],
        [
            "debugBreak",
            options.debugBreak,
            createScanStage(
                () => module.lex.tokens,
                token => addDebugBreakDiagnostic(module, token, result)
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

    return {
        stages: enabledStages(stages),
        hasCapacity,
        finish: () =>
            deduplicateDiagnostics(result).slice(0, options.maxProblems)
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
            () => addUnusedImportDiagnostics(module, index, result)
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
            "unknownVariables",
            options.unknownVariables !== "off" &&
                !options.unknownVariablesAuditFile,
            isCancelled => {
                result.push(...buildUnknownVariableDiagnostics(
                    module,
                    resolver,
                    {
                        mode: options.unknownVariables,
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
    let declarationStarts: Set<number> | undefined;
    let cursor = 0;

    return (_isCancelled, shouldYield) => {
        /* Бюджет уже израсходован соседним этапом: см. createScanStage. */
        if (shouldYield?.() === true) {
            return true;
        }

        if (!declarationStarts) {
            const starts = new Set<number>();
            walkScopes(module.symbolTree, scope => {
                for (const child of scope.children) {
                    if (child.kind === CompletionItemKind.Constant) {
                        starts.add(findObjectNameRange(module, child).start);
                    }
                }
            });
            declarationStarts = starts;
        }

        const tokens = cachedSignificantTokens(module.lex.tokens);
        const last = tokens.length - 1;
        let processed = 0;

        while (cursor < last) {
            if (budgetExpired(processed, shouldYield, RESOLVER_CHECK_INTERVAL)) {
                return true;
            }

            addConstantAssignmentDiagnostic(
                module,
                getResolver(),
                declarationStarts,
                tokens[cursor],
                tokens[cursor + 1],
                result
            );
            cursor++;
            processed++;
        }

        return false;
    };
}

function addConstantAssignmentDiagnostic(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    declarationStarts: ReadonlySet<number>,
    token: IRslToken,
    next: IRslToken,
    result: Diagnostic[]
): void {
    if (
        token.kind !== "identifier" ||
        next.kind !== "symbol" ||
        next.raw !== "=" ||
        declarationStarts.has(token.start)
    ) {
        return;
    }

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
function addLocalVisibilityDiagnostics(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    result: Diagnostic[]
): void {
    const ownerOf = new Map<RslSymbol, RslSymbol>();
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
    const localDeclarations = new Set<RslSymbol>();
    const declarationStarts = new Set<number>();
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

    if (localDeclarations.size === 0) {
        return;
    }

    const tokens = cachedSignificantTokens(module.lex.tokens);

    for (const token of tokens) {
        if (token.kind !== "identifier" || declarationStarts.has(token.start)) {
            continue;
        }

        const resolved = resolver.resolveAt(
            module.uri,
            module.symbolTree,
            token.start
        );

        if (!resolved || !localDeclarations.has(resolved.symbol)) {
            continue;
        }

        const owner = ownerOf.get(resolved.symbol);

        if (!owner) {
            continue;
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
            continue;
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

function addUnrecognizedEscapeDiagnostic(
    module: IIndexedModule,
    token: IRslToken,
    result: Diagnostic[]
): void {
    if (token.kind !== "string") {
        return;
    }

    for (const offset of findUnrecognizedEscapes(token.raw)) {
        const start = token.start + offset;
        result.push(createOffsetDiagnostic(
            module,
            start,
            start + 2,
            DiagnosticSeverity.Warning,
            "Неизвестная escape-последовательность; " +
                "допустимы \\n \\r \\t \\f \\xHH \\XHH \\\\",
            "unknown-escape-sequence"
        ));
    }
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


function addBracketDiagnostics(
    module: IIndexedModule,
    result: Diagnostic[]
): void {
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

    for (const token of module.syntax.tokens) {
        if (token.kind !== "symbol") {
            continue;
        }

        const close = pair[token.raw];

        if (close) {
            stacks[close].push(token);
            continue;
        }

        if (!stacks[token.raw]) {
            continue;
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
    }

    Object.keys(stacks).forEach(close => {
        stacks[close].forEach(opening => {
            result.push(createTokenDiagnostic(
                opening,
                DiagnosticSeverity.Error,
                `Для скобки ${openingFor[close]} не найдена закрывающая ${close}`,
                "missing-closing-bracket"
            ));
        });
    });
}

function addEndDiagnostics(
    module: IIndexedModule,
    result: Diagnostic[]
): void {
    const tokens = module.syntax.tokens;
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

    for (const token of tokens) {
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
            continue;
        }

        const word = normalizeIdentifier(token.value);

        if (word === END_KEYWORD) {
            if (unitEndStarts.has(token.start)) {
                break;
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
            continue;
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
            continue;
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
            continue;
        }

        if (!canStartBlock) {
            continue;
        }

        if (MODIFIERS.has(word)) {
            continue;
        }

        canStartBlock = false;

        if (BLOCK_START.has(word)) {
            stack.push({
                keyword: word,
                token,
                hasElse: false
            });
        }
    }

    stack.reverse().forEach(block => {
        result.push(createTokenDiagnostic(
            block.token,
            DiagnosticSeverity.Error,
            `Для блока ${block.keyword.toUpperCase()} не найден закрывающий END`,
            "missing-end"
        ));
    });
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

function addDuplicateDeclarationDiagnostics(
    module: IIndexedModule,
    result: Diagnostic[]
): void {
    walkScopes(module.symbolTree, scope => {
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

function addUnusedImportDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    result: Diagnostic[]
): void {
    const references = GetImportDefinitionTargetsFromTokens(module.lex.tokens);
    const dynamicMacroNames = GetDynamicMacroReferencesFromTokens(module.lex.tokens);
    const importInfos: Array<{
        reference: IImportDefinitionTarget;
        closureUris: Set<string>;
        publicNames: Set<string>;
    }> = [];

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

    const resolver = new RslScopeResolver(index);
    const usedImportedUris = new Set<string>();

    module.lex.tokens
        .filter(token => token.kind === "identifier")
        .filter(token => !references.some(reference =>
            reference.start <= token.start && token.end <= reference.end
        ))
        .filter(token =>
            allPublicNames.has(normalizeIdentifier(token.value))
        )
        .forEach(token => {
            const candidates = index.findImportedSymbols(
                module.uri,
                token.value
            );

            if (candidates.length > 1) {
                candidates.forEach(candidate =>
                    usedImportedUris.add(candidate.uri)
                );
                return;
            }

            const resolved = resolver.resolveAt(
                module.uri,
                module.symbolTree,
                token.start
            );

            if (resolved && resolved.uri !== module.uri) {
                usedImportedUris.add(resolved.uri);
            }
        });

    dynamicMacroNames.forEach(name => {
        index.findImportedSymbols(module.uri, name)
            .forEach(resolved => usedImportedUris.add(resolved.uri));
    });

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
        if (
            scope.kind === CompletionItemKind.Function ||
            scope.kind === CompletionItemKind.Method
        ) {
            signatureRanges.set(
                scope,
                findSignatureRange(codeTokens, scope)
            );
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
    });

    return result;
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

    return token?.kind === "identifier" &&
        (
            (
                token.raw.startsWith("{") &&
                token.raw.endsWith("}") &&
                isRslSystemSpecialVariableName(token.value)
            ) ||
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

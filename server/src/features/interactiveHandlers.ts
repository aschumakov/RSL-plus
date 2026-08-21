import {
    CancellationToken,
    CompletionItemKind,
    Definition,
    Hover,
    SignatureHelp,
    TextDocumentPositionParams,
    type TextDocuments
} from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

import { normalizeIdentifier, tokenAtOffset } from "../lexer";
import { RSL_BUILTIN_URI, type RslScopeResolver } from "../scopeResolver";
import type { RslSymbol } from "../symbols/rslSymbol";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";
import type { PerformanceLogger } from "../performanceLogger";
import type {
    IFastDocumentSnapshot
} from "../services/fastDocumentSnapshot";
import type { ParseWaitMode } from "../services/documentAnalysisService";
import { isBlockedToken, requestIsStale } from "./requestHelpers";
import {
    createRslInteractiveContext,
    type IRslInteractiveContext
} from "./interactiveContext";
import {
    resolveRslReference,
    type IRslReference,
    type IRslReferenceOutcome
} from "./interactiveReferenceResolver";
import {
    buildRslReferenceHover,
    buildRslReferenceSignatureHelp,
    findRslCallAt,
    findRslDynamicDefinition,
    findRslImportModuleDefinition,
    findRslReferenceDefinition,
    findRslReferenceTypeDefinition,
    typeNameOfOwnClass
} from "./interactiveAnswers";
import { buildRslHoverContent } from "./hoverFormatter";
import { buildRslSignatureHelp } from "./signatureHelpProvider";
import type { RslDefinitionProvider } from "./definitionProvider";
import {
    describeFormatSpecifier,
    getFormatSpecifierAt
} from "../parsing/outputFormParser";

/*
 * Интерактивные запросы: переход, переход к типу, Hover и подсказка параметров.
 *
 * Правило «кто отвечает» здесь одно на всех и записано один раз:
 *
 * 1. Строка, комментарий и квадратный блок — ответа нет, разбор не нужен.
 * 2. Доказанное отсутствие символа и неоднозначность — ответа нет, разбор тоже
 *    не нужен: ожидание всё равно ничего не изменит.
 * 3. Разрешённая ссылка — ответ по данным текущей версии. Для Hover и подсказки
 *    параметров готовая модель предпочтительнее: она знает объявление целиком,
 *    выведенный тип и документацию.
 * 4. Только «данных не хватает» разрешает ждать разбор.
 *
 * Раньше эти правила были расписаны в каждом обработчике по-своему, и ответ
 * зависел от того, успел ли закончиться разбор.
 */

export interface IRslInteractiveHandlerEnvironment {
    documents: TextDocuments<TextDocument>;
    index: WorkspaceIndex;
    resolver: RslScopeResolver;
    definitionProvider: RslDefinitionProvider;
    getFastDocumentSnapshot(document: TextDocument): IFastDocumentSnapshot;
    getCurrentModule(document: TextDocument): IIndexedModule | undefined;
    ensureDocumentParsed(
        document: TextDocument,
        mode?: ParseWaitMode
    ): Promise<RslSymbol | undefined>;
    ensureImportedSymbol?(
        fromUri: string,
        symbolName: string
    ): Promise<boolean>;
    noteInteractiveActivity?(): void;
    performance?: PerformanceLogger;
}

/** Бюджет ожидания разбора: дольше пользователь ждёт уже заметно. */
const PARSE_BUDGET_MS = 200;

export interface IRslInteractiveHandlers {
    hover(
        params: TextDocumentPositionParams,
        cancellationToken: CancellationToken
    ): Promise<Hover | null>;
    signatureHelp(
        params: TextDocumentPositionParams,
        cancellationToken: CancellationToken
    ): Promise<SignatureHelp | null>;
    definition(
        params: TextDocumentPositionParams,
        cancellationToken: CancellationToken
    ): Promise<Definition | null>;
    typeDefinition(
        params: TextDocumentPositionParams,
        cancellationToken: CancellationToken
    ): Promise<Definition | null>;
}

export function createRslInteractiveHandlers(
    environment: IRslInteractiveHandlerEnvironment
): IRslInteractiveHandlers {
    const contextAt = (
        document: TextDocument,
        params: TextDocumentPositionParams,
        cancellationToken?: CancellationToken
    ): IRslInteractiveContext => createRslInteractiveContext(
        {
            index: environment.index,
            resolver: environment.resolver,
            getFastDocumentSnapshot: value =>
                environment.getFastDocumentSnapshot(value),
            getCurrentModule: value => environment.getCurrentModule(value)
        },
        document,
        document.offsetAt(params.position),
        () => cancellationToken?.isCancellationRequested === true
    );

    const documentOf = (
        params: TextDocumentPositionParams
    ): TextDocument | undefined => {
        const document = environment.documents.get(params.textDocument.uri);

        if (document) {
            environment.noteInteractiveActivity?.();
        }

        return document;
    };

    /** Дождаться модели этой версии; undefined — не дождались. */
    const awaitModel = async (
        document: TextDocument,
        version: number,
        cancellationToken: CancellationToken,
        mode?: ParseWaitMode
    ): Promise<IIndexedModule | undefined> => {
        await waitForParseBudget(
            environment.ensureDocumentParsed(document, mode),
            PARSE_BUDGET_MS
        );

        if (requestIsStale(document, version, cancellationToken)) {
            return undefined;
        }

        return environment.getCurrentModule(document);
    };

    return {
        async hover(params, cancellationToken) {
            const document = documentOf(params);

            if (!document) {
                return null;
            }

            const version = document.version;
            const context = contextAt(document, params, cancellationToken);
            const specifier = getFormatSpecifierAt(
                context.tokens,
                context.offset
            );

            if (specifier) {
                return {
                    contents: {
                        kind: "markdown",
                        value: "**Спецификатор форматирования :" +
                            specifier.raw + "**  \n" +
                            describeFormatSpecifier(specifier.raw)
                    },
                    range: {
                        start: document.positionAt(specifier.start),
                        end: document.positionAt(specifier.end)
                    }
                };
            }

            /*
             * Готовая модель знает больше: объявление целиком, класс-контейнер,
             * файл и строку. Перехватывать её ответ быстрым значит показывать
             * меньше того, что уже посчитано.
             */
            if (!context.module) {
                const outcome = resolveRslReference(
                    context,
                    environment.index,
                    environment.resolver
                );

                if (isFinalOutcome(outcome)) {
                    return null;
                }

                const answer = outcome.kind === "resolved"
                    ? buildRslReferenceHover(
                        context,
                        environment.index,
                        outcome.reference
                    )
                    : undefined;

                if (answer) {
                    return context.isStale() ? null : answer;
                }
            }

            const model = await awaitModel(
                document,
                version,
                cancellationToken
            );

            return model
                ? modelHover(environment, document, model, context.offset)
                : null;
        },

        async signatureHelp(params, cancellationToken) {
            const document = documentOf(params);

            if (!document) {
                return null;
            }

            const version = document.version;
            const context = contextAt(document, params, cancellationToken);

            if (context.module) {
                /* Модель этой версии готова — она и отвечает: см. Hover. */
                return buildRslSignatureHelp(
                    context.module,
                    environment.resolver,
                    context.offset
                );
            }

            const call = findRslCallAt(context);

            if (!call) {
                return null;
            }

            const outcome = resolveRslReference(
                context,
                environment.index,
                environment.resolver,
                call.callee
            );

            if (isFinalOutcome(outcome)) {
                return null;
            }

            const answer = outcome.kind === "resolved"
                ? buildRslReferenceSignatureHelp(
                    context,
                    outcome.reference,
                    call.activeParameter
                )
                : undefined;

            if (answer) {
                return context.isStale() ? null : answer;
            }

            /*
             * Подсказка ищет вызов по смещению текущей позиции: на модели
             * прошлой версии это смещение указывает в другой текст, поэтому
             * подсказка была бы не устаревшей, а просто чужой.
             */
            const model = await awaitModel(
                document,
                version,
                cancellationToken,
                "force"
            );

            return model
                ? buildRslSignatureHelp(
                    model,
                    environment.resolver,
                    context.offset
                )
                : null;
        },

        async definition(params, cancellationToken) {
            const document = documentOf(params);

            if (!document) {
                return null;
            }

            const performance = environment.performance;
            const span = performance?.enabled
                ? performance.start("definition.resolve", {
                    uri: document.uri,
                    version: document.version
                })
                : undefined;
            let outcomeName = "none";
            let loadedOnDemand = false;

            try {
                const version = document.version;
                const context = contextAt(document, params, cancellationToken);
                /*
                 * Имя модуля в Import и строковая ссылка ExecMacro — это не
                 * ссылки на символ, а имена файлов и процедур: их знает каталог
                 * проекта, и разбор для них не нужен ни до, ни после.
                 */
                const byImport = findRslImportModuleDefinition(
                    context,
                    environment.index
                );

                if (byImport) {
                    outcomeName = "import";
                    return context.isStale() ? null : byImport;
                }

                if (context.token?.kind === "string") {
                    const dynamic = findRslDynamicDefinition(
                        context,
                        environment.index
                    );

                    if (dynamic) {
                        outcomeName = "dynamic";
                        return context.isStale() ? null : dynamic;
                    }
                }

                /*
                 * Индекс версии строится только пока модели нет.
                 *
                 * Он стоит около 50 мс на файле 584 КБ и 6,6 МиБ памяти, а
                 * готовая модель отвечает на то же самое и знает больше.
                 * Прежде первый переход после разбора строил индекс заново —
                 * задержка появлялась как будто случайно, в зависимости от
                 * того, что успело закончиться раньше.
                 */
                if (!context.module) {
                    const reference = resolveRslReference(
                        context,
                        environment.index,
                        environment.resolver
                    );

                    if (isFinalOutcome(reference)) {
                        outcomeName = reference.kind;
                        return null;
                    }

                    if (reference.kind === "resolved") {
                        const target = findRslReferenceDefinition(
                            context,
                            environment.index,
                            reference.reference
                        );

                        if (target) {
                            outcomeName = originName(
                                reference.reference
                            );

                            return context.isStale() ? null : target;
                        }
                    }
                }

                const result = await modelDefinition(
                    environment,
                    document,
                    params,
                    version,
                    cancellationToken,
                    value => {
                        loadedOnDemand = value;
                    }
                );
                outcomeName = result.outcome;

                return result.target;
            } finally {
                if (span) {
                    performance?.end(span, {
                        outcome: outcomeName,
                        loadedOnDemand
                    });
                }
            }
        },

        async typeDefinition(params, cancellationToken) {
            const document = documentOf(params);

            if (!document) {
                return null;
            }

            const version = document.version;
            const context = contextAt(document, params, cancellationToken);
            /* Индекс версии — только пока модели нет: см. переход. */
            const outcome = context.module
                ? { kind: "needs-model" as const }
                : resolveRslReference(
                    context,
                    environment.index,
                    environment.resolver
                );

            if (isFinalOutcome(outcome)) {
                return null;
            }

            if (outcome.kind === "resolved") {
                /*
                 * Явно написанный тип известен и до разбора: у объявления с
                 * типом и у члена класса он записан в самом тексте.
                 */
                const reference = outcome.reference;
                const typeName = reference.typeName ||
                    (reference.origin === "own" && context.token
                        ? typeNameOfOwnClass(
                            context,
                            environment.resolver,
                            context.token
                        )
                        : "");
                const target = typeName
                    ? findRslReferenceTypeDefinition(
                        context,
                        environment.index,
                        environment.resolver,
                        { ...reference, typeName }
                    )
                    : undefined;

                if (target) {
                    return context.isStale() ? null : target;
                }
            }

            /* Тип мог быть выведен из присваивания: это знает только модель. */
            const model = await awaitModel(
                document,
                version,
                cancellationToken
            );

            return model
                ? modelTypeDefinition(
                    environment,
                    document,
                    model,
                    context,
                    context.offset
                )
                : null;
        }
    };
}

/** Ответа не будет, и ждать разбор незачем. */
function isFinalOutcome(
    outcome: IRslReferenceOutcome
): outcome is { kind: "blocked" } | { kind: "not-found" } |
    { kind: "ambiguous" } {
    return outcome.kind === "blocked" ||
        outcome.kind === "not-found" ||
        outcome.kind === "ambiguous";
}

function originName(reference: IRslReference): string {
    return reference.origin;
}

/** Hover по готовой модели. */
function modelHover(
    environment: IRslInteractiveHandlerEnvironment,
    document: TextDocument,
    model: IIndexedModule,
    offset: number
): Hover | null {
    const token = tokenAtOffset(model.lex.tokens, offset, true);

    if (!token || isBlockedToken(token)) {
        return null;
    }

    const resolved = environment.resolver.resolveAt(
        document.uri,
        model.symbolTree,
        offset
    );

    if (!resolved) {
        return null;
    }

    return {
        contents: buildRslHoverContent(
            environment.index,
            resolved.uri,
            resolved.symbol,
            /*
             * Тип из присваивания: у переменной без объявленного типа подсказка
             * иначе писала variant, хотя методы класса по ней уже предлагались.
             */
            environment.resolver.effectiveTypeName(
                document.uri,
                model.symbolTree,
                resolved.symbol,
                offset
            )
        ),
        range: {
            start: document.positionAt(resolved.token.start),
            end: document.positionAt(resolved.token.end)
        }
    };
}

/** Переход к типу по готовой модели. */
function modelTypeDefinition(
    environment: IRslInteractiveHandlerEnvironment,
    document: TextDocument,
    model: IIndexedModule,
    context: IRslInteractiveContext,
    offset: number
): Definition | null {
    const token = tokenAtOffset(model.lex.tokens, offset, true);

    if (token?.kind !== "identifier") {
        return null;
    }

    const resolved = environment.resolver.resolveAt(
        document.uri,
        model.symbolTree,
        offset
    );

    if (!resolved) {
        return null;
    }

    const typeName = environment.resolver.effectiveTypeName(
        document.uri,
        model.symbolTree,
        resolved.symbol,
        offset
    );

    if (!typeName) {
        return null;
    }

    /*
     * Класс своего файла ищется в самой модели: справочник классов знает только
     * подключённые модули и прикладной каталог.
     */
    const wanted = normalizeIdentifier(typeName);
    const ownClass = model.symbolTree.children.find(child =>
        child.kind === CompletionItemKind.Class &&
        normalizeIdentifier(child.name) === wanted
    );
    const found = ownClass
        ? { moduleUri: document.uri, symbol: ownClass }
        : environment.resolver.findFastClass(
            document.uri,
            typeName,
            context.imports
        );

    if (!found || !found.moduleUri) {
        return null;
    }

    const range = environment.index.getDefinitionRange(
        found.moduleUri,
        found.symbol
    );

    return {
        uri: found.moduleUri,
        range: range || {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 }
        }
    };
}

/** Переход по готовой модели: то, что нельзя восстановить по токенам. */
async function modelDefinition(
    environment: IRslInteractiveHandlerEnvironment,
    document: TextDocument,
    params: TextDocumentPositionParams,
    version: number,
    cancellationToken: CancellationToken,
    noteLoadedOnDemand: (value: boolean) => void
): Promise<{ target: Definition | null; outcome: string }> {
    const { definitionProvider, resolver } = environment;

    await environment.ensureDocumentParsed(document);

    if (requestIsStale(document, version, cancellationToken)) {
        return { target: null, outcome: "cancelled" };
    }

    const model = environment.getCurrentModule(document);

    if (!model) {
        return { target: null, outcome: "none" };
    }

    const offset = document.offsetAt(params.position);
    const context = {
        document,
        tree: model.symbolTree,
        offset,
        tokens: model.lex.tokens
    };
    const token = tokenAtOffset(model.lex.tokens, offset, true);

    if (!token) {
        return { target: null, outcome: "none" };
    }

    /*
     * Поиск ходит по файлам и модулям, то есть между его шагами документ может
     * измениться. Смещения сняты до этих шагов, поэтому версия сверяется после
     * каждого ожидания: иначе переход уводил бы на сдвинувшееся место.
     */
    const stale = (): boolean =>
        requestIsStale(document, version, cancellationToken);
    const importedFile = await definitionProvider.findImportDefinition(context);

    if (stale()) {
        return { target: null, outcome: "cancelled" };
    }

    if (importedFile) {
        return { target: importedFile, outcome: "import" };
    }

    if (token.kind === "string") {
        const dynamic = await definitionProvider.findDynamicDefinition(context);

        if (stale()) {
            return { target: null, outcome: "cancelled" };
        }

        if (dynamic) {
            return { target: dynamic, outcome: "dynamic" };
        }
    }

    if (isBlockedToken(token)) {
        return { target: null, outcome: "none" };
    }

    let resolved = resolver.resolveAt(document.uri, model.symbolTree, offset);

    if (!resolved && token.kind === "identifier" &&
        environment.ensureImportedSymbol) {
        noteLoadedOnDemand(
            await environment.ensureImportedSymbol(document.uri, token.value)
        );

        if (stale()) {
            return { target: null, outcome: "cancelled" };
        }

        resolved = resolver.resolveAt(
            document.uri,
            model.symbolTree,
            offset
        );
    }

    if (!resolved) {
        return { target: null, outcome: "none" };
    }

    if (resolved.uri === RSL_BUILTIN_URI) {
        /*
         * У инициализатора базового класса объявления нет, но осмысленная цель
         * перехода есть — сам базовый класс.
         */
        const baseClass = resolver.resolveBaseInitializerClass(
            document.uri,
            model.symbolTree,
            offset
        );

        if (baseClass && baseClass.uri !== RSL_BUILTIN_URI) {
            const base = await definitionProvider
                .createObjectLocationByUri(
                    baseClass.uri,
                    baseClass.symbol
                );

            return stale()
                ? { target: null, outcome: "cancelled" }
                : { target: base, outcome: "baseInitializer" };
        }

        return { target: null, outcome: "builtin" };
    }

    /*
     * Место объявления читается из файла назначения, а это ожидание: за него
     * документ мог уйти вперёд. Ответ по прежним смещениям открыл бы не то
     * место, поэтому версия сверяется и здесь — последней проверкой.
     */
    const target = await definitionProvider.createObjectLocationByUri(
        resolved.uri,
        resolved.symbol
    );

    if (stale()) {
        return { target: null, outcome: "cancelled" };
    }

    return {
        target,
        outcome: resolved.uri === document.uri ? "local" : "imported"
    };
}

/**
 * Ожидание разбора с бюджетом.
 *
 * Бюджет нужен, чтобы медленный разбор большого файла не превращал переход в
 * зависание: не дождались — отвечаем тем, что есть.
 */
function waitForParseBudget(
    pending: Promise<unknown>,
    budgetMs: number
): Promise<void> {
    return new Promise(resolve => {
        let timer: NodeJS.Timeout | undefined;
        let settled = false;
        const finish = (): void => {
            if (settled) {
                return;
            }

            settled = true;

            if (timer) {
                clearTimeout(timer);
            }

            resolve();
        };

        timer = setTimeout(finish, budgetMs);
        pending.then(finish, finish);
    });
}

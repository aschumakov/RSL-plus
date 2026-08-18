import {
    CancellationToken,
    CodeActionKind,
    CodeActionParams,
    CodeActionTriggerKind,
    CompletionItem,
    type CompletionParams,
    CompletionTriggerKind,
    Definition,
    DocumentHighlightParams,
    ErrorCodes,
    ExecuteCommandParams,
    Hover,
    Range,
    ReferenceParams,
    ResponseError,
    SelectionRangeParams,
    TextDocumentPositionParams,
    type Connection,
    type TextDocuments
} from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

import { RslSymbol } from "../symbols/rslSymbol";
import { RslDefinitionProvider } from "./definitionProvider";
import { getDefaults } from "../defaults";
import { buildEnhancedRslCodeActions } from "./enhancedCodeActions";
import { buildRslDocumentHighlights } from "./documentHighlights";
import { buildRslHoverContent } from "./hoverFormatter";
import {
    buildBlockNavigationActions,
    buildSelectionRanges,
    GO_TO_BLOCK_END_COMMAND,
    GO_TO_BLOCK_START_COMMAND,
    resolveCurrentBlockRange,
    resolveBlockNavigationPosition
} from "./blockNavigation";
import { normalizeIdentifier } from "../lexer";
import type { IRslSettings } from "../interfaces";
import { tokenAtOffset, type IRslToken } from "../lexer";
import {
    describeFormatSpecifier,
    getFormatSpecifierAt
} from "../parsing/outputFormParser";
import { findRslReferencesInWorkspace } from "../analysis/references";
import { ReferenceIndex } from "../analysis/referenceIndex";
import {
    getFastDocumentImports,
    type IFastDocumentSnapshot
} from "../services/fastDocumentSnapshot";
import {
    buildRslFastCompletions,
    buildRslFastMemberCompletions,
    buildRslFastOwnClassMembers
} from "./fastCompletionProvider";
import {
    dropFastCompletionIndex,
    findFastClass,
    getFastCompletionIndex,
    type IFastCompletionIndex
} from "./fastCompletionIndex";
import type {
    ParseWaitMode
} from "../services/documentAnalysisService";
import {
    RSL_BUILTIN_URI,
    RslScopeResolver,
    type IRslFastClass
} from "../scopeResolver";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";
import type { PerformanceLogger } from "../performanceLogger";
import {
    buildKnownAutoImportCompletions,
    buildMissingImportActions
} from "./autoImportProvider";
import {
    RslCallHierarchyProvider
} from "./callHierarchyProvider";
import { buildRslSignatureHelp } from "./signatureHelpProvider";
import { buildRslContextCompletions } from "./contextCompletionProvider";
import { buildRslInlayHints } from "./inlayHintProvider";
import {
    completionPrefixAt,
    rankCompletionItemsForPrefix
} from "./completionRanking";
import { findRslWorkspaceSymbols } from "./workspaceSymbolProvider";
import {
    buildRslSourceCodeActions,
    RSL_FIX_ALL_KIND
} from "./sourceCodeActions";
import { CompletionTransport } from "./completionTransport";
import { PresentationFeatureRegistry } from "./presentationFeatureRegistry";
import { SemanticTokensFeatureRegistry } from "./semanticTokensFeatureRegistry";
import {
    buildRslRenameEdit,
    findRslRenameConflict,
    prepareRslRename
} from "./renameProvider";

interface IRslCurrentBlockRangeParams {
    textDocument: { uri: string };
    position: { line: number; character: number };
    currentRange?: Range;
}

export interface IRslLanguageFeatureEnvironment {
    connection: Connection;
    documents: TextDocuments<TextDocument>;
    index: WorkspaceIndex;
    resolver: RslScopeResolver;
    definitionProvider: RslDefinitionProvider;
    referenceIndex?: ReferenceIndex;
    getFastDocumentSnapshot(document: TextDocument): IFastDocumentSnapshot;
    ensureDocumentParsed(
        document: TextDocument,
        mode?: ParseWaitMode
    ): Promise<RslSymbol | undefined>;
    /** Разбор нужен, но debounce набора текста не снимается. */
    requestDocumentParse?(document: TextDocument): void;
    ensureImportedSymbol?(
        fromUri: string,
        symbolName: string
    ): Promise<boolean>;
    findAutoImportModules?(
        symbolName: string,
        options: {
            scanWorkspace: boolean;
            isCancelled(): boolean;
        }
    ): Promise<import("../workspaceIndex").IIndexedModule[]>;
    getSettings(uri: string): IRslSettings;
    /** Клиент умеет перезапрашивать semantic tokens по просьбе сервера. */
    supportsRefresh?(): boolean;
    noteInteractiveActivity?(): void;
    log(message: string): void;
    performance?: PerformanceLogger;
}

interface IPositionContext {
    document: TextDocument;
    tree: RslSymbol;
    offset: number;
    token?: IRslToken;
    tokens: IRslToken[];
}

/** Регистрирует LSP provider-ы и владеет их versioned-кэшами. */
export class RslLanguageFeatureRegistry {
    private defaultCompletionItems = getDefaults().completionItems;
    private registered = false;
    private referenceIndex: ReferenceIndex;
    private callHierarchyProvider: RslCallHierarchyProvider;
    private completionTransport = new CompletionTransport();
    private presentationFeatures: PresentationFeatureRegistry;
    private semanticTokensFeatures: SemanticTokensFeatureRegistry;
    /** Файлы, которым отдали пустые подсказки: модель тогда не была готова. */
    private pendingInlayHints = new Set<string>();
    private inlayRefreshTimer: NodeJS.Timeout | undefined;

    constructor(private environment: IRslLanguageFeatureEnvironment) {
        this.referenceIndex = environment.referenceIndex || new ReferenceIndex();
        this.callHierarchyProvider = new RslCallHierarchyProvider({
            index: environment.index,
            resolver: environment.resolver,
            referenceIndex: this.referenceIndex
        });
        this.presentationFeatures = new PresentationFeatureRegistry(environment);
        this.semanticTokensFeatures = new SemanticTokensFeatureRegistry({
            ...environment,
            /* Базовая подсветка берёт токены из быстрого снимка. */
            getFastLexTokens: document =>
                environment.getFastDocumentSnapshot(document).lex.tokens
        });
    }

    register(): void {
        if (this.registered) {
            return;
        }

        this.registered = true;
        this.presentationFeatures.register();
        this.semanticTokensFeatures.register();
        const {
            connection,
            documents,
            index,
            resolver,
            definitionProvider,
            ensureDocumentParsed
        } = this.environment;

        connection.onCompletion(async (
            params: CompletionParams,
            cancellationToken: CancellationToken
        ) => {
            const document = documents.get(params.textDocument.uri);

            if (!document) {
                return { isIncomplete: false, items: [] };
            }

            this.environment.noteInteractiveActivity?.();
            const version = document.version;
            /*
             * Ctrl+Space и trigger-символ — это действие пользователя: он
             * открыл список и ждёт его сейчас. Такой запрос назначает разбор
             * сам. Обычный набор букв, наоборот, идёт потоком и лишь ждёт
             * уже назначенный: иначе именно Completion и снимал бы склейку
             * правок, ради которой она сделана.
             */
            const waitMode: ParseWaitMode = isExplicitCompletion(params)
                ? "force"
                : "scheduled";
            /*
             * Спан покрывает и ожидание модели: по одному лишь analysis.full
             * не видно, какой запрос его вызвал и сколько ждал сам запрос.
             */
            const span = this.environment.performance?.enabled
                ? this.environment.performance.start("completion", {
                    uri: document.uri,
                    version,
                    waitMode
                })
                : undefined;
            const finish = <T>(
                result: T,
                fields: Record<string, string | number | boolean>
            ): T => {
                if (span) {
                    this.environment.performance!.end(span, fields);
                }
                return result;
            };
            /*
             * Бюджет ожидания короткий, а не 200 мс.
             *
             * Полный бюджет имел смысл, когда альтернативой был пустой список:
             * лучше подождать, чем ответить «ничего нет». Теперь есть
             * приблизительный ответ из быстрого снимка, и ждать модель дольше
             * пары десятков миллисекунд значит держать список закрытым ровно
             * тогда, когда пользователь его открыл. Разбор при этом не
             * отменяется — по его готовности клиент перезапросит список.
             */
            /*
             * Модель либо уже готова, либо ответ будет приблизительным.
             *
             * Ждать здесь нечего: бюджет ожидания был не жёстким. Пока идёт
             * синхронная фаза разбора, таймер сработать не может — управление
             * к нему не возвращается, — и на загруженной машине «25 мс»
             * превращались в сколько угодно. Разбор всё равно назначается, а
             * isIncomplete заставит клиента перезапросить список по готовности.
             */
            const module = this.getRequestModule(document);

            if (!module) {
                /*
                 * Разбор идёт своим ходом, но его отказ обязан быть перехвачен:
                 * отделённый Promise без catch превращает ошибку разбора в
                 * необработанное отклонение и валит процесс сервера.
                 */
                ensureDocumentParsed(document, waitMode).catch(error =>
                    this.environment.log(
                        `Completion: разбор не удался; ${errorText(error)}`
                    )
                );

                if (requestIsStale(document, version, cancellationToken)) {
                    return finish(
                        { isIncomplete: false, items: [] },
                        { cancelled: true, items: 0 }
                    );
                }

                /*
                 * Пустым списком отвечать нельзя: пользователь читает его как
                 * «в файле ничего нет». Состав — из быстрого снимка плюс то,
                 * что от модели не зависит: встроенные имена и символы
                 * прочитанных Import.
                 */
                const snapshot = this.environment.getFastDocumentSnapshot(
                    document
                );
                const offset = document.offsetAt(params.position);
                /*
                 * Компактный индекс версии вместо повторного извлечения.
                 *
                 * Прежде каждый запрос заново обходил весь файл: на модуле
                 * 237 КБ это 6 мс в медиане и до 29 мс в худшем случае, и так
                 * на каждое нажатие клавиши.
                 */
                const fastIndex = getFastCompletionIndex(snapshot);
                const members = buildRslFastMemberCompletions(
                    snapshot,
                    offset,
                    name => this.findFastClassMembers(
                        document,
                        name,
                        fastIndex,
                        offset
                    ),
                    fastIndex
                );
                const fast = members || deduplicateCompletionItems(
                    buildRslFastCompletions(snapshot, offset, fastIndex),
                    this.defaultCompletionItems,
                    this.knownImportCompletions(document)
                );

                return finish(
                    {
                        isIncomplete: true,
                        items: this.completionTransport.prepare(fast).items
                    },
                    {
                        pendingModel: true,
                        source: members ? "fastMembers" : "fastNames",
                        items: fast.length
                    }
                );
            }

            if (requestIsStale(document, version, cancellationToken)) {
                return finish(
                    { isIncomplete: false, items: [] },
                    { cancelled: true, items: 0 }
                );
            }
            const contextual = buildRslContextCompletions(
                module,
                index,
                document.offsetAt(params.position),
                resolver
            );
            if (contextual !== undefined) {
                return finish(
                    this.completionTransport.prepare(contextual),
                    { source: "context", items: contextual.length }
                );
            }
            const context = this.getPositionContext(params);

            if (!context || isBlockedToken(context.token)) {
                return finish(
                    { isIncomplete: false, items: [] },
                    { blocked: true, items: 0 }
                );
            }

            const prefix = completionPrefixAt(
                module.source,
                context.offset
            );
            const items = deduplicateCompletionItems(
                resolver.getCompletions(
                    document.uri,
                    context.tree,
                    context.offset
                ),
                this.defaultCompletionItems,
                this.environment.getSettings(document.uri).autoImport.enabled
                    ? buildKnownAutoImportCompletions(
                        module,
                        index,
                        prefix
                    )
                    : []
            );
            return finish(
                this.completionTransport.prepare(
                    rankCompletionItemsForPrefix(items, prefix)
                ),
                { source: "scope", items: items.length }
            );
        });

        connection.onCompletionResolve(item =>
            this.completionTransport.resolve(item)
        );

        connection.onSignatureHelp(async (params, cancellationToken) => {
            const document = documents.get(params.textDocument.uri);
            if (!document) {
                return null;
            }

            this.environment.noteInteractiveActivity?.();
            const version = document.version;
            /*
             * Приходит только на «(» и «,» — то есть всегда по действию
             * пользователя, а не потоком на каждую букву. Ждать здесь склейку
             * правок значит показать подсказку параметров с опозданием ровно
             * в тот момент, когда пользователь начал писать аргументы.
             */
            await waitForParseBudget(
                ensureDocumentParsed(document, "force"),
                INTERACTIVE_PARSE_BUDGET_MS
            );
            if (requestIsStale(document, version, cancellationToken)) {
                return null;
            }
            /*
             * Signature Help ищет вызов по offset текущей позиции. На модели
             * прошлой версии этот offset указывает в другой текст, поэтому
             * подсказка была бы не устаревшей, а просто чужой.
             */
            const module = this.getRequestModule(document);
            return module
                ? buildRslSignatureHelp(
                    module,
                    resolver,
                    document.offsetAt(params.position)
                )
                : null;
        });

        connection.onHover(async (
            params: TextDocumentPositionParams,
            cancellationToken: CancellationToken
        ): Promise<Hover | null> => {
            const document = documents.get(params.textDocument.uri);

            if (!document) {
                return null;
            }

            this.environment.noteInteractiveActivity?.();
            const version = document.version;
            await waitForParseBudget(
                ensureDocumentParsed(document),
                INTERACTIVE_PARSE_BUDGET_MS
            );
            if (requestIsStale(document, version, cancellationToken)) {
                return null;
            }
            const context = this.getPositionContext(params);

            if (!context || isBlockedToken(context.token)) {
                return null;
            }

            const formatSpecifier = getFormatSpecifierAt(
                context.tokens,
                context.offset
            );
            if (formatSpecifier) {
                return {
                    contents: {
                        kind: "markdown",
                        value:
                            `**Спецификатор форматирования :${formatSpecifier.raw}**  \n` +
                            describeFormatSpecifier(formatSpecifier.raw)
                    },
                    range: {
                        start: document.positionAt(formatSpecifier.start),
                        end: document.positionAt(formatSpecifier.end)
                    }
                };
            }

            const resolved = resolver.resolveAt(
                document.uri,
                context.tree,
                context.offset
            );

            if (!resolved) {
                return null;
            }

            return {
                contents: buildRslHoverContent(
                    index,
                    resolved.uri,
                    resolved.symbol,
                    /*
                     * Тип из присваивания: у переменной без объявленного типа
                     * подсказка иначе писала variant, хотя методы класса по
                     * ней уже предлагались.
                     */
                    resolver.effectiveTypeName(
                        document.uri,
                        context.tree,
                        resolved.symbol,
                        context.offset
                    )
                ),
                range: {
                    start: document.positionAt(resolved.token.start),
                    end: document.positionAt(resolved.token.end)
                }
            };
        });

        connection.onDocumentHighlight(async (
            params: DocumentHighlightParams,
            cancellationToken: CancellationToken
        ) => {
            const document = documents.get(params.textDocument.uri);
            if (!document) {
                return [];
            }

            this.environment.noteInteractiveActivity?.();
            const version = document.version;
            /*
             * Подсветка вхождений идёт за курсором, а он двигается на каждый
             * набранный символ. Это фон, а не действие пользователя.
             */
            await ensureDocumentParsed(document, "scheduled");
            if (requestIsStale(document, version, cancellationToken)) {
                return [];
            }
            const context = this.getPositionContext(params);
            /*
             * Модель именно этой версии: проверка выше говорит лишь о том, что
             * документ не изменился, а в индексе может лежать модель прежней
             * версии, чей разбор для текущей ещё не завершён. Позиции в ней
             * сдвинуты, и подсветка легла бы на чужие места.
             */
            const module = index.getCurrentModule(document.uri, version);
            if (!context || !module || isBlockedToken(context.token)) {
                return [];
            }

            return buildRslDocumentHighlights(
                module,
                index,
                resolver,
                context.offset
            );
        });

        connection.onDefinition(async (
            params: TextDocumentPositionParams,
            cancellationToken: CancellationToken
        ): Promise<Definition | null> => {
            const document = documents.get(params.textDocument.uri);

            if (!document) {
                return null;
            }

            const performance = this.environment.performance;
            const span = performance?.enabled
                ? performance.start("definition.resolve", {
                    uri: document.uri,
                    version: document.version
                })
                : undefined;
            let outcome = "none";
            let loadedOnDemand = false;

            try {
                this.environment.noteInteractiveActivity?.();
                const version = document.version;
                await ensureDocumentParsed(document);
                if (requestIsStale(document, version, cancellationToken)) {
                    outcome = "cancelled";
                    return null;
                }
                const context = this.getPositionContext(params);

                if (!context || !context.token) {
                    return null;
                }

                if (
                    context.token.kind === "comment" ||
                    context.token.kind === "square"
                ) {
                    return null;
                }

                /*
                 * Поиск определения ходит по файлам и модулям, то есть между
                 * его шагами документ может измениться. context со смещениями
                 * снят до этих шагов, поэтому ответ, посчитанный по нему после
                 * правки, указывал бы на сдвинувшееся место — переход уводил бы
                 * не туда. Поэтому версия сверяется после каждого ожидания.
                 */
                const stale = () =>
                    requestIsStale(document, version, cancellationToken);

                const importedFile = await definitionProvider
                    .findImportDefinition(context);

                if (stale()) {
                    outcome = "cancelled";
                    return null;
                }

                if (importedFile) {
                    outcome = "import";
                    return importedFile;
                }

                if (context.token.kind === "string") {
                    const dynamic = await definitionProvider
                        .findDynamicDefinition(context);

                    if (stale()) {
                        outcome = "cancelled";
                        return null;
                    }

                    if (dynamic) {
                        outcome = "dynamic";
                        return dynamic;
                    }
                }

                if (isBlockedToken(context.token)) {
                    return null;
                }

                let resolved = resolver.resolveAt(
                    document.uri,
                    context.tree,
                    context.offset
                );
                const identifierToken = tokenAtOffset(
                    context.tokens,
                    context.offset,
                    true
                );

                if (
                    !resolved &&
                    identifierToken?.kind === "identifier" &&
                    this.environment.ensureImportedSymbol
                ) {
                    loadedOnDemand =
                        await this.environment.ensureImportedSymbol(
                            document.uri,
                            identifierToken.value
                        );

                    if (stale()) {
                        outcome = "cancelled";
                        return null;
                    }

                    resolved = resolver.resolveAt(
                        document.uri,
                        context.tree,
                        context.offset
                    );
                }

                if (!resolved) {
                    return null;
                }

                if (resolved.uri === RSL_BUILTIN_URI) {
                    /*
                     * У инициализатора базового класса объявления нет, но
                     * осмысленная цель перехода есть — сам базовый класс.
                     */
                    const baseClass = resolver.resolveBaseInitializerClass(
                        document.uri,
                        context.tree,
                        context.offset
                    );

                    if (baseClass && baseClass.uri !== RSL_BUILTIN_URI) {
                        outcome = "baseInitializer";
                        return definitionProvider.createObjectLocationByUri(
                            baseClass.uri,
                            baseClass.symbol
                        );
                    }

                    outcome = "builtin";
                    return null;
                }

                outcome = resolved.uri === document.uri
                    ? "local"
                    : "imported";
                return definitionProvider.createObjectLocationByUri(
                    resolved.uri,
                    resolved.symbol
                );
            } finally {
                if (span) {
                    performance.end(span, {
                        outcome,
                        loadedOnDemand
                    });
                }
            }
        });

        connection.onReferences(async (
            params: ReferenceParams,
            cancellationToken: CancellationToken
        ) => {
            const document = documents.get(params.textDocument.uri);

            if (!document) {
                return [];
            }

            this.environment.noteInteractiveActivity?.();
            const version = document.version;
            await ensureDocumentParsed(document);
            if (requestIsStale(document, version, cancellationToken)) {
                return [];
            }
            const context = this.getPositionContext(params);

            if (!context || isBlockedToken(context.token)) {
                return [];
            }

            /* ReferenceIndex отбирает файлы до точного transient parse. */
            return findRslReferencesInWorkspace(
                index,
                resolver,
                this.referenceIndex,
                document.uri,
                context.offset,
                params.context.includeDeclaration,
                () => cancellationToken.isCancellationRequested
            );
        });

        connection.languages.inlayHint.on(async (
            params,
            cancellationToken
        ) => {
            const document = documents.get(params.textDocument.uri);

            if (
                !document ||
                !this.environment.getSettings(document.uri)
                    .inlayHints.variableTypes
            ) {
                return [];
            }

            this.environment.noteInteractiveActivity?.();
            const version = document.version;
            const span = this.environment.performance?.enabled
                ? this.environment.performance.start("inlayHints", {
                    uri: document.uri,
                    version,
                    lines: params.range.end.line - params.range.start.line
                })
                : undefined;
            const module = index.getCurrentModule(document.uri, version);

            /*
             * Разбор не форсируется: подсказки приходят на каждое нажатие
             * клавиши, и ожидание модели здесь снимало склейку правок. Пока
             * модели нет — подсказок нет, а по её готовности клиента просят
             * запросить их заново (notifyParsed).
             */
            if (!module) {
                this.environment.requestDocumentParse?.(document);
                this.pendingInlayHints.add(document.uri);
                if (span) {
                    this.environment.performance!.end(span, {
                        provisional: true,
                        hints: 0
                    });
                }
                return [];
            }

            if (requestIsStale(document, version, cancellationToken)) {
                if (span) {
                    this.environment.performance!.end(span, {
                        cancelled: true,
                        hints: 0
                    });
                }
                return [];
            }

            const hints = buildRslInlayHints(
                module,
                resolver,
                params.range,
                () => requestIsStale(document, version, cancellationToken)
            );

            if (span) {
                this.environment.performance!.end(span, {
                    cancelled: false,
                    hints: hints.length
                });
            }

            return hints;
        });

        connection.onPrepareRename?.(async (params, cancellationToken) => {
            const document = documents.get(params.textDocument.uri);
            if (!document) return null;
            this.environment.noteInteractiveActivity?.();
            const version = document.version;
            await ensureDocumentParsed(document);
            if (requestIsStale(document, version, cancellationToken)) {
                return null;
            }
            const module = index.getCurrentModule(document.uri, version);
            return module
                ? prepareRslRename(
                    module,
                    resolver,
                    document.offsetAt(params.position)
                )
                : null;
        });

        connection.onRenameRequest?.(async (params, cancellationToken) => {
            const document = documents.get(params.textDocument.uri);
            if (!document) return null;
            this.environment.noteInteractiveActivity?.();
            const version = document.version;
            await ensureDocumentParsed(document);
            if (requestIsStale(document, version, cancellationToken)) {
                return null;
            }
            /*
             * Rename правит текст по позициям модели, поэтому модель обязана
             * быть ровно той версии, для которой запрос пришёл: иначе правки
             * встанут по сдвинувшимся смещениям и испортят файл.
             */
            const module = index.getCurrentModule(document.uri, version);

            if (!module) {
                return null;
            }

            const offset = document.offsetAt(params.position);
            /*
             * Конфликт проверяется ДО правок и сообщается ошибкой запроса, а не
             * пустым результатом: пустой результат редактор показывает как
             * «переименовать нечего», и настоящая причина до пользователя не
             * доходит.
             */
            const conflict = findRslRenameConflict(
                module,
                resolver,
                offset,
                params.newName
            );

            if (conflict) {
                throw new ResponseError(
                    ErrorCodes.InvalidRequest,
                    conflict
                );
            }

            return buildRslRenameEdit(
                module,
                index,
                resolver,
                this.referenceIndex,
                offset,
                params.newName,
                () => cancellationToken.isCancellationRequested
            );
        });

        connection.onCodeAction(async (
            params: CodeActionParams,
            cancellationToken: CancellationToken
        ) => {
            const document = documents.get(params.textDocument.uri);
            const version = document?.version;
            const module = version === undefined
                ? undefined
                : index.getCurrentModule(params.textDocument.uri, version);
            if (!document || !module) {
                return [];
            }

            this.environment.noteInteractiveActivity?.();
            const sourceActions = buildRslSourceCodeActions(module, params);
            if (isSourceActionRequest(params)) {
                return sourceActions;
            }
            const navigation = supportsRefactorActions(params)
                ? buildBlockNavigationActions(module, params.range)
                : [];
            const settings = this.environment.getSettings(module.uri);
            const scanWorkspace =
                params.context.triggerKind === CodeActionTriggerKind.Invoked;
            const autoImports =
                settings.autoImport.enabled &&
                this.environment.findAutoImportModules
                ? await buildMissingImportActions(
                    module,
                    index,
                    resolver,
                    params.range,
                    name => this.environment.findAutoImportModules!(name, {
                        scanWorkspace,
                        isCancelled: () =>
                            cancellationToken.isCancellationRequested
                    })
                )
                : [];
            /*
             * Подбор Import ходит по файлам проекта, и за это время документ
             * могли изменить. Quick Fix правит текст по диапазонам запроса,
             * поэтому ответ для прежней версии вставил бы Import не туда.
             */
            if (requestIsStale(document, version, cancellationToken)) {
                return [];
            }
            return [
                ...buildEnhancedRslCodeActions(module, params),
                ...navigation,
                ...autoImports,
                ...sourceActions
            ];
        });

        connection.onWorkspaceSymbol((params, cancellationToken) => {
            this.environment.noteInteractiveActivity?.();
            if (cancellationToken.isCancellationRequested) {
                return [];
            }
            return findRslWorkspaceSymbols(index, params.query);
        });

        connection.languages.callHierarchy.onPrepare(async (
            params,
            cancellationToken
        ) => {
            const document = documents.get(params.textDocument.uri);
            if (!document) {
                return [];
            }

            this.environment.noteInteractiveActivity?.();
            const version = document.version;
            await ensureDocumentParsed(document);
            if (requestIsStale(document, version, cancellationToken)) {
                return [];
            }
            return this.callHierarchyProvider.prepare(
                document.uri,
                document.offsetAt(params.position)
            );
        });

        connection.languages.callHierarchy.onIncomingCalls((
            params,
            cancellationToken
        ) => this.callHierarchyProvider.incoming(
            params.item,
            () => cancellationToken.isCancellationRequested
        ));

        connection.languages.callHierarchy.onOutgoingCalls((
            params,
            cancellationToken
        ) => this.callHierarchyProvider.outgoing(
            params.item,
            () => cancellationToken.isCancellationRequested
        ));

        connection.onSelectionRanges(async (
            params: SelectionRangeParams,
            cancellationToken: CancellationToken
        ) => {
            const document = documents.get(params.textDocument.uri);
            if (!document) {
                return [];
            }

            const version = document.version;
            await ensureDocumentParsed(document);
            /*
             * Ответ по версии, которой в редакторе уже нет, указывал бы на
             * сдвинувшиеся позиции — то есть выделял бы не то место.
             */
            if (requestIsStale(document, version, cancellationToken)) {
                return [];
            }
            const module = index.getCurrentModule(document.uri, version);
            return module
                ? buildSelectionRanges(module, params.positions)
                : [];
        });

        connection.onRequest(
            "rsl/currentBlockRange",
            async (
                params: IRslCurrentBlockRangeParams,
                cancellationToken: CancellationToken
            ) => {
                const document = documents.get(params.textDocument.uri);
                if (!document) {
                    return null;
                }

                this.environment.noteInteractiveActivity?.();
                const version = document.version;
                await ensureDocumentParsed(document);
                if (requestIsStale(document, version, cancellationToken)) {
                    return null;
                }
                const module = index.getCurrentModule(document.uri, version);
                return module
                    ? resolveCurrentBlockRange(
                        module,
                        params.position,
                        params.currentRange
                    ) || null
                    : null;
            }
        );

        connection.onExecuteCommand(async (params: ExecuteCommandParams) => {
            const direction = params.command === GO_TO_BLOCK_START_COMMAND
                ? "start"
                : params.command === GO_TO_BLOCK_END_COMMAND
                    ? "end"
                    : undefined;
            if (!direction) {
                return null;
            }

            const args = Array.isArray(params.arguments) ? params.arguments : [];
            const uri = typeof args[0] === "string" ? args[0] : "";
            const line = typeof args[1] === "number" ? args[1] : 0;
            const character = typeof args[2] === "number" ? args[2] : 0;
            const document = documents.get(uri);
            const version = document?.version;
            if (document) {
                await ensureDocumentParsed(document);

                /*
                 * Переход по блоку в файле, который за время разбора успели
                 * изменить, увёл бы курсор по устаревшим позициям.
                 */
                if (document.version !== version) {
                    return null;
                }
            }
            const module = version === undefined
                ? index.getModule(uri)
                : index.getCurrentModule(uri, version);
            const position = module
                ? resolveBlockNavigationPosition(
                    module,
                    { line, character },
                    direction
                )
                : undefined;
            if (!position) {
                return null;
            }

            await connection.sendRequest("window/showDocument", {
                uri,
                takeFocus: true,
                selection: { start: position, end: position }
            });
            return null;
        });

    }

    invalidate(uri: string): void {
        this.presentationFeatures.invalidate(uri);
        this.semanticTokensFeatures.invalidate(uri);
        /* Текст изменился: индекс этой версии больше не нужен. */
        dropFastCompletionIndex(uri);
    }

    forget(uri: string): void {
        this.presentationFeatures.forget(uri);
        this.semanticTokensFeatures.forget(uri);
        dropFastCompletionIndex(uri);
    }

    /**
     * Загрузился внешний модуль, от которого зависят перечисленные открытые
     * файлы: их подсветка могла измениться, хотя сами документы не менялись.
     */
    notifyImportContextChanged(uris: readonly string[]): void {
        this.semanticTokensFeatures.notifyImportContextChanged(uris);
    }

    /**
     * Модель файла готова: подсветке, отданной без неё, нужен перезапрос.
     */
    notifyParsed(uri: string): void {
        this.semanticTokensFeatures.notifyParsed(uri);
        this.refreshInlayHintsIfPending(uri);
        /*
         * Модель готова, и дальше отвечает она. Прежде индекс освобождался
         * только при следующем Completion — то есть у файла, в который больше
         * не заходят, он оставался в памяти до вытеснения по счётчику.
         */
        dropFastCompletionIndex(uri);
    }

    /**
     * Подсказки типов были запрошены до готовности модели и вернулись пустыми.
     *
     * Сам клиент о готовности не знает, и без этой просьбы подсказки появились
     * бы только со следующей правкой документа. Запросы объединяются: разбор
     * нескольких открытых файлов даёт их пачкой.
     */
    private refreshInlayHintsIfPending(uri: string): void {
        if (!this.pendingInlayHints.delete(uri) || this.inlayRefreshTimer) {
            return;
        }

        this.inlayRefreshTimer = setTimeout(() => {
            this.inlayRefreshTimer = undefined;
            try {
                const result = this.environment.connection.languages
                    .inlayHint?.refresh?.();
                void Promise.resolve(result).catch(error =>
                    this.environment.log(
                        `Inlay hint refresh failed: ${errorText(error)}`
                    )
                );
            } catch (error) {
                this.environment.log(
                    `Inlay hint refresh failed: ${errorText(error)}`
                );
            }
        }, INLAY_REFRESH_COALESCE_MS);
    }

    dispose(): void {
        this.semanticTokensFeatures.dispose();
        if (this.inlayRefreshTimer) {
            clearTimeout(this.inlayRefreshTimer);
            this.inlayRefreshTimer = undefined;
        }
    }

    /**
     * Экспортируемые имена уже прочитанных Import.
     *
     * Не зависят от модели текущего файла: модули из Import разобраны отдельно
     * и лежат в индексе. Поэтому в приблизительном ответе они законны — в
     * отличие от локальных областей видимости, которых без модели нет.
     */
    /**
     * Члены класса по имени, без полной модели.
     *
     * Класс ищется там, где он может быть виден без анализа: объявления самого
     * файла из быстрого снимка, затем прочитанные модули Import. Встроенные и
     * прикладные классы остаются полной модели — их разрешение зависит от
     * Import-контекста, а он здесь ещё не построен.
     */
    /**
     * Члены класса вместе с унаследованными, без полной модели.
     *
     * Цепочка обходится от производного к базовому, член производного
     * перекрывает одноимённый член базы. Каждый следующий уровень разрешает
     * resolver — он же делает это для полного пути, поэтому правила видимости
     * не раздваиваются: класс модуля workspace может наследовать класс своего
     * модуля, класс его Import, встроенный или прикладной, а класс прикладного
     * модуля — только в контексте своего владельца.
     */
    private findFastClassMembers(
        document: TextDocument,
        className: string,
        fastIndex: IFastCompletionIndex,
        offset: number
    ): CompletionItem[] | undefined {
        const items: CompletionItem[] = [];
        const taken = new Set<string>();
        /* Цикл узнаётся по самому классу, а не по имени: имена повторяются. */
        const visited = new Set<string>();
        const resolver = this.environment.resolver;
        let found = false;
        let wanted = className;

        /* Пока база объявлена в этом же файле, её даёт индекс версии. */
        for (;;) {
            const key = "local:" + normalizeIdentifier(wanted);
            const own = visited.has(key)
                ? undefined
                : findFastClass(fastIndex, wanted, offset);

            if (!own) {
                break;
            }

            visited.add(key);
            found = true;
            addUnique(
                items,
                taken,
                buildRslFastOwnClassMembers(fastIndex, wanted, offset) || []
            );

            if (!own.baseName) {
                return items;
            }
            wanted = own.baseName;
        }

        /*
         * Дальше цепочку ведёт resolver: он же ведёт её для полного пути, и
         * правила видимости не раздваиваются. Класс модуля workspace может
         * наследовать класс своего модуля, класс его Import, встроенный или
         * прикладной; класс прикладного модуля разрешает базу только через
         * своего владельца.
         */
        let current = resolver.findFastClass(
            document.uri,
            wanted,
            fastIndex.imports
        );

        while (current && !visited.has(fastClassKey(current))) {
            visited.add(fastClassKey(current));
            found = true;
            addUnique(items, taken, publicMembers(current.symbol));
            current = resolver.findFastBaseClass(
                current,
                current.symbol.baseClassName || "",
                fastIndex.imports
            );
        }

        return found ? items : undefined;
    }

    /**
     * Модули, видимые из документа по Import текущей версии текста, включая
     * транзитивные.
     *
     * Список Import берётся из быстрого снимка этой версии, а замыкание
     * достраивается по Import уже прочитанных модулей: в RSL подключение даёт
     * доступ ко всей рекурсивной цепочке. Прежний вариант брал готовый список
     * модели предыдущей версии и лишь фильтровал его по basename — из-за этого
     * только что добавленный Import не появлялся, транзитивные отбрасывались, а
     * Import с путём не совпадал с именем файла.
     */
    private importClosure(document: TextDocument): IIndexedModule[] {
        const { index } = this.environment;

        if (!index.areImportsEnabled) {
            return [];
        }

        const wanted = getFastDocumentImports(
            this.environment.getFastDocumentSnapshot(document)
        );
        const result: IIndexedModule[] = [];
        const seen = new Set<string>([document.uri]);
        const queue: string[] = [];

        for (const name of wanted) {
            const uri = resolvedUri(index.resolveWorkspaceFile(name));

            if (uri) {
                queue.push(uri);
            }
        }

        while (queue.length > 0) {
            const uri = queue.shift()!;

            if (seen.has(uri)) {
                continue;
            }
            seen.add(uri);

            const module = index.getModule(uri);

            if (!module) {
                continue;
            }

            result.push(module);

            /* Транзитивная цепочка: Import подключённого модуля тоже видны. */
            for (const name of module.imports) {
                const next = resolvedUri(index.resolveWorkspaceFile(name));

                if (next && !seen.has(next)) {
                    queue.push(next);
                }
            }
        }

        return result;
    }

    private knownImportCompletions(document: TextDocument): CompletionItem[] {
        const { index } = this.environment;

        if (!index.areImportsEnabled) {
            return [];
        }

        const items: CompletionItem[] = [];

        for (const imported of this.importClosure(document)) {
            const from = imported.uri.replace(/^.*[/\\]/, "");

            for (const symbol of imported.symbolTree.children) {
                if (symbol.visibility === "private") {
                    continue;
                }

                items.push({
                    label: symbol.name,
                    kind: symbol.kind,
                    detail: from
                });
            }
        }

        return items;
    }

    /**
     * Модуль ровно той версии, к которой относится запрос.
     *
     * Completion/Hover/Signature Help ждут полный parse не дольше
     * INTERACTIVE_PARSE_BUDGET_MS, поэтому в индексе может лежать модель
     * предыдущей версии документа. Отвечать по ней нельзя: offset позиции
     * вычисляется по текущему тексту, а token stream и symbolTree — по
     * прежнему. После вставки текста перед символом такая смесь даёт не
     * "чуть устаревший", а прямо неверный результат — найден чужой токен
     * либо не найдено ничего.
     */
    private getRequestModule(
        document: TextDocument
    ): IIndexedModule | undefined {
        return this.environment.index.getCurrentModule(
            document.uri,
            document.version
        );
    }

    private getPositionContext(
        params: TextDocumentPositionParams
    ): IPositionContext | undefined {
        const document = this.environment.documents.get(
            params.textDocument.uri
        );
        const module = document
            ? this.getRequestModule(document)
            : undefined;
        const tree = module?.symbolTree;

        if (!document || !module || !tree) {
            return undefined;
        }

        const offset = document.offsetAt(params.position);

        return {
            document,
            tree,
            offset,
            token: tokenAtOffset(module.lex.tokens, offset, true),
            tokens: module.lex.tokens
        };
    }
}


function supportsRefactorActions(params: CodeActionParams): boolean {
    const only = params.context.only;
    return !only || only.length === 0 || only.some(kind =>
        kind === CodeActionKind.Refactor ||
        String(kind).startsWith(CodeActionKind.Refactor + ".")
    );
}

function isSourceActionRequest(params: CodeActionParams): boolean {
    const only = params.context.only;
    return !!only && only.length > 0 && only.every(kind =>
        String(kind) === CodeActionKind.Source ||
        String(kind).startsWith(CodeActionKind.Source + ".") ||
        String(kind) === RSL_FIX_ALL_KIND
    );
}

function isBlockedToken(token?: IRslToken): boolean {
    return !!token && (
        token.kind === "string" ||
        token.kind === "square" ||
        token.kind === "comment"
    );
}

/*
 * Completion/Hover/Signature Help чувствительны к задержке сильнее, чем к
 * полноте ответа. Если полный parse не успевает за это время (большой файл,
 * очередь валидаций), обработчик не ждёт дальше, а возвращает пустой
 * результат: сам parse не отменяется, и следующий запрос увидит свежую
 * модель. Отвечать по модели предыдущей версии нельзя — см.
 * getRequestModule().
 */
const INTERACTIVE_PARSE_BUDGET_MS = 200;

/*
 * Как часто разрешено просить клиента перезапросить подсказки типов. Разбор
 * нескольких открытых файлов даёт такие события пачкой.
 */
const INLAY_REFRESH_COALESCE_MS = 300;

/*
 * Бюджета ожидания у Completion больше нет.
 *
 * Он был не жёстким: пока идёт синхронная фаза разбора, управление к таймеру не
 * возвращается, и «25 мс» на загруженной машине превращались в сколько угодно.
 * Теперь готовая модель используется, а неготовая не ожидается вовсе — ответ
 * приблизительный и помечен isIncomplete.
 */

/**
 * Список открыт действием пользователя, а не набором текста.
 *
 * Ctrl+Space и trigger-символ означают, что он ждёт подсказку сейчас. Отсутствие
 * context — старый клиент; там безопаснее считать запрос явным, иначе подсказка
 * молчала бы до конца склейки правок.
 */
/** Ключ класса для защиты от цикла: источник плюс сам символ. */
function fastClassKey(value: IRslFastClass): string {
    return (value.moduleUri || value.owner?.moduleKey || "builtin") +
        "#" + value.symbol.id;
}

/** Открытые члены символа класса: приватные чужого модуля недоступны. */
function publicMembers(symbol: RslSymbol): CompletionItem[] {
    return symbol.children
        .filter(member => member.visibility !== "private")
        .map(member => ({
            label: member.name,
            kind: member.kind,
            detail: member.typeName || undefined
        }));
}

/** Добавляет члены, не перекрывая уже добавленные производным классом. */
function addUnique(
    items: CompletionItem[],
    taken: Set<string>,
    members: readonly CompletionItem[]
): void {
    for (const member of members) {
        const key = normalizeIdentifier(member.label);

        if (!taken.has(key)) {
            taken.add(key);
            items.push(member);
        }
    }
}

/** URI из разрешения имени модуля; неоднозначное и отсутствующее пропускаем. */
function resolvedUri(
    resolution: ReturnType<WorkspaceIndex["resolveWorkspaceFile"]>
): string | undefined {
    return resolution.kind === "resolved" ? resolution.value : undefined;
}

function isExplicitCompletion(params: CompletionParams): boolean {
    const kind = params.context?.triggerKind;

    return kind === undefined ||
        kind === CompletionTriggerKind.Invoked ||
        kind === CompletionTriggerKind.TriggerCharacter;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

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
            /*
             * Таймер бюджета снимается при раннем завершении parse: иначе
             * каждый интерактивный запрос удерживал бы event loop ещё на
             * весь остаток бюджета.
             */
            if (timer) {
                clearTimeout(timer);
            }
            resolve();
        };
        pending.then(finish, finish);
        if (!settled) {
            timer = setTimeout(finish, budgetMs);
        }
    });
}

function requestIsStale(
    document: TextDocument,
    version: number,
    cancellationToken?: CancellationToken
): boolean {
    return document.version !== version ||
        cancellationToken?.isCancellationRequested === true;
}

function deduplicateCompletionItems(
    ...groups: readonly (readonly CompletionItem[])[]
): CompletionItem[] {
    const result: CompletionItem[] = [];
    const seen = new Set<string>();

    for (const items of groups) {
        for (const item of items) {
            const autoImportUri = (
                item.data as { rslAutoImportUri?: unknown } | undefined
            )?.rslAutoImportUri;
            const key = autoImportUri
                ? `${String(item.label).toLowerCase()}:${autoImportUri}`
                : String(item.label).toLowerCase();

            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            result.push(item);
        }
    }

    return result;
}

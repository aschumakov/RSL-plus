import {
    CancellationToken,
    CodeActionKind,
    CodeActionParams,
    CodeActionTriggerKind,
    Definition,
    ExecuteCommandParams,
    Hover,
    Range,
    SelectionRangeParams,
    TextDocumentPositionParams,
    type Connection,
    type TextDocuments
} from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

import { RslSymbol } from "../symbols/rslSymbol";
import {
    errorText,
    requestIsStale
} from "./requestHelpers";
import { RslCompletionProvider } from "./completionProvider";
import {
    splitRslDocumentUnits
} from "../analysis/documentUnits";
import { positionAtOffset } from "../core/documentPosition";
import {
    createRslInteractiveHandlers,
    type IRslInteractiveHandlers
} from "./interactiveHandlers";
import {
    createRslSymbolUsageHandlers,
    type IRslSymbolUsageHandlers
} from "./symbolUsageHandlers";
import { RslDefinitionProvider } from "./definitionProvider";
import { buildEnhancedRslCodeActions } from "./enhancedCodeActions";
import {
    buildBlockNavigationActions,
    buildSelectionRanges,
    GO_TO_BLOCK_END_COMMAND,
    GO_TO_BLOCK_START_COMMAND,
    resolveCurrentBlockRange,
    resolveBlockNavigationPosition
} from "./blockNavigation";
import type { IRslSettings } from "../interfaces";
import { ReferenceIndex } from "../analysis/referenceIndex";
import type {
    IFastDocumentSnapshot
} from "../services/fastDocumentSnapshot";
import {
    dropFastCompletionIndex
} from "./fastCompletionIndex";
import type {
    ParseWaitMode
} from "../services/documentAnalysisService";
import { RslScopeResolver } from "../scopeResolver";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";
import type { PerformanceLogger } from "../performanceLogger";
import {
    buildMissingImportActions
} from "./autoImportProvider";
import {
    RslCallHierarchyProvider
} from "./callHierarchyProvider";
import { buildRslInlayHints } from "./inlayHintProvider";
import { findRslWorkspaceSymbols } from "./workspaceSymbolProvider";
import {
    buildRslSourceCodeActions,
    RSL_FIX_ALL_KIND
} from "./sourceCodeActions";
import { PresentationFeatureRegistry } from "./presentationFeatureRegistry";
import { SemanticTokensFeatureRegistry } from "./semanticTokensFeatureRegistry";

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


/** Регистрирует LSP provider-ы и владеет их versioned-кэшами. */
export class RslLanguageFeatureRegistry {
    private registered = false;
    private referenceIndex: ReferenceIndex;
    private callHierarchyProvider: RslCallHierarchyProvider;
    private completionProvider: RslCompletionProvider;
    /**
     * Переход, переход к типу, Hover и подсказка параметров.
     *
     * Живут отдельно: у них общее правило «кто отвечает — индекс версии или
     * модель», и держать его рядом с регистрацией всех остальных запросов
     * значило повторять это правило в каждом обработчике по-своему.
     */
    private interactive: IRslInteractiveHandlers;
    /**
     * Подсветка вхождений, поиск ссылок и переименование.
     *
     * Живут вместе: всем трём нужна модель ровно той версии, для которой
     * пришёл запрос, и ответ по отставшей модели у всех трёх не «немного
     * устаревший», а прямо неверный.
     */
    private usages: IRslSymbolUsageHandlers;
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
        this.usages = createRslSymbolUsageHandlers({
            documents: environment.documents,
            index: environment.index,
            resolver: environment.resolver,
            referenceIndex: this.referenceIndex,
            ensureDocumentParsed: (document, mode) =>
                environment.ensureDocumentParsed(document, mode),
            noteInteractiveActivity: () =>
                environment.noteInteractiveActivity?.()
        });
        this.interactive = createRslInteractiveHandlers({
            documents: environment.documents,
            index: environment.index,
            resolver: environment.resolver,
            definitionProvider: environment.definitionProvider,
            getFastDocumentSnapshot: document =>
                environment.getFastDocumentSnapshot(document),
            getCurrentModule: document => this.getRequestModule(document),
            ensureDocumentParsed: (document, mode) =>
                environment.ensureDocumentParsed(document, mode),
            ensureImportedSymbol: environment.ensureImportedSymbol
                ? (fromUri, symbolName) =>
                    environment.ensureImportedSymbol!(fromUri, symbolName)
                : undefined,
            noteInteractiveActivity: () =>
                environment.noteInteractiveActivity?.(),
            performance: environment.performance
        });
        this.completionProvider = new RslCompletionProvider(
            environment,
            document => this.getRequestModule(document)
        );
        this.presentationFeatures = new PresentationFeatureRegistry({
            ...environment,
            getBlockStartLines: document => this.blockStartLines(document)
        });
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
            ensureDocumentParsed
        } = this.environment;

        this.completionProvider.register(connection);

        connection.onSignatureHelp((params, cancellationToken) =>
            this.interactive.signatureHelp(params, cancellationToken));

        connection.onHover((
            params: TextDocumentPositionParams,
            cancellationToken: CancellationToken
        ): Promise<Hover | null> =>
            this.interactive.hover(params, cancellationToken));

        /*
         * Переход к типу: от переменной к её классу.
         *
         * Отдельный запрос LSP, и отвечает он по тому же быстрому контексту:
         * тип уже посчитан индексом версии, а класс ищется там же, где его
         * ищут подсказки.
         */
        connection.onTypeDefinition?.((
            params: TextDocumentPositionParams,
            cancellationToken: CancellationToken
        ): Promise<Definition | null> =>
            this.interactive.typeDefinition(params, cancellationToken));

        connection.onDocumentHighlight((params, cancellationToken) =>
            this.usages.documentHighlight(params, cancellationToken));

        connection.onDefinition((
            params: TextDocumentPositionParams,
            cancellationToken: CancellationToken
        ): Promise<Definition | null> =>
            this.interactive.definition(params, cancellationToken));

        connection.onReferences((params, cancellationToken) =>
            this.usages.references(params, cancellationToken));

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

        connection.onPrepareRename?.((params, cancellationToken) =>
            this.usages.prepareRename(params, cancellationToken));

        connection.onRenameRequest?.((params, cancellationToken) =>
            this.usages.rename(params, cancellationToken));

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
        /* Текст изменился: индекс и сеансы этой версии больше не нужны. */
        dropFastCompletionIndex(uri);
        this.completionProvider.forget(uri);
    }

    forget(uri: string): void {
        this.presentationFeatures.forget(uri);
        this.semanticTokensFeatures.forget(uri);
        dropFastCompletionIndex(uri);
        this.completionProvider.forget(uri);
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
         *
         * Сеанс Completion при этом НЕ выбрасывается: текст не изменился, а
         * значит и список, который пользователь сейчас читает, обязан остаться
         * тем же. Иначе список менялся сам собой ровно в тот момент, когда
         * достроилась модель.
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

    /**
     * Строки верхнеуровневых блоков документа.
     *
     * Берутся у того же разбиения на единицы, которым пользуется
     * инкрементальная диагностика: оно построено по дереву символов, проверено
     * на репозитории и не принимает за объявление текст внутри SQL-блока.
     * Пока модель этой версии не готова, границ нет — и форматирование
     * выделения считает документ целиком.
     */
    private blockStartLines(
        document: TextDocument
    ): readonly number[] | undefined {
        const module = this.getRequestModule(document);

        if (!module) {
            return undefined;
        }

        const lineStarts = module.lex.lineStarts;
        const lines = new Set<number>();

        for (const unit of splitRslDocumentUnits(
            module.source,
            module.lex.tokens,
            module.symbolTree
        )) {
            if (unit.kind !== "macro" && unit.kind !== "class") {
                continue;
            }

            lines.add(positionAtOffset(lineStarts, unit.start).line);
        }

        return [...lines].sort((left, right) => left - right);
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


/*
 * Completion/Hover/Signature Help чувствительны к задержке сильнее, чем к
 * полноте ответа. Если полный parse не успевает за это время (большой файл,
 * очередь валидаций), обработчик не ждёт дальше, а возвращает пустой
 * результат: сам parse не отменяется, и следующий запрос увидит свежую
 * модель. Отвечать по модели предыдущей версии нельзя — см.
 * getRequestModule().
 */
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








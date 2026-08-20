"use strict";

/*
 * Общий стенд Completion для тестов.
 *
 * Реестр языковых возможностей поднимается одинаково в нескольких файлах
 * тестов: заглушка соединения, документ, индекс, снимок версии. Повторение
 * этого кода означало, что стенды расходятся между собой — например в одном
 * снимок кэшируется, а в другом пересоздаётся на каждый запрос, и тесты мерят
 * разные вещи.
 */

const {
    WorkspaceIndex
} = require("../server/out/workspaceIndex");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { getDefaults } = require("../server/out/defaults");
const {
    RslLanguageFeatureRegistry
} = require("../server/out/features/languageFeatureRegistry");
const {
    createFastDocumentSnapshot
} = require("../server/out/services/fastDocumentSnapshot");
const {
    TextDocument
} = require("../server/node_modules/vscode-languageserver-textdocument");

const DEFAULT_SETTINGS = {
    diagnostics: {},
    imports: { enabled: true },
    autoImport: { enabled: false },
    semanticHighlighting: { maxFileSizeKb: 512 },
    inlayHints: { variableTypes: true },
    editor: { completeBlocksOnEnter: false }
};

/** Заглушка соединения: реестр регистрирует все обработчики сразу. */
function createConnection(handlers) {
    const register = name => callback => {
        handlers[name] = callback;
    };

    return {
        onCompletion: register("completion"),
        onCompletionResolve: register("completionResolve"),
        onSignatureHelp: register("signatureHelp"),
        onHover: register("hover"),
        onDocumentHighlight: register("documentHighlight"),
        onDefinition: register("definition"),
        onTypeDefinition: register("typeDefinition"),
        onReferences: register("references"),
        onWorkspaceSymbol: register("workspaceSymbol"),
        onCodeAction: register("codeAction"),
        onSelectionRanges: register("selectionRanges"),
        onExecuteCommand: register("executeCommand"),
        onPrepareRename: register("prepareRename"),
        onRenameRequest: register("rename"),
        onRequest: (method, callback) => {
            handlers[method] = callback;
        },
        onDocumentSymbol: register("documentSymbol"),
        onFoldingRanges: register("foldingRanges"),
        onDocumentFormatting: register("documentFormatting"),
        onDocumentRangeFormatting: register("documentRangeFormatting"),
        sendRequest: async () => undefined,
        languages: {
            callHierarchy: {
                onPrepare: register("callHierarchyPrepare"),
                onIncomingCalls: register("callHierarchyIncoming"),
                onOutgoingCalls: register("callHierarchyOutgoing")
            },
            semanticTokens: {
                on: register("semanticTokens"),
                onDelta: register("semanticTokensDelta"),
                onRange: register("semanticTokensRange"),
                refresh: () => undefined
            },
            inlayHint: {
                on: register("inlayHint"),
                refresh: () => undefined
            }
        }
    };
}

/**
 * Реестр над одним открытым документом.
 *
 * `modelReady` решает, какой путь отвечает: версия документа впереди модели —
 * работает быстрый индекс, версии совпадают — полная модель.
 */
function createCompletionRegistry(options) {
    const uri = options.uri;
    const source = options.source;
    const index = options.index || new WorkspaceIndex();

    if (!options.index) {
        index.registerWorkspaceFiles([
            uri,
            ...(options.workspace || []).map(item => item.uri)
        ]);

        for (const item of options.workspace || []) {
            index.updateExternalModule(item.uri, item.text, 1);
        }
    }

    const module = index.updateOpenModule(uri, source, 1);
    const document = TextDocument.create(
        uri,
        "rsl",
        options.modelReady === false ? 2 : 1,
        source
    );
    const handlers = {};
    /* Снимок кэшируется по версии — так делает и сервер. */
    let snapshot;
    const registry = new RslLanguageFeatureRegistry({
        connection: createConnection(handlers),
        documents: {
            get: value => value === uri ? document : undefined,
            all: () => [document]
        },
        index,
        resolver: options.resolver || new RslScopeResolver(
            index,
            getDefaults(),
            options.platform
        ),
        definitionProvider: {
            findImportDefinition: async () => undefined,
            findDynamicDefinition: async () => undefined,
            createObjectLocationByUri: () => ({ uri, range: null })
        },
        getFastDocumentSnapshot: () => {
            if (!snapshot) {
                snapshot = createFastDocumentSnapshot(document);
            }

            return snapshot;
        },
        ensureDocumentParsed: async () => undefined,
        requestDocumentParse: () => undefined,
        getSettings: () => options.settings || DEFAULT_SETTINGS,
        supportsRefresh: () => false,
        log: () => undefined
    });
    registry.register();

    return { handlers, document, index, module, registry, uri, source };
}

/** Список для позиции сразу за указанным текстом образца. */
async function completeAfter(stand, marker, context) {
    const at = stand.source.indexOf(marker);

    if (at < 0) {
        throw new Error("в образце нет: " + marker);
    }

    return completeAt(stand, at + marker.length, context);
}

/** Список для указанного смещения. */
async function completeAt(stand, offset, context) {
    return stand.handlers.completion(
        {
            textDocument: { uri: stand.uri },
            position: stand.document.positionAt(offset),
            context: context || { triggerKind: 1 }
        },
        {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose: () => undefined })
        }
    );
}

/** Разрешение элемента: то же, что делает редактор при выборе строки. */
function resolveItem(stand, item) {
    return stand.handlers.completionResolve(item);
}

/** Состав и порядок — то, что видит пользователь. */
function orderedLabels(list) {
    return [...list.items]
        .sort((first, second) =>
            String(first.sortText).localeCompare(String(second.sortText))
        )
        .map(item => String(item.label));
}

module.exports = {
    DEFAULT_SETTINGS,
    createConnection,
    createCompletionRegistry,
    completeAfter,
    completeAt,
    resolveItem,
    orderedLabels
};

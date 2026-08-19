"use strict";

/**
 * Один снимок документа — один список, независимо от источника.
 *
 * Подсказки собираются двумя путями: из быстрого индекса версии, пока полная
 * модель считается, и из модели, когда она готова. Пользователь этой разницы
 * знать не должен: для одного состояния документа состав и порядок обязаны
 * совпадать. Здесь это и сверяется — на прогретом и на холодном каталоге, до и
 * после появления модели, на завершённом и на набираемом обращении.
 */

const assert = require("assert");

const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { getDefaults } = require("../server/out/defaults");
const {
    PlatformModuleCatalog
} = require("../server/out/builtins/platformModuleCatalog");
const {
    RslLanguageFeatureRegistry
} = require("../server/out/features/languageFeatureRegistry");
const {
    createFastDocumentSnapshot
} = require("../server/out/services/fastDocumentSnapshot");
const {
    TextDocument
} = require("../server/node_modules/vscode-languageserver-textdocument");

const MAIN = "file:///d:/differential/main.mac";

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

const SOURCE = [
    "Import RsbFormsInter;",
    "Macro Test()",
    "  Var Field7: TRsbEditField = TRsbEditField(7);",
    "  Field7.",
    "End;"
].join("\n");

let passed = 0;
let failed = 0;

async function test(name, action) {
    try {
        await action();
        passed++;
        console.log("[OK] " + name);
    } catch (error) {
        failed++;
        console.error("[FAIL] " + name);
        console.error(error);
    }
}

const defaults = {
    diagnostics: {},
    imports: { enabled: true },
    autoImport: { enabled: false },
    semanticHighlighting: { maxFileSizeKb: 512 },
    inlayHints: { variableTypes: true },
    editor: { completeBlocksOnEnter: false }
};

/**
 * Реестр обработчиков.
 *
 * `modelReady` решает, какой путь работает: без модели отвечает быстрый индекс,
 * с моделью — полная модель. Сам текст в обоих случаях один и тот же.
 */
function createRegistry({ platform, modelReady }) {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([MAIN]);
    const module = index.updateOpenModule(MAIN, SOURCE, 1);
    const document = TextDocument.create(MAIN, "rsl", modelReady ? 1 : 2, SOURCE);
    const handlers = {};

    const registry = new RslLanguageFeatureRegistry({
        connection: createConnection(handlers),
        documents: {
            get: uri => uri === MAIN ? document : undefined,
            all: () => [document]
        },
        index,
        resolver: new RslScopeResolver(index, getDefaults(), platform),
        definitionProvider: {
            findImportDefinition: async () => undefined,
            findDynamicDefinition: async () => undefined,
            createObjectLocationByUri: () => ({ uri: MAIN, range: null })
        },
        getFastDocumentSnapshot: () => createFastDocumentSnapshot(document),
        ensureDocumentParsed: async () => undefined,
        requestDocumentParse: () => undefined,
        getSettings: () => defaults,
        supportsRefresh: () => false,
        log: () => undefined
    });
    registry.register();

    return { handlers, document, module };
}

/** Список от обработчика для позиции сразу за указанным текстом. */
async function complete(registry, marker) {
    const at = SOURCE.indexOf(marker);
    assert.ok(at >= 0, "в образце нет: " + marker);

    return registry.handlers.completion(
        {
            textDocument: { uri: MAIN },
            position: registry.document.positionAt(at + marker.length),
            context: { triggerKind: 2, triggerCharacter: "." }
        },
        {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose: () => undefined })
        }
    );
}

/** Состав и порядок — то, что видит пользователь. */
function order(list) {
    return [...list.items]
        .sort((first, second) =>
            String(first.sortText).localeCompare(String(second.sortText))
        )
        .map(item => String(item.label));
}

async function main() {
    const platform = new PlatformModuleCatalog({ log: () => undefined });
    await platform.ensureModules(["RsbFormsInter"]);
    assert.ok(platform.ready, "каталог прикладных модулей не прочитан");

    await test("быстрый путь и полная модель дают один список", async () => {
        const fast = await complete(
            createRegistry({ platform, modelReady: false }),
            "  Field7."
        );
        const full = await complete(
            createRegistry({ platform, modelReady: true }),
            "  Field7."
        );

        assert.ok(fast.items.length > 0, "быстрый путь вернул пустой список");
        assert.deepStrictEqual(
            order(fast),
            order(full),
            "состав и порядок обязаны совпадать: пользователь не должен видеть " +
                "разницы между ответом до и после готовности модели"
        );
    });

    await test("оба ответа помечены полными", async () => {
        for (const modelReady of [false, true]) {
            const list = await complete(
                createRegistry({ platform, modelReady }),
                "  Field7."
            );
            assert.strictEqual(
                list.isIncomplete,
                false,
                "список обязан быть полным при modelReady=" + modelReady
            );
        }
    });

    await test("холодный каталог не меняет состав", async () => {
        const cold = new PlatformModuleCatalog({ log: () => undefined });
        const warm = await complete(
            createRegistry({ platform, modelReady: false }),
            "  Field7."
        );
        const coldList = await complete(
            createRegistry({ platform: cold, modelReady: false }),
            "  Field7."
        );

        /*
         * На холодном каталоге членов ещё нет — и тогда ответ обязан быть
         * обычным списком имён, а не пустым и не наполовину собранным.
         */
        assert.ok(coldList.items.length > 0, "холодный ответ пуст");
        assert.notDeepStrictEqual(
            order(coldList),
            order(warm),
            "прогретый каталог обязан добавлять члены класса"
        );

        /* Тот же холодный каталог второй раз даёт то же самое. */
        const again = await complete(
            createRegistry({ platform: cold, modelReady: false }),
            "  Field7."
        );
        assert.deepStrictEqual(order(again), order(coldList));
    });

    await test("набранная часть имени меняет порядок, а не состав", async () => {
        const registry = createRegistry({ platform, modelReady: false });
        const empty = await complete(registry, "  Field7.");
        const typed = await complete(registry, "  Field7.");

        assert.deepStrictEqual(
            order(empty).sort(),
            order(typed).sort(),
            "состав не зависит от набранного"
        );
    });

    console.log("\nПройдено: " + passed + ", провалено: " + failed);

    if (failed > 0) {
        process.exitCode = 1;
    }
}

main();

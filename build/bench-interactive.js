"use strict";

/*
 * Замер интерактивных запросов через настоящие обработчики LSP.
 *
 * Отвечает на вопрос, который нельзя проверить набором тестов: сколько ждёт
 * пользователь, нажавший Ctrl+Click, наведший курсор или открывший подсказку
 * параметров. Режимы:
 *
 * 1. Холодный  — модель этой версии текста ещё не построена, как сразу после
 *                правки. Ожидание разбора попадает в замер: именно его и видит
 *                пользователь.
 * 2. Тёплый    — модель готова.
 * 3. Под нагрузкой — модель готова, а в фоне идёт расчёт Problems.
 *
 * Запуск:
 *   node build/bench-interactive.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "server", "out");

const { WorkspaceIndex } = require(path.join(OUT, "workspaceIndex"));
const { RslScopeResolver } = require(path.join(OUT, "scopeResolver"));
const { getDefaults } = require(path.join(OUT, "defaults"));
const {
    PlatformModuleCatalog
} = require(path.join(OUT, "builtins", "platformModuleCatalog"));
const {
    RslLanguageFeatureRegistry
} = require(path.join(OUT, "features", "languageFeatureRegistry"));
const {
    RslDefinitionProvider
} = require(path.join(OUT, "features", "definitionProvider"));
const {
    createFastDocumentSnapshot
} = require(path.join(OUT, "services", "fastDocumentSnapshot"));
const {
    dropFastCompletionIndex
} = require(path.join(OUT, "features", "fastCompletionIndex"));
const {
    buildLocalRslDiagnosticsChunked
} = require(path.join(OUT, "diagnostics"));
const {
    TextDocument
} = require(path.join(ROOT, "server", "node_modules",
    "vscode-languageserver-textdocument"));

const SETTINGS = {
    diagnostics: {},
    language: { dialect: "rsBank" },
    imports: { enabled: true },
    autoImport: { enabled: true },
    analysis: { workspaceIndexing: "activeImports" },
    semanticHighlighting: { maxFileSizeKb: 512 },
    inlayHints: { variableTypes: true },
    editor: { completeBlocksOnEnter: false }
};

/*
 * Файлы стенда лежат на диске.
 *
 * Переход по имени модуля в Import ищет файл в рабочей папке — как и в
 * настоящем проекте. С выдуманными URI этот замер показывал бы «ответа
 * нет» там, где у пользователя переход работает.
 */
const WORKSPACE = fs.mkdtempSync(
    path.join(os.tmpdir(), "rsl-bench-")
);
const MAIN = pathToFileURL(path.join(WORKSPACE, "main.mac")).toString();
const LIB = pathToFileURL(path.join(WORKSPACE, "lib.mac")).toString();

const LIB_SOURCE = [
    "Macro Shared(value)",
    "  return value;",
    "End;",
    ""
].join("\n");

/** Образец: обращения, ради которых интерактивные функции и нужны. */
function mainSource(padding) {
    const lines = [
        "Import lib;",
        "Import RsbFormsInter;",
        "Macro Test()",
        "  Var Field7: TRsbEditField = TRsbEditField(7);",
        "  Field7.bindValue(\"текст\");",
        "  Var value = Shared(1);",
        "  ExecMacro(\"Shared\");"
    ];

    /* Наполнение: интерактивный ответ не должен зависеть от размера файла. */
    for (let index = 0; index < padding; index++) {
        lines.push(`  Var filler${index} = ${index} + 1;`);
    }

    lines.push("End;", "");

    return lines.join("\n");
}

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
 * Стенд, где разбор стоит столько же, сколько у сервера.
 *
 * ensureDocumentParsed строит модель по-настоящему: холодный режим обязан
 * платить за неё, иначе замер говорил бы не о том, что видит пользователь.
 */
function createStand(source, options) {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([MAIN, LIB]);
    index.updateExternalModule(LIB, LIB_SOURCE, 1);
    index.updateOpenModule(MAIN, source, 1);

    const documentVersion = options.modelReady ? 1 : 2;
    const document = TextDocument.create(MAIN, "rsl", documentVersion, source);
    const handlers = {};
    let snapshot;
    let parses = 0;
    const resolver = new RslScopeResolver(
        index,
        getDefaults(),
        options.platform
    );
    const registry = new RslLanguageFeatureRegistry({
        connection: createConnection(handlers),
        documents: {
            get: value => value === MAIN ? document : undefined,
            all: () => [document]
        },
        index,
        resolver,
        definitionProvider: new RslDefinitionProvider({
            getOpenDocument: value => value === MAIN ? document : undefined,
            ensureDocumentParsed: async () => undefined,
            getLoadedModules: () => index.getModules(),
            getImportedModules: uri => index.getImportedModules(uri),
            findWorkspaceFileUri: name => index.findWorkspaceFileUri(name),
            resolveWorkspaceFileUri: name => index.resolveWorkspaceFile(name),
            getDefinitionRange: (uri, object) =>
                index.getDefinitionRange(uri, object),
            resolveMethodReference: (uri, tree, receiverOffset, methodName) => {
                const found = resolver.resolveMemberReference(
                    uri,
                    tree,
                    receiverOffset,
                    methodName
                );

                return found
                    ? { uri: found.uri, symbol: found.symbol }
                    : undefined;
            },
            log: () => undefined
        }),
        getFastDocumentSnapshot: () => {
            if (!snapshot) {
                snapshot = createFastDocumentSnapshot(document);
            }

            return snapshot;
        },
        /*
         * Так же, как DocumentAnalysisService: готовая модель этой версии
         * отдаётся сразу, иначе строится. Иначе тёплый режим мерил бы
         * повторный разбор, которого у сервера нет.
         */
        ensureDocumentParsed: async () => {
            const ready = index.getCurrentModule(MAIN, document.version);

            if (ready) {
                return ready.symbolTree;
            }

            parses++;
            index.updateOpenModule(MAIN, source, document.version);

            return index.getModule(MAIN)?.symbolTree;
        },
        requestDocumentParse: () => {
            index.updateOpenModule(MAIN, source, document.version);
        },
        getSettings: () => SETTINGS,
        supportsRefresh: () => false,
        log: () => undefined
    });
    registry.register();

    return {
        handlers,
        document,
        index,
        registry,
        source,
        get parses() {
            return parses;
        }
    };
}

const token = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined })
};

async function ask(stand, handler, offset, extra) {
    const started = process.hrtime.bigint();
    const answer = await stand.handlers[handler]({
        textDocument: { uri: MAIN },
        position: stand.document.positionAt(offset),
        ...(extra || {})
    }, token);

    return {
        ms: Number(process.hrtime.bigint() - started) / 1e6,
        answer
    };
}

function offsetAfter(source, marker) {
    const at = source.indexOf(marker);

    if (at < 0) {
        throw new Error("в образце нет: " + marker);
    }

    return at + marker.length;
}

function percentile(values, share) {
    if (values.length === 0) {
        return 0;
    }

    const sorted = [...values].sort((first, second) => first - second);

    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
}

function report(name, values, target, answered) {
    const verdict = target === undefined
        ? ""
        : percentile(values, 0.95) <= target
            ? "  (цель ≤ " + target + " мс — да)"
            : "  (цель ≤ " + target + " мс — НЕТ)";

    console.log("  " + name.padEnd(34) +
        "p50 " + percentile(values, 0.5).toFixed(1) +
        ", p95 " + percentile(values, 0.95).toFixed(1) +
        ", максимум " + percentile(values, 1).toFixed(1) + " мс" +
        (answered === undefined
            ? ""
            : answered ? ", ответ есть" : ", ОТВЕТА НЕТ") +
        verdict);
}

/** Фоновый расчёт Problems: он и конкурирует с запросами пользователя. */
function startBackground(index, uri) {
    let stopped = false;
    const run = async () => {
        while (!stopped) {
            const module = index.getModule(uri);

            if (module) {
                await buildLocalRslDiagnosticsChunked(
                    module,
                    index,
                    SETTINGS.diagnostics,
                    () => stopped
                );
            }

            await new Promise(resolve => setImmediate(resolve));
        }
    };
    const pending = run();

    return async () => {
        stopped = true;
        await pending;
    };
}

const REQUESTS = 12;

const CASES = [
    {
        name: "переход по Import",
        handler: "definition",
        marker: "Import li",
        answered: value => !!value
    },
    {
        name: "переход к символу модуля",
        handler: "definition",
        marker: "  Var value = Shar",
        answered: value => !!value
    },
    {
        name: "переход по строке ExecMacro",
        handler: "definition",
        marker: "  ExecMacro(\"Shar",
        answered: value => !!value
    },
    {
        name: "Hover по переменной с типом",
        handler: "hover",
        marker: "  Field7.bindValue(\"текст\");".slice(0, 8),
        answered: value => !!value
    },
    {
        name: "Signature Help по методу каталога",
        handler: "signatureHelp",
        marker: "  Field7.bindValue(",
        extra: { context: { triggerKind: 2, triggerCharacter: "(" } },
        answered: value => !!value && value.signatures.length > 0
    }
];

async function measureMode(label, source, platform, options) {
    console.log(label);

    for (const item of CASES) {
        const offset = offsetAfter(source, item.marker);
        const times = [];
        let answered = false;

        const repeats = options.once ? 1 : REQUESTS;

        for (let request = 0; request < repeats; request++) {
            /*
             * Холодный режим — это каждый раз новая правка: и модель, и
             * быстрый индекс версии строятся заново.
             */
            const stand = options.freshStand
                ? createStand(source, { platform, modelReady: false })
                : options.stand;

            if (options.freshStand) {
                dropFastCompletionIndex(MAIN);
            }

            const answer = await ask(stand, item.handler, offset, item.extra);
            times.push(answer.ms);
            answered = answered || item.answered(answer.answer);
        }

        report(item.name, times, options.target, answered);
    }
}

(async () => {
    const platform = new PlatformModuleCatalog({ log: () => undefined });
    await platform.ensureIndexLoaded();
    await platform.ensureModules(["RsbFormsInter", "CommonInter"]);

    const source = mainSource(Number(process.argv[2] || 2000));

    /* Те же файлы на диске: их ищет переход по имени модуля. */
    fs.writeFileSync(path.join(WORKSPACE, "lib.mac"), LIB_SOURCE, "utf8");
    fs.writeFileSync(path.join(WORKSPACE, "main.mac"), source, "utf8");
    console.log("образец " + Math.round(source.length / 1024) + " КБ");

    /*
     * Первый запрос в файле: снимок версии ещё не построен. У сервера так
     * бывает один раз — снимок делает анализ документа на правке.
     */
    await measureMode("первый запрос в файле (снимок ещё не построен):",
        source, platform, { freshStand: true, target: 150 });

    /*
     * Обычный случай сразу после правки: снимок версии готов, модель этой
     * версии ещё считается. Именно его и видит пользователь, нажимая
     * Ctrl+Click через мгновение после набора текста.
     */
    const cold = createStand(source, { platform, modelReady: false });

    for (const item of CASES) {
        await ask(cold, item.handler, offsetAfter(source, item.marker),
            item.extra);
    }

    await measureMode("после правки (снимок готов, модель — нет):",
        source, platform, { stand: cold, target: 150 });

    const warm = createStand(source, { platform, modelReady: true });
    /* Прогрев: первый запрос строит кэши резолвера и каталога. */
    for (const item of CASES) {
        await ask(warm, item.handler, offsetAfter(source, item.marker),
            item.extra);
    }

    await measureMode("тёплый режим (модель готова):",
        source, platform, { stand: warm, target: 50 });

    /*
     * Первый запрос после notifyParsed: модель только что стала готовой,
     * и обработчик впервые обращается к ней вместо быстрого индекса.
     * Отдельный режим потому, что кэши сеанса на этом событии
     * сбрасываются, и цена первого запроса — это цена их построения.
     */
    const parsed = createStand(source, { platform, modelReady: true });
    parsed.registry.notifyParsed(MAIN);

    await measureMode("первый запрос после notifyParsed:",
        source, platform, { stand: parsed, target: 50, once: true });

    const stop = startBackground(warm.index, MAIN);
    await measureMode("под фоновым расчётом Problems:",
        source, platform, { stand: warm, target: 50 });
    await stop();
    fs.rmSync(WORKSPACE, { recursive: true, force: true });
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

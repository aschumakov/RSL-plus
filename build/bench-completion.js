"use strict";

/*
 * Замер Completion через настоящий обработчик.
 *
 * Отвечает на вопросы, которые нельзя проверить набором тестов:
 *
 * 1. Сколько ждёт первый список — до готовности модели.
 * 2. Сколько ждёт тёплый список — когда модель уже есть.
 * 3. Сколько ждёт повторный запрос при том же состоянии документа: он обязан
 *    браться из сеанса и не считать ничего заново.
 * 4. Сколько ждёт список во время фонового расчёта Problems и подсветки.
 * 5. Сколько раз редактор обращается к серверу за один открытый список.
 * 6. Сколько ждёт список в большом проекте, пока пользователь набирает имя:
 *    Auto Import ищет среди неподключённых символов всего проекта, и это
 *    единственный список, который редактор перезапрашивает на каждую букву.
 *
 * Запуск:
 *   node build/bench-completion.js [каталог-или-файл ...]
 *
 * Без аргументов берётся сгенерированный образец, поэтому замер работает и
 * там, где репозитория макросов нет.
 */

const fs = require("fs");
const path = require("path");

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
    createFastDocumentSnapshot
} = require(path.join(OUT, "services", "fastDocumentSnapshot"));
const {
    dropFastCompletionIndex
} = require(path.join(OUT, "features", "fastCompletionIndex"));
const {
    buildLocalRslDiagnosticsChunked
} = require(path.join(OUT, "diagnostics"));
const { decodeRslSourceText } = require(path.join(OUT, "core", "textDecoding"));
const {
    TextDocument
} = require(path.join(ROOT, "server", "node_modules",
    "vscode-languageserver-textdocument"));

const SETTINGS = {
    diagnostics: {},
    imports: { enabled: true },
    autoImport: { enabled: true },
    semanticHighlighting: { maxFileSizeKb: 512 },
    inlayHints: { variableTypes: true },
    editor: { completeBlocksOnEnter: false }
};

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

/** Реестр обработчиков над одним файлом; version решает, готова ли модель. */
function createRegistry(uri, text, options) {
    const index = options.index || new WorkspaceIndex();

    if (!options.index) {
        const workspace = options.workspace || [];
        index.registerWorkspaceFiles([
            uri,
            ...workspace.map(item => item.uri)
        ]);

        for (const item of workspace) {
            index.updateExternalModule(item.uri, item.text, 1);
        }
    }

    const module = index.updateOpenModule(uri, text, 1);
    /*
     * Документ той же версии, что и модель, — это «тёплый» случай. Версия
     * впереди модели — «первый» случай: модель этой версии ещё считается.
     */
    const document = TextDocument.create(
        uri,
        "rsl",
        options.modelReady ? 1 : 2,
        text
    );
    const handlers = {};
    let snapshot;
    const registry = new RslLanguageFeatureRegistry({
        connection: createConnection(handlers),
        documents: {
            get: value => value === uri ? document : undefined,
            all: () => [document]
        },
        index,
        resolver: new RslScopeResolver(index, getDefaults(), options.platform),
        definitionProvider: {
            findImportDefinition: async () => undefined,
            findDynamicDefinition: async () => undefined,
            createObjectLocationByUri: () => ({ uri, range: null })
        },
        /*
         * Снимок кэшируется по версии — так делает и сервер
         * (documentAnalysis.getFastSnapshot). Пересоздание на каждый
         * запрос добавляло к замеру полное лексирование файла.
         */
        getFastDocumentSnapshot: () => {
            if (!snapshot) {
                snapshot = createFastDocumentSnapshot(document);
            }

            return snapshot;
        },
        ensureDocumentParsed: async () => undefined,
        requestDocumentParse: () => undefined,
        getSettings: () => SETTINGS,
        supportsRefresh: () => false,
        log: () => undefined
    });
    registry.register();

    return { handlers, document, index, module, registry };
}

/** Позиции запросов: обращение к члену и обычное имя в теле процедуры. */
function positions(text) {
    const result = [];
    const dot = /(\w)\.(?=\w|\s*$)/gmu;
    let match;

    while ((match = dot.exec(text)) !== null && result.length < 40) {
        result.push(match.index + match[0].length);
    }

    const word = /^\s{2,}(\w{3,})/gmu;

    while ((match = word.exec(text)) !== null && result.length < 80) {
        result.push(match.index + match[0].length);
    }

    return result;
}

function percentile(values, share) {
    if (values.length === 0) {
        return 0;
    }

    const sorted = [...values].sort((first, second) => first - second);
    const at = Math.min(sorted.length - 1, Math.floor(sorted.length * share));

    return sorted[at];
}

function report(name, values, target) {
    const p50 = percentile(values, 0.5);
    const p95 = percentile(values, 0.95);
    const max = percentile(values, 1);
    const verdict = target === undefined
        ? ""
        : p95 <= target ? "  (цель ≤ " + target + " мс — да)"
            : "  (цель ≤ " + target + " мс — НЕТ)";
    console.log("  " + name.padEnd(28) +
        "p50 " + p50.toFixed(1) +
        ", p95 " + p95.toFixed(1) +
        ", максимум " + max.toFixed(1) + " мс" + verdict);
}

async function ask(handlers, document, offset, trigger) {
    const started = process.hrtime.bigint();
    const list = await handlers.completion(
        {
            textDocument: { uri: document.uri },
            position: document.positionAt(offset),
            context: trigger
        },
        {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose: () => undefined })
        }
    );

    return {
        ms: Number(process.hrtime.bigint() - started) / 1e6,
        list
    };
}

/** Фоновый расчёт Problems: он и конкурирует с запросами пользователя. */
function startBackground(module, index) {
    let stopped = false;
    const run = async () => {
        while (!stopped) {
            await buildLocalRslDiagnosticsChunked(
                module,
                index,
                SETTINGS.diagnostics,
                () => stopped
            );
            await new Promise(resolve => setImmediate(resolve));
        }
    };
    const pending = run();

    return async () => {
        stopped = true;
        await pending;
    };
}

async function measureFile(name, text, platform) {
    const uri = "file:///bench/" + name;
    const offsets = positions(text);

    if (offsets.length === 0) {
        return;
    }

    console.log(name + "  " + Math.round(text.length / 1024) + " КБ, " +
        offsets.length + " позиций");

    /*
     * 1. Первый список после правки: модель этой версии ещё считается, а
     *    компактный индекс версии ещё не построен.
     *
     * Лексирование файла сюда не входит: снимок сервер делает один раз на
     * правку и не ради Completion — иначе замер говорил бы о нём, а не о
     * подсказках.
     */
    const first = [];
    const coldRegistry = createRegistry(uri, text, {
        platform,
        modelReady: false
    });
    /* Снимок строится до замеров. */
    coldRegistry.registry.invalidate(uri);

    for (const offset of offsets) {
        dropFastCompletionIndex(uri);
        coldRegistry.registry.invalidate(uri);
        first.push((await ask(
            coldRegistry.handlers,
            coldRegistry.document,
            offset,
            { triggerKind: 1 }
        )).ms);
    }

    report("первый список", first, 20);

    /* 2. Тёплый список и 3. повторный запрос того же состояния. */
    const warm = [];
    const repeated = [];
    const requestsPerList = [];
    const warmRegistry = createRegistry(uri, text, {
        platform,
        modelReady: true
    });

    for (const offset of offsets) {
        warm.push((await ask(warmRegistry.handlers, warmRegistry.document,
            offset, { triggerKind: 1 })).ms);
        const again = await ask(warmRegistry.handlers, warmRegistry.document,
            offset, { triggerKind: 3 });
        repeated.push(again.ms);
        requestsPerList.push(again.list.isIncomplete ? 2 : 1);
    }

    report("тёплый список", warm, 5);
    report("повторный из сеанса", repeated, 2);

    /* 4. Список во время фонового расчёта. */
    const underLoad = [];
    const stop = startBackground(warmRegistry.module, warmRegistry.index);

    for (const offset of offsets) {
        underLoad.push((await ask(warmRegistry.handlers, warmRegistry.document,
            offset, { triggerKind: 1 })).ms);
    }

    await stop();
    report("под фоновой нагрузкой", underLoad, 25);

    /*
     * Это вывод из контракта CompletionList, а не измерение: редактор
     * перезапрашивает список только у помеченных неполными. Настоящую
     * последовательность запросов на каждую букву мерит отдельный замер
     * набора имени ниже — там запросы считаются по факту.
     */
    const incomplete = requestsPerList.filter(value => value > 1).length;
    console.log("  обращений на список         " +
        (incomplete === 0
            ? "1 (список полный, дальше фильтрует редактор)"
            : incomplete + " из " + requestsPerList.length +
                " списков помечены неполными"));
}

/**
 * Проект из множества неподключённых модулей.
 *
 * Auto Import ищет именно среди них, и его цена растёт с размером проекта, а не
 * файла. Имена нарочно похожи: пользовательский префикс отбирает не один
 * символ, а сотни, — так и бывает в реальном проекте с общими префиксами.
 */
function syntheticWorkspace(modules, symbolsPerModule) {
    const result = [];

    for (let file = 0; file < modules; file++) {
        const lines = [];

        for (let symbol = 0; symbol < symbolsPerModule; symbol++) {
            const name = "Set" + (file * symbolsPerModule + symbol);
            lines.push("Macro " + name + "(value)");
            lines.push("  return value;");
            lines.push("End;");
        }

        result.push({
            uri: "file:///bench/lib/module" + file + ".mac",
            text: lines.join("\n")
        });
    }

    return result;
}

/**
 * Набор имени в большом проекте.
 *
 * Список Auto Import помечается неполным — значит редактор обязан
 * перезапрашивать его на каждую букву. Здесь измеряется именно это: не один
 * запрос, а последовательность `s`, `se`, `set`, `setu`, как её видит сервер.
 */
async function measureWorkspaceSearch(platform, modules, symbolsPerModule) {
    const uri = "file:///bench/typing.mac";
    const workspace = syntheticWorkspace(modules, symbolsPerModule);
    const head = "Macro Test()\n  Var result;\n  result = ";
    const tail = ";\nEnd;\n";
    const symbols = modules * symbolsPerModule;

    console.log("проект " + modules + " модулей, " + symbols +
        " символов: набор имени");

    const perLetter = new Map();
    let requests = 0;
    /*
     * Индекс проекта общий для всех нажатий: у сервера он живёт постоянно, а
     * построение с нуля на каждую букву мерило бы индексацию, а не подсказку.
     */
    const shared = createRegistry(uri, head + tail, {
        platform,
        modelReady: true,
        workspace
    });

    for (const typed of ["s", "se", "set", "setu"]) {
        const text = head + typed + tail;
        const registry = createRegistry(uri, text, {
            platform,
            modelReady: true,
            index: shared.index
        });
        const offset = head.length + typed.length;
        const times = [];

        for (let run = 0; run < 5; run++) {
            /* Каждая буква — новая версия документа: сеанс не переиспользуется. */
            registry.registry.invalidate(uri);
            const answer = await ask(
                registry.handlers,
                registry.document,
                offset,
                { triggerKind: 1 }
            );
            times.push(answer.ms);
            requests++;

            if (run === 0) {
                perLetter.set(typed, {
                    items: answer.list.items.length,
                    incomplete: answer.list.isIncomplete
                });
            }
        }

        report("после «" + typed + "»", times, 15);
    }

    for (const [typed, info] of perLetter) {
        console.log("  «" + typed + "»: элементов " + info.items +
            (info.incomplete ? ", список неполный" : ", список полный"));
    }

    console.log("  всего запросов                " + requests);
}

function syntheticSource() {
    const lines = [
        "Import RsbFormsInter;",
        "Class Ledger",
        "  Var Balance: Double;",
        "  Macro PostEntry(value: Double)",
        "  End;",
        "End;",
        "Macro Test()",
        "  Var label: TRsbLabel;",
        "  Var book: Ledger;"
    ];

    for (let index = 0; index < 400; index++) {
        lines.push("  Var value" + index + " = " + index + ";");
        lines.push("  label.");
        lines.push("  book.");
        lines.push("  value" + index + " = value" + index + " + 1;");
    }

    lines.push("End;");

    return lines.join("\n");
}

function collectFiles(targets) {
    const result = [];
    const visit = entry => {
        let stat;

        try {
            stat = fs.statSync(entry);
        } catch (error) {
            return;
        }

        if (stat.isDirectory()) {
            if (path.basename(entry) === ".git") {
                return;
            }
            fs.readdirSync(entry).forEach(item =>
                visit(path.join(entry, item))
            );
            return;
        }

        if (/\.(?:mac|rsm)$/iu.test(entry) && stat.size > 50 * 1024) {
            result.push({ path: entry, size: stat.size });
        }
    };

    targets.forEach(visit);

    return result.sort((left, right) => right.size - left.size).slice(0, 3);
}

(async () => {
    const platform = new PlatformModuleCatalog({ log: () => undefined });
    await platform.ensureIndexLoaded();
    await platform.ensureModules(["RsbFormsInter", "CommonInter", "BankInter"]);
    const targets = process.argv.slice(2);
    const files = targets.length > 0 ? collectFiles(targets) : [];

    if (files.length === 0) {
        if (targets.length > 0) {
            console.log("Подходящих файлов не найдено; беру образец.");
        }
        await measureFile("образец.mac", syntheticSource(), platform);
        await measureWorkspaceSearch(platform, 400, 25);
        return;
    }

    for (const file of files) {
        await measureFile(
            path.basename(file.path),
            decodeRslSourceText(fs.readFileSync(file.path)),
            platform
        );
    }

    await measureWorkspaceSearch(platform, 400, 25);
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

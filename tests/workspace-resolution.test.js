"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const {
    createExternalSymbolTree,
    createSymbolTree
} = require("./test-helpers");
const {
    ReferenceIndex,
    referenceIndexTesting
} = require("../server/out/analysis/referenceIndex");
const {
    buildImportResolutionDiagnostics
} = require("../server/out/diagnostics/importResolutionDiagnostics");
const {
    WorkspaceModuleLoader
} = require("../server/out/indexing/workspaceModuleLoader");
const {
    WorkspaceFileDiscoveryService
} = require("../server/out/indexing/workspaceFileDiscoveryService");
const {
    DocumentAnalysisService
} = require("../server/out/services/documentAnalysisService");
const {
    WorkerSyntaxParsePool
} = require("../server/out/services/syntaxParseService");
const {
    createExternalModuleSummary
} = require("../server/out/moduleModel");
const {
    createOpenModuleModel
} = require("../server/out/moduleModel");
const {
    isLocalReferenceTarget
} = require("../server/out/analysis/references");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

function createDocument(uri, version, source) {
    const lineStarts = [0];

    for (let index = 0; index < source.length; index++) {
        if (source[index] === "\n") {
            lineStarts.push(index + 1);
        }
    }

    return {
        uri,
        languageId: "rsl",
        version,
        lineCount: lineStarts.length,
        getText: () => source,
        positionAt(offset) {
            const bounded = Math.max(0, Math.min(offset, source.length));
            let line = 0;
            while (
                line + 1 < lineStarts.length &&
                lineStarts[line + 1] <= bounded
            ) {
                line++;
            }
            return {
                line,
                character: bounded - lineStarts[line]
            };
        },
        offsetAt(position) {
            const line = Math.max(
                0,
                Math.min(position.line, lineStarts.length - 1)
            );
            return Math.min(
                source.length,
                lineStarts[line] + Math.max(0, position.character)
            );
        }
    };
}

function testModuleResolution() {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([
        "file:///workspace/retail/common.mac",
        "file:///workspace/corporate/common.mac",
        "file:///workspace/lib/unique.mac"
    ]);

    const ambiguous = index.resolveWorkspaceFile("common");
    assert.strictEqual(ambiguous.kind, "ambiguous");
    assert.strictEqual(ambiguous.candidates.length, 2);
    assert.strictEqual(index.findWorkspaceFileUri("common"), undefined);

    const exact = index.resolveWorkspaceFile("retail/common");
    assert.strictEqual(exact.kind, "resolved");
    assert.strictEqual(
        exact.value,
        "file:///workspace/retail/common.mac"
    );

    const unique = index.resolveWorkspaceFile("unique");
    assert.strictEqual(unique.kind, "resolved");
    assert.strictEqual(
        unique.value,
        "file:///workspace/lib/unique.mac"
    );
    assert.strictEqual(index.resolveWorkspaceFile("missing").kind, "missing");
}

function testAmbiguousImportDiagnostic() {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([
        "file:///workspace/retail/common.mac",
        "file:///workspace/corporate/common.mac"
    ]);
    const source = "Import common;\nMacro Test()\nEnd;";
    const indexedModule = index.updateOpenModule(
        "file:///workspace/main.mac",
        source,
        1
    );
    const diagnostics = buildImportResolutionDiagnostics(
        indexedModule,
        index,
        { structure: true }
    );

    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, "ambiguous-import");
    assert.ok(diagnostics[0].message.includes("retail/common.mac"));
    assert.ok(diagnostics[0].message.includes("corporate/common.mac"));
    assert.strictEqual(index.findWorkspaceFileUri("common"), undefined);
}

function testExternalSummaryAndReferenceBoundaries() {
    const source = [
        "Import common, helpers;",
        "Macro PublicMacro(value)",
        "  Var localValue = 1;",
        "End;",
        "Class (TRecHandler) Customer",
        "  Macro Load(id)",
        "    Var localInMethod;",
        "  End;",
        "End;"
    ].join("\n");
    const external = createExternalModuleSummary(source);

    assert.deepStrictEqual(
        external.imports.map(value => value.toLowerCase()),
        ["common", "helpers"]
    );
    assert.ok(external.symbolTree.find("PublicMacro"));
    assert.ok(external.symbolTree.find("Customer"));
    assert.ok(external.symbolTree.find("Load"));
    assert.strictEqual(
        external.symbolTree.find("TRecHandler"),
        undefined,
        "Базовый класс не должен становиться объявлением модуля"
    );
    assert.strictEqual(
        external.symbolTree.find("localValue"),
        undefined
    );
    assert.strictEqual(
        external.symbolTree.find("localInMethod"),
        undefined
    );

    const inheritanceIndex = new WorkspaceIndex();
    const libraryUri = "file:///workspace/library.mac";
    inheritanceIndex.updateExternalModule(libraryUri, source, 1);
    const consumerSource = [
        "Import library;",
        "Macro Use(value:TRecHandler)",
        "End;"
    ].join("\n");
    const consumerUri = "file:///workspace/consumer.mac";
    inheritanceIndex.updateOpenModule(consumerUri, consumerSource, 1);
    assert.strictEqual(
        inheritanceIndex.findImportedSymbols(
            consumerUri,
            "TRecHandler"
        ).length,
        0
    );
    assert.strictEqual(
        inheritanceIndex.findImportedSymbols(
            consumerUri,
            "Customer"
        ).length,
        1
    );

    const tree = createSymbolTree([
        "Macro Test(p)",
        "  Var localValue: Integer;",
        "End;",
        "Private Macro Hidden()",
        "End;",
        "Macro PublicMacro()",
        "End;"
    ].join("\n"));
    assert.strictEqual(
        isLocalReferenceTarget(tree, tree.find("localValue")),
        true
    );
    assert.strictEqual(
        isLocalReferenceTarget(tree, tree.find("Hidden")),
        true
    );
    assert.strictEqual(
        isLocalReferenceTarget(tree, tree.find("PublicMacro")),
        false
    );
}

function testFullAndCompactModelsShareDeclarationContract() {
    const source = [
        "Import globals, helpers;",
        "Const Answer = 42;",
        "Macro Load(value:Integer):String",
        "End;",
        "Class (BaseHandler) Customer",
        "  Var Code:String;",
        "  Macro Save(id:Integer):Bool",
        "  End;",
        "End;",
        "Private Macro Hidden()",
        "End;"
    ].join("\n");
    const full = createOpenModuleModel(source).symbolTree;
    const compact = createExternalModuleSummary(source).symbolTree;

    const flattenPublic = root => {
        const result = [];
        const visit = symbol => {
            if (!symbol.isPrivate) {
                result.push({
                    id: symbol.id,
                    name: symbol.name,
                    kind: symbol.kind,
                    typeName: symbol.typeName,
                    value: symbol.value,
                    parameterText: symbol.parameterText,
                    baseClassName: symbol.baseClassName
                });
                symbol.children.forEach(visit);
            }
        };
        root.children.forEach(visit);
        return result;
    };

    assert.deepStrictEqual(flattenPublic(compact), flattenPublic(full));
    assert.strictEqual(compact.find("Hidden"), undefined);
}

function testWindowsUriCaseDoesNotCreateDuplicateModule() {
    const index = new WorkspaceIndex();

    const discoveredUri =
        "file:///d:/achumakov/gitlab/rsmacro/custom/bscarddocs.mac";
    const openedUri =
        "file:///d:/Achumakov/GITLAB/rsmacro/custom/bscarddocs.mac";

    index.registerWorkspaceFiles([discoveredUri]);

    index.updateExternalModule(
        discoveredUri,
        "Macro ExternalVersion()\nEnd;",
        1
    );

    index.updateOpenModule(
        openedUri,
        "Macro OpenVersion()\nEnd;",
        2
    );

    const resolution = index.resolveWorkspaceFile("bscarddocs");

    assert.strictEqual(
        resolution.kind,
        "resolved",
        "Разный регистр Windows-пути не должен создавать неоднозначный Import"
    );

    assert.strictEqual(
        index.getModules().length,
        1,
        "Открытый и импортированный варианты должны быть одной моделью"
    );

    assert.strictEqual(
        index.getModule(discoveredUri).uri,
        openedUri,
        "Открытая полная модель должна заменить external summary"
    );
}

async function testWorkspaceLoaderUsesActiveImports() {
    const directory = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "rsl-loader-")
    );

    try {
        const files = ["a.mac", "b.mac", "c.mac"].map(name => {
            const file = path.join(directory, name);
            fs.writeFileSync(file, "Macro Test()\nEnd;", "utf8");
            return pathToFileURL(file).toString();
        });
        const loaded = [];
        const modules = new Map();
        const workspaceFiles = new Set();
        const index = {
            registerWorkspaceFiles(uris) {
                uris.forEach(uri => workspaceFiles.add(uri));
            },
            unregisterWorkspaceFile(uri) {
                workspaceFiles.delete(uri);
            },
            removeModule(uri) {
                modules.delete(uri);
            },
            getModule(uri) {
                return modules.get(uri);
            },
            findModuleByName() {
                return undefined;
            },
            resolveWorkspaceFile(name) {
                const uri = Array.from(workspaceFiles).find(value =>
                    path.basename(new URL(value).pathname).toLowerCase() ===
                    `${name}`.replace(/\.mac$/i, "").toLowerCase() + ".mac"
                );
                return uri
                    ? { kind: "resolved", value: uri }
                    : { kind: "missing" };
            },
            updateExternalModule(uri, source, version) {
                const module = {
                    uri,
                    source: "",
                    sourceLength: source.length,
                    object: {},
                    version,
                    isOpen: false,
                    kind: "external",
                    imports: []
                };
                modules.set(uri, module);
                loaded.push(uri);
                return module;
            }
        };
        const loader = new WorkspaceModuleLoader(index, {
            log: message => {
                throw new Error(message);
            },
            onModuleLoaded() {},
            onModuleCountChanged() {}
        });

        loader.registerWorkspaceFiles(files);
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.strictEqual(
            loaded.length,
            0,
            "Регистрация workspace не должна разбирать все .mac"
        );

        loader.enqueueImport("b");
        while (loader.isIndexing) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }

        assert.deepStrictEqual(loaded, [files[1]]);
        assert.strictEqual(loader.mode, "activeImports");
    } finally {
        await fs.promises.rm(directory, {
            recursive: true,
            force: true
        });
    }
}

async function testActiveDocumentPreemptsQueuedModules() {
    const directory = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "rsl-priority-")
    );

    try {
        const names = ["running.mac", "old-active.mac", "new-active.mac"];
        const files = names.map(name =>
            pathToFileURL(path.join(directory, name)).toString()
        );
        await Promise.all(names.map((name, index) =>
            fs.promises.writeFile(
                path.join(directory, name),
                `Macro Test${index}()\nEnd;`,
                "utf8"
            )
        ));

        const loaded = [];
        const index = new WorkspaceIndex();
        const loader = new WorkspaceModuleLoader(index, {
            log: message => {
                throw new Error(message);
            },
            onModuleLoaded: module => loaded.push(module.uri),
            onModuleCountChanged() {}
        });
        loader.registerWorkspaceFiles(files);

        loader.enqueue(files[0], "background");
        loader.enqueue(files[1], "foreground");
        loader.beginForegroundGeneration();
        loader.enqueue(files[2], "foreground");

        while (loader.isIndexing) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }

        assert.deepStrictEqual(
            loaded,
            [files[0], files[2], files[1]],
            "Новая активная ветвь должна обгонять старую очередь"
        );
    } finally {
        await fs.promises.rm(directory, {
            recursive: true,
            force: true
        });
    }
}

async function testActiveDocumentPreemptsQueuedParses() {
    const sources = new Map([
        ["file:///old-a.mac", "Macro OldA()\nEnd;"],
        ["file:///old-b.mac", "Macro OldB()\nEnd;"],
        ["file:///active.mac", "Macro Active()\nEnd;"]
    ]);
    const documents = new Map(
        Array.from(sources, ([uri, source]) => [
            uri,
            createDocument(uri, 1, source)
        ])
    );
    const parsed = [];
    const service = new DocumentAnalysisService(
        {
            get: uri => documents.get(uri)
        },
        new WorkspaceIndex(),
        {
            getAvailable: () => ({
                imports: { enabled: true },
                autoImport: { enabled: true },
                analysis: { workspaceIndexing: "activeImports" },
                semanticHighlighting: { maxFileSizeKb: 512 },
                diagnostics: {}
            })
        },
        {
            log: message => {
                throw new Error(message);
            },
            invalidateProviderCaches: () => undefined,
            onParsed: module => parsed.push(module.uri),
            onImports: () => undefined,
            initialParseDelayMs: 0,
            inactiveParseDelayMs: 0
        }
    );

    for (const document of documents.values()) {
        service.open(document);
    }
    service.setActiveDocument("file:///active.mac");

    while (service.isBusy) {
        await new Promise(resolve => setTimeout(resolve, 5));
    }

    assert.strictEqual(
        parsed[0],
        "file:///active.mac",
        "Полный parse активного файла должен получить первый scheduler slot"
    );
}

/*
 * Регрессия по ревью: два больших "фоновых" файла занимают оба worker'а
 * пула, отменяются переключением вкладки, затем открывается маленький
 * активный файл. До резервирования foreground-слота в
 * WorkerSyntaxParsePool этот файл ждал освобождения worker'а физически
 * ещё разбирающего устаревший текст (cancel() не прерывает синхронный
 * parse внутри worker_threads) — до 1.2-1.5с на файлах ~550КБ. Тест
 * проходит через реальный DocumentAnalysisService + WorkerSyntaxParsePool,
 * а не только через синхронный fallback, как остальные тесты в этом файле.
 */
async function testActiveDocumentSurvivesStaleWorkerContention() {
    function makeLargeSource(approxKb) {
        const line = 'Var x1 = Something.Method(a, "text", 42) + b;\n';
        const repeats = Math.ceil((approxKb * 1024) / line.length);
        return line.repeat(repeats);
    }

    /*
     * "small" здесь всё равно должен превышать DIRECT_PARSE_MAX_CHARS
     * (150000 символов) в documentAnalysisService.ts, иначе он вообще не
     * пойдёт через worker pool и тест ничего не проверит про резерв
     * foreground-слота — только про отдельную оптимизацию (P0-2).
     */
    const documentsByUri = new Map([
        ["file:///stale-a.mac", createDocument("file:///stale-a.mac", 1, makeLargeSource(550))],
        ["file:///stale-b.mac", createDocument("file:///stale-b.mac", 1, makeLargeSource(550))],
        ["file:///active-small.mac", createDocument("file:///active-small.mac", 1, makeLargeSource(160))]
    ]);

    const pool = new WorkerSyntaxParsePool(() => {}, { poolSize: 2 });
    const parsedAt = [];
    /*
     * Момент фактического завершения parse зависит не только от очереди,
     * но и от того, сколько CPU достаётся worker'у после диспетчеризации —
     * на загруженной машине это делает сравнение времён ЗАВЕРШЕНИЯ шумным
     * и нестабильным. Момент же ДИСПЕТЧЕРИЗАЦИИ (когда pool.parse()
     * реально вызывается для документа) определяется исключительно
     * очередью/резервом слотов и не зависит от последующей CPU-гонки —
     * это и есть детерминированный инвариант, который стоит проверять.
     */
    const dispatchedAt = [];
    const recordingParser = {
        get currentUri() {
            return pool.currentUri;
        },
        parse(uri, source, lex, priority) {
            dispatchedAt.push([uri, Date.now()]);
            return pool.parse(uri, source, lex, priority);
        },
        cancel(uri) {
            return pool.cancel(uri);
        },
        dispose() {
            return pool.dispose();
        }
    };
    const service = new DocumentAnalysisService(
        { get: uri => documentsByUri.get(uri) },
        new WorkspaceIndex(),
        {
            getAvailable: () => ({
                imports: { enabled: true },
                autoImport: { enabled: true },
                analysis: { workspaceIndexing: "activeImports" },
                semanticHighlighting: { maxFileSizeKb: 512 },
                diagnostics: {}
            })
        },
        {
            log: () => undefined,
            syntaxParser: recordingParser,
            invalidateProviderCaches: () => undefined,
            onParsed: module => parsedAt.push([module.uri, Date.now()]),
            onImports: () => undefined,
            initialParseDelayMs: 0,
            inactiveParseDelayMs: 0,
            maxConcurrentValidations: 2
        }
    );

    try {
        /*
         * Прогреваем оба worker'а тривиальным parse заранее. В реальном
         * сервере worker'ы создаются один раз при старте и живут всю
         * сессию — стоимость создания потока (variable, особенно на
         * загруженной машине) не должна попадать в измеряемое окно и
         * маскировать разницу между "ждать оба занятых слота" и "ждать
         * первый освободившийся".
         */
        await Promise.all([
            pool.parse("file:///warm-1.mac", "Macro W()\nEnd;", { tokens: [] }, "background"),
            pool.parse("file:///warm-2.mac", "Macro W()\nEnd;", { tokens: [] }, "foreground")
        ]);

        // Оба больших файла открываются фоново (не активны) и занимают пул.
        service.open(documentsByUri.get("file:///stale-a.mac"));
        service.open(documentsByUri.get("file:///stale-b.mac"));
        service.setActiveDocument("file:///stale-a.mac");
        service.setActiveDocument("file:///stale-b.mac");

        // Даём обоим реально уйти в worker (не просто встать в очередь).
        await new Promise(resolve => setTimeout(resolve, 30));

        // Переключение на маленький активный файл — большие становятся
        // фоновыми/отменяются, но воркеры физически продолжают их считать.
        service.open(documentsByUri.get("file:///active-small.mac"));
        service.setActiveDocument("file:///active-small.mac");

        /*
         * Абсолютное время ЗАВЕРШЕНИЯ (parsedAt) зависит от того, сколько
         * CPU реально достаётся worker'у после старта — на загруженной
         * машине оба физических worker'а конкурируют за ядра, и даже
         * корректно продиспетченный active-small может завершить СВОЙ
         * расчёт позже второго stale-файла просто из-за шума планировщика
         * ОС, а не из-за очереди. Поэтому проверяется момент
         * ДИСПЕТЧЕРИЗАЦИИ (dispatchedAt — когда recordingParser.parse()
         * реально вызван для документа), который определяется только
         * очередью/резервом слотов и не зависит от последующей CPU-гонки.
         * До фикса (см. previousActiveUri в setActiveDocument) queued-
         * задача файла, который был активен мгновение назад, отменялась
         * собственной же логикой "снять фон с других вкладок" и не
         * диспетчеризовалась вовсе — ждать пришлось бы либо оба фоновых
         * worker'а, либо (в худшем случае) бесконечно.
         */
        await waitFor(() => parsedAt.length === 3, 20000);

        const dispatchTimeOf = uri => dispatchedAt.find(([u]) => u === uri)[1];
        const completionTimeOf = uri => parsedAt.find(([u]) => u === uri)[1];
        const activeDispatchTime = dispatchTimeOf("file:///active-small.mac");
        const laterStaleCompletionTime = Math.max(
            completionTimeOf("file:///stale-a.mac"),
            completionTimeOf("file:///stale-b.mac")
        );

        assert.ok(
            activeDispatchTime < laterStaleCompletionTime,
            "Активный файл должен уйти в worker сразу после освобождения " +
                "ПЕРВОГО занятого слота, а не после завершения ОБОИХ " +
                "фоновых 550КБ-файлов — иначе он ждёт освобождения worker'а " +
                "вместо использования резервированного слота"
        );
    } finally {
        await pool.dispose();
    }
}

async function testParseReadinessDoesNotWaitForSettings() {
    const uri = "file:///workspace/navigation.mac";
    const source = [
        "Import library;",
        "Macro Test()",
        "  Shared();",
        "End;"
    ].join("\n");
    const document = createDocument(uri, 1, source);
    const index = new WorkspaceIndex();
    const performanceEvents = [];
    const imported = [];
    const service = new DocumentAnalysisService(
        {
            get: requestedUri =>
                requestedUri === document.uri ? document : undefined
        },
        index,
        {
            getAvailable: () => ({
                imports: { enabled: true },
                autoImport: { enabled: true },
                analysis: { workspaceIndexing: "activeImports" },
                semanticHighlighting: { maxFileSizeKb: 512 },
                diagnostics: {}
            })
        },
        {
            log: message => {
                throw new Error(message);
            },
            performance: {
                enabled: true,
                start(event) {
                    performanceEvents.push(event);
                    return { event };
                },
                end() {}
            },
            invalidateProviderCaches: () => undefined,
            onParsed: () => undefined,
            onImports: (_uri, imports) => imported.push(...imports),
            initialParseDelayMs: 1000
        }
    );

    service.setActiveDocument(uri);
    assert.strictEqual(service.open(document), true);
    assert.strictEqual(
        service.open(document),
        false,
        "Повторный open той же версии должен быть идемпотентным"
    );
    service.changed(document);

    assert.strictEqual(
        performanceEvents.filter(event =>
            event === "analysis.fastSnapshot"
        ).length,
        1,
        "onDidChangeContent после open не должен повторно запускать lexer"
    );
    assert.strictEqual(
        performanceEvents.filter(event =>
            event === "analysis.outlineSnapshot"
        ).length,
        1,
        "Outline должен готовиться один раз до фонового parser"
    );
    assert.ok(
        Array.isArray(service.getFastSnapshot(document).symbols),
        "Structure должна быть готова сразу после открытия"
    );

    const parsed = await Promise.race([
        service.ensureParsed(document),
        new Promise((_, reject) => setTimeout(
            () => reject(new Error(
                "ensureParsed ожидает workspace/configuration"
            )),
            250
        ))
    ]);

    assert.ok(parsed, "AST должен быть доступен без запроса настроек");
    assert.deepStrictEqual(imported, ["library"]);
    service.close(uri);
}

async function testReferenceIndexIsLazyPersistentAndTargeted() {
    const directory = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "rsl-ref-index-")
    );
    const originalReadFile = fs.promises.readFile;

    try {
        const firstPath = path.join(directory, "First.mac");
        const secondPath = path.join(directory, "Second.mac");
        const cachePath = path.join(
            directory,
            "cache",
            "references-v2.json"
        );
        fs.writeFileSync(firstPath, "Macro TargetName()\nEnd;\n", "utf8");
        fs.writeFileSync(secondPath, "Macro OtherName()\nEnd;\n", "utf8");

        const firstUri = pathToFileURL(firstPath).toString();
        const secondUri = pathToFileURL(secondPath).toString();
        const uris = [firstUri, secondUri];
        const referenceIndex = new ReferenceIndex({ readBatchSize: 2 });
        referenceIndex.configurePersistence(cachePath);
        referenceIndex.retainWorkspaceFiles(uris);

        const firstCandidates = await referenceIndex.findCandidates(
            "targetname",
            uris
        );
        assert.deepStrictEqual(
            firstCandidates.map(item => item.uri),
            [firstUri]
        );
        assert.strictEqual(referenceIndex.getStats().indexedFiles, 2);
        await referenceIndex.flush();
        assert.ok(fs.existsSync(cachePath));

        let persistentCacheReads = 0;
        fs.promises.readFile = async (filePath, ...args) => {
            if (path.resolve(String(filePath)) === path.resolve(cachePath)) {
                persistentCacheReads++;
            }
            return originalReadFile.call(fs.promises, filePath, ...args);
        };

        const restored = new ReferenceIndex({ readBatchSize: 2 });
        restored.configurePersistence(cachePath);
        restored.retainWorkspaceFiles(uris);
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(
            persistentCacheReads,
            0,
            "Persistent index не должен читаться при старте language server"
        );
        const restoredCandidates = await restored.findCandidates(
            "targetname",
            uris
        );
        fs.promises.readFile = originalReadFile;
        assert.strictEqual(
            persistentCacheReads,
            1,
            "Persistent index должен загружаться лениво при первом References"
        );
        assert.deepStrictEqual(
            restoredCandidates.map(item => item.uri),
            [firstUri],
            "Индекс должен восстанавливаться с диска по mtime + size"
        );
        assert.ok(restored.getStats().persistedFiles >= 2);

        restored.invalidate(secondUri);
        assert.strictEqual(
            restored.getStats().indexedFiles,
            1,
            "Инвалидация одного файла не должна очищать весь ReferenceIndex"
        );

        fs.writeFileSync(
            firstPath,
            "Macro RenamedTarget()\nEnd;\n// changed size\n",
            "utf8"
        );
        const staleCandidates = await restored.findCandidates(
            "targetname",
            [firstUri]
        );
        assert.strictEqual(
            staleCandidates.length,
            0,
            "Изменение mtime/size должно принудительно перестроить запись"
        );

        let eagerReferenceScans = 0;
        const loader = new WorkspaceModuleLoader(
            new WorkspaceIndex(),
            {
                log: () => undefined,
                onModuleLoaded: () => undefined,
                onModuleCountChanged: () => undefined
            },
            {
                retainWorkspaceFiles: () => undefined,
                invalidate: () => undefined,
                indexSource: () => {
                    eagerReferenceScans++;
                }
            }
        );
        loader.registerWorkspaceFiles([secondUri]);
        await loader.ensureLoadedUri(secondUri);
        assert.strictEqual(
            eagerReferenceScans,
            0,
            "Загрузка Import не должна сканировать файл ради References"
        );

        const hashes = referenceIndexTesting.collectIdentifierHashes(
            "Alpha Alpha Beta"
        );
        assert.strictEqual(
            hashes.length,
            2,
            "Хэши в файле должны быть уникальными"
        );

        const graphPaths = ["A.mac", "B.mac", "C.mac", "Unrelated.mac"]
            .map(name => path.join(directory, name));
        fs.writeFileSync(
            graphPaths[0],
            "Macro TargetName()\nEnd;",
            "utf8"
        );
        fs.writeFileSync(
            graphPaths[1],
            "Import A;\nMacro Use()\n TargetName();\nEnd;",
            "utf8"
        );
        fs.writeFileSync(graphPaths[2], "Import B;", "utf8");
        fs.writeFileSync(
            graphPaths[3],
            "Macro Nothing()\nEnd;",
            "utf8"
        );

        const graphUris = graphPaths.map(value =>
            pathToFileURL(value).toString()
        );
        const graphIndex = new ReferenceIndex({ readBatchSize: 4 });
        graphIndex.retainWorkspaceFiles(graphUris);
        await graphIndex.findCandidates("targetname", graphUris);
        const limited = new Set(await graphIndex.getCandidateUris(
            graphUris[0],
            graphUris
        ));
        assert.ok(limited.has(graphUris[0]));
        assert.ok(limited.has(graphUris[1]));
        assert.ok(limited.has(graphUris[2]));
        assert.ok(!limited.has(graphUris[3]));
    } finally {
        fs.promises.readFile = originalReadFile;
        await fs.promises.rm(directory, {
            recursive: true,
            force: true
        });
    }
}

async function testImportedSymbolLoadsOnDemand() {
    const directory = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "rsl-navigation-")
    );

    try {
        const libraryPath = path.join(directory, "library.mac");
        const libraryUri = pathToFileURL(libraryPath).toString();
        const mainUri = pathToFileURL(
            path.join(directory, "main.mac")
        ).toString();
        await fs.promises.writeFile(
            libraryPath,
            "Macro Shared()\nEnd;",
            "utf8"
        );

        const index = new WorkspaceIndex();
        const source = "Import library;\nMacro Test()\n Shared();\nEnd;";
        index.updateOpenModule(mainUri, source, 1);
        const loader = new WorkspaceModuleLoader(index, {
            log: message => {
                throw new Error(message);
            },
            onModuleLoaded: () => undefined,
            onModuleCountChanged: () => undefined
        });
        loader.registerWorkspaceFiles([libraryUri]);

        assert.strictEqual(
            index.findImportedSymbols(mainUri, "Shared").length,
            0
        );
        assert.strictEqual(
            await loader.ensureImportedSymbol(mainUri, "Shared"),
            true
        );
        assert.strictEqual(
            index.findImportedSymbols(mainUri, "Shared").length,
            1
        );
    } finally {
        await fs.promises.rm(directory, {
            recursive: true,
            force: true
        });
    }
}

async function testAutoImportSearchLoadsOnlyExporter() {
    const directory = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "rsl-auto-import-")
    );

    try {
        const exporterPath = path.join(directory, "library.mac");
        const usagePath = path.join(directory, "usage.mac");
        const privatePath = path.join(directory, "private.mac");
        await Promise.all([
            fs.promises.writeFile(
                exporterPath,
                "Macro Shared(value)\nEnd;",
                "utf8"
            ),
            fs.promises.writeFile(
                usagePath,
                "Macro Test()\n Shared(1);\nEnd;",
                "utf8"
            ),
            fs.promises.writeFile(
                privatePath,
                "Private Macro Shared(value)\nEnd;",
                "utf8"
            )
        ]);

        const uris = [exporterPath, usagePath, privatePath].map(file =>
            pathToFileURL(file).toString()
        );
        const index = new WorkspaceIndex();
        const loader = new WorkspaceModuleLoader(index, {
            log: message => {
                throw new Error(message);
            },
            onModuleLoaded: () => undefined,
            onModuleCountChanged: () => undefined
        });
        loader.registerWorkspaceFiles(uris);

        const automatic = await loader.findModulesExportingSymbol(
            "Shared",
            10,
            { scanWorkspace: false }
        );
        assert.deepStrictEqual(automatic, []);
        assert.strictEqual(
            index.size,
            0,
            "Автоматический Quick Fix не должен читать workspace"
        );

        const modules = await loader.findModulesExportingSymbol("Shared");

        assert.deepStrictEqual(
            modules.map(module => module.uri),
            [uris[0]]
        );
        assert.ok(index.getModule(uris[0]));
        assert.strictEqual(index.getModule(uris[1]), undefined);
        assert.strictEqual(index.getModule(uris[2]), undefined);
    } finally {
        await fs.promises.rm(directory, {
            recursive: true,
            force: true
        });
    }
}

async function testServerSideWorkspaceDiscovery() {
    const directory = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "rsl-discovery-")
    );
    try {
        await fs.promises.mkdir(path.join(directory, "src"));
        await fs.promises.mkdir(path.join(directory, "node_modules"));
        await fs.promises.writeFile(path.join(directory, "main.mac"), "", "utf8");
        await fs.promises.writeFile(path.join(directory, "src", "lib.MAC"), "", "utf8");
        await fs.promises.writeFile(
            path.join(directory, "node_modules", "ignored.mac"),
            "",
            "utf8"
        );
        let discovered;
        const service = new WorkspaceFileDiscoveryService({
            log: message => { throw new Error(message); },
            initialDelayMs: 0,
            interactivePauseMs: 0,
            onFiles: uris => { discovered = Array.from(uris); }
        });
        service.configure({
            capabilities: {},
            rootUri: pathToFileURL(directory).toString()
        });
        await waitFor(() => Array.isArray(discovered), 1000);
        const names = discovered.map(uri => path.basename(new URL(uri).pathname))
            .sort();
        assert.deepStrictEqual(names, ["lib.MAC", "main.mac"]);
        service.dispose();
    } finally {
        await fs.promises.rm(directory, { recursive: true, force: true });
    }
}

async function waitFor(predicate, timeoutMs) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error("timeout");
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

(async () => {
    testModuleResolution();
    console.log("[OK] workspace различает resolved, ambiguous и missing");

    testAmbiguousImportDiagnostic();
    console.log("[OK] неоднозначный Import не выбирается молча");

    testExternalSummaryAndReferenceBoundaries();
    console.log("[OK] external summary не смешивает публичные и локальные символы");

    testFullAndCompactModelsShareDeclarationContract();
    console.log("[OK] full и compact модели используют единый declaration contract");

    await testWorkspaceLoaderUsesActiveImports();
    console.log("[OK] загружается только активный Import-граф");

    await testActiveDocumentPreemptsQueuedModules();
    console.log("[OK] новая активная Import-ветвь вытесняет старую очередь");

    await testActiveDocumentPreemptsQueuedParses();
    console.log("[OK] полный parse активного файла вытесняет фоновые разборы");

    await testActiveDocumentSurvivesStaleWorkerContention();
    console.log("[OK] активный документ не ждёт занятые фоновыми файлами worker'ы");

    await testParseReadinessDoesNotWaitForSettings();
    console.log("[OK] парсер и Import не ждут workspace/configuration");

    await testReferenceIndexIsLazyPersistentAndTargeted();
    console.log("[OK] ReferenceIndex ленивый, persistent и адресный");

    await testImportedSymbolLoadsOnDemand();
    console.log("[OK] Import-символ загружается для навигации по запросу");

    await testAutoImportSearchLoadsOnlyExporter();
    console.log("[OK] Auto Import адресно загружает только экспортирующий модуль");

    await testServerSideWorkspaceDiscovery();
    console.log("[OK] каталог workspace строится в language server и соблюдает exclude");
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

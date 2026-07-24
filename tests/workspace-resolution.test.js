"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const { CBase } = require("../server/out/common");
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
    DocumentAnalysisService
} = require("../server/out/services/documentAnalysisService");
const {
    scanExternalModule
} = require("../server/out/indexing/externalModuleScanner");
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
    const indexedModule = index.updateModule(
        "file:///workspace/main.mac",
        source,
        new CBase(source, 0),
        1,
        true
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
    const external = scanExternalModule(source);

    assert.deepStrictEqual(
        external.imports.map(value => value.toLowerCase()),
        ["common", "helpers"]
    );
    assert.ok(external.symbolTree.RecursiveFind("PublicMacro"));
    assert.ok(external.symbolTree.RecursiveFind("Customer"));
    assert.ok(external.symbolTree.RecursiveFind("Load"));
    assert.strictEqual(
        external.symbolTree.RecursiveFind("TRecHandler"),
        undefined,
        "Базовый класс не должен становиться объявлением модуля"
    );
    assert.strictEqual(
        external.symbolTree.RecursiveFind("localValue"),
        undefined
    );
    assert.strictEqual(
        external.symbolTree.RecursiveFind("localInMethod"),
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
    inheritanceIndex.updateModule(
        consumerUri,
        consumerSource,
        new CBase(consumerSource, 0),
        1,
        true
    );
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

    const tree = new CBase([
        "Macro Test(p)",
        "  Var localValue: Integer;",
        "End;",
        "Private Macro Hidden()",
        "End;",
        "Macro PublicMacro()",
        "End;"
    ].join("\n"), 0);
    assert.strictEqual(
        isLocalReferenceTarget(tree, tree.RecursiveFind("localValue")),
        true
    );
    assert.strictEqual(
        isLocalReferenceTarget(tree, tree.RecursiveFind("Hidden")),
        true
    );
    assert.strictEqual(
        isLocalReferenceTarget(tree, tree.RecursiveFind("PublicMacro")),
        false
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
                import: "ДА",
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
        index.updateModule(
            mainUri,
            source,
            new CBase(source, 0),
            1,
            true
        );
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

(async () => {
    testModuleResolution();
    console.log("[OK] workspace различает resolved, ambiguous и missing");

    testAmbiguousImportDiagnostic();
    console.log("[OK] неоднозначный Import не выбирается молча");

    testExternalSummaryAndReferenceBoundaries();
    console.log("[OK] external summary не смешивает публичные и локальные символы");

    await testWorkspaceLoaderUsesActiveImports();
    console.log("[OK] загружается только активный Import-граф");

    await testParseReadinessDoesNotWaitForSettings();
    console.log("[OK] парсер и Import не ждут workspace/configuration");

    await testReferenceIndexIsLazyPersistentAndTargeted();
    console.log("[OK] ReferenceIndex ленивый, persistent и адресный");

    await testImportedSymbolLoadsOnDemand();
    console.log("[OK] Import-символ загружается для навигации по запросу");
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

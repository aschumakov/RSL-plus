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
    createExternalModuleSummary
} = require("../server/out/moduleModel");
const {
    createOpenModuleModel
} = require("../server/out/moduleModel");
const {
    isLocalReferenceTarget
} = require("../server/out/analysis/references");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { isFullTestRun } = require("./test-mode");

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

    /*
     * Параметры Macro намеренно не сравниваются: внешний модуль их не хранит
     * (см. includeCallableParameters). Подпись импортированного Macro
     * собирается из parameterText, который здесь как раз сравнивается, а сами
     * параметры чужого файла не видны и не разрешаются.
     */
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
                symbol.children
                    .filter(child => child.isContainer || child.isProperty)
                    .forEach(visit);
            }
        };
        root.children.forEach(visit);
        return result;
    };

    assert.deepStrictEqual(flattenPublic(compact), flattenPublic(full));
    assert.strictEqual(compact.find("Hidden"), undefined);
    assert.deepStrictEqual(
        compact.find("Load").children,
        [],
        "Внешний модуль не должен хранить параметры Macro"
    );
    assert.ok(
        compact.find("Load").parameterText.includes("value"),
        "Подпись импортированного Macro обязана остаться доступной"
    );
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

/*
 * Компактный модуль появляется в индексе целиком: symbol index, граф Import и
 * ключ Import-замыкания обновляются одним шагом.
 *
 * На этом ключе держится инвалидация кэша semantic tokens: версия открытого
 * документа при загрузке его зависимости не меняется, и если ключ не сдвинется,
 * подсветка останется устаревшей. Частичное обновление (например, символы без
 * пересчёта замыкания) выглядело бы как работающее — до первого файла, чью
 * подсветку никто не обновил.
 */
function testCompactModuleAppearsAtomically() {
    const index = new WorkspaceIndex();
    const mainUri = "file:///workspace/main.mac";
    const libraryUri = "file:///workspace/library.mac";
    index.registerWorkspaceFiles([mainUri, libraryUri]);
    index.updateOpenModule(
        mainUri,
        "Import library;\nMacro Caller()\n  SharedHandler(1);\nEnd;",
        1
    );

    const keyBefore = index.getImportClosureKey(mainUri);
    assert.strictEqual(
        index.findImportedSymbols(mainUri, "SharedHandler").length,
        0,
        "До загрузки зависимости внешнего символа быть не должно"
    );
    /*
     * Ребро графа существует до загрузки: оно строится по именам Import,
     * разрешённым через каталог workspace, а не по загруженным модулям.
     * Именно поэтому загрузка обязана менять ключ замыкания — иначе
     * "зависимость известна" и "зависимость загружена" стали бы
     * неразличимы для кэшей.
     */
    assert.deepStrictEqual(
        index.getDependents(libraryUri),
        [mainUri],
        "Зависимость по имени Import известна ещё до загрузки модуля"
    );

    const declarations = createExternalModuleSummary(
        "Macro SharedHandler(value)\nEnd;"
    );
    index.updateExternalModuleFromDeclarations(
        libraryUri,
        32,
        {
            declarations: declarations.symbolTree.children.map(symbol => ({
                kind: "macro",
                name: symbol.name,
                visibility: "public",
                parameterText: symbol.parameterText,
                returnType: "variant",
                start: 0,
                end: 1,
                selectionStart: 0,
                selectionEnd: 1,
                startLine: 0,
                startCharacter: 0,
                endLine: 0,
                endCharacter: 1,
                children: []
            })),
            imports: []
        },
        1700000000000
    );

    assert.strictEqual(
        index.findImportedSymbols(mainUri, "SharedHandler").length,
        1,
        "Символ обязан стать доступным сразу после появления модуля"
    );
    assert.deepStrictEqual(
        index.getDependents(libraryUri),
        [mainUri],
        "Граф Import обязан остаться согласованным с symbol index"
    );
    assert.notStrictEqual(
        index.getImportClosureKey(mainUri),
        keyBefore,
        "Ключ Import-замыкания обязан измениться: на нём держится " +
            "инвалидация кэша semantic tokens"
    );

    /* Та же зависимость с новым mtime — снова другой ключ. */
    const keyAfterFirst = index.getImportClosureKey(mainUri);
    index.updateExternalModuleFromDeclarations(
        libraryUri,
        32,
        { declarations: [], imports: [] },
        1700000000001
    );
    assert.notStrictEqual(
        index.getImportClosureKey(mainUri),
        keyAfterFirst,
        "Перезагрузка зависимости обязана сдвигать ключ замыкания"
    );
    assert.strictEqual(
        index.findImportedSymbols(mainUri, "SharedHandler").length,
        0,
        "Старые символы зависимости не должны оставаться в индексе"
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
            /*
             * Загрузчик принимает результат только компактными объявлениями:
             * исходный текст внешнего файла в основной поток больше не
             * попадает (см. compactModuleProtocol.ts).
             */
            updateExternalModuleFromDeclarations(
                uri,
                sourceLength,
                declarations,
                version
            ) {
                const module = {
                    uri,
                    source: "",
                    sourceLength,
                    object: {},
                    version,
                    isOpen: false,
                    kind: "external",
                    imports: declarations.imports
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
 * Регрессия по ревью: полный parse синхронный, поэтому несколько разборов,
 * запущенных в одном проходе очереди, выполняются одной цепочкой microtask —
 * между ними Node не возвращается ни к таймерам, ни к LSP IPC. На восьми
 * файлах по 300КБ это давало задержку таймера до 171 мс (на холодном
 * прогоне до 398 мс).
 *
 * Проверяется не задержка в миллисекундах (она зависит от машины), а сам
 * инвариант: между разборами управление возвращается в event loop.
 *
 * Поколение считает самоперепланирующийся setImmediate: его callback
 * выполняется ровно один раз за оборот event loop, поэтому номер поколения —
 * это детерминированный счётчик оборотов, не зависящий ни от разрешения
 * таймеров, ни от скорости машины (таймер в 1 мс мог бы не успеть стать
 * "просроченным" на быстрой машине и дал бы ложное совпадение поколений).
 * Разборы в одной цепочке microtask неизбежно получают одно поколение.
 *
 * Второй инвариант — активный документ разбирается первым, даже если его
 * запросили последним.
 */
async function testValidationsYieldEventLoopBetweenFiles() {
    const line = 'Var x1 = Something.Method(a, "text", 42) + b;\n';
    const source = line.repeat(Math.ceil((90 * 1024) / line.length));
    const uris = [
        "file:///batch-1.mac",
        "file:///batch-2.mac",
        "file:///batch-3.mac",
        "file:///batch-4.mac",
        "file:///active-batch.mac"
    ];
    const activeUri = "file:///active-batch.mac";
    const documentsByUri = new Map(
        uris.map(uri => [uri, createDocument(uri, 1, source)])
    );

    const parsed = [];
    let generation = 0;
    let counting = true;
    const countGenerations = () => {
        if (!counting) {
            return;
        }
        generation++;
        setImmediate(countGenerations);
    };
    setImmediate(countGenerations);

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
            invalidateProviderCaches: () => undefined,
            onParsed: module => parsed.push([module.uri, generation]),
            onImports: () => undefined,
            initialParseDelayMs: 0,
            inactiveParseDelayMs: 0
        }
    );

    try {
        service.setActiveDocument(activeUri);
        /*
         * ensureParsed() ставит foreground для любого документа, результат
         * которого ждёт LSP-запрос. Активный запрашивается последним — он
         * всё равно должен уйти в разбор первым.
         */
        const pending = uris.map(uri =>
            service.ensureParsed(documentsByUri.get(uri))
        );
        await Promise.all(pending);
        await waitFor(() => parsed.length === uris.length, 20000);

        assert.strictEqual(
            parsed[0][0],
            activeUri,
            "Активный документ должен разбираться первым, даже если его " +
                `запросили последним; порядок: ${parsed.map(([u]) => u)}`
        );

        const byGeneration = new Map();
        for (const [, parsedGeneration] of parsed) {
            byGeneration.set(
                parsedGeneration,
                (byGeneration.get(parsedGeneration) || 0) + 1
            );
        }
        const crowded = Array.from(byGeneration.entries())
            .find(([, count]) => count > 1);

        assert.ok(
            !crowded,
            "Разборы должны быть разнесены по оборотам event loop: в одном " +
                `обороте их ${crowded && crowded[1]}. Значит очередь снова ` +
                "выгружается пачкой, и всё это время таймеры и LSP IPC " +
                `ждут. Поколения разборов: ${parsed.map(([, g]) => g)}`
        );
    } finally {
        counting = false;
    }
}

/*
 * Очень большой файл разбирается фазами.
 *
 * lex, parse и построение модели стоят примерно одинаково, и одним куском это
 * блокировка на 75 мс (550КБ) и 165 мс (1.1МБ) — столько ждут таймеры и все
 * LSP-запросы. Проверяется не время (оно машинозависимо), а сам факт: между
 * фазами управление возвращается в event loop, а у файла обычного размера
 * лишних возвратов нет — там пауза только отложила бы готовность модели.
 *
 * Второй инвариант: одновременно идёт не больше одного разбора. С фазовым
 * разбором это перестало обеспечиваться само собой, и без явного признака
 * два больших файла держали бы в памяти два AST одновременно.
 */
async function testLargeFileIsAnalysedInPhases() {
    const line = 'Var x1 = Something.Method(a, "text", 42) + b;\n';
    const largeSource = line.repeat(Math.ceil((320 * 1024) / line.length));
    const smallSource = line.repeat(Math.ceil((20 * 1024) / line.length));
    const uris = {
        large: "file:///phased-large.mac",
        second: "file:///phased-second.mac",
        small: "file:///phased-small.mac"
    };
    const documentsByUri = new Map([
        [uris.large, createDocument(uris.large, 1, largeSource)],
        [uris.second, createDocument(uris.second, 1, largeSource)],
        [uris.small, createDocument(uris.small, 1, smallSource)]
    ]);

    let generation = 0;
    let counting = true;
    const countGenerations = () => {
        if (!counting) return;
        generation++;
        setImmediate(countGenerations);
    };
    setImmediate(countGenerations);

    const startedAt = new Map();
    const spans = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const service = new DocumentAnalysisService(
        { get: uri => documentsByUri.get(uri) },
        new WorkspaceIndex(),
        {
            getAvailable: () => ({
                imports: { enabled: false },
                autoImport: { enabled: false },
                analysis: { workspaceIndexing: "activeImports" },
                semanticHighlighting: { maxFileSizeKb: 512 },
                diagnostics: {}
            })
        },
        {
            log: () => undefined,
            performance: {
                enabled: true,
                start: (event, fields) => {
                    if (event === "analysis.full") {
                        concurrent++;
                        maxConcurrent = Math.max(maxConcurrent, concurrent);
                        startedAt.set(fields.uri, generation);
                    }
                    return { event, fields };
                },
                end: span => {
                    if (span.event === "analysis.full") {
                        concurrent--;
                        spans.push({
                            uri: span.fields.uri,
                            generations: generation - startedAt.get(span.fields.uri)
                        });
                    }
                },
                mark: () => undefined
            },
            invalidateProviderCaches: () => undefined,
            onParsed: () => undefined,
            onImports: () => undefined,
            initialParseDelayMs: 0,
            inactiveParseDelayMs: 0
        }
    );

    try {
        await service.ensureParsed(documentsByUri.get(uris.small));
        const small = spans.find(item => item.uri === uris.small);
        assert.ok(small, "Разбор небольшого файла должен быть зафиксирован");
        assert.strictEqual(
            small.generations,
            0,
            "Файл обычного размера не должен разбиваться на фазы: пауза " +
                "только отложила бы готовность модели"
        );

        /*
         * Второй файл запрашивается не сразу, а когда разбор первого уже идёт
         * и находится между фазами. Именно так возникает риск параллельности:
         * новая работа планирует проход очереди, а тот без явного признака
         * "разбор идёт" запустил бы второй разбор поверх первого.
         */
        const largeParse = service.ensureParsed(
            documentsByUri.get(uris.large)
        );
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));
        const secondParse = service.ensureParsed(
            documentsByUri.get(uris.second)
        );
        await Promise.all([largeParse, secondParse]);

        const large = spans.find(item => item.uri === uris.large);
        assert.ok(
            large.generations >= 2,
            "Большой файл обязан отдавать управление между фазами; " +
                `оборотов event loop за разбор: ${large.generations}`
        );
        /*
         * Сегодня это выполняется и без явной защиты: пауза разбора уже стоит
         * в очереди setImmediate, а новый проход очереди планируется позже и
         * по FIFO выполняется после неё — двух фаз хватает, чтобы разбор
         * успел завершиться. Утверждение оставлено как формулировка
         * инварианта: он перестанет держаться сам собой, если точек возврата
         * станет больше (например, при порционном лексировании).
         */
        assert.strictEqual(
            maxConcurrent,
            1,
            "Одновременно должен идти один разбор: иначе два больших файла " +
                `держат два AST сразу, получено ${maxConcurrent}`
        );
    } finally {
        counting = false;
    }
}

/*
 * Переключение вкладки прерывает оставшиеся фазы покинутого файла.
 *
 * Большой файл разбирается частями, и без прерывания новый активный документ
 * ждал бы все оставшиеся фазы предыдущего — на файле 1,1 МБ это больше ста
 * миллисекунд ожидания того, что пользователь уже не смотрит. Работа при этом
 * не теряется: покинутый файл возвращается в фоновую очередь.
 */
async function testActiveSwitchInterruptsPhasesOfLeftFile() {
    const line = 'Var x1 = Something.Method(a, "text", 42) + b;\n';
    const bigSource = line.repeat(Math.ceil((700 * 1024) / line.length));
    const smallSource = line.repeat(Math.ceil((8 * 1024) / line.length));
    const bigUri = "file:///left-behind.mac";
    const smallUri = "file:///newly-active.mac";
    const documentsByUri = new Map([
        [bigUri, createDocument(bigUri, 1, bigSource)],
        [smallUri, createDocument(smallUri, 1, smallSource)]
    ]);

    const parsed = [];
    const started = [];
    const service = new DocumentAnalysisService(
        { get: uri => documentsByUri.get(uri) },
        new WorkspaceIndex(),
        {
            getAvailable: () => ({
                imports: { enabled: false },
                autoImport: { enabled: false },
                analysis: { workspaceIndexing: "activeImports" },
                semanticHighlighting: { maxFileSizeKb: 512 },
                diagnostics: {}
            })
        },
        {
            log: () => undefined,
            performance: {
                enabled: true,
                start: (event, fields) => {
                    if (event === "analysis.full") started.push(fields.uri);
                    return { event, fields };
                },
                end: () => undefined,
                mark: () => undefined
            },
            invalidateProviderCaches: () => undefined,
            onParsed: module => parsed.push(module.uri),
            onImports: () => undefined,
            initialParseDelayMs: 0,
            inactiveParseDelayMs: 0
        }
    );

    /* Обе вкладки открыты, как при обычном переключении между файлами. */
    service.setActiveDocument(bigUri);
    service.open(documentsByUri.get(bigUri));
    service.setActiveDocument(smallUri);
    service.open(documentsByUri.get(smallUri));
    service.setActiveDocument(bigUri);

    /*
     * Ждём фактического начала разбора большого файла: переключение до его
     * старта проверяло бы не прерывание фаз, а обычную работу очереди.
     * Опрос таймером в 1 мс попадает между фазами.
     */
    await waitForFast(() => started.includes(bigUri), 20000);

    /* Пользователь переключился на другой файл. */
    service.setActiveDocument(smallUri);

    await waitFor(() => parsed.includes(smallUri), 20000);

    assert.strictEqual(
        parsed[0],
        smallUri,
        "Новый активный файл обязан быть разобран первым, а не ждать " +
            `оставшиеся фазы покинутого; порядок: ${parsed}`
    );

    /* Покинутый файл не потерян: он вернулся в очередь и будет разобран. */
    await waitFor(() => parsed.includes(bigUri), 20000);
    service.close(bigUri);
    service.close(smallUri);
}

/*
 * Быстрое переключение вкладок не должно стоить работы за каждый файл.
 *
 * Раньше setActiveDocument синхронно делал полный lexRsl и сканирование
 * объявлений, то есть переключение по Ctrl+Tab платило за каждый файл, через
 * который пользователь лишь прошёл: на 12 файлах по 200КБ это больше секунды
 * основного потока, в которую не отвечали ни таймеры, ни LSP. Отсюда и жалоба
 * «структура появляется с задержкой» — очередь разборов при этом чистилась
 * правильно, работа выполнялась прямо в обработчике переключения.
 */
async function testFastTabSwitchingDoesNotBlockMainThread() {
    const line = 'Var x1 = Something.Method(a, "text", 42) + b;\n';
    const source = line.repeat(Math.ceil((200 * 1024) / line.length));
    const uris = [];
    const documentsByUri = new Map();
    for (let index = 0; index < 12; index++) {
        const uri = `file:///tab-${index}.mac`;
        uris.push(uri);
        documentsByUri.set(uri, createDocument(uri, 1, source));
    }

    const outlines = [];
    const service = new DocumentAnalysisService(
        { get: uri => documentsByUri.get(uri) },
        new WorkspaceIndex(),
        {
            getAvailable: () => ({
                imports: { enabled: false },
                autoImport: { enabled: false },
                analysis: { workspaceIndexing: "activeImports" },
                semanticHighlighting: { maxFileSizeKb: 512 },
                diagnostics: {}
            })
        },
        {
            log: () => undefined,
            performance: {
                enabled: true,
                start(event, fields) {
                    if (event === "analysis.outlineSnapshot") {
                        outlines.push(fields.uri);
                    }
                    return { event };
                },
                end() {},
                mark() {}
            },
            invalidateProviderCaches: () => undefined,
            onParsed: () => undefined,
            onImports: () => undefined,
            initialParseDelayMs: 0,
            inactiveParseDelayMs: 0,
            changeDebounceMs: 0
        }
    );

    for (const uri of uris) {
        service.open(documentsByUri.get(uri));
    }

    /* События переключения приходят подряд, быстрее, чем успевает разбор. */
    const startedAt = Date.now();
    for (const uri of uris) {
        service.setActiveDocument(uri);
    }
    const switchMs = Date.now() - startedAt;

    assert.ok(
        switchMs < 150,
        "Переключение вкладок обязано быть дешёвым: работа за файл, через " +
            `который лишь прошли, блокирует основной поток; вышло ${switchMs} мс`
    );

    const lastUri = uris[uris.length - 1];
    await service.ensureParsed(documentsByUri.get(lastUri));
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.deepStrictEqual(
        Array.from(new Set(outlines)),
        [lastUri],
        "Outline обязан строиться только для вкладки, на которой " +
            `остановились; построен для: ${Array.from(new Set(outlines))}`
    );

    for (const uri of uris) {
        service.close(uri);
    }
}

/*
 * Задача, ставшая ненужной, пропускается на старте, а не разбирается до конца.
 *
 * Полный разбор до фазового порога идёт одним куском и никого не пускает
 * вперёд, поэтому проверять актуальность нужно именно в момент старта задачи:
 * к этому времени файл могли закрыть или изменить.
 */
async function testStaleTaskIsSkippedAtDispatch() {
    const line = 'Var x1 = Something.Method(a, "text", 42) + b;\n';
    const source = line.repeat(Math.ceil((60 * 1024) / line.length));
    const uri = "file:///stale-task.mac";
    const documentsByUri = new Map([[uri, createDocument(uri, 1, source)]]);

    const parsed = [];
    const skipped = [];
    const service = new DocumentAnalysisService(
        { get: requested => documentsByUri.get(requested) },
        new WorkspaceIndex(),
        {
            getAvailable: () => ({
                imports: { enabled: false },
                autoImport: { enabled: false },
                analysis: { workspaceIndexing: "activeImports" },
                semanticHighlighting: { maxFileSizeKb: 512 },
                diagnostics: {}
            })
        },
        {
            log: () => undefined,
            performance: {
                enabled: true,
                start: () => ({}),
                end() {},
                mark(event, fields) {
                    if (event === "analysis.skipped") {
                        skipped.push(fields.reason);
                    }
                }
            },
            invalidateProviderCaches: () => undefined,
            onParsed: module => parsed.push(module.uri),
            onImports: () => undefined,
            initialParseDelayMs: 0,
            inactiveParseDelayMs: 0,
            changeDebounceMs: 0
        }
    );

    service.setActiveDocument(uri);
    service.open(documentsByUri.get(uri));

    /*
     * ensureParsed ставит задачу в очередь сразу, а обслуживается она
     * следующим setImmediate. Файл закрывается в этом окне — именно так
     * выглядит вкладка, закрытая пока очередь до неё не дошла.
     */
    const pending = service.ensureParsed(documentsByUri.get(uri));
    documentsByUri.delete(uri);
    await pending;
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.deepStrictEqual(
        parsed,
        [],
        "Разбор закрытого файла — чистая блокировка основного потока"
    );
    assert.ok(
        skipped.includes("documentClosed"),
        `Пропуск обязан быть зафиксирован причиной; получено: ${skipped}`
    );
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

/*
 * Правка, не меняющая длину файла, обязана быть замечена индексом ссылок.
 *
 * Прежде запись считалась актуальной по дате и размеру, и при совпадении файл
 * не читался вовсе. Замена Alpha на Bravo их не меняет, поэтому в индексе
 * оставался прежний набор идентификаторов, и Find All References по новому
 * имени возвращал ноль результатов. Дату здесь восстанавливаем намеренно: она
 * сохраняется при checkout ветки и распаковке архива.
 */
async function testReferenceIndexDetectsSameLengthEdit() {
    const directory = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "rsl-ref-fp-")
    );

    try {
        const filePath = path.join(directory, "Lib.mac");
        const cachePath = path.join(directory, "cache", "references.json");
        const uri = pathToFileURL(filePath).toString();

        fs.writeFileSync(filePath, "Macro Alpha()\nEnd;\n", "utf8");
        const before = fs.statSync(filePath);

        let index = new ReferenceIndex({
            log: () => undefined,
            cacheFilePath: cachePath
        });
        index.retainWorkspaceFiles([uri]);
        assert.strictEqual(
            (await index.findCandidates("Alpha", [uri])).length,
            1,
            "Исходное имя обязано находиться"
        );
        await index.flush();

        /* Та же длина, та же дата — изменилось только содержимое. */
        fs.writeFileSync(filePath, "Macro Bravo()\nEnd;\n", "utf8");
        fs.utimesSync(filePath, before.atime, before.mtime);
        assert.strictEqual(
            fs.statSync(filePath).size,
            before.size,
            "Проверка имеет смысл только при совпавшем размере"
        );

        /* Новая сессия: кэш читается с диска. */
        index = new ReferenceIndex({
            log: () => undefined,
            cacheFilePath: cachePath
        });
        index.retainWorkspaceFiles([uri]);

        assert.strictEqual(
            (await index.findCandidates("Bravo", [uri])).length,
            1,
            "Новое имя обязано находиться, иначе Find All References молча " +
                "теряет ссылки после checkout или распаковки архива"
        );
        assert.strictEqual(
            (await index.findCandidates("Alpha", [uri])).length,
            0,
            "Имени, которого в файле уже нет, находиться не должно"
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
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

async function waitForFast(predicate, timeoutMs) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started >= timeoutMs) {
            throw new Error("Истекло время ожидания тестового события");
        }
        await new Promise(resolve => setTimeout(resolve, 1));
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

    testCompactModuleAppearsAtomically();
    console.log("[OK] компактный модуль появляется в индексе целиком");

    /*
     * Проверки конкуренции задач: очередь загрузки, вытеснение, фазы
     * разбора и отзывчивость основного потока.
     *
     * Они смотрят на порядок и на время, поэтому идут только в полном
     * наборе и только последовательно — рядом работающий тестовый процесс
     * превращает такую проверку в лотерею.
     */
    if (isFullTestRun()) {
        await testWorkspaceLoaderUsesActiveImports();
        console.log("[OK] загружается только активный Import-граф");

        await testActiveDocumentPreemptsQueuedModules();
        console.log("[OK] новая активная Import-ветвь вытесняет старую очередь");

        await testActiveDocumentPreemptsQueuedParses();
        console.log("[OK] полный parse активного файла вытесняет фоновые разборы");

        await testValidationsYieldEventLoopBetweenFiles();
        console.log("[OK] разборы не блокируют event loop пачкой, активный первым");

        await testLargeFileIsAnalysedInPhases();
        console.log("[OK] очень большой файл разбирается фазами, разбор один");

        await testActiveSwitchInterruptsPhasesOfLeftFile();
        console.log("[OK] переключение вкладки прерывает фазы покинутого файла");

        await testFastTabSwitchingDoesNotBlockMainThread();
        console.log("[OK] быстрое переключение вкладок не блокирует основной поток");

        await testStaleTaskIsSkippedAtDispatch();
        console.log("[OK] ненужная задача пропускается на старте");
    }
    await testParseReadinessDoesNotWaitForSettings();
    console.log("[OK] парсер и Import не ждут workspace/configuration");

    await testReferenceIndexIsLazyPersistentAndTargeted();
    console.log("[OK] ReferenceIndex ленивый, persistent и адресный");

    await testReferenceIndexDetectsSameLengthEdit();
    console.log("[OK] правка той же длины не теряется индексом ссылок");

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

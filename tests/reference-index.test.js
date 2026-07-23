"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const {
    ReferenceIndex,
    referenceIndexTesting
} = require("../server/out/analysis/referenceIndex");
const {
    WorkspaceIndex
} = require("../server/out/workspaceIndex");
const {
    WorkspaceModuleLoader
} = require("../server/out/indexing/workspaceModuleLoader");

(async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rsl-ref-index-"));
    const firstPath = path.join(directory, "First.mac");
    const secondPath = path.join(directory, "Second.mac");
    const cachePath = path.join(directory, "cache", "references-v2.json");
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

    const originalReadFile = fs.promises.readFile;
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

    fs.writeFileSync(firstPath, "Macro RenamedTarget()\nEnd;\n// changed size\n", "utf8");
    const staleCandidates = await restored.findCandidates("targetname", [firstUri]);
    assert.strictEqual(
        staleCandidates.length,
        0,
        "Изменение mtime/size должно принудительно перестроить запись"
    );

    let eagerReferenceScans = 0;
    const loaderIndex = new WorkspaceIndex();
    const loaderReferenceIndex = {
        retainWorkspaceFiles: () => undefined,
        invalidate: () => undefined,
        indexSource: () => { eagerReferenceScans++; }
    };
    const loader = new WorkspaceModuleLoader(
        loaderIndex,
        {
            log: () => undefined,
            onModuleLoaded: () => undefined,
            onModuleCountChanged: () => undefined
        },
        loaderReferenceIndex
    );
    loader.registerWorkspaceFiles([secondUri]);
    await loader.ensureLoadedUri(secondUri);
    assert.strictEqual(
        eagerReferenceScans,
        0,
        "Загрузка Import не должна повторно сканировать файл ради References"
    );

    const hashes = referenceIndexTesting.collectIdentifierHashes(
        "Alpha Alpha Beta"
    );
    assert.strictEqual(hashes.length, 2, "Хэши в файле должны быть уникальными");

    const aPath = path.join(directory, "A.mac");
    const bPath = path.join(directory, "B.mac");
    const cPath = path.join(directory, "C.mac");
    const unrelatedPath = path.join(directory, "Unrelated.mac");
    fs.writeFileSync(aPath, "Macro TargetName()\nEnd;", "utf8");
    fs.writeFileSync(bPath, "Import A;\nMacro Use()\n TargetName();\nEnd;", "utf8");
    fs.writeFileSync(cPath, "Import B;", "utf8");
    fs.writeFileSync(unrelatedPath, "Macro Nothing()\nEnd;", "utf8");

    const graphUris = [aPath, bPath, cPath, unrelatedPath]
        .map(value => pathToFileURL(value).toString());
    const graphIndex = new ReferenceIndex({ readBatchSize: 4 });
    graphIndex.retainWorkspaceFiles(graphUris);

    /* Первый cold scan строит точные hashes и полный лёгкий Import-граф. */
    await graphIndex.findCandidates("targetname", graphUris);
    const limited = new Set(await graphIndex.getCandidateUris(
        graphUris[0],
        graphUris
    ));
    assert.ok(limited.has(graphUris[0]));
    assert.ok(limited.has(graphUris[1]));
    assert.ok(limited.has(graphUris[2]));
    assert.ok(!limited.has(graphUris[3]));

    fs.rmSync(directory, { recursive: true, force: true });
    console.log("[OK] ReferenceIndex ленивый, точный, persistent и адресно инвалидируется");
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

"use strict";

/**
 * Замыкание открытого файла читается раньше остального проекта.
 *
 * Контекст активного документа должен становиться полным как можно быстрее:
 * пока он неполон, подсказка молчит после точки, а проверки не делают
 * выводов. Порядок обязан быть таким:
 *
 *     открытый файл -> его Import -> транзитивные -> остальной проект
 *
 * Модули библиотек участвуют в этом замыкании наравне с файлами проекта:
 * разрешение у них общее, и то, что файл лежит за пределами проекта, на
 * очередь не влияет. В состав проекта он при этом не попадает.
 */

const assert = require("assert");

const serverModulePath = require.resolve("../server/out/server");

require.cache[serverModulePath] = {
    id: serverModulePath,
    filename: serverModulePath,
    loaded: true,
    exports: {
        getTree: () => [],
        GetFileByNameRequest: () => undefined
    }
};

const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const {
    WorkspaceModuleLoader
} = require("../server/out/indexing/workspaceModuleLoader");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const ROOT = "file:///d:/active/";
const MAIN = ROOT + "main.mac";
const created = [];

/** Состав стенда: main -> a -> b, плюс библиотечный lib и посторонние. */
const SOURCES = {
    [MAIN]: { imports: ["a"], name: "Root" },
    [ROOT + "a.mac"]: { imports: ["b", "lib"], name: "FromA" },
    [ROOT + "b.mac"]: { imports: [], name: "FromB" },
    [ROOT + "far1.mac"]: { imports: [], name: "Far1" },
    [ROOT + "far2.mac"]: { imports: [], name: "Far2" }
};

function makeLibrary() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rsl-active-lib-"));

    fs.writeFileSync(
        path.join(root, "lib.mac"),
        "Macro FromLib()\n  return 1;\nEnd;\n",
        "utf8"
    );
    created.push(root);

    return root;
}

function cleanup() {
    for (const root of created.splice(0)) {
        fs.rmSync(root, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 25
        });
    }
}

/** Загрузчик с поддельным чтением: важен порядок, а не содержимое. */
function board(libraryRoot) {
    const index = new WorkspaceIndex();
    const read = [];

    index.registerWorkspaceFiles(Object.keys(SOURCES));
    index.setLibraryPaths([libraryRoot]);

    const loader = new WorkspaceModuleLoader(index, {
        log: () => undefined,
        onModuleLoaded: () => undefined,
        onModuleCountChanged: () => undefined,
        compactModules: {
            index: async request => {
                read.push(request.uri);

                const known = SOURCES[request.uri];
                const name = known
                    ? known.name
                    : path.basename(request.uri).replace(/\.mac$/iu, "");

                return {
                    id: 0,
                    uri: request.uri,
                    generation: request.generation || 0,
                    status: "indexed",
                    mtimeMs: 1,
                    size: 64,
                    fingerprint: "64:" + name,
                    sourceLength: 64,
                    declarations: [{
                        name,
                        kind: "macro",
                        visibility: "public",
                        line: 0,
                        character: 6,
                        children: []
                    }],
                    imports: known ? known.imports : [],
                    fileReferences: [],
                    reused: false
                };
            }
        }
    });

    return { index, loader, read };
}

/**
 * Дать очереди доработать.
 *
 * Признака занятости у загрузчика нет, поэтому ожидание считается по самой
 * очереди: пока чтения продолжаются, крутим дальше. Так проба не
 * заканчивается на первом же тике — из-за чего и выглядела провалом.
 */
async function settle(read) {
    let stable = 0;

    for (let attempt = 0; attempt < 400 && stable < 20; attempt++) {
        const before = read.length;

        await new Promise(resolve => setImmediate(resolve));

        stable = read.length === before ? stable + 1 : 0;
    }
}

test("замыкание открытого файла читается, посторонние — нет", async () => {
    const library = makeLibrary();
    const { index, loader, read } = board(library);

    index.updateOpenModule(
        MAIN,
        "Import a;\nMacro Root()\n  return 1;\nEnd;\n",
        1
    );
    index.markOpen(MAIN);

    loader.beginForegroundGeneration();
    await loader.ensureLoadedByName("a");
    await settle(read);

    const names = read.map(uri => path.basename(uri).toLowerCase());

    assert.ok(
        names.includes("a.mac"),
        "прямой Import обязан быть прочитан: " + names.join(", ")
    );
    assert.ok(
        names.includes("b.mac"),
        "транзитивный тоже: " + names.join(", ")
    );
    assert.ok(
        !names.includes("far1.mac") && !names.includes("far2.mac"),
        "посторонние файлы проекта в замыкание не входят: " + names.join(", ")
    );
});

test("библиотечный модуль замыкания читается наравне с проектом", async () => {
    const library = makeLibrary();
    const { index, loader, read } = board(library);

    index.updateOpenModule(
        MAIN,
        "Import a;\nMacro Root()\n  return 1;\nEnd;\n",
        1
    );
    index.markOpen(MAIN);

    loader.beginForegroundGeneration();
    await loader.ensureLoadedByName("a");
    await settle(read);

    const libraryUri = pathToFileURL(
        path.join(library, "lib.mac")
    ).toString();

    assert.ok(
        read.some(uri => uri.toLowerCase() === libraryUri.toLowerCase()),
        "модуль библиотеки обязан попасть в замыкание: " + read.join(", ")
    );

    /* И при этом он не стал файлом проекта. */
    assert.ok(
        !index.hasWorkspaceFile(libraryUri),
        "библиотечный файл в составе проекта не числится"
    );
    assert.ok(
        index.isLibraryFile(libraryUri),
        "и помечен библиотечным"
    );
});

test("прямой Import читается раньше транзитивного", async () => {
    const library = makeLibrary();
    const { index, loader, read } = board(library);

    index.updateOpenModule(
        MAIN,
        "Import a;\nMacro Root()\n  return 1;\nEnd;\n",
        1
    );
    index.markOpen(MAIN);

    loader.beginForegroundGeneration();
    await loader.ensureLoadedByName("a");
    await settle(read);

    const order = read.map(uri => path.basename(uri).toLowerCase());
    const directAt = order.indexOf("a.mac");
    const transitiveAt = order.indexOf("b.mac");

    assert.ok(directAt >= 0 && transitiveAt >= 0, "оба обязаны быть прочитаны");
    assert.ok(
        directAt < transitiveAt,
        "порядок обязан быть «прямой, потом транзитивный»: " + order.join(", ")
    );
});

(async () => {
    for (const item of tests) {
        try {
            await item.action();
            passed++;
            console.log("[OK] " + item.name);
        } catch (error) {
            failed++;
            console.error("[FAIL] " + item.name);
            console.error(error);
        }
    }

    cleanup();

    console.log(
        failed === 0
            ? "\nПройдено: " + passed
            : "\nПройдено: " + passed + ", провалено: " + failed
    );

    if (failed > 0) {
        process.exitCode = 1;
    }
})();

"use strict";

/**
 * Одно чтение файла кормит всех фоновых потребителей.
 *
 * Загрузчик модулей, каталог проекта и индекс ссылок спрашивают об одном и том
 * же файле. Компактное чтение держит текст в руках и считает всё сразу:
 * объявления, Import, строковые ссылки и хэши идентификаторов. Прежде индекс
 * ссылок собирал свои хэши сам — открывая тот же файл во второй раз и уже на
 * основном потоке, в тот момент, когда пользователь ждёт ответа на поиск
 * ссылок.
 *
 * Отдельно проверяется, что открытый документ у worker'а не спрашивают вовсе.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const {
    CompactModuleWorkerService
} = require("../server/out/indexing/compactModuleWorkerService");
const {
    WorkspaceModuleLoader
} = require("../server/out/indexing/workspaceModuleLoader");
const { ReferenceIndex } = require("../server/out/analysis/referenceIndex");
const {
    collectIdentifierHashes,
    hashReferenceIdentifier
} = require("../server/out/analysis/referenceSourceFacts");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

function withWorkspace(action) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rsl-facts-"));
    const service = new CompactModuleWorkerService({ log: () => undefined });

    return action({ directory, service }).finally(async () => {
        await service.dispose();
        fs.rmSync(directory, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 25
        });
    });
}

function writeModule(directory, name, source) {
    const filePath = path.join(directory, name);

    fs.writeFileSync(filePath, source);

    return { filePath, uri: pathToFileURL(filePath).toString() };
}

const WITH_TARGET = [
    "Import shared;",
    "",
    "Macro CallsTarget()",
    "  return GetClient(1);",
    "End;",
    ""
].join("\n");

const WITHOUT_TARGET = [
    "Macro Alone()",
    "  Var value = 1;",
    "  return value;",
    "End;",
    ""
].join("\n");

/** Загрузчик с настоящим worker и настоящим индексом ссылок. */
function createLoader(directory, service, uris) {
    const index = new WorkspaceIndex();
    const referenceIndex = new ReferenceIndex({ log: () => undefined });
    const loader = new WorkspaceModuleLoader(
        index,
        {
            log: () => undefined,
            compactModules: service,
            onModuleLoaded: () => undefined,
            onModuleCountChanged: () => undefined
        },
        referenceIndex
    );

    loader.registerWorkspaceFiles(uris);
    index.registerWorkspaceFiles(uris);

    return { index, loader, referenceIndex };
}

test("ответ несёт хэши идентификаторов того же чтения", () =>
    withWorkspace(async ({ directory, service }) => {
        const { uri } = writeModule(directory, "facts.mac", WITH_TARGET);
        const response = await service.index({ uri, generation: 0 });

        assert.strictEqual(response.status, "indexed");
        assert.deepStrictEqual(
            Array.from(response.identifierHashes),
            Array.from(collectIdentifierHashes(WITH_TARGET)),
            "набор обязан совпадать с тем, что посчитал бы индекс ссылок сам"
        );
        assert.ok(
            Array.from(response.identifierHashes).includes(
                hashReferenceIdentifier("getclient")
            ),
            "имя из тела обязано попасть в набор"
        );
    }));

test("имя из строки в наборе есть", () =>
    withWorkspace(async ({ directory, service }) => {
        /*
         * Набор нужен как отсечка для поиска ссылок, а в RSL имя метода
         * запросто написано строкой. По токенам такие вхождения пропали бы.
         */
        const source = 'Macro Run()\n  return R2M(obj, "Method");\nEnd;\n';
        const { uri } = writeModule(directory, "strings.mac", source);
        const response = await service.index({ uri, generation: 0 });

        assert.ok(
            Array.from(response.identifierHashes).includes(
                hashReferenceIdentifier("method")
            ),
            "имя, написанное строкой, обязано попасть в набор"
        );
    }));

test("после индексации поиск ссылок не читает лишних файлов", () =>
    withWorkspace(async ({ directory, service }) => {
        const uris = [];

        uris.push(writeModule(directory, "target.mac", WITH_TARGET).uri);

        for (let index = 0; index < 12; index++) {
            uris.push(
                writeModule(directory, "plain" + index + ".mac", WITHOUT_TARGET).uri
            );
        }

        const board = createLoader(directory, service, uris);

        for (const uri of uris) {
            await board.loader.ensureLoadedUri(uri);
        }

        assert.strictEqual(
            board.referenceIndex.acceptedScannedFacts,
            uris.length,
            "факты обязаны прийти на каждый файл"
        );

        const originalReadFile = fs.promises.readFile;
        let reads = 0;

        fs.promises.readFile = function (...args) {
            reads++;

            return originalReadFile.apply(this, args);
        };

        let candidates;

        try {
            candidates = await board.referenceIndex.findCandidates(
                "GetClient",
                uris
            );
        } finally {
            fs.promises.readFile = originalReadFile;
        }

        assert.deepStrictEqual(
            candidates.map(item => item.uri),
            [uris[0]],
            "кандидат ровно один"
        );
        assert.strictEqual(
            reads,
            1,
            "читается только он: у остальных имени нет в наборе"
        );
    }));

test("открытый документ у worker не спрашивают", () =>
    withWorkspace(async ({ directory, service }) => {
        const { uri } = writeModule(directory, "opened.mac", WITH_TARGET);
        const board = createLoader(directory, service, [uri]);

        /* Документ открыт: в индексе полная модель из буфера редактора. */
        board.index.updateOpenModule(uri, WITH_TARGET + "\nMacro Extra()\nEnd;\n", 1);

        const before = service.stats.requests;

        /* Уже загруженный модуль загрузчик и так не перечитывает. */
        await board.loader.ensureLoadedUri(uri);

        assert.strictEqual(
            service.stats.requests - before,
            0,
            "загруженный модуль второй раз не читают"
        );

        /*
         * А вот перезагрузка по наблюдателю за файлами доходит до чтения:
         * сохранение открытого документа — обычное дело, и раньше файл
         * читался и сканировался, чтобы ответ тут же отбросили.
         */
        await board.loader.reload(uri);

        assert.strictEqual(
            service.stats.requests - before,
            0,
            "запроса к worker быть не должно"
        );
        assert.strictEqual(
            board.loader.loaderCounters.skippedOpenDocuments,
            1
        );
        assert.ok(
            board.index.getModule(uri).symbolTree.children
                .some(symbol => symbol.name === "Extra"),
            "в индексе осталась модель редактора, а не сводка с диска"
        );
    }));

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

    console.log(
        failed === 0
            ? "\nПройдено: " + passed
            : "\nПройдено: " + passed + ", провалено: " + failed
    );

    if (failed > 0) {
        process.exitCode = 1;
    }
})();

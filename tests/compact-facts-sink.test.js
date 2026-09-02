"use strict";

/**
 * Одно чтение файла кормит всех, кому нужны его факты.
 *
 * Читают файл двое: загрузчик Import и достройка каталога. Обоим отвечает один
 * worker и оба получают ответ целиком — с объявлениями, Import, строковыми
 * ссылками и хэшами идентификаторов.
 *
 * Хэши брал только загрузчик. Ответ достройки их выбрасывал, и индекс ссылок
 * позже добывал то же самое сам, читая тот же файл второй раз — на основном
 * потоке и в тот момент, когда пользователь ждёт ответа на поиск ссылок.
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
    RslCatalogWarmupService
} = require("../server/out/indexing/catalogWarmupService");
const {
    RslCompactFactsSink
} = require("../server/out/analysis/compactFactsSink");
const { ReferenceIndex } = require("../server/out/analysis/referenceIndex");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

function withWorkspace(action) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rsl-sink-"));
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

const WITH_TARGET = [
    "Import shared;",
    "",
    "Macro CallsTarget()",
    "  return GetClient(1);",
    "End;",
    ""
].join("\n");

const WITHOUT_TARGET = "Macro Alone()\n  Var value = 1;\nEnd;\n";

test("достройка каталога кормит индекс ссылок", () =>
    withWorkspace(async ({ directory, service }) => {
        const uris = [];

        for (let index = 0; index < 8; index++) {
            const file = path.join(directory, "plain" + index + ".mac");

            fs.writeFileSync(file, index === 0 ? WITH_TARGET : WITHOUT_TARGET);
            uris.push(pathToFileURL(file).toString());
        }

        const index = new WorkspaceIndex();
        const referenceIndex = new ReferenceIndex({ log: () => undefined });
        const sink = new RslCompactFactsSink(referenceIndex);

        index.registerWorkspaceFiles(uris);

        const warmup = new RslCatalogWarmupService({
            index,
            read: uri => service.index({
                uri,
                generation: 0,
                priority: "background"
            }),
            log: () => undefined,
            onCompactFacts: response => sink.accept(response),
            pauseMs: 0,
            idleMs: 0,
            concurrency: 4
        });

        await new Promise(resolve => {
            warmup.add(uris);

            const timer = setInterval(() => {
                if (sink.stats.scans >= uris.length) {
                    clearInterval(timer);
                    resolve();
                }
            }, 20);

            setTimeout(() => {
                clearInterval(timer);
                resolve();
            }, 60000);
        });

        warmup.stop();

        /* Загрузчик Import этих файлов не грузил: полных модулей нет. */
        assert.strictEqual(
            index.getModules().length,
            0,
            "модули в индекс не попадали"
        );
        assert.strictEqual(
            sink.stats.scans,
            uris.length,
            "факты пришли с каждого чтения: " + JSON.stringify(sink.stats)
        );
        assert.strictEqual(
            sink.stats.accepted,
            uris.length,
            "и каждый принят индексом ссылок"
        );
        assert.strictEqual(
            sink.stats.discarded,
            0,
            "в нормальном ходе ничего не выбрасывается"
        );

        /* И теперь первый поиск ссылок не перечитывает эти файлы. */
        const originalReadFile = fs.promises.readFile;
        let reads = 0;

        fs.promises.readFile = function (...args) {
            reads++;

            return originalReadFile.apply(this, args);
        };

        let candidates;

        try {
            candidates = await referenceIndex.findCandidates("GetClient", uris);
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

test("повторный ответ про тот же файл не считается потерей", () =>
    withWorkspace(async ({ directory, service }) => {
        const file = path.join(directory, "twice.mac");

        fs.writeFileSync(file, WITH_TARGET);

        const uri = pathToFileURL(file).toString();
        const referenceIndex = new ReferenceIndex({ log: () => undefined });
        const sink = new RslCompactFactsSink(referenceIndex);
        const read = () => service.index({
            uri,
            generation: 0,
            priority: "background"
        });

        sink.accept(await read());

        /* Второй раз: содержимое то же, запись уже сверена этим отпечатком. */
        sink.accept(await read());

        assert.strictEqual(sink.stats.accepted, 1);
        assert.strictEqual(
            sink.stats.discarded,
            1,
            "второй ответ про тот же файл — не потеря, а повтор"
        );
    }));

test("ответ без сканирования потерей не считается", () =>
    withWorkspace(async ({ directory, service }) => {
        const file = path.join(directory, "unchanged.mac");

        fs.writeFileSync(file, WITH_TARGET);

        const uri = pathToFileURL(file).toString();
        const referenceIndex = new ReferenceIndex({ log: () => undefined });
        const sink = new RslCompactFactsSink(referenceIndex);
        const first = await service.index({ uri, generation: 0 });

        sink.accept(first);

        /* С известным отпечатком worker отвечает unchanged: хэшей там нет. */
        const second = await service.index({
            uri,
            generation: 0,
            knownFingerprint: first.fingerprint
        });

        sink.accept(second);

        assert.strictEqual(second.status, "unchanged");
        assert.strictEqual(sink.stats.scans, 1, "сканирование было одно");
        assert.strictEqual(
            sink.stats.withoutHashes,
            1,
            "файл не сканировался — считать заново нечего"
        );
        assert.strictEqual(sink.stats.discarded, 0);
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

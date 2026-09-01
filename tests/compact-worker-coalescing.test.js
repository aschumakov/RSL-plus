"use strict";

/**
 * Один файл — один запрос к compact worker.
 *
 * Загрузчик модулей и прогрев каталога пользуются одним worker и легко просят
 * один и тот же файл: первому нужны объявления и Import, второму — состав для
 * каталога и строковые ссылки. Ответ у обоих один и тот же, а читался и
 * сканировался файл дважды.
 *
 * Отдельно проверяется приоритет: файл, поставленный фоновой индексацией, не
 * должен заставлять интерактивный запрос ждать всю фоновую очередь.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const {
    CompactModuleWorkerService
} = require("../server/out/indexing/compactModuleWorkerService");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

function withWorkspace(action) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rsl-coalesce-"));
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

const SOURCE = [
    "Import shared;",
    "",
    "Macro Alpha()",
    "  return ExecMacroFile(\"other.mac\", \"Run\");",
    "End;",
    "",
    "Macro Bravo()",
    "  return 2;",
    "End;",
    ""
].join("\n");

test("два потребителя одного URI дают один запрос worker", () =>
    withWorkspace(async ({ directory, service }) => {
        const { uri } = writeModule(directory, "shared.mac", SOURCE);
        /* Загрузчик и прогрев спрашивают один файл одновременно. */
        const [loader, warmup] = await Promise.all([
            service.index({ uri, generation: 1, priority: "background" }),
            service.index({ uri, generation: 1, priority: "foreground" })
        ]);

        assert.strictEqual(loader.status, "indexed");
        assert.strictEqual(warmup.status, "indexed");
        assert.deepStrictEqual(
            loader.declarations.map(item => item.name),
            warmup.declarations.map(item => item.name),
            "оба обязаны получить один и тот же состав"
        );
        assert.deepStrictEqual(
            warmup.fileReferences,
            ["other.mac"],
            "строковые ссылки нужны каталогу и обязаны дойти"
        );
        assert.strictEqual(
            service.stats.dispatched,
            1,
            "worker обязан получить ровно один запрос: " +
            JSON.stringify(service.stats)
        );
        assert.strictEqual(service.stats.coalesced, 1);
    }));

test("фоновый запрос повышается пришедшим интерактивным", () =>
    withWorkspace(async ({ directory, service }) => {
        const { uri: busy } = writeModule(directory, "busy.mac", SOURCE);
        const { uri: wanted } = writeModule(directory, "wanted.mac", SOURCE);

        /* Первый занимает worker, остальные встают в очередь. */
        const first = service.index({ uri: busy, generation: 1 });
        const background = service.index({
            uri: wanted,
            generation: 1,
            priority: "background"
        });
        const foreground = service.index({
            uri: wanted,
            generation: 1,
            priority: "foreground"
        });

        await Promise.all([first, background, foreground]);

        assert.strictEqual(
            service.stats.promoted,
            1,
            "ожидающий запрос обязан быть повышен: " +
            JSON.stringify(service.stats)
        );
        assert.strictEqual(
            service.stats.dispatched,
            2,
            "файлов два — запросов два, а не три"
        );
    }));

test("изменившийся файл не получает прежний ответ", () =>
    withWorkspace(async ({ directory, service }) => {
        const written = writeModule(directory, "changing.mac", SOURCE);
        const first = await service.index({ uri: written.uri, generation: 1 });

        assert.strictEqual(first.status, "indexed");

        fs.writeFileSync(
            written.filePath,
            SOURCE + "\nMacro Charlie()\nEnd;\n"
        );

        const second = await service.index({
            uri: written.uri,
            generation: 2,
            knownFingerprint: first.fingerprint
        });

        assert.strictEqual(
            second.status,
            "indexed",
            "содержимое изменилось — ответ обязан быть полным"
        );
        assert.ok(
            second.declarations.some(item => item.name === "Charlie"),
            "и содержать новое объявление"
        );
    }));

test("разные отпечатки не объединяются: каждый получает своё", () =>
    withWorkspace(async ({ directory, service }) => {
        const written = writeModule(directory, "stable.mac", SOURCE);
        const first = await service.index({ uri: written.uri, generation: 1 });

        assert.strictEqual(first.status, "indexed");

        /*
         * Один спрашивает с отпечатком — ему хватит unchanged. Второй без
         * отпечатка: ему нужен полный состав. Объединить их нельзя, и
         * проверяется, что каждый получает именно то, о чём просил.
         */
        const [withPrint, without] = await Promise.all([
            service.index({
                uri: written.uri,
                generation: 2,
                knownFingerprint: first.fingerprint
            }),
            service.index({ uri: written.uri, generation: 2 })
        ]);

        assert.strictEqual(
            withPrint.status,
            "unchanged",
            "спрашивавший с отпечатком обязан получить unchanged"
        );
        assert.strictEqual(
            without.status,
            "indexed",
            "спрашивавший без отпечатка обязан получить полный состав"
        );
        assert.deepStrictEqual(
            without.declarations.map(item => item.name),
            first.declarations.map(item => item.name)
        );
    }));

test("expectedExport не объединяется с обычным запросом", () =>
    withWorkspace(async ({ directory, service }) => {
        const { uri } = writeModule(directory, "exports.mac", SOURCE);
        const before = service.stats.dispatched;
        const [plain, targeted] = await Promise.all([
            service.index({ uri, generation: 1 }),
            service.index({ uri, generation: 1, expectedExport: "Alpha" })
        ]);

        assert.strictEqual(plain.status, "indexed");
        assert.ok(
            targeted.status === "indexed" || targeted.status === "notExported",
            "адресная проверка обязана ответить по существу: " + targeted.status
        );
        assert.strictEqual(
            service.stats.dispatched - before,
            2,
            "два разных вопроса — два запроса: объединять их нельзя"
        );
    }));

test("два одинаковых expectedExport объединяются", () =>
    withWorkspace(async ({ directory, service }) => {
        const { uri } = writeModule(directory, "same-export.mac", SOURCE);
        const before = service.stats.dispatched;

        await Promise.all([
            service.index({ uri, generation: 1, expectedExport: "Alpha" }),
            service.index({ uri, generation: 1, expectedExport: "Alpha" })
        ]);

        assert.strictEqual(
            service.stats.dispatched - before,
            1,
            "один и тот же вопрос — один запрос"
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

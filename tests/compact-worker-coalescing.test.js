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

/**
 * Занять worker посторонним файлом.
 *
 * Объединяются только запросы, стоящие в ОЧЕРЕДИ: ушедший worker'у
 * попутчиков не берёт. Поэтому проверка объединения обязана сперва занять
 * worker, иначе первый же запрос уходит немедленно и объединять нечего.
 */
function occupyWorker(directory, service, name) {
    const { uri } = writeModule(directory, name, SOURCE);

    return service.index({ uri, generation: 1, priority: "background" });
}

test("два потребителя одного URI дают один запрос worker", () =>
    withWorkspace(async ({ directory, service }) => {
        const busy = occupyWorker(directory, service, "busy.mac");
        const { uri } = writeModule(directory, "shared.mac", SOURCE);
        const before = service.stats.dispatched;
        /* Загрузчик и прогрев спрашивают один файл, пока worker занят. */
        const [loader, warmup] = await Promise.all([
            service.index({ uri, generation: 1, priority: "background" }),
            service.index({ uri, generation: 1, priority: "foreground" }),
            busy
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
            service.stats.dispatched - before,
            1,
            "worker обязан получить ровно один запрос: " +
            JSON.stringify(service.stats)
        );
        assert.strictEqual(service.stats.coalesced, 1);
    }));

test("присоединившийся получает ответ про СВОЙ запрос", () =>
    withWorkspace(async ({ directory, service }) => {
        /*
         * Содержимое у объединённых общее, а номер запроса и поколение — свои.
         * Они не про файл, а про спросившего: поколение решает, нужен ли
         * результат ещё, номер сопоставляет ответ с запросом.
         */
        const busy = occupyWorker(directory, service, "busy.mac");
        const { uri } = writeModule(directory, "shared-ids.mac", SOURCE);
        const before = service.stats.dispatched;
        const [first, second, third] = await Promise.all([
            service.index({ uri, generation: 7, priority: "background" }),
            service.index({ uri, generation: 42, priority: "background" }),
            service.index({ uri, generation: 42, priority: "foreground" }),
            busy
        ]);

        assert.strictEqual(
            service.stats.dispatched - before,
            1,
            "спрашивали одно и то же: запрос обязан быть один"
        );
        assert.deepStrictEqual(
            [first.generation, second.generation, third.generation],
            [7, 42, 42],
            "каждому — его поколение, а не поколение соседа"
        );
        assert.strictEqual(
            new Set([first.id, second.id, third.id]).size,
            3,
            "и свой номер запроса у каждого"
        );
        assert.deepStrictEqual(
            second.declarations.map(item => item.name),
            first.declarations.map(item => item.name),
            "а содержимое общее"
        );
        assert.strictEqual(second.uri, first.uri);
        assert.strictEqual(second.status, first.status);
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

test("к уже выполняющемуся запросу присоединиться нельзя", () =>
    withWorkspace(async ({ directory, service }) => {
        /*
         * Гонка, ради которой объединение ограничено очередью.
         *
         * Файл читается worker'ом; пока он это делает, файл меняют. Пришедший
         * следом запрос обязан получить НОВОЕ содержимое, а не результат
         * чтения, начатого до правки. Проверка поколения у вызывающего тут не
         * помогает: его запрос начался уже после сброса.
         */
        const busy = occupyWorker(directory, service, "busy.mac");
        const written = writeModule(directory, "racing.mac", SOURCE);
        const queued = service.index({
            uri: written.uri,
            generation: 1,
            priority: "background"
        });

        /*
         * Как только посторонний файл закончен, racing.mac уходит worker'у:
         * pump вызывается синхронно при разборе ответа, до продолжения этого
         * await. Дальше файл уже выполняется.
         */
        await busy;

        const beforeCoalesced = service.stats.coalesced;

        fs.writeFileSync(
            written.filePath,
            SOURCE + "\nMacro Charlie()\nEnd;\n"
        );

        const foreground = await service.index({
            uri: written.uri,
            generation: 2,
            priority: "foreground"
        });

        await queued;

        assert.strictEqual(
            service.stats.coalesced - beforeCoalesced,
            0,
            "выполняющийся запрос попутчиков не берёт: " +
            JSON.stringify(service.stats)
        );
        assert.strictEqual(foreground.status, "indexed");
        assert.ok(
            foreground.declarations.some(item => item.name === "Charlie"),
            "ответ обязан быть по новому содержимому файла"
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
        const busy = occupyWorker(directory, service, "busy.mac");
        const [withPrint, without] = await Promise.all([
            service.index({
                uri: written.uri,
                generation: 2,
                knownFingerprint: first.fingerprint
            }),
            service.index({ uri: written.uri, generation: 2 }),
            busy
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
        const busy = occupyWorker(directory, service, "busy.mac");
        const { uri } = writeModule(directory, "exports.mac", SOURCE);
        const before = service.stats.dispatched;
        const [plain, targeted] = await Promise.all([
            service.index({ uri, generation: 1 }),
            service.index({ uri, generation: 1, expectedExport: "Alpha" }),
            busy
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
        const busy = occupyWorker(directory, service, "busy.mac");
        const { uri } = writeModule(directory, "same-export.mac", SOURCE);
        const before = service.stats.dispatched;

        await Promise.all([
            service.index({ uri, generation: 1, expectedExport: "Alpha" }),
            service.index({ uri, generation: 1, expectedExport: "Alpha" }),
            busy
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

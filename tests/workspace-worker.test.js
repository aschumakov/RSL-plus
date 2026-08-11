"use strict";

/*
 * Компактная индексация внешних файлов в worker.
 *
 * Здесь проверяется сам механизм: протокол, очередь, повторное использование
 * разбора, устойчивость к падению worker'а и остановка. Сценарии
 * взаимодействия с загрузчиком Import появятся вместе с его переводом на
 * worker.
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
    readCompactModule
} = require("../server/out/indexing/compactModuleReader");
const {
    WorkspaceModuleLoader
} = require("../server/out/indexing/workspaceModuleLoader");
const {
    createExternalModuleSummary
} = require("../server/out/moduleModel");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

let passed = 0;
let failed = 0;

async function test(name, action) {
    try {
        await action();
        passed++;
        console.log(`[OK] ${name}`);
    } catch (error) {
        failed++;
        console.error(`[FAIL] ${name}`);
        console.error(error);
    }
}

function externalSource(macroCount) {
    const chunks = ["Import shared, helpers;"];
    for (let index = 0; index < macroCount; index++) {
        chunks.push(
            `Macro Exported${index}(first, second:Integer):String`,
            `  Var localValue${index} = ${index};`,
            "End;",
            `Private Macro Hidden${index}()`,
            "End;"
        );
    }
    chunks.push("Class (Base) Holder", "  Var Code:String;", "  Macro Load(id)", "  End;", "End;");
    return chunks.join("\n");
}

function withWorkspace(action) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rsl-worker-"));
    const service = new CompactModuleWorkerService({ log: () => undefined });
    return action({ directory, service }).finally(async () => {
        await service.dispose();
        fs.rmSync(directory, { recursive: true, force: true });
    });
}

function writeModule(directory, name, source) {
    const filePath = path.join(directory, name);
    fs.writeFileSync(filePath, source);
    return { filePath, uri: pathToFileURL(filePath).toString() };
}

(async () => {
    await test(
        "worker отдаёт тот же состав объявлений, что разбор на месте",
        () => withWorkspace(async ({ directory, service }) => {
            const source = externalSource(3);
            const { uri } = writeModule(directory, "same.mac", source);

            const response = await service.index({ uri, generation: 1 });
            assert.strictEqual(response.status, "indexed");
            assert.strictEqual(response.sourceLength, source.length);
            assert.strictEqual(response.generation, 1);

            /*
             * Сравнение идёт через symbol tree: именно его строит основной
             * поток из ответа worker'а, и именно он должен совпадать с
             * загрузкой на месте.
             */
            const local = createExternalModuleSummary(source);
            const index = new WorkspaceIndex();
            const remote = index.updateExternalModuleFromDeclarations(
                uri,
                response.sourceLength,
                { declarations: response.declarations, imports: response.imports },
                response.mtimeMs
            );

            const flatten = root => root.children.map(symbol => ({
                name: symbol.name,
                kind: symbol.kind,
                parameterText: symbol.parameterText,
                children: symbol.children.map(child => child.name)
            }));

            assert.deepStrictEqual(
                flatten(remote.symbolTree),
                flatten(local.symbolTree)
            );
            assert.deepStrictEqual(
                response.imports.map(value => value.toLowerCase()),
                ["shared", "helpers"]
            );
        })
    );

    await test(
        "в ответе нет исходника, AST и token stream",
        () => withWorkspace(async ({ directory, service }) => {
            const { uri } = writeModule(
                directory,
                "payload.mac",
                externalSource(4)
            );
            const response = await service.index({ uri, generation: 0 });

            assert.deepStrictEqual(
                Object.keys(response).sort(),
                [
                    "declarations", "exportsRequestedName", "generation", "id",
                    "imports", "mtimeMs", "reused", "sourceLength", "status",
                    "uri"
                ],
                "Состав ответа расширился — проверьте, не попал ли в него " +
                    "текст, дерево или токены"
            );

            const serialized = JSON.stringify(response);
            assert.ok(
                !serialized.includes("localValue"),
                "Локальные переменные Macro не должны попадать во внешний модуль"
            );
            assert.ok(
                !serialized.includes("Hidden"),
                "Private-объявления не должны покидать worker"
            );
            assert.ok(
                !/"tokens"|"root"|"lex"/.test(serialized),
                "В ответе не должно быть token stream и синтаксического дерева"
            );
        })
    );

    await test(
        "повторный запрос того же файла не сканируется заново",
        () => withWorkspace(async ({ directory, service }) => {
            const { uri } = writeModule(
                directory,
                "memo.mac",
                externalSource(3)
            );

            const first = await service.index({ uri, generation: 0 });
            const second = await service.index({
                uri,
                generation: 0,
                expectedExport: "Exported1"
            });

            assert.strictEqual(first.reused, false);
            assert.strictEqual(
                second.reused,
                true,
                "Адресная проверка экспорта после загрузки обязана " +
                    "переиспользовать уже готовый разбор"
            );
            assert.strictEqual(second.exportsRequestedName, true);
            assert.deepStrictEqual(
                second.declarations.map(item => item.name),
                first.declarations.map(item => item.name)
            );
        })
    );

    await test(
        "изменение файла отменяет переиспользование",
        () => withWorkspace(async ({ directory, service }) => {
            const { filePath, uri } = writeModule(
                directory,
                "changed.mac",
                externalSource(2)
            );
            const first = await service.index({ uri, generation: 0 });

            /* mtime на Windows имеет ограниченное разрешение. */
            await new Promise(resolve => setTimeout(resolve, 20));
            fs.writeFileSync(
                filePath,
                externalSource(2) + "\nMacro AddedLater()\nEnd;"
            );

            const second = await service.index({ uri, generation: 0 });
            assert.strictEqual(second.reused, false);
            assert.ok(
                second.declarations.some(item => item.name === "AddedLater"),
                "После правки файла обязан вернуться новый состав"
            );
            assert.notStrictEqual(second.mtimeMs, first.mtimeMs);
        })
    );

    await test(
        "известный mtime отвечает unchanged без чтения",
        () => withWorkspace(async ({ directory, service }) => {
            const { uri } = writeModule(
                directory,
                "unchanged.mac",
                externalSource(2)
            );
            const first = await service.index({ uri, generation: 0 });
            const second = await service.index({
                uri,
                generation: 0,
                knownMtimeMs: first.mtimeMs
            });

            assert.strictEqual(second.status, "unchanged");
            assert.strictEqual(second.mtimeMs, first.mtimeMs);
            assert.strictEqual(second.declarations, undefined);
        })
    );

    await test(
        "адресная проверка сообщает об отсутствии экспорта",
        () => withWorkspace(async ({ directory, service }) => {
            const { uri } = writeModule(
                directory,
                "exports.mac",
                externalSource(2)
            );
            const response = await service.index({
                uri,
                generation: 0,
                expectedExport: "Hidden0"
            });

            assert.strictEqual(response.status, "indexed");
            assert.strictEqual(
                response.exportsRequestedName,
                false,
                "Private-объявление не является экспортом"
            );
        })
    );

    await test(
        "удалённый файл не роняет сервис",
        () => withWorkspace(async ({ service }) => {
            const missing = pathToFileURL(
                path.join(os.tmpdir(), "rsl-worker-missing", "nope.mac")
            ).toString();
            const response = await service.index({
                uri: missing,
                generation: 0
            });

            assert.strictEqual(response.status, "missing");
            assert.strictEqual(response.uri, missing);
        })
    );

    await test(
        "очередь сохраняет порядок и поколение запросов",
        () => withWorkspace(async ({ directory, service }) => {
            const modules = [0, 1, 2, 3].map(index => writeModule(
                directory,
                `queued-${index}.mac`,
                externalSource(2 + index)
            ));

            const responses = await Promise.all(modules.map((module, index) =>
                service.index({ uri: module.uri, generation: index })
            ));

            responses.forEach((response, index) => {
                assert.strictEqual(response.uri, modules[index].uri);
                assert.strictEqual(
                    response.generation,
                    index,
                    "Поколение обязано возвращаться без изменений: по нему " +
                        "загрузчик отбрасывает уже ненужные результаты"
                );
            });
            assert.strictEqual(service.isBusy, false);
        })
    );

    await test(
        "падение worker не ломает сервис и не теряет запрос",
        () => {
            const directory = fs.mkdtempSync(
                path.join(os.tmpdir(), "rsl-worker-crash-")
            );
            const logs = [];
            const service = new CompactModuleWorkerService({
                log: message => logs.push(message)
            });
            const { uri } = writeModule(
                directory,
                "crash.mac",
                externalSource(3)
            );

            return (async () => {
                const before = await service.index({ uri, generation: 0 });
                assert.strictEqual(before.status, "indexed");

                /*
                 * Аварию потока изнутри не воспроизвести: обработчик worker'а
                 * ловит ошибки разбора и отвечает "failed". Поэтому поток
                 * убивается извне — для сервиса это ровно то же событие exit
                 * с ненулевым кодом.
                 */
                const crashed = service.worker;
                assert.ok(crashed, "worker должен быть создан первым запросом");
                const inFlight = service.index({ uri, generation: 1 });
                await crashed.terminate();

                const interrupted = await inFlight;
                assert.ok(
                    interrupted.status === "failed" ||
                        interrupted.status === "indexed",
                    "Запрос, застигнутый падением, обязан получить ответ, " +
                        `а не остаться висеть; получено: ${interrupted.status}`
                );
                assert.strictEqual(interrupted.generation, 1);

                const after = await service.index({ uri, generation: 2 });
                assert.strictEqual(
                    after.status,
                    "indexed",
                    "После падения сервис обязан продолжить работу на новом " +
                        "worker'е, а не остаться сломанным"
                );
                assert.notStrictEqual(service.worker, crashed);
                assert.ok(
                    logs.length > 0,
                    "Падение потока обязано попадать в лог сервера"
                );
            })().finally(async () => {
                await service.dispose();
                fs.rmSync(directory, { recursive: true, force: true });
            });
        }
    );

    await test(
        "после остановки сервис отвечает, а не зависает",
        () => {
            const directory = fs.mkdtempSync(
                path.join(os.tmpdir(), "rsl-worker-stop-")
            );
            const service = new CompactModuleWorkerService({
                log: () => undefined
            });
            const { uri } = writeModule(
                directory,
                "stopped.mac",
                externalSource(2)
            );

            return service.index({ uri, generation: 0 })
                .then(() => service.dispose())
                .then(() => service.index({ uri, generation: 0 }))
                .then(response => {
                    assert.strictEqual(response.status, "failed");
                })
                .finally(() => {
                    fs.rmSync(directory, { recursive: true, force: true });
                });
        }
    );

    /* --- связка с загрузчиком Import ------------------------------------ */

    /**
     * Индексатор с управляемой задержкой: позволяет проверить, что происходит,
     * пока worker ещё не ответил.
     */
    function createControlledIndexer() {
        const calls = [];
        let release = () => undefined;
        const gate = new Promise(resolve => { release = resolve; });

        return {
            calls,
            release: () => release(),
            indexer: {
                async index(request) {
                    calls.push(request);
                    await gate;
                    return readCompactModule({ ...request, id: 0 });
                }
            }
        };
    }

    function createLoader(directory, options = {}) {
        const index = new WorkspaceIndex();
        const loaded = [];
        const loader = new WorkspaceModuleLoader(index, {
            log: options.log || (() => undefined),
            compactModules: options.compactModules,
            onModuleLoaded: module => loaded.push(module.uri),
            onModuleCountChanged: () => undefined
        });
        loader.registerWorkspaceFiles(
            fs.readdirSync(directory)
                .filter(name => name.endsWith(".mac"))
                .map(name => pathToFileURL(path.join(directory, name)).toString())
        );
        return { index, loader, loaded };
    }

    await test(
        "загрузчик индексирует внешний модуль через worker",
        () => withWorkspace(async ({ directory, service }) => {
            writeModule(directory, "imported.mac", externalSource(2));
            const { index, loader, loaded } = createLoader(directory, {
                compactModules: service
            });

            const module = await loader.ensureLoadedByName("imported");

            assert.ok(module, "Модуль должен загрузиться");
            assert.strictEqual(module.isOpen, false);
            assert.ok(
                module.symbolTree.find("Exported0"),
                "Экспортируемое объявление должно попасть в индекс"
            );
            assert.strictEqual(
                module.symbolTree.find("Hidden0"),
                undefined,
                "Private-объявление не должно попасть в индекс"
            );
            assert.deepStrictEqual(loaded, [module.uri]);
            assert.strictEqual(index.getModule(module.uri), module);
            assert.strictEqual(
                module.source,
                "",
                "Внешний модуль не должен удерживать исходный текст"
            );
        })
    );

    await test(
        "локальная модель не перезаписывается ответом worker'а",
        () => withWorkspace(async ({ directory }) => {
            const { uri } = writeModule(
                directory,
                "opened.mac",
                externalSource(2)
            );
            const controlled = createControlledIndexer();
            const { index, loader } = createLoader(directory, {
                compactModules: controlled.indexer
            });

            const pending = loader.ensureLoadedUri(uri);
            await new Promise(resolve => setImmediate(resolve));

            /*
             * Пока worker считает, пользователь открыл этот файл: в индексе
             * появилась точная модель. Компактный ответ обязан быть отброшен —
             * иначе открытый документ потерял бы области видимости и AST.
             */
            index.updateOpenModule(uri, "Macro Opened()\nEnd;", 1);
            controlled.release();
            await pending;

            const module = index.getModule(uri);
            assert.strictEqual(
                module.isOpen,
                true,
                "Открытая модель обязана остаться открытой"
            );
            assert.ok(module.symbolTree.find("Opened"));
        })
    );

    await test(
        "Ctrl+Click обгоняет фоновую очередь индексации",
        () => withWorkspace(async ({ directory, service }) => {
            for (let index = 0; index < 6; index++) {
                writeModule(directory, `bulk-${index}.mac`, externalSource(2));
            }
            const target = writeModule(
                directory,
                "target.mac",
                externalSource(2)
            );
            const order = [];
            const { loader } = createLoader(directory, {
                compactModules: {
                    index: async request => {
                        order.push(request.uri);
                        return service.index(request);
                    }
                }
            });

            loader.setIndexingMode("full");
            loader.startBackgroundIndexing();
            const requested = await loader.ensureLoadedUri(target.uri);

            assert.ok(requested, "Адресный запрос обязан вернуть модуль");
            assert.ok(
                order.indexOf(target.uri) <= 1,
                "Запрос по Ctrl+Click должен обгонять фоновую очередь, а не " +
                    `ждать её; порядок обращений: ${order.length} шт., ` +
                    `позиция цели ${order.indexOf(target.uri)}`
            );
        })
    );

    await test(
        "неизменившийся файл не переиндексируется повторно",
        () => withWorkspace(async ({ directory, service }) => {
            const { uri } = writeModule(
                directory,
                "reload.mac",
                externalSource(2)
            );
            const requests = [];
            const { index, loader, loaded } = createLoader(directory, {
                compactModules: {
                    index: async request => {
                        const response = await service.index(request);
                        requests.push({
                            knownMtimeMs: request.knownMtimeMs,
                            status: response.status
                        });
                        return response;
                    }
                }
            });

            const first = await loader.ensureLoadedUri(uri);
            assert.strictEqual(requests[0].status, "indexed");

            /* Наблюдатель за файлами срабатывает и на сохранение без правок. */
            await loader.reload(uri);

            assert.strictEqual(
                requests[1].knownMtimeMs,
                first.version,
                "Загрузчик обязан сообщить worker'у уже известный mtime"
            );
            assert.strictEqual(
                requests[1].status,
                "unchanged",
                "Файл не менялся — worker не должен его перечитывать"
            );
            assert.deepStrictEqual(
                loaded,
                [uri],
                "Повторная публикация модуля запускала бы пересчёт " +
                    "межфайловых Problems у всех зависимых файлов"
            );
            assert.strictEqual(index.getModule(uri), first);
        })
    );

    await test(
        "упавший worker не оставляет Import без индексации",
        () => withWorkspace(async ({ directory }) => {
            writeModule(directory, "fallback.mac", externalSource(2));
            const logs = [];
            const { loader } = createLoader(directory, {
                log: message => logs.push(message),
                compactModules: {
                    index: async request => ({
                        id: 0,
                        uri: request.uri,
                        generation: request.generation,
                        status: "failed",
                        error: "worker недоступен"
                    })
                }
            });

            const module = await loader.ensureLoadedByName("fallback");

            assert.ok(
                module,
                "При недоступном worker загрузка обязана пройти на месте: " +
                    "иначе навигация по Import молча перестала бы работать"
            );
            assert.ok(module.symbolTree.find("Exported0"));
            assert.ok(
                logs.some(message => message.includes("main thread")),
                "Переход на резервный путь обязан попадать в лог"
            );
        })
    );

    console.log("");
    console.log(`Пройдено: ${passed}`);
    console.log(`Ошибок: ${failed}`);

    if (failed > 0) {
        process.exitCode = 1;
    }
})();

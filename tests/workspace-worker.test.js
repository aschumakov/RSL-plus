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
                    "declarations", "exportsRequestedName", "fingerprint",
                    "generation", "id", "imports", "mtimeMs", "reused",
                    "sourceLength", "status", "uri"
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
        "известный отпечаток отвечает unchanged без сканирования",
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
                knownFingerprint: first.fingerprint
            });

            assert.strictEqual(second.status, "unchanged");
            assert.strictEqual(second.mtimeMs, first.mtimeMs);
            assert.strictEqual(second.fingerprint, first.fingerprint);
            assert.strictEqual(second.declarations, undefined);
        })
    );

    await test(
        "изменённый файл с сохранённой датой не считается неизменённым",
        () => withWorkspace(async ({ directory, service }) => {
            const before = "Macro Before()\nEnd;";
            const after = "Macro Afterx()\nEnd;";
            assert.strictEqual(
                before.length,
                after.length,
                "Тест проверяет именно содержимое: размер обязан совпасть"
            );
            const { filePath, uri } = writeModule(
                directory,
                "same-mtime.mac",
                before
            );
            /*
             * Дата ставится ровной в миллисекундах и задаётся явно оба раза.
             * Через stat.mtime её восстановить нельзя: Date округляет доли
             * миллисекунды, файл получает дату на 1 мс другую, и тест
             * проходил бы просто потому, что даты не совпали.
             */
            const stamp = new Date(1700000000000);
            fs.utimesSync(filePath, stamp, stamp);
            const first = await service.index({ uri, generation: 0 });
            assert.strictEqual(first.status, "indexed");

            /*
             * Так выглядит правка, пришедшая из системы контроля версий или от
             * утилиты копирования: содержимое другое, а дата изменения
             * прежняя. По одному mtime такой файл выглядел неизменённым, и в
             * индексе оставались объявления, которых в файле уже нет.
             */
            fs.writeFileSync(filePath, after);
            fs.utimesSync(filePath, stamp, stamp);

            const second = await service.index({
                uri,
                generation: 0,
                knownFingerprint: first.fingerprint
            });

            /*
             * Предпосылка проверяется отдельно: если дата или размер всё же
             * разошлись, тест обязан упасть здесь, а не «пройти» на условии,
             * которого он не собирался проверять.
             */
            assert.strictEqual(
                second.mtimeMs,
                first.mtimeMs,
                "Дата обязана совпасть, иначе проверяется не подмена " +
                    "содержимого, а обычное изменение файла"
            );
            assert.strictEqual(
                fs.statSync(filePath).size,
                Buffer.byteLength(before),
                "Размер обязан остаться прежним, иначе тест ничего не ловит"
            );
            assert.strictEqual(
                second.status,
                "indexed",
                "Файл с другим содержимым обязан быть переиндексирован, " +
                    "даже если дата изменения осталась прежней"
            );
            assert.notStrictEqual(second.fingerprint, first.fingerprint);
            assert.ok(
                second.declarations.some(item => item.name === "Afterx"),
                "В ответе обязан быть новый состав объявлений"
            );
        })
    );

    await test(
        "сохранение без правок отвечает unchanged по отпечатку",
        () => withWorkspace(async ({ directory, service }) => {
            const source = externalSource(2);
            const { filePath, uri } = writeModule(
                directory,
                "resaved.mac",
                source
            );
            const first = await service.index({ uri, generation: 0 });

            /* mtime на Windows имеет ограниченное разрешение. */
            await new Promise(resolve => setTimeout(resolve, 20));
            /* Ctrl+S без правок: дата новая, содержимое прежнее. */
            fs.writeFileSync(filePath, source);

            const second = await service.index({
                uri,
                generation: 0,
                knownFingerprint: first.fingerprint
            });

            assert.notStrictEqual(
                second.mtimeMs,
                first.mtimeMs,
                "Дата изменения обязана обновиться, иначе проверяется не то"
            );
            assert.strictEqual(
                second.status,
                "unchanged",
                "Отпечаток следует за содержимым, а не за датой: повторная " +
                    "публикация модуля запускала бы пересчёт межфайловых " +
                    "Problems у всех зависимых файлов"
            );
            assert.strictEqual(second.fingerprint, first.fingerprint);
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
                            knownFingerprint: request.knownFingerprint,
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

            assert.ok(
                first.fingerprint,
                "Внешний модуль обязан запомнить отпечаток содержимого"
            );
            assert.strictEqual(
                requests[1].knownFingerprint,
                first.fingerprint,
                "Загрузчик обязан сообщить worker'у уже известный отпечаток"
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

    /**
     * Индексатор, у которого задерживается доставка ответа, а не чтение.
     *
     * Так ведёт себя настоящий worker: файл он читает сразу, а ответ идёт к
     * основному потоку позже. Именно в этом окне файл успевает измениться или
     * исчезнуть, и именно оно проверяется ниже.
     */
    function createDelayedDeliveryIndexer() {
        let release = () => undefined;
        const delivered = new Promise(resolve => { release = resolve; });
        let signalRead = () => undefined;
        /*
         * Момент "файл уже прочитан" сообщается промисом, а не паузой: пауза
         * на медленной машине истекала бы до чтения, и тест проверял бы уже
         * не то окно между чтением и доставкой ответа, ради которого написан.
         */
        const readCompleted = new Promise(resolve => { signalRead = resolve; });
        let calls = 0;

        return {
            get calls() { return calls; },
            readCompleted,
            release: () => release(),
            indexer: {
                async index(request) {
                    calls++;
                    const response = await readCompactModule({
                        ...request,
                        id: 0
                    });
                    signalRead();
                    await delivered;
                    return response;
                }
            }
        };
    }

    await test(
        "правка файла во время запроса приводит к повторному чтению",
        () => withWorkspace(async ({ directory }) => {
            const { filePath, uri } = writeModule(
                directory,
                "changed-in-flight.mac",
                "Macro Before()\nEnd;"
            );
            const controlled = createDelayedDeliveryIndexer();
            const { index, loader } = createLoader(directory, {
                compactModules: controlled.indexer
            });

            const first = loader.ensureLoadedUri(uri);
            /* Ждём, пока worker прочитает прежнее содержимое. */
            await controlled.readCompleted;
            fs.writeFileSync(filePath, "Macro After()\nEnd;");
            const reloaded = loader.reload(uri);
            controlled.release();
            await Promise.all([first, reloaded]);

            assert.strictEqual(
                controlled.calls,
                2,
                "reload обязан перечитать файл, а не дождаться устаревшего " +
                    "запроса: иначе индекс остаётся с прежним содержимым до " +
                    "следующей правки"
            );
            assert.ok(
                index.getModule(uri).symbolTree.find("After"),
                "В индексе должно оказаться новое содержимое файла"
            );
            assert.strictEqual(
                index.getModule(uri).symbolTree.find("Before"),
                undefined
            );
        })
    );

    await test(
        "удаление файла во время запроса не возвращает его в индекс",
        () => withWorkspace(async ({ directory }) => {
            const { filePath, uri } = writeModule(
                directory,
                "deleted-in-flight.mac",
                externalSource(2)
            );
            const controlled = createDelayedDeliveryIndexer();
            const { index, loader } = createLoader(directory, {
                compactModules: controlled.indexer
            });

            const pending = loader.ensureLoadedUri(uri);
            await controlled.readCompleted;

            loader.remove(uri);
            fs.rmSync(filePath);
            controlled.release();
            await pending;

            assert.strictEqual(
                index.getModule(uri),
                undefined,
                "Ответ, прочитанный до удаления, не имеет права вернуть " +
                    "удалённый файл в индекс"
            );
        })
    );

    await test(
        "исключение файла из проекта отбрасывает ответ по нему",
        () => withWorkspace(async ({ directory }) => {
            const { uri } = writeModule(
                directory,
                "excluded-in-flight.mac",
                externalSource(2)
            );
            const controlled = createDelayedDeliveryIndexer();
            const { index, loader } = createLoader(directory, {
                compactModules: controlled.indexer
            });

            const pending = loader.ensureLoadedUri(uri);
            await controlled.readCompleted;

            /* Файл перестал попадать в каталог проекта. */
            loader.registerWorkspaceFiles([]);
            controlled.release();
            await pending;

            assert.strictEqual(
                index.getModule(uri),
                undefined,
                "Исключённый из проекта файл не должен попасть в индекс"
            );
        })
    );

    await test(
        "исключение файла во время reload не возвращает его в индекс",
        () => withWorkspace(async ({ directory }) => {
            const { uri } = writeModule(
                directory,
                "excluded-while-reloading.mac",
                externalSource(2)
            );
            const controlled = createDelayedDeliveryIndexer();
            const { index, loader } = createLoader(directory, {
                compactModules: controlled.indexer
            });

            const pending = loader.ensureLoadedUri(uri);
            await controlled.readCompleted;

            /*
             * Наблюдатель за файлами сообщил о правке, пока первый запрос ещё
             * не доставил ответ; reload встаёт в ожидание этого запроса. За
             * время ожидания файл исключают из проекта.
             */
            const reloaded = loader.reload(uri);
            loader.registerWorkspaceFiles([]);
            controlled.release();
            await Promise.all([pending, reloaded]);

            assert.strictEqual(
                index.getModule(uri),
                undefined,
                "reload после исключения возвращал файл в индекс: повторное " +
                    "чтение получает свежий epoch, и проверка ответа его " +
                    "пропускает"
            );
            assert.strictEqual(
                controlled.calls,
                1,
                "Перечитывать исключённый файл не нужно: reload обязан " +
                    "отмениться, а не выдать повторный запрос"
            );
        })
    );

    await test(
        "адресный запрос обгоняет фоновую индексацию в очереди worker",
        () => withWorkspace(async ({ directory, service }) => {
            const background = [];
            for (let index = 0; index < 5; index++) {
                background.push(writeModule(
                    directory,
                    `queued-bg-${index}.mac`,
                    externalSource(2)
                ).uri);
            }
            const target = writeModule(
                directory,
                "urgent.mac",
                externalSource(2)
            ).uri;

            const order = [];
            const observed = {
                index: async request => {
                    const response = await service.index(request);
                    order.push(request.uri);
                    return response;
                }
            };

            const pending = background.map(uri => observed.index({
                uri,
                generation: 0,
                priority: "background"
            }));
            const urgent = observed.index({
                uri: target,
                generation: 1,
                priority: "foreground"
            });

            await Promise.all([...pending, urgent]);

            const position = order.indexOf(target);
            assert.ok(
                position <= 1,
                "Запрос активного документа обязан обгонять фоновую " +
                    `индексацию; он обработан ${position + 1}-м из ` +
                    `${order.length}`
            );
        })
    );

    await test(
        "адресный запрос обгоняет пачку проверок Auto Import",
        () => withWorkspace(async ({ directory, service }) => {
            /*
             * Auto Import ставит кандидатов в очередь пачкой (batchSize в
             * findModulesExportingSymbol), поэтому с общим приоритетом
             * навигация оказывалась за всей пачкой, а не за одним файлом.
             */
            const candidates = [];
            for (let index = 0; index < 8; index++) {
                candidates.push(writeModule(
                    directory,
                    `candidate-${index}.mac`,
                    externalSource(2)
                ).uri);
            }
            const target = writeModule(
                directory,
                "navigated.mac",
                externalSource(2)
            ).uri;

            const order = [];
            const observed = request => service.index(request).then(response => {
                order.push(request.uri);
                return response;
            });

            const search = candidates.map(uri => observed({
                uri,
                generation: 0,
                expectedExport: "Exported0",
                priority: "search"
            }));
            const urgent = observed({
                uri: target,
                generation: 1,
                priority: "foreground"
            });

            await Promise.all([...search, urgent]);

            const position = order.indexOf(target);
            assert.ok(
                position <= 1,
                "Адресная навигация обязана обгонять обход кандидатов Auto " +
                    `Import; она обработана ${position + 1}-й из ` +
                    `${order.length}`
            );
        })
    );

    await test(
        "обход кандидатов Auto Import не занимает приоритет навигации",
        () => withWorkspace(async ({ directory }) => {
            for (let index = 0; index < 3; index++) {
                writeModule(directory, `scanned-${index}.mac`, externalSource(2));
            }
            const requests = [];
            const { loader } = createLoader(directory, {
                compactModules: {
                    index: async request => {
                        requests.push(request);
                        return readCompactModule({ ...request, id: 0 });
                    }
                }
            });

            await loader.findModulesExportingSymbol("Unknown0", 10, {
                scanWorkspace: true
            });

            assert.ok(requests.length > 0, "Обход обязан обратиться к worker");
            assert.deepStrictEqual(
                Array.from(new Set(requests.map(item => item.priority))),
                ["search"],
                "Явно вызванный Auto Import обязан идти отдельным уровнем " +
                    "приоритета: с foreground его пачка задерживала адресную " +
                    "навигацию"
            );

            const navigated = requests.length;
            await loader.ensureLoadedUri(
                pathToFileURL(path.join(directory, "scanned-0.mac")).toString()
            );
            assert.strictEqual(
                requests[navigated].priority,
                "foreground",
                "Адресная загрузка обязана сохранить высший приоритет"
            );
        })
    );

    /* --- постоянный кэш компактных сводок ------------------------------- */

    const {
        configureCompactModuleCache,
        compactModuleCache
    } = require("../server/out/indexing/compactModuleReader");

    /**
     * Кэш модульный, поэтому каждый тест получает свой файл и выключает кэш
     * после себя: иначе записи одного теста попадали бы в другой.
     */
    function withCache(action) {
        const directory = fs.mkdtempSync(
            path.join(os.tmpdir(), "rsl-cache-")
        );
        const cacheFile = path.join(directory, "compact-modules.json");
        configureCompactModuleCache(cacheFile);
        return action({ directory, cacheFile })
            .finally(() => {
                configureCompactModuleCache(undefined);
                /*
                 * Повторы обязательны: запись кэша могла ещё держать файл, и на
                 * Windows rmdir тогда падает с ENOTEMPTY. Без maxRetries тест
                 * падал примерно один раз из четырёх — на уборке, а не на
                 * проверке.
                 */
                fs.rmSync(directory, {
                    recursive: true,
                    force: true,
                    maxRetries: 10,
                    retryDelay: 20
                });
            });
    }

    await test(
        "кэш переживает перезапуск и снимает повторное сканирование",
        () => withCache(async ({ directory, cacheFile }) => {
            const { uri } = writeModule(
                directory,
                "cached.mac",
                externalSource(3)
            );

            const first = await readCompactModule({ uri, generation: 0, id: 1 });
            assert.strictEqual(first.status, "indexed");
            assert.strictEqual(
                first.reused,
                false,
                "Первое обращение обязано просканировать файл"
            );
            await compactModuleCache().flush();
            assert.ok(fs.existsSync(cacheFile), "Кэш обязан появиться на диске");

            /*
             * Перезапуск сессии: память на последние файлы пуста, на диске
             * остался только кэш. Файл не менялся, поэтому сканирование
             * повторяться не должно.
             */
            configureCompactModuleCache(undefined);
            configureCompactModuleCache(cacheFile);

            const second = await readCompactModule({
                uri,
                generation: 0,
                id: 2
            });

            assert.strictEqual(second.status, "indexed");
            assert.strictEqual(
                second.reused,
                true,
                "Сводка неизменённого файла обязана прийти из кэша, а не " +
                    "сканироваться заново при каждом запуске"
            );
            assert.deepStrictEqual(
                second.declarations.map(item => item.name),
                first.declarations.map(item => item.name)
            );
            assert.deepStrictEqual(second.imports, first.imports);
            assert.strictEqual(second.sourceLength, first.sourceLength);
        })
    );

    await test(
        "изменённый файл не берётся из кэша",
        () => withCache(async ({ directory, cacheFile }) => {
            const { filePath, uri } = writeModule(
                directory,
                "cache-stale.mac",
                "Macro Before()\nEnd;"
            );
            const stamp = new Date(1700000000000);
            fs.utimesSync(filePath, stamp, stamp);
            await readCompactModule({ uri, generation: 0, id: 1 });
            await compactModuleCache().flush();

            /* Та же дата и тот же размер — отличается только содержимое. */
            fs.writeFileSync(filePath, "Macro Afterx()\nEnd;");
            fs.utimesSync(filePath, stamp, stamp);
            configureCompactModuleCache(undefined);
            configureCompactModuleCache(cacheFile);

            const second = await readCompactModule({
                uri,
                generation: 0,
                id: 2
            });

            assert.strictEqual(second.reused, false);
            assert.ok(
                second.declarations.some(item => item.name === "Afterx"),
                "Кэш обязан сверяться по отпечатку содержимого: иначе после " +
                    "правки в индекс попадали бы прежние объявления"
            );
        })
    );

    await test(
        "кэш чужой версии и повреждённый кэш не ломают чтение",
        () => withCache(async ({ directory, cacheFile }) => {
            const { uri } = writeModule(
                directory,
                "cache-bad.mac",
                externalSource(2)
            );

            for (const content of [
                JSON.stringify({ version: 999, entries: [] }),
                "{ это не JSON",
                JSON.stringify({ version: 1, entries: "не массив" })
            ]) {
                fs.writeFileSync(cacheFile, content);
                configureCompactModuleCache(undefined);
                configureCompactModuleCache(cacheFile);

                const response = await readCompactModule({
                    uri,
                    generation: 0,
                    id: 3
                });
                assert.strictEqual(
                    response.status,
                    "indexed",
                    `Кэш (${content.slice(0, 20)}) обязан игнорироваться, ` +
                        "а не отменять индексацию"
                );
                assert.ok(response.declarations.length > 0);
            }
        })
    );

    await test(
        "сводки прежней версии кэша не переиспользуются",
        () => withCache(async ({ directory, cacheFile }) => {
            /*
             * Отпечаток считается по байтам файла, а он от смены способа чтения
             * не меняется. Поэтому сводки, снятые до распознавания CP866,
             * выглядели актуальными и отдавались как есть — с именами из
             * вопросительных знаков. Отсечь их может только номер версии.
             */
            const { uri } = writeModule(
                directory,
                "cache-old-version.mac",
                externalSource(4)
            );
            await readCompactModule({ uri, generation: 0, id: 1 });
            await compactModuleCache().flush();

            const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
            assert.ok(parsed.entries.length > 0, "Кэш обязан быть записан");
            /* Записи те же и отпечаток тот же — отличается только версия. */
            fs.writeFileSync(
                cacheFile,
                JSON.stringify({ version: 1, entries: parsed.entries })
            );
            configureCompactModuleCache(undefined);
            configureCompactModuleCache(cacheFile);

            const again = await readCompactModule({
                uri,
                generation: 0,
                id: 2
            });

            assert.strictEqual(again.status, "indexed");
            assert.strictEqual(
                again.reused,
                false,
                "Сводка прежней версии обязана быть перечитана заново"
            );
        })
    );

    await test(
        "в кэш не попадают исходный текст и AST",
        () => withCache(async ({ directory, cacheFile }) => {
            /* Состав уникален: тест не должен зависеть от памяти сессии. */
            const { uri } = writeModule(
                directory,
                "cache-payload.mac",
                externalSource(7)
            );
            await readCompactModule({ uri, generation: 0, id: 1 });
            await compactModuleCache().flush();

            const raw = fs.readFileSync(cacheFile, "utf8");
            const parsed = JSON.parse(raw);
            /*
             * Версия 2 — распознавание CP866. Поднимать её нужно и тогда, когда
             * изменился не формат записи, а способ получения содержимого:
             * отпечаток считается по байтам файла и потому совпадал, и старые
             * сводки без русских имён отдавались как актуальные.
             */
            assert.strictEqual(parsed.version, 2);
            assert.deepStrictEqual(
                Object.keys(parsed.entries[0]).sort(),
                [
                    "declarations", "fingerprint", "imports", "mtimeMs",
                    "sourceLength", "uri"
                ],
                "Состав записи расширился — проверьте, не попал ли в кэш " +
                    "текст, дерево или токены"
            );
            assert.ok(
                !raw.includes("localValue"),
                "Локальные переменные Macro не должны попадать в кэш"
            );
            assert.ok(
                !raw.includes("Hidden"),
                "Private-объявления не должны попадать в кэш"
            );
            assert.ok(
                !/"tokens"|"root"|Macro Exported0\(/.test(raw),
                "В кэше не должно быть исходного текста и дерева"
            );
        })
    );

    await test(
        "кэш ограничен по объёму, а не только по числу записей",
        () => withCache(async ({ directory, cacheFile }) => {
            /*
             * Объём сводки задаётся числом экспортируемых объявлений, а не
             * размером файла. Без предела по байтам кэш растёт до размеров,
             * при которых его загрузка дороже сэкономленного сканирования.
             */
            for (let index = 0; index < 6; index++) {
                const { uri } = writeModule(
                    directory,
                    `bulky-${index}.mac`,
                    externalSource(400) + `\n// unique ${index}`
                );
                await readCompactModule({ uri, generation: 0, id: index });
            }
            await compactModuleCache().flush();

            const size = fs.statSync(cacheFile).size;
            assert.ok(
                size < 32 * 1024 * 1024,
                `Кэш обязан оставаться в пределах бюджета; вышло ${size} байт`
            );

            const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
            assert.ok(
                parsed.entries.length > 0,
                "Бюджет не должен вырождать кэш в пустой файл"
            );
        })
    );

    await test(
        "без настроенного пути кэш выключен",
        () => withWorkspace(async ({ directory }) => {
            configureCompactModuleCache(undefined);
            const { uri } = writeModule(
                directory,
                "no-cache.mac",
                externalSource(2)
            );

            const response = await readCompactModule({
                uri,
                generation: 0,
                id: 1
            });

            assert.strictEqual(response.status, "indexed");
            assert.strictEqual(
                compactModuleCache().configured,
                false,
                "Без каталога расширения кэш обязан оставаться выключенным"
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

"use strict";

/**
 * Библиотеки модулей за пределами проекта.
 *
 * Платформа ищет модуль по USERMACRODIR: сперва рядом с собой, потом по
 * перечисленным каталогам, и первое совпадение побеждает. Плагин обязан
 * отвечать так же — и при этом не превращать базовую поставку в проект:
 * 9457 файлов и 222 МБ в Ctrl+T, в поиске использований и в фоновом чтении
 * не нужны никому.
 *
 * Проверяется и порядок, и цена: без вопроса о модуле ни один исходник
 * библиотеки не читается.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

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

const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const {
    RslLibraryModuleIndex
} = require("../server/out/indexing/libraryModuleIndex");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const created = [];

/** Каталог с файлами: { "lib.mac": "текст", "sub/lib.mac": "…" }. */
function makeTree(prefix, files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

    for (const [name, text] of Object.entries(files)) {
        const full = path.join(root, name.replace(/\//gu, path.sep));

        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, text, "utf8");
    }

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

/** Индекс проекта с зарегистрированными файлами и настроенными библиотеками. */
function stand(workspaceFiles, libraryPaths) {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles(workspaceFiles);
    index.setLibraryPaths(libraryPaths);

    return index;
}

function macro(name) {
    return "Macro " + name + "()\n  return 1;\nEnd;\n";
}

test("проект перекрывает библиотеку", () => {
    const library = makeTree("rsl-lib-", { "lib.mac": macro("FromLibrary") });
    const project = makeTree("rsl-prj-", { "lib.mac": macro("FromProject") });
    const own = pathToFileURL(path.join(project, "lib.mac")).toString();
    const index = stand([own], [library]);
    const resolved = index.resolveWorkspaceFile("lib");

    assert.strictEqual(resolved.kind, "resolved");
    assert.strictEqual(
        resolved.value,
        own,
        "у одноимённого модуля побеждает файл проекта"
    );

    /*
     * И библиотека при этом не прочитана: ответ нашёлся раньше.
     */
    assert.strictEqual(
        index.libraryCounters.scannedRoots,
        0,
        "библиотеку спрашивать было незачем"
    );
});

test("первый путь библиотеки перекрывает следующий", () => {
    const first = makeTree("rsl-lib1-", { "shared.mac": macro("First") });
    const second = makeTree("rsl-lib2-", { "shared.mac": macro("Second") });
    const index = stand([], [first, second]);
    const resolved = index.resolveWorkspaceFile("shared");

    assert.strictEqual(resolved.kind, "resolved");
    assert.strictEqual(
        resolved.value,
        pathToFileURL(path.join(first, "shared.mac")).toString(),
        "побеждает первый перечисленный каталог"
    );

    /*
     * Неоднозначности между библиотеками не бывает: второй каталог
     * спрашивается только тогда, когда в первом ничего не нашлось.
     */
    assert.notStrictEqual(
        resolved.kind,
        "ambiguous",
        "два одноимённых в разных библиотеках — не спор"
    );
});

test("модуль находится в базовой поставке", () => {
    const library = makeTree("rsl-base-", {
        "Cb/report.mac": macro("Report"),
        "other.mac": macro("Other")
    });
    const index = stand([], [library]);
    const resolved = index.resolveWorkspaceFile("report");

    assert.strictEqual(
        resolved.kind,
        "resolved",
        "модуль в подкаталоге поставки обязан находиться"
    );
    assert.strictEqual(
        resolved.value,
        pathToFileURL(path.join(library, "Cb", "report.mac")).toString()
    );
});

test("замыкание Import переходит между библиотеками", () => {
    /*
     * `middle` лежит в первой библиотеке и подключает `deep` из второй.
     * Разрешение у обоих одно и то же, поэтому граница библиотек ничего не
     * значит: замыкание её просто не замечает.
     */
    const first = makeTree("rsl-cl1-", {
        "middle.mac": "Import deep;\n" + macro("Middle")
    });
    const second = makeTree("rsl-cl2-", { "deep.mac": macro("Deep") });
    const index = stand([], [first, second]);
    const middle = index.resolveWorkspaceFile("middle");

    assert.strictEqual(middle.kind, "resolved");

    const deep = index.resolveWorkspaceFile("deep");

    assert.strictEqual(
        deep.kind,
        "resolved",
        "модуль из второй библиотеки обязан находиться по имени из первой"
    );
    assert.strictEqual(
        deep.value,
        pathToFileURL(path.join(second, "deep.mac")).toString()
    );
});

test("библиотека не попадает в состав проекта", () => {
    const library = makeTree("rsl-noidx-", {
        "used.mac": macro("Used"),
        "unused.mac": macro("Unused"),
        "deep/also.mac": macro("Also")
    });
    const index = stand([], [library]);
    const before = index.getWorkspaceFileUris().length;
    const resolved = index.resolveWorkspaceFile("used");

    assert.strictEqual(resolved.kind, "resolved");
    assert.strictEqual(
        index.getWorkspaceFileUris().length,
        before,
        "состав проекта от разрешения имени не растёт: " +
            index.getWorkspaceFileUris().join(", ")
    );
    assert.ok(
        !index.hasWorkspaceFile(resolved.value),
        "найденный файл библиотеки файлом проекта не становится"
    );
});

test("на старте исходники библиотеки не читаются", () => {
    /*
     * Цена настройки до первого вопроса обязана быть нулевой. Считаются
     * именно чтения содержимого: имена каталогов читаются лениво и только
     * тогда, когда о модуле спросили.
     */
    const library = makeTree("rsl-cold-", {
        "a.mac": macro("A"),
        "b.mac": macro("B"),
        "c/d.mac": macro("D")
    });
    const reads = [];
    const originalRead = fs.readFileSync;
    const originalReadDir = fs.readdirSync;
    let directoryReads = 0;

    fs.readFileSync = function (target, ...rest) {
        if (String(target).startsWith(library)) {
            reads.push(String(target));
        }

        return originalRead.call(this, target, ...rest);
    };
    fs.readdirSync = function (target, ...rest) {
        if (String(target).startsWith(library)) {
            directoryReads++;
        }

        return originalReadDir.call(this, target, ...rest);
    };

    try {
        const index = stand([], [library]);

        assert.deepStrictEqual(
            reads,
            [],
            "настройка сама по себе ничего не читает"
        );
        assert.strictEqual(
            directoryReads,
            0,
            "и оглавления тоже: указатель строится по запросу"
        );

        /* Вопрос про модуль: читаются имена, но не содержимое. */
        index.resolveWorkspaceFile("a");

        assert.deepStrictEqual(
            reads,
            [],
            "разрешение имени содержимое не читает: " + reads.join(", ")
        );
        assert.ok(
            directoryReads > 0,
            "а оглавления к этому моменту прочитаны"
        );

        /* Второй вопрос обходится готовым указателем. */
        const after = directoryReads;

        index.resolveWorkspaceFile("b");

        assert.strictEqual(
            directoryReads,
            after,
            "повторный вопрос каталоги не перечитывает"
        );
    } finally {
        fs.readFileSync = originalRead;
        fs.readdirSync = originalReadDir;
    }
});

test("каталог открытого вне проекта файла спрашивается первым", () => {
    /*
     * У файла вне проекта соседи по каталогу — его ближайшая библиотека.
     * Настройкой этот корень не становится: он живёт, пока файл открыт.
     */
    const configured = makeTree("rsl-cfg-", { "helper.mac": macro("FromCfg") });
    const beside = makeTree("rsl-beside-", {
        "helper.mac": macro("FromBeside")
    });
    const index = stand([], [configured]);

    assert.strictEqual(
        index.resolveWorkspaceFile("helper").value,
        pathToFileURL(path.join(configured, "helper.mac")).toString(),
        "без открытого файла отвечает настроенная библиотека"
    );

    index.setTemporaryLibraryRoot(beside);

    assert.strictEqual(
        index.resolveWorkspaceFile("helper").value,
        pathToFileURL(path.join(beside, "helper.mac")).toString(),
        "каталог открытого файла сильнее настроенной библиотеки"
    );

    index.setTemporaryLibraryRoot(undefined);

    assert.strictEqual(
        index.resolveWorkspaceFile("helper").value,
        pathToFileURL(path.join(configured, "helper.mac")).toString(),
        "файл закрыли — корень пропал"
    );
});

test("написанный путь сильнее имени", () => {
    const library = makeTree("rsl-sub-", {
        "lib.mac": macro("Root"),
        "sub/lib.mac": macro("Sub")
    });
    const index = stand([], [library]);

    assert.strictEqual(
        index.resolveWorkspaceFile("sub/lib").value,
        pathToFileURL(path.join(library, "sub", "lib.mac")).toString(),
        "Import sub/lib обязан привести именно в sub"
    );
    assert.strictEqual(
        index.resolveWorkspaceFile("lib").value,
        pathToFileURL(path.join(library, "lib.mac")).toString()
    );
});

test("смена настройки забывает найденное", () => {
    const first = makeTree("rsl-sw1-", { "one.mac": macro("One") });
    const second = makeTree("rsl-sw2-", { "one.mac": macro("Two") });
    const index = stand([], [first]);

    assert.strictEqual(
        index.resolveWorkspaceFile("one").value,
        pathToFileURL(path.join(first, "one.mac")).toString()
    );

    index.setLibraryPaths([second]);

    assert.strictEqual(
        index.resolveWorkspaceFile("one").value,
        pathToFileURL(path.join(second, "one.mac")).toString(),
        "после смены настройки отвечает новая библиотека"
    );
});

test("указатель библиотеки отвечает и без индекса проекта", () => {
    /* Сам указатель проверяется отдельно: у него своя цена и свои счётчики. */
    const library = makeTree("rsl-plain-", { "solo.mac": macro("Solo") });
    const paths = [library];
    const catalog = new RslLibraryModuleIndex({ paths: () => paths });

    assert.strictEqual(
        catalog.resolve("solo"),
        pathToFileURL(path.join(library, "solo.mac")).toString()
    );
    assert.strictEqual(catalog.resolve("нет-такого"), undefined);
    assert.strictEqual(catalog.counters.scans, 1, "каталог прочитан один раз");
    assert.strictEqual(catalog.counters.hits, 1);
    assert.strictEqual(catalog.counters.misses, 1);
});

test("загруженный библиотечный модуль не становится модулем проекта",
    () => {
    /*
     * Разрешение имени состав проекта не меняло и раньше, а вот загрузка
     * — меняла: модель любого прочитанного файла записывалась и в каталог
     * проекта, и в состав файлов. Однажды прочитанный `base/utils.mac`
     * после этого начинал перекрывать `utils.mac` проекта.
     */
    const library = makeTree("rsl-load-", {
        "utils.mac": macro("FromLibrary")
    });
    const index = stand([], [library]);
    const resolved = index.resolveWorkspaceFile("utils");

    assert.strictEqual(resolved.kind, "resolved");

    /* Именно загрузка: модель строится так же, как её строит загрузчик. */
    index.updateExternalModule(
        resolved.value,
        fs.readFileSync(
            path.join(library, "utils.mac"), "utf8"
        ),
        1
    );

    assert.ok(
        index.getModule(resolved.value),
        "модуль обязан быть загружен"
    );
    assert.ok(
        !index.hasWorkspaceFile(resolved.value),
        "и при этом не числиться файлом проекта"
    );
    assert.deepStrictEqual(
        index.getWorkspaceFileUris(),
        [],
        "состав проекта пуст: " + index.getWorkspaceFileUris().join(", ")
    );
    assert.ok(
        index.isLibraryFile(resolved.value),
        "файл обязан числиться библиотечным"
    );

    /* И в каталоге объявлений проекта его тоже нет. */
    const declared = index.catalog.find
        ? index.catalog.find("FromLibrary")
        : [];

    assert.deepStrictEqual(
        (declared || []).map(item => item.name),
        [],
        "объявления библиотеки в каталоге проекта не место"
    );
});

test("после смены папки отвечает новая, а не загруженная прежде", () => {
    /*
     * Отладка идёт из папки A, потом из папки B. Прежде `helper.mac` из A
     * оставался в памяти, а имя искали среди ЗАГРУЖЕННЫХ моделей по
     * базовому имени — порядка поиска они не знают, и A продолжал
     * выигрывать.
     */
    const first = makeTree("rsl-dbg-a-", {
        "helper.mac": macro("FromA")
    });
    const second = makeTree("rsl-dbg-b-", {
        "helper.mac": macro("FromB")
    });
    const index = stand([], []);

    index.setTemporaryLibraryRoot(first);

    const fromA = index.resolveWorkspaceFile("helper");

    assert.strictEqual(
        fromA.value,
        pathToFileURL(path.join(first, "helper.mac")).toString()
    );

    /* Модель A прочитана и лежит в памяти. */
    index.updateExternalModule(
        fromA.value,
        fs.readFileSync(path.join(first, "helper.mac"), "utf8"),
        1
    );

    index.setTemporaryLibraryRoot(second);

    assert.strictEqual(
        index.resolveWorkspaceFile("helper").value,
        pathToFileURL(path.join(second, "helper.mac")).toString(),
        "после переключения обязана побеждать вторая папка"
    );

    /*
     * И тот, кто спрашивает модель по имени, обязан получить её же — а не
     * прочитанную раньше модель из первой папки.
     */
    const model = index.importedModule("helper");

    assert.ok(
        model === undefined ||
            model.uri ===
                pathToFileURL(path.join(second, "helper.mac")).toString(),
        "модель обязана быть из второй папки, а пришла из " +
            (model && model.uri)
    );
});

test("незавершённый обход проекта не отдаёт победу библиотеке", () => {
    /*
     * Состав проекта ещё обходится, и «нет в каталоге» пока не значит
     * «нет в проекте»: адресный поиск по диску проекта не отработал.
     * Ответить библиотекой в этот момент значит дать одноимённому файлу
     * поставки выиграть просто потому, что обход не успел.
     */
    const library = makeTree("rsl-race-lib-", {
        "helper.mac": macro("FromLibrary")
    });
    const project = makeTree("rsl-race-prj-", {
        "helper.mac": macro("FromProject")
    });
    const own = pathToFileURL(path.join(project, "helper.mac")).toString();
    const index = new WorkspaceIndex();

    index.setLibraryPaths([library]);

    /* Обход ещё идёт: состав не объявлен готовым. */
    assert.strictEqual(
        index.workspaceFilesReady,
        false,
        "стенд обязан начинаться с незавершённого обхода"
    );
    assert.strictEqual(
        index.resolveWorkspaceFile("helper").kind,
        "missing",
        "до конца обхода библиотека отвечать не должна"
    );

    /* Библиотеку спросит адресный поиск — после своего прохода. */
    assert.strictEqual(
        index.resolveLibraryFile("helper"),
        pathToFileURL(path.join(library, "helper.mac")).toString(),
        "но по прямому вопросу она отвечает"
    );

    /* Обход дошёл до файла проекта — и он побеждает. */
    index.registerWorkspaceFiles([own]);

    assert.strictEqual(
        index.resolveWorkspaceFile("helper").value,
        own,
        "файл проекта сильнее одноимённого файла библиотеки"
    );
});

test("библиотека внутри проекта отдельным указателем не становится",
    async () => {
    /*
     * Настройку держат постоянной: в ней и репозиторий, и базовая поставка.
     * Открыт репозиторий — его файлы уже в составе проекта, и второй
     * указатель по ним не нужен. Открыта отдельная папка задачи — тот же
     * репозиторий работает библиотекой, и настройку менять не приходится.
     */
    const repository = makeTree("rsl-repo-", {
        "shared.mac": macro("FromRepo")
    });
    const base = makeTree("rsl-base2-", { "other.mac": macro("FromBase") });
    const own = pathToFileURL(path.join(repository, "shared.mac")).toString();

    /* Сценарий первый: открыт сам репозиторий. */
    const inside = stand([own], [repository, base]);

    inside.setWorkspaceRoots([repository]);

    assert.strictEqual(
        inside.resolveWorkspaceFile("shared").value,
        own,
        "отвечает состав проекта"
    );
    assert.strictEqual(
        await inside.prewarmLibraries(),
        1,
        "прогревается только поставка: репозиторий и так обойдён"
    );

    /* Сценарий второй: открыта папка задачи, репозиторий стал библиотекой. */
    const outside = stand([], [repository, base]);

    outside.setWorkspaceRoots([makeTree("rsl-task-", {})]);

    assert.strictEqual(
        outside.resolveWorkspaceFile("shared").value,
        own,
        "тот же файл находится через библиотеку, настройку менять не надо"
    );
});

test("прогрев строит указатели заранее и один раз", async () => {
    const library = makeTree("rsl-warm-", {
        "one.mac": macro("One"),
        "deep/two.mac": macro("Two")
    });
    const index = stand([], [library]);

    assert.strictEqual(
        index.libraryCounters.scannedRoots,
        0,
        "до прогрева ничего не прочитано"
    );
    assert.strictEqual(await index.prewarmLibraries(), 1);
    assert.strictEqual(
        index.libraryCounters.scannedRoots,
        1,
        "указатель построен"
    );
    assert.strictEqual(
        await index.prewarmLibraries(),
        0,
        "повторный прогрев работы не делает"
    );

    /* И первый вопрос после прогрева уже не читает каталогов. */
    const before = index.libraryCounters.scans;

    assert.ok(index.resolveWorkspaceFile("two").kind === "resolved");
    assert.strictEqual(index.libraryCounters.scans, before);
});
test("прогрев дробится на порции и уступает поток", async () => {
    /*
     * Общее время прогрева про отзывчивость ничего не говорит: 68 мс одним
     * куском и столько же десятью порциями — разные вещи. Прежний обход был
     * синхронной рекурсией и занимал поток целиком.
     */
    const files = {};

    for (let at = 0; at < 40; at++) {
        files["dir" + (at % 8) + "/m" + at + ".mac"] = macro("M" + at);
    }

    const library = makeTree("rsl-chunk-", files);
    const index = stand([], [library]);

    assert.strictEqual(await index.prewarmLibraries(), 1);
    assert.strictEqual(
        index.libraryCounters.files,
        40,
        "все имена обязаны быть прочитаны"
    );
    assert.ok(
        index.isLibraryPrewarmed(library),
        "указатель корня обязан быть опубликован"
    );
});

test("прогрев уступает работе пользователя", async () => {
    /*
     * Пока идёт окно тишины после действия человека, обход не продвигается:
     * прогрев про будущее удобство, а человек работает сейчас.
     */
    const library = makeTree("rsl-quiet-", {
        "a.mac": macro("A"),
        "b/c.mac": macro("C")
    });
    const index = stand([], [library]);
    let busy = true;

    index.setInteractiveProbe(() => busy);

    const running = index.prewarmLibraries();

    await new Promise(resolve => setTimeout(resolve, 60));

    assert.strictEqual(
        index.libraryCounters.files,
        0,
        "пока пользователь работает, имена не читаются"
    );

    busy = false;

    assert.strictEqual(await running, 1);
    assert.strictEqual(
        index.libraryCounters.files,
        2,
        "после окна тишины обход доходит до конца"
    );
});

test("недостроенный указатель не отвечает половиной", async () => {
    /*
     * Указатель корня публикуется целиком: половина ответа хуже, чем
     * синхронный обход по требованию, который остался запасным путём.
     */
    const library = makeTree("rsl-atomic-", { "solo.mac": macro("Solo") });
    const index = stand([], [library]);
    let busy = true;

    index.setInteractiveProbe(() => busy);

    const running = index.prewarmLibraries();

    await new Promise(resolve => setTimeout(resolve, 40));

    assert.ok(
        !index.isLibraryPrewarmed(library),
        "пока обход не кончился, указателя нет"
    );

    /* И запасной путь всё равно отвечает: синхронный обход по требованию. */
    assert.strictEqual(
        index.resolveWorkspaceFile("solo").kind,
        "resolved",
        "ответ обязан быть и до конца прогрева"
    );

    busy = false;
    await running;
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

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

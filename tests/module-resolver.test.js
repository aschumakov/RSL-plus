"use strict";

/**
 * Единое разрешение имени модуля в файл проекта.
 *
 * Разрешением занимались двое, и они разошлись по поведению. Каталог проекта
 * отвечал по составу, собранному обходом, и честно сообщал о неоднозначности.
 * Переход к определению, не дождавшись каталога, обходил диск сам — своим
 * списком исключаемых каталогов, своей нормализацией имени и своим правилом
 * выбора: первый подошедший файл.
 *
 * Отсюда главное, что здесь проверяется: ответ не зависит от того, успел ли
 * построиться каталог. Всё остальное — следствия того же расхождения.
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
    WorkspaceModuleResolver,
    RSL_EXCLUDED_DIRECTORIES,
    isExcludedRslDirectory,
    resolveRslWorkspaceRoots
} = require("../server/out/indexing/workspaceModuleResolver");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const SOURCE = "Macro Helper()\n  return 1;\nEnd;\n";

function scratch(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTree(directory) {
    fs.rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 25
    });
}

/** Кладёт файл, создавая каталоги по пути. */
function put(root, relative, text = SOURCE) {
    const file = path.join(root, relative.replace(/\//g, path.sep));

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");

    return file;
}

/**
 * Стенд: проект на диске, индекс и resolver над ним.
 *
 * Каталог наполняется по требованию: `discover()` повторяет то, что делает
 * фоновый обход, и только после него каталог считается построенным. До этого
 * resolver обязан отвечать так же — этим и отличается вся проверка.
 */
function stand(files, options = {}) {
    const directory = scratch("rsl-module-resolver-");
    const paths = new Map();

    for (const [relative, text] of Object.entries(files)) {
        paths.set(relative, put(directory, relative, text));
    }

    const index = new WorkspaceIndex();
    let reads = 0;
    const resolver = new WorkspaceModuleResolver({
        catalog: {
            resolveWorkspaceFile: name => index.resolveWorkspaceFile(name),
            registerWorkspaceFile: uri => index.registerWorkspaceFile(uri),
            workspaceFilesReady: () => index.workspaceFilesReady
        },
        roots: () => [options.root || directory],
        log: () => undefined
    });

    /* Обход проекта: тот же список исключений, что у настоящего. */
    function collect(from, found = []) {
        for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
            const full = path.join(from, entry.name);

            if (entry.isDirectory()) {
                if (!isExcludedRslDirectory(entry.name)) {
                    collect(full, found);
                }
            } else if (/\.mac$/iu.test(entry.name)) {
                found.push(pathToFileURL(full).toString());
            }
        }

        return found;
    }

    return {
        directory,
        index,
        resolver,
        uriOf: relative => pathToFileURL(paths.get(relative)).toString(),
        pathOf: relative => paths.get(relative),
        /** Отмечает завершённый обход: каталог полон. */
        discover() {
            index.registerWorkspaceFiles(collect(directory));
        },
        countReads() {
            return reads;
        },
        /** Считает обращения к диску: по ним видно повторный обход. */
        watchDisk() {
            const original = fs.promises.readdir;

            fs.promises.readdir = function (target, ...rest) {
                if (String(target).startsWith(directory)) {
                    reads++;
                }

                return original.call(this, target, ...rest);
            };

            return () => {
                fs.promises.readdir = original;
            };
        },
        dispose() {
            removeTree(directory);
        }
    };
}

test("1. обычный и строковый Import разрешаются одинаково", async () => {
    const board = stand({ "lib/helper.mac": SOURCE });

    try {
        for (const written of ["helper", "helper.mac", "lib/helper.mac"]) {
            const resolution = await board.resolver.resolve(written);

            assert.strictEqual(
                resolution.kind,
                "resolved",
                written + ": обязано разрешиться"
            );
            assert.strictEqual(
                resolution.value,
                board.uriOf("lib/helper.mac"),
                written + ": обязано вести в тот же файл"
            );
        }
    } finally {
        board.dispose();
    }
});

test("2. ответ до и после построения каталога одинаков", async () => {
    const before = stand({ "lib/helper.mac": SOURCE });
    const after = stand({ "lib/helper.mac": SOURCE });

    try {
        /* Каталог пуст: отвечает адресный поиск. */
        const early = await before.resolver.resolve("helper");

        after.discover();

        /* Каталог построен: отвечает он. */
        const late = await after.resolver.resolve("helper");

        assert.strictEqual(early.kind, late.kind, "вид ответа обязан совпасть");
        assert.strictEqual(
            early.value,
            before.uriOf("lib/helper.mac"),
            "до каталога обязан вести в свой lib/helper.mac"
        );
        assert.strictEqual(
            late.value,
            after.uriOf("lib/helper.mac"),
            "после каталога — в свой, тот же по расположению"
        );
    } finally {
        before.dispose();
        after.dispose();
    }
});

test("3. два одноимённых файла: оба и в устойчивом порядке", async () => {
    const board = stand({
        "zeta/helper.mac": SOURCE,
        "alpha/helper.mac": SOURCE
    });

    try {
        const early = await board.resolver.resolve("helper");

        assert.strictEqual(
            early.kind,
            "ambiguous",
            "молча выбирать первый нельзя: " + JSON.stringify(early)
        );
        assert.deepStrictEqual(
            early.candidates,
            [board.uriOf("alpha/helper.mac"), board.uriOf("zeta/helper.mac")],
            "порядок обязан быть по пути, а не по порядку обхода"
        );

        /* И после построения каталога — тот же ответ и тот же порядок. */
        board.discover();

        const late = await board.resolver.resolve("helper");

        assert.deepStrictEqual(
            late.candidates,
            early.candidates,
            "каталог обязан отвечать так же, как адресный поиск"
        );
    } finally {
        board.dispose();
    }
});

test("4. sub/lib.mac выбирает точное совпадение", async () => {
    const board = stand({
        "sub/lib.mac": SOURCE,
        "other/lib.mac": SOURCE
    });

    try {
        for (const written of ["sub/lib.mac", "sub\\lib.mac", "sub/lib"]) {
            const resolution = await board.resolver.resolve(written);

            assert.strictEqual(
                resolution.kind,
                "resolved",
                written + ": точное совпадение обязано снять неоднозначность"
            );
            assert.strictEqual(
                resolution.value,
                board.uriOf("sub/lib.mac"),
                written + ": обязано вести в sub/lib.mac"
            );
        }

        /* Без пути имя по-прежнему неоднозначно. */
        assert.strictEqual(
            (await board.resolver.resolve("lib")).kind,
            "ambiguous",
            "без пути выбирать за человека нельзя"
        );
    } finally {
        board.dispose();
    }
});

test("5. исключаемые каталоги одинаковы на обоих путях", async () => {
    const hidden = {};

    for (const name of RSL_EXCLUDED_DIRECTORIES) {
        hidden[name + "/buried.mac"] = SOURCE;
    }

    const board = stand(hidden);

    try {
        /* Адресный поиск: каталог ещё пуст. */
        const early = await board.resolver.resolve("buried");

        assert.strictEqual(
            early.kind,
            "missing",
            "файл в исключённом каталоге не должен находиться: " +
            JSON.stringify(early)
        );

        /* Обход проекта: тот же список исключений. */
        board.discover();

        assert.strictEqual(
            (await board.resolver.resolve("buried")).kind,
            "missing",
            "каталог проекта обязан исключать те же каталоги"
        );
    } finally {
        board.dispose();
    }
});

test("6. URI перехода совпадает с зарегистрированным побайтно", async () => {
    const board = stand({ "lib/Helper.mac": SOURCE });

    try {
        board.discover();

        const registered = board.index.getWorkspaceFiles
            ? board.index.getWorkspaceFiles()
            : undefined;
        const resolution = await board.resolver.resolve("helper");

        assert.strictEqual(resolution.kind, "resolved");
        assert.strictEqual(
            resolution.value,
            board.uriOf("lib/Helper.mac"),
            "URI обязан быть тем же, что зарегистрирован за файлом"
        );

        if (registered) {
            assert.ok(
                registered.includes(resolution.value),
                "и обязан присутствовать в составе проекта"
            );
        }
    } finally {
        board.dispose();
    }
});

test("7. регистр корня сохраняется", () => {
    const directory = scratch("RSL-Case-Root-");

    try {
        const roots = resolveRslWorkspaceRoots({
            workspaceFolders: [
                { uri: pathToFileURL(directory).toString(), name: "root" }
            ]
        });

        assert.deepStrictEqual(
            roots,
            [path.resolve(directory)],
            "корень обязан остаться в исходном регистре"
        );

        /* Один и тот же корень в разном регистре — по-прежнему один. */
        const twice = resolveRslWorkspaceRoots({
            workspaceFolders: [
                { uri: pathToFileURL(directory).toString(), name: "a" },
                {
                    uri: pathToFileURL(directory.toLowerCase()).toString(),
                    name: "b"
                }
            ]
        });

        assert.strictEqual(
            twice.length,
            process.platform === "win32" ? 1 : 2,
            "одинаковость корней проверяется без учёта регистра на Windows"
        );
    } finally {
        removeTree(directory);
    }
});

test("8. созданный файл превращает missing в resolved", async () => {
    const board = stand({ "lib/other.mac": SOURCE });

    try {
        assert.strictEqual(
            (await board.resolver.resolve("late")).kind,
            "missing",
            "файла ещё нет"
        );

        put(board.directory, "lib/late.mac");
        board.resolver.invalidate();

        const found = await board.resolver.resolve("late");

        assert.strictEqual(
            found.kind,
            "resolved",
            "после создания файл обязан находиться"
        );
        assert.ok(
            found.value.toLowerCase().endsWith("lib/late.mac"),
            "и вести именно в него: " + found.value
        );
    } finally {
        board.dispose();
    }
});

test("9. удалённый файл больше не возвращается", async () => {
    const board = stand({ "lib/gone.mac": SOURCE });

    try {
        board.discover();

        assert.strictEqual(
            (await board.resolver.resolve("gone")).kind,
            "resolved",
            "пока файл есть, он находится"
        );

        fs.rmSync(board.pathOf("lib/gone.mac"));
        board.index.unregisterWorkspaceFile(board.uriOf("lib/gone.mac"));
        board.resolver.invalidate();

        assert.strictEqual(
            (await board.resolver.resolve("gone")).kind,
            "missing",
            "удалённый файл возвращать нельзя"
        );
    } finally {
        board.dispose();
    }
});

test("10. после построения каталога переход не обходит диск", async () => {
    const board = stand({ "lib/helper.mac": SOURCE });

    try {
        board.discover();

        const restore = board.watchDisk();

        try {
            /* Существующее имя: отвечает каталог. */
            await board.resolver.resolve("helper");
            /* И несуществующее: раньше именно оно запускало полный обход. */
            await board.resolver.resolve("nosuchmodule");
            await board.resolver.resolve("nosuchmodule");
        } finally {
            restore();
        }

        assert.strictEqual(
            board.countReads(),
            0,
            "после построения каталога переход обязан отвечать без обхода; " +
            "обращений к диску: " + board.countReads()
        );
    } finally {
        board.dispose();
    }
});

/**
 * Задержать обход диска и дать вмешаться в проект посередине.
 *
 * Обход идёт асинхронно и живёт дольше события наблюдателя за файлами. Без
 * поколения он доводил до конца работу, начатую по прежнему составу проекта.
 */
async function withSlowScan(inside, onRead, action) {
    const original = fs.promises.readdir;
    let done = false;

    fs.promises.readdir = async function (target, ...rest) {
        const listing = await original.call(this, target, ...rest);

        /*
         * Вмешательство после чтения каталога с файлами, а не корня.
         *
         * Если править проект до того, как обход добрался до нужного каталога,
         * он просто увидит новое состояние — и проверка пройдёт даже без
         * поколения, ничего не проверив.
         */
        if (!done && String(target).replace(/\\/gu, "/").endsWith("/lib")) {
            done = true;
            await onRead();
        }

        return listing;
    };

    try {
        return await action();
    } finally {
        fs.promises.readdir = original;
    }
}

test("11. файл, удалённый во время обхода, не возвращается", async () => {
    const board = stand({ "lib/doomed.mac": SOURCE });

    try {
        const answer = await withSlowScan(
            board.directory,
            async () => {
                /* Пока обход идёт, файл удаляют и сообщают об этом. */
                fs.rmSync(board.pathOf("lib/doomed.mac"));
                board.resolver.invalidate();
            },
            () => board.resolver.resolve("doomed")
        );

        assert.strictEqual(
            answer.kind,
            "missing",
            "обход не имеет права оживить удалённый файл: " +
            JSON.stringify(answer)
        );

        /* И в каталоге его тоже не должно остаться. */
        assert.strictEqual(
            board.index.resolveWorkspaceFile("doomed").kind,
            "missing",
            "удалённый файл не должен попасть в каталог задним числом"
        );
    } finally {
        board.dispose();
    }
});

test("12. файл, созданный во время обхода, потом находится", async () => {
    const board = stand({ "lib/other.mac": SOURCE });

    try {
        const answer = await withSlowScan(
            board.directory,
            async () => {
                /* Пока обход ищет и не находит, файл появляется. */
                put(board.directory, "lib/fresh.mac");
                board.resolver.invalidate();
            },
            () => board.resolver.resolve("fresh")
        );

        /*
         * Ответ этого запроса может быть любым: файла на момент начала обхода
         * не было. Важно, что «такого нет» не запомнилось — иначе файл остался
         * бы невидимым до конца сеанса.
         */
        const next = await board.resolver.resolve("fresh");

        assert.strictEqual(
            next.kind,
            "resolved",
            "созданный во время обхода файл обязан найтись следующим запросом; " +
            "первый ответ был " + JSON.stringify(answer)
        );
    } finally {
        board.dispose();
    }
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

    console.log(
        failed === 0
            ? "\nПройдено: " + passed
            : "\nПройдено: " + passed + ", провалено: " + failed
    );

    if (failed > 0) {
        process.exitCode = 1;
    }
})();

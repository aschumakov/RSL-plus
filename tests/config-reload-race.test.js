"use strict";

/**
 * Смена области поиска не создаёт окна со старым каталогом.
 *
 * Политика обновлялась сразу, а состав проекта оставался прежним — собранным
 * по прежним правилам — и по-прежнему считался готовым. Адресный поиск сначала
 * смотрит в каталог, поэтому в промежутке между правкой настройки и концом
 * нового обхода:
 *
 *   уже исключённый файл продолжал разрешаться;
 *   файл из добавленного корня считался отсутствующим.
 *
 * Ответ зависел от того, успел ли закончиться обход. Здесь проверяется, что не
 * зависит.
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

const {
    WorkspaceFileDiscoveryService
} = require("../server/out/indexing/workspaceFileDiscoveryService");
const {
    WorkspaceModuleResolver
} = require("../server/out/indexing/workspaceModuleResolver");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

function workspace(files) {
    const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "rsl-race-"))
    );

    for (const [relative, text] of Object.entries(files)) {
        const full = path.join(root, relative);

        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, text);
    }

    return {
        root,
        write: (relative, text) => {
            const full = path.join(root, relative);

            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, text);
        },
        dispose: () => fs.rmSync(root, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 25
        })
    };
}

/**
 * Сервер в миниатюре: обход, индекс и адресный поиск, связанные как в server.ts.
 *
 * Сам обход не запускается по таймеру — его вызывают руками, чтобы поймать
 * промежуточное состояние между сменой политики и концом обхода.
 */
/**
 * Созданные службы обхода.
 *
 * Каждая держит отложенный таймер, и без остановки процесс теста не
 * завершится вовсе.
 */
const services = [];

function board(root) {
    const index = new WorkspaceIndex();
    const discovery = new WorkspaceFileDiscoveryService({
        log: () => undefined,
        onFiles: uris => index.registerWorkspaceFiles(uris),
        initialDelayMs: 1000000
    });

    discovery.configure({
        workspaceFolders: [
            { uri: pathToFileURL(root).toString(), name: "test" }
        ]
    });

    const resolver = new WorkspaceModuleResolver({
        catalog: {
            resolveWorkspaceFile: name => index.resolveWorkspaceFile(name),
            registerWorkspaceFile: uri => index.registerWorkspaceFile(uri),
            workspaceFilesReady: () => index.workspaceFilesReady
        },
        roots: () => discovery.rootPaths(),
        isExcluded: full => discovery.searchPolicy().isExcluded(full),
        log: () => undefined
    });

    /** Обход, как если бы он прошёл: состав собирается по текущей политике. */
    const runDiscovery = () => {
        const found = [];
        const walk = directory => {
            for (const entry of fs.readdirSync(directory, {
                withFileTypes: true
            })) {
                const full = path.join(directory, entry.name);

                if (discovery.searchPolicy().isExcluded(full)) {
                    continue;
                }

                if (entry.isDirectory()) {
                    walk(full);
                } else if (/\.mac$/iu.test(entry.name)) {
                    found.push(pathToFileURL(full).toString());
                }
            }
        };

        for (const item of discovery.rootPaths()) {
            if (fs.existsSync(item)) {
                walk(item);
            }
        }

        index.registerWorkspaceFiles(found);
    };

    /** То, что делает сервер по правке настройки. */
    const reload = () => {
        if (discovery.reloadProjectConfig()) {
            index.resetWorkspaceFiles();
            resolver.invalidate();

            return true;
        }

        return false;
    };

    services.push(discovery);

    return { index, discovery, resolver, runDiscovery, reload };
}

const CONFIG = ".rslplus.json";

test("смена moduleRoots не оставляет старый каталог авторитетным", async () => {
    const stand = workspace({
        "old/lib.mac": "Macro Old()\nEnd;\n",
        "new/lib.mac": "Macro New()\nEnd;\n"
    });

    try {
        stand.write(CONFIG, JSON.stringify({ moduleRoots: ["old"] }));

        const kit = board(stand.root);

        kit.runDiscovery();

        const before = await kit.resolver.resolve("lib");

        assert.strictEqual(before.kind, "resolved");
        assert.ok(
            before.value.toLowerCase().includes("/old/"),
            "пока корень old, находится он: " + before.value
        );

        /* Настройка изменилась, нового обхода ЕЩЁ НЕ БЫЛО. */
        stand.write(CONFIG, JSON.stringify({ moduleRoots: ["new"] }));
        assert.strictEqual(kit.reload(), true);

        const between = await kit.resolver.resolve("lib");

        assert.strictEqual(
            between.kind,
            "resolved",
            "новый корень доступен и до обхода: адресный поиск идёт по диску"
        );
        assert.ok(
            between.value.toLowerCase().includes("/new/"),
            "старый файл больше не авторитетен: " + between.value
        );

        /* И после обхода ответ тот же. */
        kit.runDiscovery();

        const after = await kit.resolver.resolve("lib");

        assert.strictEqual(
            after.value.toLowerCase(),
            between.value.toLowerCase(),
            "ответ не зависит от того, успел ли закончиться обход"
        );
    } finally {
        stand.dispose();
    }
});

test("новое исключение действует до конца обхода", async () => {
    const stand = workspace({ "legacy/lib.mac": "Macro Old()\nEnd;\n" });

    try {
        const kit = board(stand.root);

        kit.runDiscovery();

        assert.strictEqual(
            (await kit.resolver.resolve("lib")).kind,
            "resolved",
            "пока исключений нет, файл находится"
        );

        stand.write(CONFIG, JSON.stringify({ exclude: ["legacy/**"] }));
        assert.strictEqual(kit.reload(), true);

        assert.strictEqual(
            (await kit.resolver.resolve("lib")).kind,
            "missing",
            "исключённый файл не должен находиться и до нового обхода"
        );

        kit.runDiscovery();

        assert.strictEqual(
            (await kit.resolver.resolve("lib")).kind,
            "missing",
            "и после обхода тоже"
        );
    } finally {
        stand.dispose();
    }
});

test("состав считается неготовым до нового обхода", () => {
    const stand = workspace({ "old/lib.mac": "Macro Old()\nEnd;\n" });

    try {
        stand.write(CONFIG, JSON.stringify({ moduleRoots: ["old"] }));

        const kit = board(stand.root);

        kit.runDiscovery();
        assert.strictEqual(kit.index.workspaceFilesReady, true);

        stand.write(CONFIG, JSON.stringify({ moduleRoots: ["new"] }));
        kit.reload();

        assert.strictEqual(
            kit.index.workspaceFilesReady,
            false,
            "каталог собран по прежним правилам: верить ему нельзя"
        );

        kit.runDiscovery();
        assert.strictEqual(kit.index.workspaceFilesReady, true);
    } finally {
        stand.dispose();
    }
});

test("добавленная папка получает moduleRoots", () => {
    const first = workspace({ "macro/one.mac": "Macro One()\nEnd;\n" });
    const second = workspace({ "macro/two.mac": "Macro Two()\nEnd;\n" });

    try {
        first.write(CONFIG, JSON.stringify({ moduleRoots: ["macro"] }));

        const kit = board(first.root);

        assert.deepStrictEqual(
            kit.discovery.rootPaths().map(item => path.basename(item)),
            ["macro"]
        );

        kit.discovery.updateWorkspaceFolders(
            [{ uri: pathToFileURL(second.root).toString(), name: "second" }],
            []
        );

        const roots = kit.discovery.rootPaths();

        assert.strictEqual(
            roots.length,
            2,
            "moduleRoots применяются и к добавленной папке: " +
            JSON.stringify(roots)
        );
        assert.ok(
            roots.every(item => path.basename(item) === "macro"),
            "оба корня — macro внутри своей папки"
        );
    } finally {
        first.dispose();
        second.dispose();
    }
});

test("удалённая папка перестаёт обходиться", async () => {
    const first = workspace({ "lib.mac": "Macro One()\nEnd;\n" });
    const second = workspace({ "other.mac": "Macro Two()\nEnd;\n" });

    try {
        const kit = board(first.root);

        kit.discovery.updateWorkspaceFolders(
            [{ uri: pathToFileURL(second.root).toString(), name: "second" }],
            []
        );
        kit.runDiscovery();

        assert.strictEqual(
            (await kit.resolver.resolve("lib")).kind,
            "resolved"
        );

        kit.discovery.updateWorkspaceFolders(
            [],
            [{ uri: pathToFileURL(first.root).toString(), name: "first" }]
        );
        kit.index.resetWorkspaceFiles();
        kit.resolver.invalidate();
        kit.runDiscovery();

        assert.strictEqual(
            (await kit.resolver.resolve("lib")).kind,
            "missing",
            "папки в проекте больше нет"
        );
        assert.strictEqual(
            (await kit.resolver.resolve("other")).kind,
            "resolved",
            "оставшаяся папка по-прежнему видна"
        );
    } finally {
        first.dispose();
        second.dispose();
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

    for (const service of services) {
        service.dispose();
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

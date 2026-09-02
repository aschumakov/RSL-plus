"use strict";

/**
 * Правка `.rslplus.json` действует без перезапуска редактора.
 *
 * Настройка задаёт область поиска модулей. Требовать ради её правки
 * перезапуска — значит заставлять пользователя гадать, почему изменение не
 * подействовало.
 *
 * Работа при этом отложенная: сам обход состава встаёт в обычную очередь и
 * уступает правке. Здесь проверяется, что политика обновилась и что
 * бессмысленной работы не запускается — сохранение файла без изменений не
 * должно перестраивать проект.
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

let passed = 0;
let failed = 0;

function test(name, action) {
    try {
        action();
        passed++;
        console.log("[OK] " + name);
    } catch (error) {
        failed++;
        console.error("[FAIL] " + name);
        console.error(error);
    }
}

/** Каталог проекта на диске. */
function workspace(files) {
    const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "rsl-reload-"))
    );

    for (const [relative, text] of Object.entries(files)) {
        const full = path.join(root, relative);

        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, text);
    }

    return {
        root,
        write: (relative, text) =>
            fs.writeFileSync(path.join(root, relative), text),
        dispose: () => fs.rmSync(root, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 25
        })
    };
}

/** Обход, настроенный на этот корень; сам обход не запускается. */
function discovery(root) {
    const service = new WorkspaceFileDiscoveryService({
        log: () => undefined,
        onFiles: () => undefined,
        /* Обход отложен настолько, что в тесте не начнётся. */
        initialDelayMs: 1000000
    });

    service.configure({
        workspaceFolders: [
            { uri: pathToFileURL(root).toString(), name: "test" }
        ]
    });

    return service;
}

const CONFIG = ".rslplus.json";

test("новая настройка меняет корни поиска", () => {
    const board = workspace({
        "macro/lib.mac": "Macro Lib()\nEnd;\n",
        "other/lib.mac": "Macro Lib()\nEnd;\n"
    });

    try {
        const service = discovery(board.root);

        assert.deepStrictEqual(
            service.rootPaths().map(item => path.basename(item)),
            [path.basename(board.root)],
            "без настройки корень один — сам проект"
        );

        board.write(CONFIG, JSON.stringify({ moduleRoots: ["macro"] }));

        assert.strictEqual(
            service.reloadProjectConfig(),
            true,
            "политика изменилась"
        );
        assert.deepStrictEqual(
            service.rootPaths().map(item => path.basename(item)),
            ["macro"],
            "и корни стали теми, что названы"
        );

        service.dispose();
    } finally {
        board.dispose();
    }
});

test("исключения тоже обновляются", () => {
    const board = workspace({ "legacy/lib.mac": "Macro Lib()\nEnd;\n" });

    try {
        const service = discovery(board.root);
        const victim = path.join(board.root, "legacy", "lib.mac");

        assert.ok(!service.searchPolicy().isExcluded(victim));

        board.write(CONFIG, JSON.stringify({ exclude: ["legacy/**"] }));

        assert.strictEqual(
            service.reloadProjectConfig(),
            true,
            "изменились только исключения, но это изменение по существу"
        );

        assert.ok(
            service.searchPolicy().isExcluded(victim),
            "правка настройки обязана подействовать сразу"
        );

        service.dispose();
    } finally {
        board.dispose();
    }
});

test("сохранение без изменений ничего не перестраивает", () => {
    const board = workspace({ "macro/lib.mac": "Macro Lib()\nEnd;\n" });

    try {
        board.write(CONFIG, JSON.stringify({ moduleRoots: ["macro"] }));

        const service = discovery(board.root);

        /* Тот же текст: политика та же, работы быть не должно. */
        board.write(CONFIG, JSON.stringify({ moduleRoots: ["macro"] }));

        assert.strictEqual(
            service.reloadProjectConfig(),
            false,
            "перестраивать проект из-за сохранения без правок незачем"
        );

        service.dispose();
    } finally {
        board.dispose();
    }
});

test("удаление настройки возвращает прежнее поведение", () => {
    const board = workspace({ "macro/lib.mac": "Macro Lib()\nEnd;\n" });

    try {
        board.write(CONFIG, JSON.stringify({ moduleRoots: ["macro"] }));

        const service = discovery(board.root);

        assert.deepStrictEqual(
            service.rootPaths().map(item => path.basename(item)),
            ["macro"]
        );

        fs.rmSync(path.join(board.root, CONFIG));

        assert.strictEqual(service.reloadProjectConfig(), true);
        assert.deepStrictEqual(
            service.rootPaths().map(item => path.basename(item)),
            [path.basename(board.root)],
            "без файла настройки корни снова прежние"
        );

        service.dispose();
    } finally {
        board.dispose();
    }
});

test("сломанная настройка не рушит обход", () => {
    const board = workspace({ "macro/lib.mac": "Macro Lib()\nEnd;\n" });

    try {
        const service = discovery(board.root);

        board.write(CONFIG, "{ сломано");
        service.reloadProjectConfig();

        assert.deepStrictEqual(
            service.rootPaths().map(item => path.basename(item)),
            [path.basename(board.root)],
            "при негодном файле остаются умолчания, а не пустой список корней"
        );

        service.dispose();
    } finally {
        board.dispose();
    }
});

console.log(
    failed === 0
        ? "\nПройдено: " + passed
        : "\nПройдено: " + passed + ", провалено: " + failed
);

if (failed > 0) {
    process.exitCode = 1;
}

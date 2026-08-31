"use strict";

/**
 * Цепочка Import достраивается независимо от порядка фоновой индексации.
 *
 * Загрузчик выходил сразу, если модуль уже лежит в индексе, и его импорты
 * повторно не обходил. Из-за этого хватало такого совпадения: Deep прочитан
 * первым, потом B, потом A, и к моменту открытия Main предел внешних моделей
 * успел вытеснить Deep. Загрузчик видел B готовым, до Deep не доходил, и
 * Problems, Completion и разрешение имён зависели от того, в каком порядке
 * фон прочитал проект.
 */

const assert = require("assert");

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
    WorkspaceModuleLoader
} = require("../server/out/indexing/workspaceModuleLoader");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const MAIN = "file:///d:/chain/main.mac";
const A = "file:///d:/chain/a.mac";
const B = "file:///d:/chain/b.mac";
const DEEP = "file:///d:/chain/deep.mac";

/** Содержимое цепочки: Main → A → B → Deep. */
const SOURCES = {
    [MAIN]: { imports: ["a"], name: "Root" },
    [A]: { imports: ["b"], name: "FromA" },
    [B]: { imports: ["deep"], name: "FromB" },
    [DEEP]: { imports: [], name: "FromDeep" }
};

/**
 * Стенд загрузчика с поддельным сканером.
 *
 * Настоящий читает файлы в рабочем потоке; здесь состав известен заранее, а
 * проверяется не чтение, а то, до каких модулей загрузчик доходит.
 */
function createBoard(limit) {
    const index = new WorkspaceIndex({ maxExternalModules: limit });
    const read = [];
    const loader = new WorkspaceModuleLoader(index, {
        log: () => undefined,
        onModuleLoaded: () => undefined,
        onModuleCountChanged: () => undefined,
        compactModules: {
            index: async request => {
                const source = SOURCES[request.uri];

                read.push(request.uri);

                if (!source) {
                    return {
                        id: 0,
                        uri: request.uri,
                        generation: request.generation || 0,
                        status: "missing"
                    };
                }

                return {
                    id: 0,
                    uri: request.uri,
                    generation: request.generation || 0,
                    status: "indexed",
                    mtimeMs: 1,
                    size: 64,
                    fingerprint: "64:" + source.name,
                    sourceLength: 64,
                    declarations: [{
                        name: source.name,
                        kind: "macro",
                        visibility: "public",
                        line: 0,
                        character: 6,
                        children: []
                    }],
                    imports: source.imports,
                    fileReferences: [],
                    reused: false
                };
            }
        }
    });

    loader.registerWorkspaceFiles([MAIN, A, B, DEEP]);

    return { index, loader, read };
}

/**
 * Дождаться, пока загрузчик утихнет.
 *
 * Признака «очередь пуста» недостаточно: между двумя элементами загрузчик
 * ненадолго свободен, и проверка уходила дальше на середине цепочки. Ждём,
 * пока состав индекса и число чтений перестанут меняться.
 */
async function drain(board) {
    let stable = 0;
    let previous = "";

    for (let round = 0; round < 2000 && stable < 6; round++) {
        await new Promise(resolve => setImmediate(resolve));

        const now = board.index.size + ":" + board.read.length;

        if (now === previous) {
            stable++;
        } else {
            stable = 0;
            previous = now;
        }
    }
}

test("вытесненное звено цепочки догружается при открытии корня", async () => {
    /*
     * Предел 2: пока грузятся B и A, для Deep места не остаётся.
     */
    const board = createBoard(2);

    board.loader.enqueue(DEEP, "background");
    await drain(board);
    board.loader.enqueue(B, "background");
    await drain(board);
    board.loader.enqueue(A, "background");
    await drain(board);

    /*
     * Состояния «Deep вытеснен и забыт» здесь уже не увидеть: догрузка
     * цепочки восстанавливает его сама. Поэтому проверяется итог, а не
     * промежуточное состояние — а то, что проверка не пустая, показывает
     * снятие правки: без неё Deep до конца остаётся невидимым.
     */

    /* Открытие корневого документа: его цепочка обязана восстановиться. */
    board.index.updateOpenModule(
        MAIN,
        "Import a;\n\nMacro Run()\n  FromA();\nEnd;\n",
        1
    );
    board.loader.beginForegroundGeneration();
    board.loader.enqueue(A, "foreground");
    await drain(board);

    assert.ok(board.index.getModule(A), "прямая зависимость на месте");
    assert.ok(board.index.getModule(B), "и вторая тоже");
    assert.ok(
        board.index.getModule(DEEP),
        "вытесненное звено обязано догрузиться: " +
            "загрузчик не имеет права считать B готовым и остановиться"
    );
});

test("циклическая цепочка не зацикливает обход", async () => {
    const board = createBoard(8);

    /* Deep импортирует A: цикл A → B → Deep → A. */
    const original = SOURCES[DEEP].imports;

    SOURCES[DEEP].imports = ["a"];

    try {
        board.loader.enqueue(A, "background");
        await drain(board);

        assert.ok(board.index.getModule(A), "A загружен");
        assert.ok(board.index.getModule(B), "B загружен");
        assert.ok(board.index.getModule(DEEP), "Deep загружен");

        /* Повторный запрос по уже загруженному: обход обязан завершиться. */
        board.loader.enqueue(A, "background");
        await drain(board);

        assert.ok(board.index.getModule(DEEP), "цепочка на месте");
    } finally {
        SOURCES[DEEP].imports = original;
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

"use strict";

/**
 * Постоянный каталог проекта: полный Ctrl+T сразу после запуска.
 *
 * Каталог собирается фоновым обходом всего проекта — на проверенном проекте
 * это 6165 файлов и 104 МБ чтения. До конца обхода Ctrl+T, переход к
 * реализации и иерархия типов видят только прочитанное, и ответ на один и тот
 * же запрос в первые секунды меняется на глазах.
 *
 * Состав файлов сохраняется между запусками. Проверяется то, ради чего:
 * ответ полон сразу, обход читает только изменившееся, а всё, что разошлось с
 * диском, отбрасывается.
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
const { RslCatalogStore } = require("../server/out/indexing/catalogStore");
const {
    RslCatalogWarmupService
} = require("../server/out/indexing/catalogWarmupService");
const {
    extractCompactDeclarations
} = require("../server/out/analysis/declarationExtractor");
const {
    RslCatalogRestore
} = require("../server/out/indexing/catalogRestore");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const FILES = 12;

async function createProject() {
    const directory = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "rsl-catalog-store-")
    );
    const files = [];

    for (let number = 0; number < FILES; number++) {
        const file = path.join(directory, "mod" + number + ".mac");

        await fs.promises.writeFile(
            file,
            "Macro Symbol" + number + "(value)\n  return value;\nEnd;\n",
            "utf8"
        );
        files.push({ file, uri: pathToFileURL(file).toString() });
    }

    return { directory, files };
}

/** Обход проекта с сохранением состава: как на сервере. */
/**
 * Собрать записи, которые хранилище отдаёт при чтении.
 *
 * load больше не возвращает массив: состав идёт по одной записи и в памяти
 * хранилища не остаётся — второй экземпляр состава проекта стоил около 16 МиБ.
 */
async function loadRecords(store, uris) {
    const records = [];

    await store.load(uris, record => {
        records.push(record);
    });

    return records;
}

function createWarmup(project, store, reads) {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles(project.files.map(item => item.uri));

    const service = new RslCatalogWarmupService({
        index,
        store,
        budgetMs: 1000,
        pauseMs: 0,
        idleMs: 0,
        read: async uri => {
            reads.push(uri);

            const file = project.files.find(item => item.uri === uri);
            const source = await fs.promises.readFile(file.file, "utf8");
            const compact = extractCompactDeclarations(source);

            return {
                id: 1,
                uri,
                generation: 0,
                status: "indexed",
                mtimeMs: 0,
                fingerprint: String(source.length),
                sourceLength: source.length,
                declarations: compact.declarations,
                imports: compact.imports,
                fileReferences: [],
                reused: false
            };
        }
    });

    /*
     * Постановка в очередь — отдельным шагом.
     *
     * На сервере обход начинается только после того, как сохранённый состав
     * вернулся в каталог: иначе он прочитает файлы, состав которых уже
     * известен. Стенд повторяет этот порядок.
     */
    const start = () => service.add(project.files.map(item => item.uri));

    return { index, service, start };
}

/** Сколько символов проекта видит каталог. */
function symbolCount(index) {
    return index.catalog.stats.symbols;
}

test("сохранённый состав возвращается в каталог до обхода", async () => {
    const project = await createProject();
    const storeDirectory = path.join(project.directory, "store");

    try {
        /* Первый запуск: обход читает всё и сохраняет состав. */
        const firstStore = new RslCatalogStore({ buckets: 4, saveDebounceMs: 600_000 });

        firstStore.configurePersistence(storeDirectory);

        const firstReads = [];
        const first = createWarmup(project, firstStore, firstReads);

        first.start();
        await first.service.runToCompletion();
        await firstStore.flush();

        assert.strictEqual(
            firstReads.length,
            FILES,
            "первый запуск обязан прочитать все файлы"
        );

        const expected = symbolCount(first.index);

        assert.ok(expected >= FILES, "каталог собран: " + expected);

        /* Второй запуск: состав читается с диска до всякого обхода. */
        const secondStore = new RslCatalogStore({ buckets: 4, saveDebounceMs: 600_000 });

        secondStore.configurePersistence(storeDirectory);

        const secondReads = [];
        const second = createWarmup(project, secondStore, secondReads);
        const restored = await loadRecords(
            secondStore,
            project.files.map(item => item.uri)
        );

        for (const record of restored) {
            second.index.catalog.recordDeclarations({
                uri: record.uri,
                version: 0,
                declarations: record.declarations,
                imports: record.imports,
                fileReferences: new Set(record.fileReferences)
            });
        }

        assert.strictEqual(
            symbolCount(second.index),
            expected,
            "каталог обязан быть полным до начала обхода"
        );

        /*
         * Обход сверяет восстановленное — по одному чтению на файл.
         *
         * Прежде здесь стояло «не читает ничего», и это было ошибкой: у
         * восстановленной записи есть строковые ссылки, обход считал по ним
         * файл полностью известным и не ставил его в очередь. Сверка не
         * выполнялась ни разу, а символ из подменённого между запусками файла
         * оставался в Ctrl+T до конца сессии.
         */
        second.start();
        await second.service.runToCompletion();

        assert.strictEqual(
            secondReads.length,
            FILES,
            "обход обязан сверить каждый восстановленный файл"
        );
        assert.strictEqual(
            symbolCount(second.index),
            expected,
            "и каталог остался полным"
        );

        /*
         * Сверенное второй раз не читается: записи уже подтверждены.
         *
         * flush обязателен: обход зовёт запись, не дожидаясь её, и у
         * последних файлов она ещё не дошла до хранилища. На сервере между
         * обходами проходит куда больше времени, здесь его надо дождаться.
         */
        await secondStore.flush();
        secondReads.length = 0;
        second.service.add(project.files.map(item => item.uri));
        await second.service.runToCompletion();

        assert.deepStrictEqual(
            secondReads,
            [],
            "подтверждённые записи не перечитываются"
        );
    } finally {
        /*
         * Сохранение отложено таймером: без ожидания уборка сносит каталог
         * прямо под записью, и тест падает не на том, что проверяет.
         */
        await fs.promises.rm(project.directory, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 50
        });
    }
});

test("восстановленный каталог сверяется обходом в порядке сервера", async () => {
    /*
     * Точный порядок сервера: load → restore.add → warmup.add →
     * runToCompletion. Прежние проверки читали хранилище, но НЕ клали состав в
     * каталог, и потому не видели главного: у восстановленной записи есть
     * строковые ссылки, а обход считал по ним файл полностью известным и не
     * ставил его в очередь вовсе. Сверка «один раз за сессию» не выполнялась
     * ни разу, и символ из файла, изменённого между запусками, оставался в
     * Ctrl+T до конца сессии.
     */
    const project = await createProject();
    const storeDirectory = path.join(project.directory, "store");
    let next;

    try {
        const first = new RslCatalogStore({
            buckets: 4,
            saveDebounceMs: 600_000
        });

        first.configurePersistence(storeDirectory);

        const firstBoard = createWarmup(project, first, []);

        firstBoard.start();
        await firstBoard.service.runToCompletion();
        await first.flush();

        /* Файл подменён, пока сервер не работал. */
        const changed = project.files[3];

        await fs.promises.writeFile(
            changed.file,
            "Macro RenamedThree(value)\n  return value;\nEnd;\n",
            "utf8"
        );

        next = new RslCatalogStore({ buckets: 4, saveDebounceMs: 600_000 });

        next.configurePersistence(storeDirectory);

        const reads = [];
        const board = createWarmup(project, next, reads);
        const restore = new RslCatalogRestore(board.index.catalog, {
            isOpen: () => false
        });

        await next.load(
            project.files.map(item => item.uri),
            record => restore.add(record)
        );

        assert.strictEqual(
            restore.count,
            FILES,
            "каталог восстановлен целиком: он и нужен сразу"
        );
        assert.deepStrictEqual(
            board.index.catalog.modulesExporting("Symbol3"),
            [changed.uri],
            "до обхода в каталоге ещё прежний символ — так и задумано"
        );

        board.start();
        await board.service.runToCompletion();

        assert.deepStrictEqual(
            [...reads].sort(),
            project.files.map(item => item.uri).sort(),
            "обход обязан сверить каждый восстановленный файл"
        );
        assert.deepStrictEqual(
            board.index.catalog.modulesExporting("Symbol3"),
            [],
            "прежний символ обязан уйти из каталога"
        );
        assert.deepStrictEqual(
            board.index.catalog.modulesExporting("RenamedThree"),
            [changed.uri],
            "а новый — появиться"
        );
    } finally {
        await next?.flush?.();
        await fs.promises.rm(project.directory, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 25
        });
    }
});

test("изменившийся файл перечитывается, остальные — нет", async () => {
    const project = await createProject();
    const storeDirectory = path.join(project.directory, "store");

    try {
        const store = new RslCatalogStore({ buckets: 4, saveDebounceMs: 600_000 });

        store.configurePersistence(storeDirectory);

        const firstReads = [];

        const initial = createWarmup(project, store, firstReads);

        initial.start();
        await initial.service.runToCompletion();
        await store.flush();

        /* Один файл изменён на диске. */
        await fs.promises.writeFile(
            project.files[3].file,
            "Macro Renamed3(value)\n  return value;\nEnd;\n",
            "utf8"
        );

        const nextStore = new RslCatalogStore({ buckets: 4, saveDebounceMs: 600_000 });

        nextStore.configurePersistence(storeDirectory);
        await nextStore.load(project.files.map(item => item.uri));

        const reads = [];
        const next = createWarmup(project, nextStore, reads);

        next.start();
        await next.service.runToCompletion();

        /*
         * Первый обход после перезапуска читает проект целиком.
         *
         * Восстановленная запись неизменности не доказывает: дату и размер
         * сохраняют системы контроля версий, а правка одинаковой длины их не
         * меняет. Полный Ctrl+T от этого не страдает — каталог доступен сразу,
         * — а сверяет его этот обход, в рабочем потоке.
         */
        assert.deepStrictEqual(
            [...reads].sort(),
            project.files.map(item => item.uri).sort(),
            "первый обход после перезапуска сверяет все файлы"
        );

        /* Второй обход в той же сессии читает только изменившееся. */
        await fs.promises.writeFile(
            project.files[2].file,
            "Macro Renamed2(value)\n  return value;\nEnd;\n",
            "utf8"
        );

        const secondReads = [];
        const again = createWarmup(project, nextStore, secondReads);

        again.start();
        await again.service.runToCompletion();

        assert.deepStrictEqual(
            secondReads,
            [project.files[2].uri],
            "сверенные записи больше не перечитываются: " +
                secondReads.join(", ")
        );
    } finally {
        /*
         * Сохранение отложено таймером: без ожидания уборка сносит каталог
         * прямо под записью, и тест падает не на том, что проверяет.
         */
        await fs.promises.rm(project.directory, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 50
        });
    }
});

test("правка во время сохранения не теряется", async () => {
    /*
     * Пока корзина пишется, обход присылает более свежий состав того же файла.
     * Прежде flush снимал несохранённое безусловно: на диске оставалась
     * прежняя версия, в памяти — пусто, и никаких признаков незаконченной
     * работы. Следующий запуск возвращал старое.
     */
    const project = await createProject();
    const storeDirectory = path.join(project.directory, "store");
    const store = new RslCatalogStore({ buckets: 4, saveDebounceMs: 600_000 });

    store.configurePersistence(storeDirectory);

    const target = project.files[0];
    const declare = name => [{
        name,
        kind: "macro",
        visibility: "public",
        line: 0,
        character: 6,
        children: []
    }];

    /* Переименование задерживается: в эту щель и попадает вторая запись. */
    const originalRename = fs.promises.rename;
    let releaseRename = () => undefined;
    const renameReached = new Promise(resolve => {
        fs.promises.rename = async (...args) => {
            resolve();

            await new Promise(next => {
                releaseRename = next;
            });

            return originalRename(...args);
        };
    });

    try {
        await store.record(target.uri, declare("V1"), [], []);

        const saving = store.flush();

        await renameReached;

        /* Второй состав того же файла приходит посреди записи. */
        await store.record(target.uri, declare("V2"), [], []);

        releaseRename();
        await saving;

        fs.promises.rename = originalRename;

        assert.ok(
            store.stats.pendingDeclarations > 0,
            "свежая запись обязана остаться несохранённой, а не исчезнуть"
        );
        assert.ok(
            store.stats.dirtyBuckets > 0,
            "и её корзина обязана остаться в очереди на запись"
        );

        /* Досохранение и перезапуск: на диске обязана оказаться V2. */
        await store.flush();

        const restarted = new RslCatalogStore({
            buckets: 4,
            saveDebounceMs: 600_000
        });

        restarted.configurePersistence(storeDirectory);

        const records = await loadRecords(restarted, [target.uri]);

        assert.deepStrictEqual(
            records.map(item => item.declarations.map(one => one.name)),
            [["V2"]],
            "после перезапуска обязана вернуться свежая версия"
        );
    } finally {
        fs.promises.rename = originalRename;
        await store.flush();
        await fs.promises.rm(project.directory, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 25
        });
    }
});

test("удалённый файл не возвращается в каталог", async () => {
    const project = await createProject();
    const storeDirectory = path.join(project.directory, "store");

    try {
        const store = new RslCatalogStore({ buckets: 4, saveDebounceMs: 600_000 });

        store.configurePersistence(storeDirectory);
        const walk = createWarmup(project, store, []);

        walk.start();
        await walk.service.runToCompletion();
        await store.flush();

        /* Файла больше нет, и в проекте он не зарегистрирован. */
        await fs.promises.rm(project.files[0].file);

        const remaining = project.files.slice(1).map(item => item.uri);
        const nextStore = new RslCatalogStore({ buckets: 4, saveDebounceMs: 600_000 });

        nextStore.configurePersistence(storeDirectory);

        const restored = await loadRecords(nextStore, remaining);

        assert.strictEqual(
            restored.length,
            FILES - 1,
            "запись об удалённом файле не имеет права вернуться"
        );
        assert.ok(
            !restored.some(record => record.uri === project.files[0].uri),
            "и именно та самая запись"
        );
    } finally {
        /*
         * Сохранение отложено таймером: без ожидания уборка сносит каталог
         * прямо под записью, и тест падает не на том, что проверяет.
         */
        await fs.promises.rm(project.directory, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 50
        });
    }
});

test("повреждённая запись пропускается, а не роняет запуск", async () => {
    const project = await createProject();
    const storeDirectory = path.join(project.directory, "store");

    try {
        const store = new RslCatalogStore({ buckets: 4, saveDebounceMs: 600_000 });

        store.configurePersistence(storeDirectory);
        const walk = createWarmup(project, store, []);

        walk.start();
        await walk.service.runToCompletion();
        await store.flush();

        /* Одна корзина испорчена: обрыв записи, выключение машины. */
        const buckets = (await fs.promises.readdir(storeDirectory))
            .filter(name => name.endsWith(".json"));

        assert.ok(buckets.length > 0, "корзины обязаны быть записаны");
        await fs.promises.writeFile(
            path.join(storeDirectory, buckets[0]),
            "{\"version\": 1, \"files\": [",
            "utf8"
        );

        const nextStore = new RslCatalogStore({
            buckets: 4,
            saveDebounceMs: 600_000,
            log: () => undefined
        });

        nextStore.configurePersistence(storeDirectory);

        const restored = await loadRecords(
            nextStore,
            project.files.map(item => item.uri)
        );

        assert.ok(
            restored.length > 0 && restored.length < FILES,
            "целые корзины обязаны прочитаться, порченая — нет: " +
                restored.length
        );
    } finally {
        /*
         * Сохранение отложено таймером: без ожидания уборка сносит каталог
         * прямо под записью, и тест падает не на том, что проверяет.
         */
        await fs.promises.rm(project.directory, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 50
        });
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

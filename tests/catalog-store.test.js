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

        /* И обход не читает ничего: файлы не менялись. */
        second.start();
        await second.service.runToCompletion();

        assert.strictEqual(
            secondReads.length,
            0,
            "неизменившиеся файлы не читаются: прочитано " + secondReads.length
        );
        /*
         * Файлы не просто не читаются — они и в очередь не попадают: обход
         * достраивает каталог, а достраивать в нём нечего.
         */
        assert.strictEqual(
            second.service.progress.done,
            0,
            "обходу нечего делать: обработано " +
                second.service.progress.done
        );
        assert.strictEqual(
            symbolCount(second.index),
            expected,
            "и каталог остался полным"
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

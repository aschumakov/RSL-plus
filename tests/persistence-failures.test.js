"use strict";

/**
 * Сохранение при отказе диска и при наложении записей.
 *
 * Четыре хранилища — сохранённый состав проекта, записи о ссылках, индекс
 * References и кэш компактных сводок — сохраняются по одной схеме: очередь
 * изменений, отложенная запись, временный файл, rename. Схема повторена четыре
 * раза независимо, и разошлась именно на путях отказа:
 *
 *   записи о ссылках вычёркивали корзину из очереди до записи и не возвращали
 *   её ни при отказе mkdir, ни при отказе writeFile;
 *
 *   сохранённый состав возвращал корзину после отказа записи, но не после
 *   отказа mkdir;
 *
 *   кэш компактных сводок снимал признак «есть что писать» до записи, поэтому
 *   после отказа повторный flush считал, что работы нет;
 *
 *   индекс References и кэш сводок не разводили отложенную запись и явный
 *   flush: clearTimeout останавливает таймер, но не запись, которую тот уже
 *   начал, — и обе писали один временный файл.
 *
 * Ни один существующий тест этого не видел: все они пишут на исправный диск и
 * flush вызывают по одному. Потери рабочих данных здесь нет — теряется кэш, —
 * но потеря молчаливая: до конца сеанса на диске остаётся устаревший снимок.
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
    RslReferenceShardStore
} = require("../server/out/analysis/referenceShards");
const { RslCatalogStore } = require("../server/out/indexing/catalogStore");
const { ReferenceIndex } = require("../server/out/analysis/referenceIndex");
const {
    CompactModuleCache
} = require("../server/out/indexing/compactModuleCache");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

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

/**
 * Подмена одного метода fs.promises на время одного действия.
 *
 * Подменяется адресно — только для путей внутри каталога проверки, — чтобы
 * отказ не задел ни чтение исходников самой проверкой, ни соседние тесты.
 * Возврат исходного метода в finally: без него упавший тест ломал бы все
 * следующие.
 */
async function withFailure(method, inside, action) {
    const original = fs.promises[method];
    let calls = 0;

    fs.promises[method] = async function (target, ...rest) {
        if (String(target).startsWith(inside)) {
            calls++;

            const error = new Error("отказ диска для проверки: " + method);

            error.code = "EACCES";

            throw error;
        }

        return original.call(this, target, ...rest);
    };

    try {
        await action();
    } finally {
        fs.promises[method] = original;
    }

    return calls;
}

/** Счётчик одновременных записей: сколько их пересеклось во времени. */
async function withSlowWrite(inside, action) {
    const original = fs.promises.writeFile;
    let active = 0;
    let peak = 0;

    fs.promises.writeFile = async function (target, ...rest) {
        if (!String(target).startsWith(inside)) {
            return original.call(this, target, ...rest);
        }

        active++;
        peak = Math.max(peak, active);

        try {
            /* Запись длится дольше одного тика: иначе наложения не увидеть. */
            await new Promise(resolve => setTimeout(resolve, 20));

            return await original.call(this, target, ...rest);
        } finally {
            active--;
        }
    };

    try {
        await action();
    } finally {
        fs.promises.writeFile = original;
    }

    return peak;
}

const REFERENCE = {
    targetKey: "target",
    startLine: 0,
    startCharacter: 0,
    endLine: 0,
    endCharacter: 5,
    isDeclaration: false
};

/* ------------------------------ записи о ссылках ------------------------- */

async function shardCase(method) {
    const directory = scratch("rsl-shard-fail-");
    const shardsDirectory = path.join(directory, "shards");
    const store = new RslReferenceShardStore({
        log: () => undefined,
        buckets: 2,
        saveDebounceMs: 600_000
    });

    store.configurePersistence(shardsDirectory);

    try {
        const file = path.join(directory, "user.mac");
        const source = "Macro Use()\n  Shared();\nEnd;\n";

        await fs.promises.writeFile(file, source, "utf8");

        const uri = pathToFileURL(file).toString();

        await store.record(uri, "shared", [REFERENCE], source);

        /* Отказ на первом сохранении. */
        const calls = await withFailure(
            method,
            shardsDirectory,
            () => store.flush()
        );

        assert.ok(calls > 0, method + " обязан был вызваться");
        /*
         * Готовой корзины нет. Временный файл при отказе rename остаётся — он
         * и должен: следующая запись перезапишет его целиком.
         */
        assert.strictEqual(
            fs.existsSync(shardsDirectory) &&
                fs.readdirSync(shardsDirectory)
                    .some(name => name.startsWith("refs-") &&
                        name.endsWith(".json")),
            false,
            "после отказа готовой корзины на диске быть не должно"
        );

        /* Диск исправен — второй flush обязан записать то же самое. */
        await store.flush();

        const written = fs.readdirSync(shardsDirectory)
            .filter(name => name.startsWith("refs-") &&
                name.endsWith(".json"));

        assert.ok(
            written.length > 0,
            "после отказа " + method + " корзина обязана вернуться в очередь " +
            "и записаться следующим flush; в каталоге: " +
            fs.readdirSync(shardsDirectory).join(", ")
        );

        /* И записалось именно содержимое, а не пустая оболочка. */
        const payload = JSON.parse(
            fs.readFileSync(path.join(shardsDirectory, written[0]), "utf8")
        );

        assert.ok(
            payload.files.some(item => item.uri === uri),
            "в записанной корзине обязан быть наш файл"
        );
    } finally {
        removeTree(directory);
    }
}

test("записи о ссылках: отказ mkdir не теряет очередь", () =>
    shardCase("mkdir"));

test("записи о ссылках: отказ writeFile не теряет очередь", () =>
    shardCase("writeFile"));

test("записи о ссылках: отказ rename не теряет очередь", () =>
    shardCase("rename"));

/* --------------------------- сохранённый состав -------------------------- */

test("сохранённый состав: отказ mkdir не теряет очередь", async () => {
    const directory = scratch("rsl-catalog-fail-");
    const storeDirectory = path.join(directory, "store");
    const store = new RslCatalogStore({
        buckets: 2,
        saveDebounceMs: 600_000,
        log: () => undefined
    });

    store.configurePersistence(storeDirectory);

    try {
        /* Настоящий файл: запись берёт его дату и размер. */
        const file = path.join(directory, "main.mac");

        await fs.promises.writeFile(file, "Macro Run()\nEnd;\n", "utf8");

        const uri = pathToFileURL(file).toString();

        await store.record(
            uri,
            [
                {
                    name: "Run",
                    kind: 12,
                    line: 0,
                    character: 0,
                    endLine: 0,
                    endCharacter: 3
                }
            ],
            [],
            []
        );

        const calls = await withFailure(
            "mkdir",
            storeDirectory,
            () => store.flush()
        );

        assert.ok(calls > 0, "mkdir обязан был вызваться");

        await store.flush();

        assert.ok(
            fs.existsSync(storeDirectory) &&
                fs.readdirSync(storeDirectory).length > 0,
            "после отказа mkdir корзина обязана вернуться в очередь и " +
            "записаться следующим flush"
        );
    } finally {
        removeTree(directory);
    }
});

/* ------------------------- кэш компактных сводок ------------------------- */

function compactEntry(length) {
    return {
        fingerprint: String(length) + ":abc",
        mtimeMs: 1,
        sourceLength: length,
        snapshot: { declarations: [], imports: [], fileReferences: [] }
    };
}

test("кэш сводок: отказ записи не отменяет следующий flush", async () => {
    const directory = scratch("rsl-compact-fail-");
    const cacheFile = path.join(directory, "compact.json");
    const cache = new CompactModuleCache({ log: () => undefined });

    cache.configure(cacheFile);

    try {
        cache.set("file:///d:/project/main.mac", compactEntry(10));

        const calls = await withFailure(
            "writeFile",
            directory,
            () => cache.flush()
        );

        assert.ok(calls > 0, "writeFile обязан был вызваться");
        assert.strictEqual(
            fs.existsSync(cacheFile),
            false,
            "после отказа файла кэша быть не должно"
        );

        /*
         * Прежде здесь всё и терялось: dirty снимался до записи, и повторный
         * flush молча ничего не делал.
         */
        await cache.flush();

        assert.ok(
            fs.existsSync(cacheFile),
            "после отказа записи повторный flush обязан записать кэш"
        );

        const payload = JSON.parse(fs.readFileSync(cacheFile, "utf8"));

        assert.strictEqual(
            payload.entries.length,
            1,
            "и записать саму запись, а не пустую оболочку"
        );
    } finally {
        removeTree(directory);
    }
});

test("кэш сводок: правка во время записи не теряется", async () => {
    const directory = scratch("rsl-compact-race-");
    const cacheFile = path.join(directory, "compact.json");
    const cache = new CompactModuleCache({ log: () => undefined });

    cache.configure(cacheFile);

    try {
        cache.set("file:///d:/project/first.mac", compactEntry(10));

        const original = fs.promises.writeFile;
        let second = false;

        fs.promises.writeFile = async function (target, ...rest) {
            if (String(target).startsWith(directory) && !second) {
                second = true;
                /* Правка приходит, пока запись уже идёт. */
                cache.set("file:///d:/project/second.mac", compactEntry(20));
            }

            return original.call(this, target, ...rest);
        };

        try {
            await cache.flush();
        } finally {
            fs.promises.writeFile = original;
        }

        await cache.flush();

        const payload = JSON.parse(fs.readFileSync(cacheFile, "utf8"));

        assert.deepStrictEqual(
            payload.entries.map(item => item.uri).sort(),
            [
                "file:///d:/project/first.mac",
                "file:///d:/project/second.mac"
            ],
            "правка во время записи обязана попасть в следующий снимок"
        );
    } finally {
        removeTree(directory);
    }
});

/* --------------------------- наложение записей --------------------------- */

test("кэш сводок: отложенная запись и flush не пересекаются", async () => {
    const directory = scratch("rsl-compact-serial-");
    const cacheFile = path.join(directory, "compact.json");
    /* Пауза короткая: таймер обязан успеть сработать до flush. */
    const cache = new CompactModuleCache({ log: () => undefined });

    cache.configure(cacheFile);

    try {
        cache.set("file:///d:/project/main.mac", compactEntry(10));

        const peak = await withSlowWrite(directory, async () => {
            /* Две записи подряд, вторая — пока первая ещё идёт. */
            const first = cache.flush();

            cache.set("file:///d:/project/other.mac", compactEntry(20));

            const second = cache.flush();

            await Promise.all([first, second]);
        });

        assert.strictEqual(
            peak,
            1,
            "одновременных записей в один временный файл быть не должно"
        );
        assert.ok(fs.existsSync(cacheFile), "кэш обязан остаться на диске");
        JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    } finally {
        removeTree(directory);
    }
});

test("индекс References: отложенная запись и flush не пересекаются",
    async () => {
        const directory = scratch("rsl-refindex-serial-");
        const cacheFile = path.join(directory, "reference-index.json");
        const index = new ReferenceIndex({ log: () => undefined });

        index.configurePersistence(cacheFile);

        try {
            const uri = "file:///d:/project/main.mac";

            index.indexSource(uri, "Macro Run()\n  Shared();\nEnd;\n");

            const peak = await withSlowWrite(directory, async () => {
                const first = index.flush();

                index.indexSource(
                    "file:///d:/project/other.mac",
                    "Macro Other()\n  Shared();\nEnd;\n"
                );

                const second = index.flush();

                await Promise.all([first, second]);
            });

            assert.strictEqual(
                peak,
                1,
                "одновременных записей в один временный файл быть не должно"
            );
            assert.ok(
                fs.existsSync(cacheFile),
                "индекс обязан остаться на диске, а не быть удалён " +
                "вторым переименованием"
            );
            JSON.parse(fs.readFileSync(cacheFile, "utf8"));
        } finally {
            removeTree(directory);
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

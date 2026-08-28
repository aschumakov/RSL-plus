"use strict";

/**
 * Постоянные записи о ссылках: повторный поиск не перечитывает проект.
 *
 * Find All References для каждого файла-кандидата читает его с диска,
 * лексирует, разбирает и разрешает имена заново. На проверенном проекте
 * популярное имя даёт 2533 файла-кандидата на 66 МБ, и один только их разбор
 * стоит 4,2 секунды — при каждом запросе, сколько бы раз его ни повторили.
 *
 * Запись появляется тогда, когда файл всё равно пришлось разобрать, живёт до
 * его изменения и переживает перезапуск. Проверяется главное: тот же ответ,
 * но без чтения.
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
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { ReferenceIndex } = require("../server/out/analysis/referenceIndex");
const {
    RslReferenceShardStore
} = require("../server/out/analysis/referenceShards");
const {
    findRslReferencesInWorkspace
} = require("../server/out/analysis/references");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const LIBRARY = "Macro SharedHelper(value)\n  return value;\nEnd;\n";

/** Проект: библиотека и несколько её пользователей на диске. */
async function createProject(users = 6) {
    const directory = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "rsl-reference-shards-")
    );
    const libraryPath = path.join(directory, "library.mac");

    await fs.promises.writeFile(libraryPath, LIBRARY, "utf8");

    const userPaths = [];

    for (let number = 0; number < users; number++) {
        const file = path.join(directory, "user" + number + ".mac");

        await fs.promises.writeFile(
            file,
            "Import library;\n\nMacro Use" + number + "()\n" +
            "  SharedHelper(" + number + ");\n" +
            "  SharedHelper(" + number + " + 1);\nEnd;\n",
            "utf8"
        );
        userPaths.push(file);
    }

    return {
        directory,
        libraryUri: pathToFileURL(libraryPath).toString(),
        userPaths,
        userUris: userPaths.map(file => pathToFileURL(file).toString())
    };
}

/**
 * Стенд поиска: считает чтения файлов с диска.
 *
 * Именно их и должна снять запись, поэтому считаются они, а не время: время на
 * шести файлах ничего не покажет, а чтение видно точно.
 */
function createStand(project, shardDirectory) {
    const index = new WorkspaceIndex();
    const uris = [project.libraryUri, ...project.userUris];

    index.registerWorkspaceFiles(uris);
    index.updateOpenModule(project.libraryUri, LIBRARY, 1);

    const shards = new RslReferenceShardStore({
        log: () => undefined,
        buckets: 4
    });

    shards.configurePersistence(shardDirectory);

    const referenceIndex = new ReferenceIndex({ log: () => undefined });

    referenceIndex.retainWorkspaceFiles(uris);

    const original = fs.promises.readFile;
    const reads = { count: 0 };

    return {
        index,
        shards,
        reads,
        /** Поиск ссылок на SharedHelper из библиотеки. */
        async find() {
            const module = index.getModule(project.libraryUri);
            const offset = LIBRARY.indexOf("SharedHelper");

            reads.count = 0;
            fs.promises.readFile = (...args) => {
                /*
                 * Считаются только исходники: чтение самих записей — это и
                 * есть та работа, ради которой они заведены, и записывать её
                 * в расход бессмысленно.
                 */
                if (/\.mac$/iu.test(String(args[0]))) {
                    reads.count++;
                }

                return original(...args);
            };

            try {
                return await findRslReferencesInWorkspace(
                    index,
                    new RslScopeResolver(index),
                    referenceIndex,
                    module.uri,
                    offset,
                    false,
                    () => false,
                    shards
                );
            } finally {
                fs.promises.readFile = original;
            }
        }
    };
}

function signature(locations) {
    return locations
        .map(item =>
            item.uri + ":" + item.range.start.line + ":" +
            item.range.start.character)
        .sort();
}

test("повторный поиск не читает неизменившиеся файлы", async () => {
    const project = await createProject();
    const shardDirectory = path.join(project.directory, "shards");

    try {
        const stand = createStand(project, shardDirectory);
        const first = await stand.find();
        const firstReads = stand.reads.count;

        assert.ok(
            first.length >= 12,
            "две ссылки в каждом из шести файлов: найдено " + first.length
        );
        assert.ok(
            firstReads >= 6,
            "первый поиск обязан прочитать кандидатов: " + firstReads
        );

        const second = await stand.find();

        assert.deepStrictEqual(
            signature(second),
            signature(first),
            "ответ обязан совпасть до последней позиции"
        );
        assert.strictEqual(
            stand.reads.count,
            0,
            "повторный поиск не имеет права читать файлы: прочитано " +
                stand.reads.count
        );
    } finally {
        await fs.promises.rm(project.directory, {
            recursive: true,
            force: true
        });
    }
});

test("изменение файла отменяет его запись", async () => {
    const project = await createProject();
    const shardDirectory = path.join(project.directory, "shards");

    try {
        const stand = createStand(project, shardDirectory);
        const before = await stand.find();

        await stand.find();

        /* Правка одного файла: дата и размер меняются. */
        await fs.promises.writeFile(
            project.userPaths[0],
            "Import library;\n\nMacro Use0()\n  SharedHelper(0);\nEnd;\n",
            "utf8"
        );

        const after = await stand.find();

        assert.strictEqual(
            after.length,
            before.length - 1,
            "одна ссылка удалена — ответ обязан это показать"
        );
        assert.ok(
            stand.reads.count >= 1,
            "изменённый файл обязан быть прочитан заново"
        );
        assert.ok(
            stand.reads.count <= 2,
            "а остальные — нет: прочитано " + stand.reads.count
        );
    } finally {
        await fs.promises.rm(project.directory, {
            recursive: true,
            force: true
        });
    }
});

test("запись переживает перезапуск", async () => {
    const project = await createProject();
    const shardDirectory = path.join(project.directory, "shards");

    try {
        const first = createStand(project, shardDirectory);
        const expected = await first.find();

        await first.shards.flush();

        /* Новый стенд — как новый запуск сервера: в памяти ничего нет. */
        const restarted = createStand(project, shardDirectory);
        const found = await restarted.find();

        assert.deepStrictEqual(
            signature(found),
            signature(expected),
            "после перезапуска ответ обязан совпасть"
        );
        assert.strictEqual(
            restarted.reads.count,
            0,
            "после перезапуска файлы не перечитываются: прочитано " +
                restarted.reads.count
        );
    } finally {
        await fs.promises.rm(project.directory, {
            recursive: true,
            force: true
        });
    }
});

test("отсутствие ссылок тоже запоминается", async () => {
    const project = await createProject(3);
    const shardDirectory = path.join(project.directory, "shards");

    try {
        /* Файл, где имя встречается, но ни к чему не относится. */
        const noise = path.join(project.directory, "noise.mac");

        await fs.promises.writeFile(
            noise,
            "Macro Other()\n  Var SharedHelper = 1;\n" +
            "  return SharedHelper;\nEnd;\n",
            "utf8"
        );

        const stand = createStand(
            {
                ...project,
                userUris: [
                    ...project.userUris,
                    pathToFileURL(noise).toString()
                ]
            },
            shardDirectory
        );

        await stand.find();
        await stand.find();

        assert.strictEqual(
            stand.reads.count,
            0,
            "файл без подходящих ссылок тоже не перечитывается: прочитано " +
                stand.reads.count
        );
    } finally {
        await fs.promises.rm(project.directory, {
            recursive: true,
            force: true
        });
    }
});

test("отменённый поиск ничего не запоминает", async () => {
    const project = await createProject(4);
    const shardDirectory = path.join(project.directory, "shards");

    try {
        const stand = createStand(project, shardDirectory);
        const module = stand.index.getModule(project.libraryUri);
        const offset = LIBRARY.indexOf("SharedHelper");

        const cancelled = await findRslReferencesInWorkspace(
            stand.index,
            new RslScopeResolver(stand.index),
            new ReferenceIndex({ log: () => undefined }),
            module.uri,
            offset,
            false,
            () => true,
            stand.shards
        );

        assert.deepStrictEqual(cancelled, [], "отменённый поиск пуст");
        assert.strictEqual(
            stand.shards.stats.files,
            0,
            "отменённый поиск не имеет права оставлять записи"
        );

        const found = await stand.find();

        assert.ok(
            found.length >= 8,
            "следующий поиск обязан найти всё: " + found.length
        );
    } finally {
        await fs.promises.rm(project.directory, {
            recursive: true,
            force: true
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

"use strict";

/**
 * Один файл — одно чтение с диска за запрос References.
 *
 * В холодной сессии с восстановленными постоянными кэшами один и тот же файл
 * читался дважды. Записи о ссылках сверяют восстановленную запись: stat,
 * чтение, декодирование, отпечаток. Если запись цела, но по искомому имени в
 * ней ничего нет, файл уходит в индекс References — а у того своя проверка
 * актуальности, и он читает тот же файл заново.
 *
 * На редком имени это мелочь. На проверенном проекте популярное имя даёт 2533
 * файла-кандидата на 66 МБ, и лишним оказывается второй проход по тем же 66 МБ.
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

function removeTree(directory) {
    fs.rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 25
    });
}

/**
 * Проект: библиотека с искомым именем и файлы, которые её зовут.
 *
 * Часть пользователей зовёт другое имя: их записи о ссылках цели не содержат,
 * и именно они уходят дальше в индекс References — тот самый путь, где файл
 * читался второй раз.
 */
async function createProject(users = 6) {
    const directory = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "rsl-read-count-")
    );

    await fs.promises.writeFile(
        path.join(directory, "library.mac"),
        "Macro SharedHelper(value)\n  return value;\nEnd;\n\n" +
        "Macro OtherHelper(value)\n  return value;\nEnd;\n",
        "utf8"
    );

    const userPaths = [];

    for (let number = 0; number < users; number++) {
        const file = path.join(directory, "user" + number + ".mac");
        /* Каждый зовёт оба имени: записи заводятся на одно, ищется другое. */

        await fs.promises.writeFile(
            file,
            "Import library;\n\nMacro Use" + number + "()\n" +
            "  return SharedHelper(" + number + ")" +
            " + OtherHelper(" + number + ");\nEnd;\n",
            "utf8"
        );
        userPaths.push(file);
    }

    return {
        directory,
        libraryPath: path.join(directory, "library.mac"),
        userPaths
    };
}

/** Считает физические чтения файлов проекта по URI. */
function countReads(directory) {
    const original = fs.promises.readFile;
    const byPath = new Map();

    fs.promises.readFile = function (target, ...rest) {
        const name = String(target);

        if (name.startsWith(directory) && /\.mac$/iu.test(name)) {
            byPath.set(name, (byPath.get(name) || 0) + 1);
        }

        return original.call(this, target, ...rest);
    };

    return {
        stop() {
            fs.promises.readFile = original;

            return byPath;
        }
    };
}

/** Сессия сервера над проектом: индекс, записи о ссылках, индекс References. */
function session(project, shardsDirectory) {
    const index = new WorkspaceIndex();
    const uris = [
        pathToFileURL(project.libraryPath).toString(),
        ...project.userPaths.map(file => pathToFileURL(file).toString())
    ];

    index.registerWorkspaceFiles(uris);

    const librarySource = fs.readFileSync(project.libraryPath, "utf8");
    const libraryUri = uris[0];
    index.updateOpenModule(libraryUri, librarySource, 1);
    const referenceIndex = new ReferenceIndex({ log: () => undefined });
    const shards = new RslReferenceShardStore({
        log: () => undefined,
        buckets: 2,
        saveDebounceMs: 600_000
    });

    shards.configurePersistence(shardsDirectory);

    return {
        index,
        shards,
        referenceIndex,
        libraryUri,
        async find(name = "SharedHelper") {
            return findRslReferencesInWorkspace(
                index,
                new RslScopeResolver(index),
                referenceIndex,
                libraryUri,
                librarySource.indexOf(name) + 2,
                true,
                () => false,
                shards
            );
        }
    };
}

test("холодная сессия: каждый файл читается не больше одного раза", async () => {
    const project = await createProject(6);
    const shardsDirectory = path.join(project.directory, "shards");

    try {
        /* Первая сессия наполняет записи о ссылках и сохраняет их. */
        const first = session(project, shardsDirectory);
        const warm = await first.find();

        assert.ok(warm.length > 0, "ссылки обязаны находиться");

        await first.shards.flush();

        /*
         * Вторая сессия — холодная: записи восстановлены с диска и потому
         * несверены. Именно здесь файл и читался дважды.
         */
        const second = session(project, shardsDirectory);
        const watch = countReads(project.directory);
        let found;

        try {
            /* Ищется ДРУГОЕ имя: записи файлов есть, а этого имени в них нет. */
            found = await second.find("OtherHelper");
        } finally {
            var reads = watch.stop();
        }

        assert.ok(found.length > 0, "второе имя тоже обязано находиться");

        /*
         * Ожидаемое число чтений холодной сессии: по одному на файл-кандидат.
         *
         * Каждого проверяют оба хранилища — записи о ссылках и индекс
         * References, — и до общего чтения каждый читал сам: было по два.
         */
        assert.deepStrictEqual(
            [...reads.values()],
            project.userPaths.map(() => 1),
            "по одному чтению на каждый файл-кандидат"
        );

        const twice = [...reads.entries()]
            .filter(([, count]) => count > 1)
            .map(([file, count]) => path.basename(file) + ": " + count);

        assert.deepStrictEqual(
            twice,
            [],
            "файлы, прочитанные больше одного раза: " + twice.join(", ")
        );
    } finally {
        removeTree(project.directory);
    }
});

test("тёплая сессия файлы не перечитывает", async () => {
    const project = await createProject(4);
    const shardsDirectory = path.join(project.directory, "shards");

    try {
        const board = session(project, shardsDirectory);

        await board.find();

        /* Второй запрос той же сессии: всё уже сверено. */
        const watch = countReads(project.directory);

        await board.find();

        const reads = watch.stop();

        assert.strictEqual(
            reads.size,
            0,
            "повторный запрос не имеет права читать диск: " +
            [...reads.keys()].map(file => path.basename(file)).join(", ")
        );
    } finally {
        removeTree(project.directory);
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

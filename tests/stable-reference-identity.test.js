"use strict";

/**
 * Тождество объявления переживает его сдвиг по файлу.
 *
 * Постоянные записи о ссылках хранят, КУДА ведёт каждое найденное вхождение.
 * Пока это «куда» собиралось из имени, вида и границ объявления, любая правка
 * ВЫШЕ по файлу делала цель другим символом: сохранённые записи переставали к
 * ней относиться, поиск начинался заново, а Rename рисковал переписать не всё.
 *
 * Снаружи при этом не менялось ничего: отпечаток интерфейса тот же, файлы,
 * которые ссылаются, не тронуты. Положение символа не является его тождеством.
 *
 * Здесь это проверяется целиком: состав найденного, тождество цели, отсутствие
 * повторного чтения неизменившихся файлов и полнота Rename.
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
const {
    computeRslModuleInterface
} = require("../server/out/indexing/moduleInterface");
const { createOpenModuleModel } = require("../server/out/moduleModel");
const { rslSymbolRefKey } = require("../server/out/symbols/symbolRef");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

/** Библиотека: Filler выше, Alpha ниже — сдвигать будем Alpha. */
function library(fillerBody) {
    return [
        "Macro Filler()",
        ...fillerBody,
        "End;",
        "",
        "Macro Alpha()",
        "  return 1;",
        "End;",
        ""
    ].join("\n");
}

const USER = "Import lib;\n\nMacro Use()\n  Alpha();\nEnd;\n";

const opened = [];

async function settle() {
    while (opened.length > 0) {
        await opened.pop().flush();
    }
}

/** Проект на диске: lib.mac и user.mac. */
async function createProject() {
    const directory = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "rsl-stable-ref-")
    );
    const libPath = path.join(directory, "lib.mac");
    const userPath = path.join(directory, "user.mac");

    await fs.promises.writeFile(libPath, library([]), "utf8");
    await fs.promises.writeFile(userPath, USER, "utf8");

    return {
        directory,
        libPath,
        userPath,
        libUri: pathToFileURL(libPath).toString(),
        userUri: pathToFileURL(userPath).toString()
    };
}

/**
 * Стенд поиска: считает чтения исходников этого проекта.
 *
 * Именно их и снимает постоянная запись, поэтому считаются они, а не время.
 */
function createStand(project, shardDirectory, libText) {
    const index = new WorkspaceIndex();
    const uris = [project.libUri, project.userUri];

    index.registerWorkspaceFiles(uris);
    index.updateOpenModule(project.libUri, libText, 1);

    const shards = new RslReferenceShardStore({
        log: () => undefined,
        buckets: 4
    });

    shards.configurePersistence(shardDirectory);
    opened.push(shards);

    const referenceIndex = new ReferenceIndex({ log: () => undefined });

    referenceIndex.retainWorkspaceFiles(uris);

    const original = fs.promises.readFile;
    const reads = { count: 0 };

    return {
        index,
        shards,
        reads,
        /** Ссылки на Alpha из библиотеки. */
        async find(text) {
            const source = text ?? libText;

            index.updateOpenModule(project.libUri, source, 2);

            const module = index.getModule(project.libUri);
            const offset = source.indexOf("Alpha");

            reads.count = 0;
            fs.promises.readFile = (...args) => {
                const target = String(args[0]);

                if (
                    target.startsWith(project.directory) &&
                    /\.mac$/iu.test(target)
                ) {
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
        .map(item => item.uri + ":" + item.range.start.line +
            ":" + item.range.start.character)
        .sort()
        .join("|");
}

/** Тождество объявления Alpha в текущей модели. */
function alphaKey(index, uri) {
    const alpha = index.getModule(uri).symbolTree.children.find(
        item => item.name.toLowerCase() === "alpha"
    );

    return rslSymbolRefKey({ uri, symbolId: alpha.id });
}

test("сдвиг объявления не отменяет постоянные записи", async () => {
    const project = await createProject();
    const shardDirectory = path.join(project.directory, ".shards");

    try {
        const before = library([]);
        const stand = createStand(project, shardDirectory, before);

        /* 1. Первый поиск: запись про user.mac появляется. */
        const first = await stand.find(before);

        assert.strictEqual(first.length, 1, "вхождение в user.mac найдено");
        assert.ok(stand.reads.count > 0, "в первый раз файл читается");

        const firstKey = alphaKey(stand.index, project.libUri);

        await stand.shards.flush();

        /* 2. Правка только тела Filler: Alpha съезжает на две строки. */
        const after = library(["  Var x = 1;", "  Var y = 2;"]);

        assert.strictEqual(
            computeRslModuleInterface(createOpenModuleModel(before))
                .fingerprint,
            computeRslModuleInterface(createOpenModuleModel(after))
                .fingerprint,
            "снаружи модуль не изменился"
        );

        await fs.promises.writeFile(project.libPath, after, "utf8");

        /* 3. user.mac не тронут. */
        const second = await stand.find(after);

        assert.strictEqual(
            signature(second),
            signature(first),
            "то же вхождение в том же месте"
        );
        assert.strictEqual(
            stand.reads.count,
            0,
            "user.mac не изменился — перечитывать его незачем"
        );
        assert.strictEqual(
            alphaKey(stand.index, project.libUri),
            firstKey,
            "тождество цели то же, хотя объявление съехало"
        );
    } finally {
        await settle();
        await fs.promises.rm(project.directory, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 25
        });
    }
});

test("Rename после сдвига переписывает всё", async () => {
    /*
     * Частичный Rename недопустим: он оставляет проект не собирающимся, и
     * заметить это можно только на сборке.
     */
    const project = await createProject();
    const shardDirectory = path.join(project.directory, ".shards");

    try {
        const before = library([]);
        const stand = createStand(project, shardDirectory, before);

        await stand.find(before);
        await stand.shards.flush();

        const after = library(["  Var x = 1;", "  Var y = 2;"]);

        await fs.promises.writeFile(project.libPath, after, "utf8");

        /*
         * Rename собирается из объявления и всех вхождений: сюда входят и
         * найденные в открытых файлах, и восстановленные из записей.
         */
        const usages = await stand.find(after);
        const declaration = stand.index
            .getModule(project.libUri)
            .symbolTree.children.find(
                item => item.name.toLowerCase() === "alpha"
            );

        assert.ok(declaration, "объявление на месте");
        assert.strictEqual(
            usages.length,
            1,
            "вхождение из записи не потерялось"
        );
        assert.strictEqual(
            usages[0].uri,
            project.userUri,
            "и оно в user.mac"
        );

        /* Строка объявления в текущей модели — та, куда его сдвинули. */
        const line = after.slice(0, declaration.range.start)
            .split("\n").length - 1;

        assert.strictEqual(
            line,
            5,
            "объявление действительно съехало на две строки"
        );
    } finally {
        await settle();
        await fs.promises.rm(project.directory, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 25
        });
    }
});

test("записи прежнего формата отбрасываются", async () => {
    /*
     * В записях версии 1 тождество цели собрано из положения объявления, и
     * толковать их как новые нельзя: мигрировать нечем — положение не
     * восстанавливает номер объявления. Их отбрасывают, а новые появятся при
     * первом же запросе.
     */
    const project = await createProject();
    const shardDirectory = path.join(project.directory, ".shards");

    try {
        await fs.promises.mkdir(shardDirectory, { recursive: true });

        /* Корзина прежнего формата: версия 1. */
        const stale = {
            version: 1,
            files: [{
                uri: project.userUri,
                mtimeMs: 1,
                size: 1,
                fingerprint: "старый",
                names: [{
                    name: "alpha",
                    refs: [{
                        targetKey: project.libUri + ":alpha:3:20:40",
                        startLine: 3,
                        startCharacter: 2,
                        endLine: 3,
                        endCharacter: 7,
                        isDeclaration: false
                    }]
                }]
            }]
        };

        for (let bucket = 0; bucket < 4; bucket++) {
            await fs.promises.writeFile(
                path.join(shardDirectory, "shard-" + bucket + ".json"),
                JSON.stringify(stale),
                "utf8"
            );
        }

        const before = library([]);
        const stand = createStand(project, shardDirectory, before);
        const found = await stand.find(before);

        assert.strictEqual(
            found.length,
            1,
            "ответ строится заново, а не по записи прежнего формата"
        );
        assert.ok(
            stand.reads.count > 0,
            "и файл для этого действительно читается"
        );
    } finally {
        await settle();
        await fs.promises.rm(project.directory, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 25
        });
    }
});

test("инкрементальный ответ равен сканированию с нуля", async () => {
    /*
     * Записи о ссылках — это кэш, и главное требование к кэшу одно: ответ
     * по нему совпадает с ответом без него. Здесь один стенд проходит
     * правку с накопленными записями, второй сканирует тот же текст
     * начисто, и ответы сравниваются.
     */
    const project = await createProject();
    const shardDirectory = path.join(project.directory, ".shards");

    try {
        const before = library([]);
        const warm = createStand(project, shardDirectory, before);

        await warm.find(before);
        await warm.shards.flush();

        const after = library(["  Var x = 1;", "  Var y = 2;"]);

        await fs.promises.writeFile(project.libPath, after, "utf8");

        const incremental = await warm.find(after);

        /* Сканирование с нуля: свой каталог записей, ещё пустой. */
        const cold = createStand(
            project,
            path.join(project.directory, ".fresh"),
            after
        );
        const fresh = await cold.find(after);

        assert.strictEqual(
            signature(incremental),
            signature(fresh),
            "состав найденного обязан совпасть"
        );
        assert.strictEqual(
            alphaKey(warm.index, project.libUri),
            alphaKey(cold.index, project.libUri),
            "и тождество цели тоже"
        );
        assert.ok(
            cold.reads.count > 0,
            "сканирование с нуля файл читает"
        );
    } finally {
        await settle();
        await fs.promises.rm(project.directory, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 25
        });
    }
});

test("тождество не зависит от написания URI файла", () => {
    /*
     * Ключ строится по идентичности файла, а не по строке: на
     * регистронезависимой файловой системе два написания — один файл.
     */
    const lower = "file:///d:/stable/lib.mac";
    const upper = "file:///D:/stable/lib.mac";
    const symbolId = "module/3:alpha";
    const same = process.platform === "win32" ||
        process.platform === "darwin";

    assert.strictEqual(
        rslSymbolRefKey({ uri: lower, symbolId }) ===
            rslSymbolRefKey({ uri: upper, symbolId }),
        same
    );
    assert.notStrictEqual(
        rslSymbolRefKey({ uri: lower, symbolId }),
        rslSymbolRefKey({ uri: lower, symbolId: "module/3:beta" })
    );
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

    await settle();

    console.log(
        failed === 0
            ? "\nПройдено: " + passed
            : "\nПройдено: " + passed + ", провалено: " + failed
    );

    if (failed > 0) {
        process.exitCode = 1;
    }
})();

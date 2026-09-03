"use strict";

/**
 * Открытая модель всегда главнее фонового переноса.
 *
 * Перенос сохранённого состава проекта в каталог идёт порциями и уступает
 * поток — иначе одним куском он занимает его на 170 мс подряд, и приходится
 * это на запуск, когда пользователь уже набирает текст.
 *
 * Проверка «файл не открыт» стояла один раз, перед началом записи. А между
 * порциями файл успевают открыть: живая модель записывает свой, более свежий
 * состав, а перенос продолжает писать сохранённый — поверх него. Ошибка тихая:
 * каталог отвечает про объявления, которых в файле уже нет, а заметно это
 * только по Ctrl+T и подбору Import.
 *
 * Здесь три случая: файл открылся до записи, файл открылся после записи между
 * порциями индексации, и обычный крупный закрытый файл — он обязан
 * переноситься целиком и по-прежнему порциями.
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

const { WorkspaceCatalog } = require("../server/out/indexing/workspaceCatalog");
const { RslCatalogRestore } = require("../server/out/indexing/catalogRestore");
const {
    extractCompactDeclarations
} = require("../server/out/analysis/declarationExtractor");
const { createOpenModuleModel } = require("../server/out/moduleModel");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const BIG = "file:///d:/restore/big.mac";

/** Файл с count объявлениями: имена сохранённой версии узнаваемы. */
function sourceOf(count, prefix) {
    const lines = [];

    for (let at = 0; at < count; at++) {
        lines.push("Macro " + prefix + at + "()");
        lines.push("End;");
        lines.push("");
    }

    return lines.join("\n");
}

/** Сохранённая запись такого файла. */
function recordOf(uri, count, prefix) {
    const snapshot = extractCompactDeclarations(sourceOf(count, prefix));

    return {
        uri,
        declarations: snapshot.declarations,
        imports: snapshot.imports,
        fileReferences: []
    };
}

/** Сколько имён с этим началом знает каталог. */
function namesWithPrefix(catalog, prefix) {
    return catalog.find(prefix, 10000)
        .filter(item => item.name.toLowerCase().startsWith(prefix))
        .length;
}

test("A. файл открылся до записи — старое не коммитится", async () => {
    const catalog = new WorkspaceCatalog();
    let asked = 0;

    const restore = new RslCatalogRestore(catalog, {
        /*
         * Первый вопрос — проверка на входе: файл ещё закрыт, работа
         * начинается. Дальше он открыт, и это видит первая же проверка
         * на границе порции.
         */
        isOpen: () => ++asked > 1,
        batch: 10,
        sliceMs: 1
    });

    await restore.add(recordOf(BIG, 200, "Old"));

    assert.ok(
        asked > 1,
        "актуальность спрашивалась не только на входе"
    );
    assert.strictEqual(
        restore.count,
        0,
        "брошенный перенос восстановленным не считается"
    );
    assert.strictEqual(restore.abandonedCount, 1);
    assert.strictEqual(
        catalog.has(BIG),
        false,
        "запись не появилась вовсе"
    );
    assert.strictEqual(namesWithPrefix(catalog, "old"), 0);
});

test("B. файл открылся после записи — доиндексация прекращается", async () => {
    /*
     * Самый неприятный случай. Запись уже сделана, и живая модель её заменила
     * своей — вместе с уже проиндексированными именами. Дописывать старые
     * имена поверх живой записи нельзя: в каталоге оказались бы объявления
     * двух разных версий файла сразу.
     */
    const catalog = new WorkspaceCatalog();
    let committed = false;

    const restore = new RslCatalogRestore(catalog, {
        /*
         * Файл открывается ровно в тот момент, когда запись переноса уже
         * появилась в каталоге, но порции индексации ещё идут.
         */
        isOpen: () => {
            if (!committed && catalog.has(BIG)) {
                committed = true;

                /* Живая модель записывает свой, более свежий состав. */
                catalog.record({
                    uri: BIG,
                    version: 5,
                    symbolTree: createOpenModuleModel(
                        sourceOf(2, "Live")
                    ).symbolTree,
                    imports: []
                });
            }

            return committed;
        },
        batch: 10,
        sliceMs: 1
    });

    await restore.add(recordOf(BIG, 200, "Old"));

    assert.ok(committed, "запись переноса действительно успела появиться");
    assert.strictEqual(
        restore.count,
        0,
        "перенос брошен и восстановленным не считается"
    );
    assert.strictEqual(
        namesWithPrefix(catalog, "old"),
        0,
        "ни одно имя сохранённой версии не осталось в каталоге"
    );
    assert.strictEqual(
        namesWithPrefix(catalog, "live"),
        2,
        "а живые имена на месте"
    );
    assert.strictEqual(catalog.versionOf(BIG), 5, "запись живая");
});

test("C. обычный крупный закрытый файл переносится целиком", async () => {
    const catalog = new WorkspaceCatalog();
    let asked = 0;

    const restore = new RslCatalogRestore(catalog, {
        isOpen: () => {
            asked++;

            return false;
        },
        batch: 10,
        sliceMs: 1
    });

    await restore.add(recordOf(BIG, 200, "Old"));

    assert.strictEqual(restore.count, 1);
    assert.strictEqual(restore.abandonedCount, 0);
    assert.strictEqual(
        namesWithPrefix(catalog, "old"),
        200,
        "перенесены все объявления"
    );
    /*
     * Дробление сохранилось. Считаются проверки актуальности, а не
     * уступки потоку: уступка зависит от часов и на мелких объявлениях
     * может не случиться вовсе, а проверка стоит на каждой границе.
     */
    assert.ok(
        asked >= 20,
        "порций было мало: проверок " + asked
    );
});

test("мелкий файл открытого документа не перезаписывается", async () => {
    /* Прежняя проверка на входе никуда не делась: она про мелкие файлы. */
    const catalog = new WorkspaceCatalog();

    catalog.record({
        uri: BIG,
        version: 5,
        symbolTree: createOpenModuleModel(sourceOf(2, "Live")).symbolTree,
        imports: []
    });

    const restore = new RslCatalogRestore(catalog, {
        isOpen: () => true,
        batch: 10000,
        sliceMs: 0
    });

    await restore.add(recordOf(BIG, 3, "Old"));

    assert.strictEqual(restore.count, 0);
    assert.strictEqual(namesWithPrefix(catalog, "old"), 0);
    assert.strictEqual(namesWithPrefix(catalog, "live"), 2);
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

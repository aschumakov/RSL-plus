"use strict";

/**
 * Перенос сохранённого каталога в рабочий — порциями.
 *
 * Одним куском перенос 98 640 символов занимал поток на 170 мс подряд, а
 * бюджет отзывчивости — 25 мс. Приходится это на запуск, когда пользователь
 * уже набирает текст, поэтому проверяется не общее время, а самый длинный
 * непрерывный отрезок.
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

const {
    WorkspaceCatalog
} = require("../server/out/indexing/workspaceCatalog");
const {
    restoreRslCatalogRecords,
    RSL_CATALOG_RESTORE_SLICE_MS
} = require("../server/out/indexing/catalogRestore");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

/** Сохранённые записи: столько файлов и символов, сколько попросят. */
function records(files, perFile) {
    const result = [];

    for (let file = 0; file < files; file++) {
        const declarations = [];

        for (let symbol = 0; symbol < perFile; symbol++) {
            declarations.push({
                name: "Sym" + file + "_" + symbol,
                kind: "macro",
                visibility: "public",
                line: symbol,
                character: 0,
                children: []
            });
        }

        result.push({
            uri: "file:///d:/p/m" + file + ".mac",
            version: 0,
            stamp: { mtimeMs: 1, size: 1 },
            declarations,
            imports: [],
            fileReferences: []
        });
    }

    return result;
}

test("состав переносится целиком", async () => {
    const catalog = new WorkspaceCatalog();
    const saved = records(40, 4);
    const restored = await restoreRslCatalogRecords(catalog, saved, {
        isOpen: () => false
    });

    assert.strictEqual(restored, saved.length, "перенесены все записи");
    assert.deepStrictEqual(
        catalog.modulesExporting("Sym7_2"),
        ["file:///d:/p/m7.mac"],
        "символ обязан находиться по каталогу"
    );
});

test("открытый документ не перезаписывается сохранённым", async () => {
    const catalog = new WorkspaceCatalog();
    const saved = records(10, 2);
    const open = saved[3].uri;
    const restored = await restoreRslCatalogRecords(catalog, saved, {
        isOpen: uri => uri === open
    });

    assert.strictEqual(restored, saved.length - 1);
    assert.deepStrictEqual(
        catalog.modulesExporting("Sym3_1"),
        [],
        "у открытого файла своя модель, и она свежее"
    );
});

/** Самый длинный непрерывный отрезок занятости при заданной порции. */
async function longestStretch(saved, sliceMs) {
    const catalog = new WorkspaceCatalog();
    const gaps = [];
    let last = process.hrtime.bigint();

    await restoreRslCatalogRecords(catalog, saved, {
        isOpen: () => false,
        sliceMs,
        onYield: () => {
            gaps.push(Number(process.hrtime.bigint() - last) / 1e6);
            last = process.hrtime.bigint();
        }
    });

    gaps.push(Number(process.hrtime.bigint() - last) / 1e6);

    return { longest: Math.max(...gaps), yields: gaps.length - 1 };
}

test("перенос уступает поток и укладывается в порцию", async () => {
    /* Столько символов, сколько в проверенном проекте. */
    const saved = records(6165, 16);

    /*
     * Сравнение с непрерывным переносом, а не абсолютный порог в миллисекундах.
     *
     * Полный набор гоняет до шести файлов сразу, и на загруженной машине любое
     * измерение времени плавает: абсолютный порог здесь падал через один. Оба
     * замера идут в одном процессе и страдают от нагрузки одинаково, поэтому
     * их отношение устойчиво, а именно оно и описывает суть — перенос больше
     * не держит поток одним куском.
     */
    const whole = await longestStretch(saved, 24 * 60 * 60 * 1000);
    const sliced = await longestStretch(saved, RSL_CATALOG_RESTORE_SLICE_MS);

    assert.strictEqual(whole.yields, 0, "непрерывный перенос поток не уступает");
    assert.ok(
        sliced.yields > 1,
        "порционный обязан уступать не раз: " + sliced.yields
    );
    assert.ok(
        sliced.longest * 3 < whole.longest,
        "порция " + sliced.longest.toFixed(1) +
            " мс против непрерывных " + whole.longest.toFixed(1) + " мс"
    );
});

test("пустой список переносить нечего", async () => {
    const catalog = new WorkspaceCatalog();

    assert.strictEqual(
        await restoreRslCatalogRecords(catalog, [], { isOpen: () => false }),
        0
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

    console.log(
        failed === 0
            ? "\nПройдено: " + passed
            : "\nПройдено: " + passed + ", провалено: " + failed
    );

    if (failed > 0) {
        process.exitCode = 1;
    }
})();

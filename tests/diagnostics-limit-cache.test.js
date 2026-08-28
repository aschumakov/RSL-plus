"use strict";

/**
 * Предел Problems ограничивает вывод, а не анализ.
 *
 * Расчёт обрывался на двухсотом сообщении, и это отменяло запись в кэш: обрыв
 * означает неполный результат, а неполный запоминать нельзя. Файл, набравший
 * предел, пересчитывался целиком на каждую правку — и обрыв обходился дороже
 * полного расчёта: на printdog.mac 92 мс против 71, на taxoutmesBody.mac 73
 * против 49. С обрывом каждый расчёт холодный, без обрыва второй берёт
 * неизменившиеся единицы из кэша.
 *
 * Проверяется главное: ответ от этого не меняется, а вторая правка такого
 * файла переиспользует то, что не менялось.
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
    RslDiagnosticEngine
} = require("../server/out/diagnostics/diagnosticEngine");

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

const MAIN = "file:///d:/limit/main.mac";
const LIBRARY = "file:///d:/limit/library.mac";
const LIMIT = 200;
/* Сообщений заведомо больше предела: по два на процедуру. */
const MACROS = 150;

/** Файл, в котором сообщений больше предела публикации. */
function noisySource(salt) {
    const lines = ["Import library;", ""];

    for (let index = 0; index < MACROS; index++) {
        lines.push(
            "Macro Process" + index + "(document)",
            "  Var first = " + (index + salt) + ";",
            "  Var second = 0;",
            /* Присваивание самому себе: по два на процедуру. */
            "  first = first;",
            "  second = second;",
            "  return first;",
            "End;",
            ""
        );
    }

    return lines.join("\n");
}

/** Стенд: движок с наблюдением за лентой text кэша единиц. */
function stand(source) {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN, LIBRARY]);
    index.updateExternalModule(
        LIBRARY,
        "Macro FromLibrary()\nEnd;\n",
        1
    );

    const engine = new RslDiagnosticEngine();
    const cache = engine.unitCache;
    const original = cache.begin.bind(cache);
    let last;

    cache.begin = (module, lane, fingerprint) => {
        const run = original(module, lane, fingerprint);

        if (lane === "text") {
            last = {
                full: run.full,
                units: run.units.length,
                stale: run.stale.length,
                reused: run.reused.length,
                outcome: "не завершён"
            };
        }

        return {
            ...run,
            commit: value => {
                if (lane === "text") {
                    last.outcome = "запомнен";
                }

                run.commit(value);
            },
            abort: () => {
                if (lane === "text") {
                    last.outcome = "отброшен";
                }

                run.abort();
            }
        };
    };

    let version = 0;

    return {
        index,
        engine,
        /** Пересчитать файл и вернуть находки вместе со сведениями о кэше. */
        run(text, limit = LIMIT) {
            version++;

            const module = index.updateOpenModule(MAIN, text, version);
            const found = engine.buildLocal(module, index, {
                maxProblems: limit
            });

            return { found, cache: last };
        },
        /** Изменить импортируемый модуль: лента imports обязана устареть. */
        changeLibrary(text) {
            index.updateExternalModule(LIBRARY, text, 2);
        }
    };
}

function signature(diagnostics) {
    return diagnostics.map(item =>
        item.code + "@" + item.range.start.line + ":" +
        item.range.start.character);
}

test("файл с избытком сообщений запоминается в кэше", () => {
    const board = stand();
    const source = noisySource(0);
    const first = board.run(source);

    assert.strictEqual(
        first.found.length,
        LIMIT,
        "публикуется ровно предел: " + first.found.length
    );
    assert.strictEqual(
        first.cache.outcome,
        "запомнен",
        "полный расчёт обязан попасть в кэш"
    );

    /* И сообщений на самом деле больше предела. */
    const all = board.run(source, 100_000);

    assert.ok(
        all.found.length > LIMIT,
        "образец обязан давать больше предела: " + all.found.length
    );
});

test("первые двести сообщений устойчивы", () => {
    const source = noisySource(0);
    const cold = stand().run(source);
    const board = stand();

    board.run(source);

    /* Второй расчёт того же текста идёт по кэшу — ответ обязан совпасть. */
    const warm = board.run(source);

    assert.deepStrictEqual(
        signature(warm.found),
        signature(cold.found),
        "ответ по кэшу обязан совпадать с холодным"
    );
    assert.strictEqual(
        warm.cache.stale,
        0,
        "неизменившийся файл не имеет права пересчитываться: единиц " +
            warm.cache.stale
    );
});

test("правка запомненной единицы пересчитывает только её", () => {
    const board = stand();
    const source = noisySource(0);

    board.run(source);

    /* Правка внутри одной процедуры. */
    const at = source.indexOf("Var first = 75;");

    assert.notStrictEqual(at, -1, "образец обязан содержать эту строку");

    const edited = source.slice(0, at) +
        "Var first = 750;" + source.slice(at + "Var first = 75;".length);
    const warm = board.run(edited);

    assert.strictEqual(
        warm.cache.stale,
        1,
        "пересчитаться обязана одна единица, а не " + warm.cache.stale
    );
    assert.strictEqual(
        warm.cache.outcome,
        "запомнен",
        "и результат снова обязан попасть в кэш"
    );

    /* Ответ обязан совпасть с полным расчётом того же текста. */
    assert.deepStrictEqual(
        signature(warm.found),
        signature(stand().run(edited).found),
        "точечный пересчёт не имеет права менять ответ"
    );
});

test("добавленная процедура считается заново, остальные — нет", () => {
    const board = stand();
    const source = noisySource(0);

    board.run(source);

    const added = source +
        "Macro Added(document)\n  Var value = 1;\n  value = value;\n" +
        "  return value;\nEnd;\n";
    const warm = board.run(added);

    /*
     * Дописанная в конец процедура задевает две единицы: саму новую и ту,
     * что была последней — её текст теперь кончается в другом месте.
     */
    assert.ok(
        warm.cache.stale <= 2,
        "пересчитаться обязаны единицы правки, а не " + warm.cache.stale
    );
    assert.ok(
        warm.cache.units - warm.cache.stale > 100,
        "остальные обязаны быть переиспользованы: единиц " + warm.cache.units
    );
    assert.deepStrictEqual(
        signature(warm.found),
        signature(stand().run(added).found),
        "ответ обязан совпасть с полным расчётом"
    );
});

test("изменение импортируемого модуля не отменяет ленту text", () => {
    const board = stand();
    const source = noisySource(0);

    board.run(source);
    board.changeLibrary("Macro FromLibrary()\nEnd;\nMacro Added()\nEnd;\n");

    const warm = board.run(source);

    assert.strictEqual(
        warm.cache.stale,
        0,
        "проверки по тексту от чужого модуля не устаревают: единиц " +
            warm.cache.stale
    );
    assert.deepStrictEqual(
        signature(warm.found),
        signature(stand().run(source).found),
        "ответ обязан совпасть с полным расчётом"
    );
});

test("сообщения не теряются после череды правок", () => {
    /*
     * Главная опасность точечного пересчёта — молча потерянное сообщение:
     * находка неизменившейся единицы взята из записи, и ошибка записи видна
     * только сравнением с полным расчётом.
     */
    const board = stand();
    let text = noisySource(0);

    board.run(text);

    for (let step = 1; step <= 8; step++) {
        const at = text.indexOf("Var second = 0;", text.length / 3);

        text = text.slice(0, at) + "Var second = " + step + ";" +
            text.slice(at + "Var second = 0;".length);

        const warm = board.run(text);

        assert.deepStrictEqual(
            signature(warm.found),
            signature(stand().run(text).found),
            "правка " + step + ": ответ разошёлся с полным расчётом"
        );
        assert.strictEqual(
            warm.cache.outcome,
            "запомнен",
            "правка " + step + ": результат обязан попасть в кэш"
        );
    }
});

if (failed > 0) {
    console.error("\nПройдено: " + passed + "\nОшибок: " + failed);
    process.exitCode = 1;
} else {
    console.log("\nПройдено: " + passed + "\nОшибок: " + failed);
}

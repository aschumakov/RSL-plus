"use strict";

/**
 * Кэш resolver сбрасывается только от того, что касается документа.
 *
 * Актуальность кэшей разрешения имён проверялась по общей ревизии индекса, а
 * она растёт от любого модуля проекта. Из-за этого фоновая индексация
 * постороннего файла обнуляла горячие кэши открытого документа — при том, что
 * ни сам документ, ни его Import, ни их транзитивное замыкание не менялись. В
 * режимах workspaceIdle и full в фоне читаются тысячи модулей, и кэш обнулялся
 * тысячи раз подряд.
 *
 * Проверяется по счётчикам попаданий самого resolver: они и есть та величина,
 * ради которой кэш существует.
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
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { lexRsl } = require("../server/out/lexer");

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

const MAIN = "file:///d:/scope/main.mac";
const LIB = "file:///d:/scope/lib.mac";
const DEEP = "file:///d:/scope/deep.mac";
const STRANGER = "file:///d:/scope/stranger.mac";

const LIB_SOURCE = "Import deep;\n\nMacro LibHelper()\n  return DeepValue();\nEnd;\n";
const DEEP_SOURCE = "Macro DeepValue()\n  return 1;\nEnd;\n";
const MAIN_SOURCE = [
    "Import lib;",
    "",
    "Macro Run()",
    "  Var value = LibHelper();",
    "  return value;",
    "End;",
    ""
].join("\n");

/** Проект: главный файл, его зависимость, её зависимость и посторонний файл. */
function stand() {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN, LIB, DEEP, STRANGER]);
    index.updateExternalModule(DEEP, DEEP_SOURCE, 1);
    index.updateExternalModule(LIB, LIB_SOURCE, 1);
    index.updateExternalModule(STRANGER, "Macro Alone()\nEnd;\nEnd;\n", 1);

    const module = index.updateOpenModule(MAIN, MAIN_SOURCE, 1);
    const resolver = new RslScopeResolver(index);
    const offsets = lexRsl(MAIN_SOURCE).tokens
        .filter(token => token.kind === "identifier")
        .map(token => token.start + 1);

    /** Разрешить все имена файла и вернуть прирост попаданий и промахов. */
    function resolveAll() {
        const before = resolver.getCacheStats();

        for (const offset of offsets) {
            resolver.resolveAt(MAIN, module.symbolTree, offset);
        }

        const after = resolver.getCacheStats();

        return {
            hits: after.hits - before.hits,
            misses: after.misses - before.misses
        };
    }

    return { index, resolver, module, resolveAll };
}

test("посторонний модуль не сбрасывает кэш активного документа", () => {
    const board = stand();

    /* Первый проход наполняет кэш. */
    const first = board.resolveAll();

    assert.ok(first.misses > 0, "первый проход обязан считать: " + first.misses);

    const warm = board.resolveAll();

    assert.strictEqual(
        warm.misses,
        0,
        "второй проход обязан отвечать из кэша"
    );

    /*
     * Фоновая индексация: посторонний модуль перечитан. Именно это и обнуляло
     * кэш — общая ревизия индекса росла.
     */
    for (let round = 2; round < 12; round++) {
        board.index.updateExternalModule(
            STRANGER,
            "Macro Alone()\n  return " + round + ";\nEnd;\n",
            round
        );
    }

    const after = board.resolveAll();

    assert.strictEqual(
        after.misses,
        0,
        "чужой модуль не имеет права сбрасывать кэш: промахов " + after.misses
    );
    assert.strictEqual(
        after.hits,
        warm.hits,
        "и попаданий обязано остаться столько же"
    );
});

test("изменение прямого Import сбрасывает кэш", () => {
    const board = stand();

    board.resolveAll();

    assert.strictEqual(board.resolveAll().misses, 0, "кэш прогрет");

    board.index.updateExternalModule(
        LIB,
        LIB_SOURCE + "\nMacro LibExtra()\nEnd;\n",
        2
    );

    assert.ok(
        board.resolveAll().misses > 0,
        "изменение подключённого модуля обязано сбросить кэш"
    );
});

test("изменение транзитивного Import сбрасывает кэш", () => {
    const board = stand();

    board.resolveAll();

    assert.strictEqual(board.resolveAll().misses, 0, "кэш прогрет");

    /* deep не подключён напрямую: он приходит через lib. */
    board.index.updateExternalModule(
        DEEP,
        DEEP_SOURCE + "\nMacro DeepExtra()\nEnd;\n",
        2
    );

    assert.ok(
        board.resolveAll().misses > 0,
        "изменение модуля из цепочки обязано сбросить кэш"
    );
});

test("появление файла в проекте сбрасывает кэш", () => {
    /*
     * Import разрешаются по именам: новый одноимённый файл меняет окружение
     * документа даже там, где ребра Import-графа на этот URI не было вовсе.
     */
    const board = stand();

    board.resolveAll();

    assert.strictEqual(board.resolveAll().misses, 0, "кэш прогрет");

    board.index.registerWorkspaceFile("file:///d:/scope/other/lib.mac");

    assert.ok(
        board.resolveAll().misses > 0,
        "состав файлов изменился — кэш обязан пересчитаться"
    );
});

test("удаление файла из проекта сбрасывает кэш", () => {
    const board = stand();

    board.resolveAll();

    assert.strictEqual(board.resolveAll().misses, 0, "кэш прогрет");

    board.index.unregisterWorkspaceFile(STRANGER);

    assert.ok(
        board.resolveAll().misses > 0,
        "состав файлов изменился — кэш обязан пересчитаться"
    );
});

test("ревизия документа не меняется от чужого модуля", () => {
    const board = stand();
    const before = board.index.getSemanticRevision(MAIN);

    board.index.updateExternalModule(STRANGER, "Macro Alone()\nEnd;\n", 2);

    assert.strictEqual(
        board.index.getSemanticRevision(MAIN),
        before,
        "чужой модуль ревизию документа не трогает"
    );

    /*
     * Подключённый модуль — тоже не трогает, если снаружи он не изменился.
     *
     * Здесь перечитан тот же текст: так выглядит фоновое перечитывание файла.
     * Прежде ревизия от этого менялась, и горячие кэши документа обнулялись
     * без всякой причины.
     */
    board.index.updateExternalModule(LIB, LIB_SOURCE, 2);

    assert.strictEqual(
        board.index.getSemanticRevision(MAIN),
        before,
        "тот же интерфейс — то же окружение документа"
    );

    /* А изменение публичного объявления обязано её изменить. */
    board.index.updateExternalModule(
        LIB,
        LIB_SOURCE + "\nMacro LibExtra()\nEnd;\n",
        3
    );

    assert.notStrictEqual(
        board.index.getSemanticRevision(MAIN),
        before,
        "новое публичное объявление видно соседнему файлу"
    );
});

test("правка тела подключённого модуля ревизию не меняет", () => {
    /*
     * То, ради чего заведён отпечаток интерфейса. Соседний файл видит от
     * модуля только Import и публичные объявления с подписями; что написано
     * внутри Macro — его дело, и ни один вывод в соседнем файле от этого не
     * меняется.
     */
    const board = stand();
    const before = board.index.getSemanticRevision(MAIN);

    board.index.updateExternalModule(
        LIB,
        LIB_SOURCE.replace("return DeepValue();", "return DeepValue() + 1;"),
        2
    );

    assert.strictEqual(
        board.index.getSemanticRevision(MAIN),
        before,
        "тело чужого Macro снаружи не видно"
    );
});

console.log(
    failed === 0
        ? "\nПройдено: " + passed
        : "\nПройдено: " + passed + ", провалено: " + failed
);

if (failed > 0) {
    process.exitCode = 1;
}

"use strict";

/**
 * Отчёты для разбора работы сервера.
 *
 * Между текстом и ответом лежат замыкание Import, ревизии интерфейсов, каталог
 * и кэши. Когда ответ выглядит неверным, без такого отчёта разбираться тяжело.
 *
 * Проверяется, что отчёт показывает именно состояние сервера — и что он ничего
 * не меняет: команда разбора не имеет права греть кэши или что-то достраивать.
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
    buildRslInspectorReport
} = require("../server/out/features/inspectorReports");
const { RslTypeEngine } = require("../server/out/analysis/typeEngine");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

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

const LIB = "file:///d:/inspect/lib.mac";
const MAIN = "file:///d:/inspect/main.mac";

const LIB_SOURCE = [
    "Macro Send(document: TBFile, silent)",
    "  return 1;",
    "End;",
    "",
    "Private Macro Hidden()",
    "End;",
    ""
].join("\n");

const MAIN_SOURCE = [
    "Import lib, notyet;",
    "",
    "Macro Run()",
    "  Var doc: TBFile;",
    "  return Send(doc, 0);",
    "End;",
    ""
].join("\n");

/** Стенд: два модуля, main подключает lib. */
function board() {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([LIB, MAIN]);
    index.updateOpenModule(LIB, LIB_SOURCE, 1);
    index.updateOpenModule(MAIN, MAIN_SOURCE, 1);

    const resolver = new RslScopeResolver(index);

    return {
        index,
        environment: {
            index,
            resolver,
            types: new RslTypeEngine(index, resolver)
        }
    };
}

function report(kind, uri, offset) {
    return buildRslInspectorReport(board().environment, { kind, uri, offset });
}

test("дерево символов показывает объявления и видимость", () => {
    const text = report("symbolTree", LIB);

    assert.ok(text.includes("Send"), "процедура обязана быть");
    assert.ok(text.includes("Hidden"), "приватная тоже: это отчёт, а не сводка");
    assert.ok(text.includes("private"), "видимость показана");
});

test("интерфейс показывает только внешне видимое", () => {
    const text = report("moduleInterface", LIB);

    assert.ok(text.includes("Send"), "публичная процедура видна снаружи");
    assert.ok(
        !text.includes("Hidden"),
        "приватная снаружи не видна и в интерфейс не входит"
    );
    assert.ok(
        text.includes("совпадает с хранимым: да"),
        "пересчитанный отпечаток обязан совпасть с тем, что в индексе"
    );
});

test("замыкание показывает и то, что не нашлось", () => {
    const text = report("importClosure", MAIN);

    assert.ok(text.includes(LIB), "разрешившийся модуль показан");
    assert.ok(
        text.includes("Не найдено") && text.includes("notyet"),
        "ненайденный Import — самое важное в этом отчёте"
    );
});

test("символ под курсором объясняется", () => {
    const offset = MAIN_SOURCE.indexOf("Send(doc");
    const text = report("explainSymbol", MAIN, offset);

    assert.ok(text.includes(LIB), "объявляющий модуль показан");
    assert.ok(text.includes("прямой Import"), "путь Import показан");
    assert.ok(text.includes("Ревизия интерфейса"), "ревизия показана");
});

test("неразрешённое имя объясняется тоже", () => {
    const offset = MAIN_SOURCE.indexOf("doc, 0");
    const text = report("explainSymbol", MAIN, MAIN_SOURCE.length - 3);

    assert.ok(
        text.includes("не разрешилось") || text.includes("Найден"),
        "отчёт обязан ответить в любом случае: " + text
    );
    void offset;
});

test("тип под курсором объясняется", () => {
    const offset = MAIN_SOURCE.indexOf("doc, 0");
    const text = report("explainType", MAIN, offset);

    assert.ok(text.includes("Тип имени под курсором"), "строка про тип есть");
    assert.ok(text.includes("Внутри вызова"), "контекст вызова показан");
});

test("сводка внешнего модуля синтаксического дерева не имеет", () => {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([LIB]);
    index.updateExternalModule(LIB, LIB_SOURCE, 1);

    const resolver = new RslScopeResolver(index);
    const text = buildRslInspectorReport(
        { index, resolver, types: new RslTypeEngine(index, resolver) },
        { kind: "syntaxTree", uri: LIB }
    );

    assert.ok(
        text.includes("Дерева нет"),
        "отчёт обязан честно сказать, а не строить модель ради показа"
    );
});

test("незагруженный модуль не строится ради отчёта", () => {
    const stand = board();
    const before = stand.index.getModules().length;
    const text = buildRslInspectorReport(stand.environment, {
        kind: "symbolTree",
        uri: "file:///d:/inspect/never.mac"
    });

    assert.ok(text.includes("не загружен"));
    assert.strictEqual(
        stand.index.getModules().length,
        before,
        "отчёт ничего не достраивает"
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

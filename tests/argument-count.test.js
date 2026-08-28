"use strict";

/**
 * Аргументов больше, чем параметров.
 *
 * Проверяется только избыток и только у процедур, объявленных в том же файле.
 * Каждое из этих ограничений стоит на замере по проекту макросов:
 *
 *   недостаток аргументов встречается у 3,9% вызовов с известной сигнатурой —
 *   столько настоящих ошибок там быть не может, и это согласуется с тем, что
 *   хвостовые аргументы разрешено опускать. Ни одного параметра со значением
 *   по умолчанию среди 31 314 просмотренных объявлений не нашлось, то есть
 *   правил необязательности подтвердить нечем;
 *
 *   сверка с платформенными сигнатурами давала 2586 находок в 272 файлах из
 *   400 — их каталог неполон, и спорить с ним бессмысленно. С ограничением до
 *   своего файла остаётся 180 находок в 31 файле;
 *
 *   процедура, объявленная без параметров, не проверяется вовсе: так выглядят
 *   точки входа и конструкции, которых модель не знает.
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

const MAIN = "file:///d:/args/main.mac";
const LIBRARY = "file:///d:/args/library.mac";

/** Находки правила в файле; зависимость подключается при необходимости. */
function findings(source, options = {}) {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN, LIBRARY]);

    if (options.library) {
        index.updateExternalModule(LIBRARY, options.library, 1);
    }

    const module = index.updateOpenModule(MAIN, source, 1);

    return new RslDiagnosticEngine()
        .buildLocal(module, index, options.settings)
        .filter(item => item.code === "argument-count");
}

function body(lines) {
    return [
        "Macro Target(first, second, third)",
        "  return first + second + third;",
        "End;",
        "",
        "Macro Run()",
        ...lines,
        "  return 1;",
        "End;",
        ""
    ].join("\n");
}

test("лишний аргумент находится", () => {
    const found = findings(body(["  Target(1, 2, 3, 4);"]));

    assert.strictEqual(found.length, 1, "одна находка");
    assert.strictEqual(found[0].severity, 2, "по умолчанию предупреждение");
    assert.ok(
        found[0].message.includes("передано 4") &&
        found[0].message.includes("объявлено 3"),
        "сообщение обязано называть оба числа: " + found[0].message
    );
});

test("верный и неполный вызов молчат", () => {
    assert.deepStrictEqual(
        findings(body(["  Target(1, 2, 3);"])),
        [],
        "точное число аргументов"
    );
    assert.deepStrictEqual(
        findings(body(["  Target(1, 2);"])),
        [],
        "недостаток не проверяется: правил необязательности подтвердить нечем"
    );
});

test("процедура без параметров не проверяется", () => {
    const source = [
        "Macro Entry()",
        "  return 1;",
        "End;",
        "",
        "Macro Run()",
        "  Entry(1, 2);",
        "  return 1;",
        "End;",
        ""
    ].join("\n");

    assert.deepStrictEqual(
        findings(source),
        [],
        "точку входа с аргументами доказать нечем"
    );
});

test("чужая процедура не проверяется", () => {
    const source = [
        "Import library;",
        "",
        "Macro Run()",
        "  FromLibrary(1, 2, 3, 4, 5);",
        "  return 1;",
        "End;",
        ""
    ].join("\n");

    assert.deepStrictEqual(
        findings(source, {
            library: "Macro FromLibrary(one, two)\n  return one;\nEnd;\n"
        }),
        [],
        "сигнатура из другого файла не проверяется: см. заголовок"
    );
});

test("объявление со скобкой вызовом не считается", () => {
    const source = [
        "Macro Target(first, second, third)",
        "  return first;",
        "End;",
        "",
        "Macro Run()",
        "  FILE Target(one, two, three, four) WRITE;",
        "  return 1;",
        "End;",
        ""
    ].join("\n");

    assert.deepStrictEqual(
        findings(source),
        [],
        "FILE ИМЯ(...) — это объявление, а не вызов"
    );
});

test("обращение к члену объекта не проверяется", () => {
    const source = [
        "Macro Target(first)",
        "  return first;",
        "End;",
        "",
        "Macro Run(document)",
        "  document.Target(1, 2, 3);",
        "  return 1;",
        "End;",
        ""
    ].join("\n");

    assert.deepStrictEqual(
        findings(source),
        [],
        "метод объекта — не одноимённая процедура файла"
    );
});

test("правило выключается настройкой и меняет уровень", () => {
    const source = body(["  Target(1, 2, 3, 4);"]);

    assert.deepStrictEqual(
        findings(source, { settings: { argumentCount: false } }),
        [],
        "булева настройка выключает проверку"
    );
    assert.deepStrictEqual(
        findings(source, { settings: { rules: { "argument-count": "none" } } }),
        [],
        "уровень none тоже"
    );
    assert.strictEqual(
        findings(source, {
            settings: { rules: { "argument-count": "error" } }
        })[0].severity,
        1,
        "уровень меняется настройкой"
    );
});

test("подавление комментарием действует", () => {
    const source = [
        "Macro Target(first, second, third)",
        "  return first;",
        "End;",
        "",
        "Macro Run()",
        "  // rsl-disable-next-line argument-count",
        "  Target(1, 2, 3, 4);",
        "  Target(1, 2, 3, 4);",
        "  return 1;",
        "End;",
        ""
    ].join("\n");
    const found = findings(source);

    assert.strictEqual(found.length, 1, "погашена одна из двух строк");
    assert.strictEqual(found[0].range.start.line, 7);
});

test("повторный анализ не удваивает находки", () => {
    const index = new WorkspaceIndex();
    const source = body(["  Target(1, 2, 3, 4);"]);

    index.registerWorkspaceFiles([MAIN]);

    const engine = new RslDiagnosticEngine();
    const first = engine.buildLocal(index.updateOpenModule(MAIN, source, 1), index);
    const second = engine.buildLocal(index.updateOpenModule(MAIN, source, 2), index);

    assert.deepStrictEqual(
        second.filter(item => item.code === "argument-count").length,
        first.filter(item => item.code === "argument-count").length,
        "повторный расчёт обязан дать столько же"
    );
});

if (failed > 0) {
    console.error("\nПройдено: " + passed + "\nОшибок: " + failed);
    process.exitCode = 1;
} else {
    console.log("\nПройдено: " + passed + "\nОшибок: " + failed);
}

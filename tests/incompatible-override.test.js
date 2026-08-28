"use strict";

/**
 * Метод наследника расходится с методом базового класса.
 *
 * Компилятор такое не остановит: вызов через базовый тип просто передаст не
 * то. Найти это глазами трудно — базовый класс обычно в другом файле, — а
 * обнаруживается оно на рабочем месте.
 *
 * На проверенном проекте правило нашло 15 расхождений в 9 файлах из 3000, и
 * все они в одной иерархии панелей: сигнатуры разошлись при правках наследника.
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

const MAIN = "file:///d:/override/main.mac";
const LIBRARY = "file:///d:/override/library.mac";
const OTHER = "file:///d:/override/other/library.mac";

function findings(source, options = {}) {
    const index = new WorkspaceIndex();
    const files = [MAIN, LIBRARY];

    if (options.duplicateLibrary) {
        files.push(OTHER);
    }

    index.registerWorkspaceFiles(files);

    if (options.library) {
        /* Подробная модель: сравнивать можно только с ней. */
        index.updateOpenModule(LIBRARY, options.library, 1);
    }

    if (options.duplicateLibrary) {
        index.updateOpenModule(OTHER, options.duplicateLibrary, 1);
    }

    const module = index.updateOpenModule(MAIN, source, 1);

    return new RslDiagnosticEngine()
        .buildLocal(module, index, options.settings)
        .filter(item => item.code === "incompatible-override");
}

const SAME_FILE = [
    "Class Base",
    "  Macro Handle(document, options)",
    "    return document;",
    "  End;",
    "  Macro Same(one)",
    "    return one;",
    "  End;",
    "End;",
    "",
    "Class(Base) Child",
    "  Macro Handle(document)",
    "    return document;",
    "  End;",
    "  Macro Same(one)",
    "    return one;",
    "  End;",
    "End;",
    ""
].join("\n");

test("другое число параметров находится", () => {
    const found = findings(SAME_FILE);

    assert.strictEqual(found.length, 1, "одна находка");
    assert.strictEqual(found[0].severity, 2, "по умолчанию предупреждение");
    assert.ok(
        found[0].message.includes("1 против 2"),
        "сообщение обязано называть оба числа: " + found[0].message
    );
    assert.strictEqual(
        found[0].range.start.line,
        10,
        "подчёркивается имя метода наследника"
    );
});

test("совпадающая сигнатура молчит", () => {
    const source = [
        "Class Base",
        "  Macro Handle(document, options)",
        "    return document;",
        "  End;",
        "End;",
        "",
        "Class(Base) Child",
        "  Macro Handle(document, options)",
        "    return options;",
        "  End;",
        "End;",
        ""
    ].join("\n");

    assert.deepStrictEqual(findings(source), []);
});

test("другая передача по ссылке находится", () => {
    const source = [
        "Class Base",
        "  Macro Ref(@value)",
        "    return value;",
        "  End;",
        "End;",
        "",
        "Class(Base) Child",
        "  Macro Ref(value)",
        "    return value;",
        "  End;",
        "End;",
        ""
    ].join("\n");
    const found = findings(source);

    assert.strictEqual(found.length, 1);
    assert.ok(
        found[0].message.includes("по ссылке"),
        found[0].message
    );
});

test("базовый класс в другом файле тоже сравнивается", () => {
    const source = [
        "Import library;",
        "",
        "Class(Base) Child",
        "  Macro Handle(document)",
        "    return document;",
        "  End;",
        "End;",
        ""
    ].join("\n");
    const found = findings(source, {
        library: [
            "Class Base",
            "  Macro Handle(document, options)",
            "    return document;",
            "  End;",
            "End;",
            ""
        ].join("\n")
    });

    assert.strictEqual(found.length, 1, "сигнатура из зависимости учтена");
});

test("неоднозначный базовый класс: правило молчит", () => {
    const library = [
        "Class Base",
        "  Macro Handle(document, options)",
        "    return document;",
        "  End;",
        "End;",
        ""
    ].join("\n");
    const source = [
        "Import library;",
        "",
        "Class(Base) Child",
        "  Macro Handle(document)",
        "    return document;",
        "  End;",
        "End;",
        ""
    ].join("\n");

    assert.deepStrictEqual(
        findings(source, { library, duplicateLibrary: library }),
        [],
        "два одноимённых класса — сравнивать не с чем"
    );
});

test("незагруженный базовый класс: правило молчит", () => {
    const source = [
        "Import library;",
        "",
        "Class(Base) Child",
        "  Macro Handle(document)",
        "    return document;",
        "  End;",
        "End;",
        ""
    ].join("\n");

    assert.deepStrictEqual(
        findings(source),
        [],
        "без подробной модели базового класса сравнивать нечего"
    );
});

test("метод, которого в базовом классе нет, не проверяется", () => {
    const source = [
        "Class Base",
        "  Macro Handle(document)",
        "    return document;",
        "  End;",
        "End;",
        "",
        "Class(Base) Child",
        "  Macro OwnMethod(one, two, three)",
        "    return one;",
        "  End;",
        "End;",
        ""
    ].join("\n");

    assert.deepStrictEqual(findings(source), []);
});

test("правило выключается и меняет уровень", () => {
    assert.deepStrictEqual(
        findings(SAME_FILE, { settings: { incompatibleOverride: false } }),
        []
    );
    assert.deepStrictEqual(
        findings(SAME_FILE, {
            settings: { rules: { "incompatible-override": "none" } }
        }),
        []
    );
    assert.strictEqual(
        findings(SAME_FILE, {
            settings: { rules: { "incompatible-override": "error" } }
        })[0].severity,
        1
    );
});

test("подавление комментарием действует", () => {
    const source = [
        "Class Base",
        "  Macro Handle(document, options)",
        "    return document;",
        "  End;",
        "End;",
        "",
        "Class(Base) Child",
        "  // rsl-disable-next-line incompatible-override",
        "  Macro Handle(document)",
        "    return document;",
        "  End;",
        "End;",
        ""
    ].join("\n");

    assert.deepStrictEqual(findings(source), []);
});

test("повторный анализ не удваивает находки", () => {
    assert.strictEqual(findings(SAME_FILE).length, findings(SAME_FILE).length);
});

if (failed > 0) {
    console.error("\nПройдено: " + passed + "\nОшибок: " + failed);
    process.exitCode = 1;
} else {
    console.log("\nПройдено: " + passed + "\nОшибок: " + failed);
}

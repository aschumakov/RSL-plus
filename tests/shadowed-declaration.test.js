"use strict";

/**
 * Объявление закрывает собой другое, видимое в том же месте.
 *
 * Правило выключено по умолчанию и говорит подсказкой: затенение — приём
 * законный, и на чужом коде поток таких сообщений мешал бы больше, чем помогал.
 *
 * Что проверяется и почему именно это — решено замером на проекте макросов.
 * Закрытая глобальная переменная подключённого модуля из проверки исключена:
 * таких находок было 624 из 679, а 379 приходилось на одно имя SQL — объявить
 * у себя `Var SQL` здесь обычное дело. Осталось 81 сообщение в 29 файлах из
 * 868, и просмотренные — настоящие: параметр `ismale` в KFGD_acb.mac закрывает
 * макрос `ismale` из EVRAZ_LIB, а `GetDescription(pDoc)` в CLASS_CP.mac —
 * поле `pDoc` своего же класса.
 *
 * Третий случай — переменная поверх параметра той же процедуры — сюда не
 * входит: отдельной области у параметров в RSL нет, и о таком объявлении уже
 * сообщает duplicate-declaration.
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

const MAIN = "file:///d:/shadow/main.mac";
const LIBRARY = "file:///d:/shadow/library.mac";
const OTHER = "file:///d:/shadow/other/library.mac";

/** Сообщения правила; по умолчанию оно включается, иначе тест ничего не видит. */
function diagnostics(lines, options = {}) {
    const index = new WorkspaceIndex();
    const files = [MAIN, LIBRARY];

    if (options.duplicateLibrary) {
        files.push(OTHER);
    }

    index.registerWorkspaceFiles(files);

    if (options.library) {
        index.updateOpenModule(LIBRARY, options.library, 1);
    }

    if (options.duplicateLibrary) {
        index.updateOpenModule(OTHER, options.duplicateLibrary, 1);
    }

    const module = index.updateOpenModule(MAIN, lines.join("\n") + "\n", 1);
    const settings = options.settings === undefined
        ? { shadowedDeclaration: true }
        : options.settings;

    return new RslDiagnosticEngine()
        .buildLocal(module, index, settings)
        .filter(item => item.code === "shadowed-declaration");
}

/** Только тексты сообщений: так виднее, о чём именно говорит правило. */
function messages(lines, options) {
    return diagnostics(lines, options).map(item => item.message);
}

const CLASS_FIELD = [
    "Class Panel",
    "  Var caption;",
    "  Macro Show(other)",
    "    Var caption;",
    "    caption = other;",
    "    return caption;",
    "  End;",
    "End;"
];

test("переменная метода закрывает поле своего класса", () => {
    const found = diagnostics(CLASS_FIELD);

    assert.strictEqual(found.length, 1, "одна находка");
    assert.strictEqual(found[0].severity, 3, "по умолчанию подсказка");
    assert.ok(
        found[0].message.includes("caption") &&
        found[0].message.includes("Panel"),
        "сообщение обязано назвать имя и класс: " + found[0].message
    );
    assert.strictEqual(found[0].range.start.line, 3, "подчёркивается объявление");
});

test("параметр метода тоже закрывает поле класса", () => {
    assert.deepStrictEqual(
        messages([
            "Class Panel",
            "  Var caption;",
            "  Macro Show(caption)",
            "    return caption;",
            "  End;",
            "End;"
        ]),
        ["caption закрывает собой поле класса Panel"]
    );
});

test("правило выключено по умолчанию", () => {
    assert.deepStrictEqual(
        diagnostics(CLASS_FIELD, { settings: {} }),
        [],
        "без настройки правило молчит"
    );
    assert.deepStrictEqual(
        diagnostics(CLASS_FIELD, { settings: { shadowedDeclaration: false } }),
        [],
        "и выключенное молчит"
    );
});

test("разные имена молчат", () => {
    assert.deepStrictEqual(
        messages([
            "Class Panel",
            "  Var caption;",
            "  Macro Show(other)",
            "    Var title;",
            "    return title + other;",
            "  End;",
            "End;"
        ]),
        []
    );
});

test("поле чужого класса не считается закрытым", () => {
    assert.deepStrictEqual(
        messages([
            "Class First",
            "  Var caption;",
            "End;",
            "",
            "Class Second",
            "  Macro Show()",
            "    Var caption;",
            "    return caption;",
            "  End;",
            "End;"
        ]),
        [],
        "поле видно только внутри своего класса"
    );
});

test("объявление закрывает процедуру подключённого модуля", () => {
    const found = messages([
        "Import library;",
        "",
        "Macro Run(ismale)",
        "  return ismale;",
        "End;"
    ], {
        library: "Macro ismale(id)\n  return id;\nEnd;\n"
    });

    assert.deepStrictEqual(found, ["ismale закрывает собой имя из модуля library"]);
});

test("закрытая глобальная переменная модуля молчит", () => {
    assert.deepStrictEqual(
        messages([
            "Import library;",
            "",
            "Macro Run()",
            "  Var SQL;",
            "  SQL = 1;",
            "  return SQL;",
            "End;"
        ], {
            library: "Var SQL;\nMacro Helper()\n  return SQL;\nEnd;\n"
        }),
        [],
        "объявить свой SQL при глобальном SQL — обычное дело: см. заголовок"
    );
});

test("приватное имя модуля закрытым не считается", () => {
    assert.deepStrictEqual(
        messages([
            "Import library;",
            "",
            "Macro Run(hidden)",
            "  return hidden;",
            "End;"
        ], {
            library: "Private Macro hidden(id)\n  return id;\nEnd;\n"
        }),
        [],
        "приватное имя отсюда и так не видно"
    );
});

test("неоднозначное имя из двух модулей молчит", () => {
    const library = "Macro Helper(id)\n  return id;\nEnd;\n";

    assert.deepStrictEqual(
        messages([
            "Import library;",
            "",
            "Macro Run(Helper)",
            "  return Helper;",
            "End;"
        ], { library, duplicateLibrary: library }),
        [],
        "какой из двух модулей назвать — неизвестно, и об этом говорит своя проверка"
    );
});

test("имя из неподключённого модуля закрытым не считается", () => {
    assert.deepStrictEqual(
        messages([
            "Macro Run(ismale)",
            "  return ismale;",
            "End;"
        ], {
            library: "Macro ismale(id)\n  return id;\nEnd;\n"
        }),
        [],
        "без Import имя сюда не приходит"
    );
});

test("переменная поверх параметра остаётся за duplicate-declaration", () => {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN]);

    const source = [
        "Macro Run(value)",
        "  Var value;",
        "  return value;",
        "End;",
        ""
    ].join("\n");
    const found = new RslDiagnosticEngine().buildLocal(
        index.updateOpenModule(MAIN, source, 1),
        index,
        { shadowedDeclaration: true }
    );

    assert.deepStrictEqual(
        found.filter(item => item.code === "shadowed-declaration"),
        [],
        "второго сообщения об одном и том же быть не должно"
    );
    assert.strictEqual(
        found.filter(item => item.code === "duplicate-declaration").length,
        1,
        "об этом говорит duplicate-declaration"
    );
});

test("уровень меняется настройкой", () => {
    assert.deepStrictEqual(
        diagnostics(CLASS_FIELD, {
            settings: {
                shadowedDeclaration: true,
                rules: { "shadowed-declaration": "none" }
            }
        }),
        [],
        "уровень none выключает проверку"
    );
    assert.strictEqual(
        diagnostics(CLASS_FIELD, {
            settings: {
                shadowedDeclaration: true,
                rules: { "shadowed-declaration": "warning" }
            }
        })[0].severity,
        2
    );
});

test("подавление комментарием действует", () => {
    assert.deepStrictEqual(
        messages([
            "Class Panel",
            "  Var caption;",
            "  Macro Show(other)",
            "    // rsl-disable-next-line shadowed-declaration",
            "    Var caption;",
            "    caption = other;",
            "    return caption;",
            "  End;",
            "End;"
        ]),
        []
    );
});

test("повторный анализ не удваивает находки", () => {
    assert.strictEqual(
        diagnostics(CLASS_FIELD).length,
        diagnostics(CLASS_FIELD).length
    );
});

if (failed > 0) {
    console.error("\nПройдено: " + passed + "\nОшибок: " + failed);
    process.exitCode = 1;
} else {
    console.log("\nПройдено: " + passed + "\nОшибок: " + failed);
}

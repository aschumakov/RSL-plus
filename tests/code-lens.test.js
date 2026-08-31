"use strict";

/**
 * Строка над Macro и Class.
 *
 * Счёт идёт по этому файлу, и это решено замером. Точный проектный счёт одного
 * объявления на проекте из 2826 файлов занял от 40 мс до 3,4 с — редактор же
 * спрашивает строку сразу для всех видимых объявлений. Дешёвая замена, «в
 * скольких файлах имя упоминается», тоже не подошла: вывод «не упоминается»
 * имеет право делать только сверенная с диском запись, а сверка стоит одного
 * чтения на файл, то есть первого же обхода всего проекта.
 *
 * Поэтому цифра честно про файл, а за проектным ответом строка ведёт в
 * References и Call Hierarchy.
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
    buildRslCodeLenses,
    RSL_SHOW_CALL_HIERARCHY_COMMAND,
    RSL_SHOW_REFERENCES_COMMAND
} = require("../server/out/features/codeLensProvider");

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

const MAIN = "file:///d:/lens/main.mac";

function lenses(lines) {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN]);

    return buildRslCodeLenses(
        index.updateOpenModule(MAIN, lines.join("\n") + "\n", 1)
    );
}

/** Заголовки строк счёта, по одной на объявление. */
function counts(lines) {
    return lenses(lines)
        .filter(lens => lens.command.command === RSL_SHOW_REFERENCES_COMMAND)
        .map(lens => lens.command.title);
}

const SOURCE = [
    "Macro Helper(value)",
    "  return value;",
    "End;",
    "",
    "Macro First()",
    "  return Helper(1);",
    "End;",
    "",
    "Macro Second()",
    "  return Helper(2) + Helper(3);",
    "End;",
    "",
    "Macro Lonely()",
    "  return 0;",
    "End;"
];

test("счёт использований и процедур", () => {
    assert.deepStrictEqual(
        counts(SOURCE),
        [
            "вхождений в файле: 3, процедур: 2",
            "в этом файле не встречается",
            "в этом файле не встречается",
            "в этом файле не встречается"
        ]
    );
});

test("на каждое объявление приходится две строки", () => {
    const all = lenses(SOURCE);

    assert.strictEqual(all.length, 8, "четыре объявления по две строки");
    assert.deepStrictEqual(
        [...new Set(all.map(lens => lens.command.command))].sort(),
        [RSL_SHOW_CALL_HIERARCHY_COMMAND, RSL_SHOW_REFERENCES_COMMAND].sort()
    );
});

test("строка указывает на имя объявления", () => {
    const first = lenses(SOURCE)[0];

    assert.strictEqual(first.range.start.line, 0);
    assert.strictEqual(
        first.range.start.character,
        "Macro ".length,
        "строка встаёт над именем, а не над словом Macro"
    );
    assert.deepStrictEqual(
        first.command.arguments,
        [MAIN, first.range.start],
        "команде передаются файл и позиция"
    );
});

test("обращение к члену объекта не считается", () => {
    assert.deepStrictEqual(
        counts([
            "Macro Handle(value)",
            "  return value;",
            "End;",
            "",
            "Macro Run(document)",
            "  return document.Handle(1);",
            "End;"
        ]),
        ["в этом файле не встречается", "в этом файле не встречается"],
        "document.Handle — другое имя"
    );
});

test("класс тоже получает строку", () => {
    const found = counts([
        "Class Panel",
        "  Macro Show()",
        "    return 1;",
        "  End;",
        "End;",
        "",
        "Macro Run()",
        "  Var p = Panel();",
        "  return p;",
        "End;"
    ]);

    assert.strictEqual(found.length, 3, "класс, его метод и процедура");
    assert.strictEqual(found[0], "вхождений в файле: 1, процедур: 1", "класс");
});

test("собственное объявление в счёт не идёт", () => {
    assert.deepStrictEqual(
        counts([
            "Macro Alone()",
            "  return 1;",
            "End;"
        ]),
        ["в этом файле не встречается"]
    );
});

test("рекурсивный вызов считается", () => {
    assert.deepStrictEqual(
        counts([
            "Macro Loop(value)",
            "  return Loop(value - 1);",
            "End;"
        ]),
        ["вхождений в файле: 1"],
        "вызов из самой себя — использование, но не чужая процедура"
    );
});

test("локальное имя, затеняющее процедуру, в счёт не идёт", () => {
    /*
     * Прежде `Var Foo = 1; Foo = 2; return Foo;` внутри чужой процедуры
     * показывалось как три использования процедуры Foo. Там это имя значит
     * переменную, и к процедуре отношения не имеет.
     */
    assert.deepStrictEqual(
        counts([
            "Macro Foo(value)",
            "  return value;",
            "End;",
            "",
            "Macro Shadowed()",
            "  Var Foo = 1;",
            "  Foo = 2;",
            "  return Foo;",
            "End;",
            "",
            "Macro Caller()",
            "  return Foo(1);",
            "End;"
        ]),
        [
            "вхождений в файле: 1, процедур: 1",
            "в этом файле не встречается",
            "в этом файле не встречается"
        ],
        "считается только настоящий вызов из Caller"
    );
});

test("параметр, затеняющий процедуру, в счёт не идёт", () => {
    assert.deepStrictEqual(
        counts([
            "Macro Foo(value)",
            "  return value;",
            "End;",
            "",
            "Macro Shadowed(Foo)",
            "  return Foo;",
            "End;"
        ]),
        ["в этом файле не встречается", "в этом файле не встречается"]
    );
});

test("файл без объявлений строк не даёт", () => {
    assert.deepStrictEqual(lenses(["Var moduleLevel = 1;"]), []);
});

if (failed > 0) {
    console.error("\nПройдено: " + passed + "\nОшибок: " + failed);
    process.exitCode = 1;
} else {
    console.log("\nПройдено: " + passed + "\nОшибок: " + failed);
}

"use strict";

/**
 * Необязательная настройка проекта и заглушки внешних модулей.
 *
 * Главное требование — без файла настройки поведение прежнее. Появление
 * возможности настроить обход не должно менять умолчание.
 *
 * Второе — негодный файл не проходит молча. Опечатка в имени поля означает,
 * что настройка выглядит записанной, а не действует, и промолчать значило бы
 * незаметно не дать пользователю того, чего он просил.
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
    isExcludedByRslConfig,
    parseRslProjectConfig
} = require("../server/out/config/projectConfig");
const { buildRslModuleStub } = require("../server/out/features/stubGenerator");
const { createOpenModuleModel } = require("../server/out/moduleModel");
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

test("полная настройка читается", () => {
    const answer = parseRslProjectConfig(JSON.stringify({
        moduleRoots: ["macro", "custom"],
        exclude: ["archive/**", "old/**"],
        stubPaths: [".rslplus/stubs"]
    }));

    assert.deepStrictEqual(answer.problems, []);
    assert.deepStrictEqual(answer.config.moduleRoots, ["macro", "custom"]);
    assert.deepStrictEqual(answer.config.exclude, ["archive/**", "old/**"]);
    assert.deepStrictEqual(answer.config.stubPaths, [".rslplus/stubs"]);
});

test("пустой объект даёт умолчания", () => {
    const answer = parseRslProjectConfig("{}");

    assert.deepStrictEqual(answer.problems, []);
    assert.deepStrictEqual(answer.config.moduleRoots, []);
    assert.deepStrictEqual(answer.config.exclude, []);
});

test("опечатка в имени поля не проходит молча", () => {
    const answer = parseRslProjectConfig(JSON.stringify({
        moduleRoot: ["macro"]
    }));

    assert.deepStrictEqual(
        answer.problems,
        ["Неизвестное поле: moduleRoot"],
        "настройка выглядит записанной, а не действует"
    );
});

test("сломанный JSON не проходит молча", () => {
    const answer = parseRslProjectConfig("{ moduleRoots: ");

    assert.strictEqual(answer.problems.length, 1);
    assert.ok(answer.problems[0].includes("не разбирается"));
    assert.deepStrictEqual(
        answer.config.moduleRoots,
        [],
        "при негодном файле остаются умолчания"
    );
});

test("неверный тип поля называется", () => {
    const answer = parseRslProjectConfig(JSON.stringify({
        exclude: "archive/**"
    }));

    assert.deepStrictEqual(answer.problems, [
        "exclude: ожидался список строк"
    ]);
});

test("dialect больше не публичная настройка", () => {
    /*
     * Поле читалось, проверялось и не меняло ровно ничего. Публичная
     * настройка, которая молча ничего не делает, хуже её отсутствия:
     * пользователь пишет её и ждёт эффекта. Теперь про неё сказано как
     * про любое неизвестное поле.
     */
    const answer = parseRslProjectConfig(JSON.stringify({
        dialect: "rsBank"
    }));

    assert.deepStrictEqual(
        answer.problems,
        ["Неизвестное поле: dialect"]
    );
});

const PATTERNS = ["archive/**", "old/**", "*.bak.mac"];

test("шаблоны исключения работают", () => {
    assert.ok(isExcludedByRslConfig("archive/2020/a.mac", PATTERNS));
    assert.ok(isExcludedByRslConfig("archive", PATTERNS), "и сам каталог");
    assert.ok(isExcludedByRslConfig("old/a.mac", PATTERNS));
    assert.ok(isExcludedByRslConfig("lib.bak.mac", PATTERNS));
});

test("лишнего шаблоны не исключают", () => {
    assert.ok(!isExcludedByRslConfig("macro/a.mac", PATTERNS));
    assert.ok(!isExcludedByRslConfig("archived/a.mac", PATTERNS));
    assert.ok(!isExcludedByRslConfig("sub/old/a.mac", PATTERNS));
});

test("без шаблонов не исключается ничего", () => {
    assert.ok(!isExcludedByRslConfig("archive/a.mac", []));
});

test("разделитель пути значения не имеет", () => {
    assert.ok(isExcludedByRslConfig("archive\\2020\\a.mac", PATTERNS));
});

const SOURCE = [
    "Import shared;",
    "",
    "Const LIMIT = 10;",
    "Var moduleLevel: String;",
    "",
    "Macro Send(document: TBFile, silent): Number",
    "  Var local = 1;",
    "  return local;",
    "End;",
    "",
    "Private Macro Hidden(x)",
    "End;",
    "",
    "Class (TBase) THolder",
    "  Var Code: String;",
    "  Macro Load(id)",
    "    return id;",
    "  End;",
    "End;",
    ""
].join("\n");

/** Заглушка модуля по его тексту. */
function stub(source) {
    const uri = "file:///d:/stub/lib.mac";
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([uri]);
    index.updateOpenModule(uri, source, 1);

    return buildRslModuleStub(index.getModule(uri));
}

test("заглушка содержит внешне видимое", () => {
    const text = stub(SOURCE);

    assert.ok(text.includes("Import shared;"), "Import");
    assert.ok(text.includes("Const LIMIT = 10;"), "константа со значением");
    assert.ok(
        /var moduleLevel: string;/iu.test(text),
        "переменная с типом; регистр имени типа в RSL значения не имеет"
    );
    assert.ok(
        text.includes("Macro Send(document: TBFile, silent): Number"),
        "подпись и тип результата: " + text
    );
    assert.ok(text.includes("Class (TBase) THolder"), "класс с базовым");
    assert.ok(text.includes("Macro Load(id)"), "метод класса");
});

test("тел и приватного в заглушке нет", () => {
    const text = stub(SOURCE);

    assert.ok(!text.includes("Hidden"), "приватная процедура снаружи не видна");
    assert.ok(!text.includes("Var local"), "тело в заглушку не входит");
    assert.ok(!text.includes("return"), "и возврат тоже");
});

test("заглушка разбирается как обычный модуль", () => {
    /*
     * Это и есть смысл заглушки: для сервера она такой же файл проекта, и
     * подсказка, переход и вывод типа работают по ней сами.
     */
    const model = createOpenModuleModel(stub(SOURCE));
    const names = model.symbolTree.children.map(symbol => symbol.name).sort();

    assert.deepStrictEqual(
        names,
        ["LIMIT", "Send", "THolder", "moduleLevel"]
    );
    assert.deepStrictEqual(model.imports, ["shared"]);
});

console.log(
    failed === 0
        ? "\nПройдено: " + passed
        : "\nПройдено: " + passed + ", провалено: " + failed
);

if (failed > 0) {
    process.exitCode = 1;
}

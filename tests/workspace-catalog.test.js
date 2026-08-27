"use strict";

/**
 * Постоянный каталог проекта: полнота и повторяемость.
 *
 * Ctrl+T прежде перебирал загруженные модули в порядке Map и останавливался на
 * двухсотом совпадении — до сортировки. Состав ответа зависел от того, в каком
 * порядке файлы попали в память, а вытесненные модели пропадали из ответа
 * совсем. Каталог отвечает за оба свойства и живёт отдельно от LRU моделей.
 */

const assert = require("assert");

const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const {
    findRslWorkspaceSymbols
} = require("../server/out/features/workspaceSymbolProvider");

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

function moduleSource(index) {
    return [
        "Macro Handler" + index + "(value)",
        "  return value;",
        "End;",
        "Class Holder" + index,
        "  Var Field" + index + ";",
        "End;",
        ""
    ].join("\n");
}

/** Проект из count файлов, загруженных в заданном порядке. */
function buildProject(count, order) {
    const index = new WorkspaceIndex({ maxExternalModules: 40 });
    const uris = [];

    for (let file = 0; file < count; file++) {
        uris.push("file:///d:/project/module" + String(file).padStart(4, "0") + ".mac");
    }

    index.registerWorkspaceFiles(uris);

    for (const position of order(uris.length)) {
        index.updateExternalModule(uris[position], moduleSource(position), 1);
    }

    return index;
}

const FORWARD = length => Array.from({ length }, (_, index) => index);
const BACKWARD = length => FORWARD(length).reverse();
const SHUFFLED = length => {
    /* Детерминированная «случайность»: тест обязан быть повторяемым. */
    const values = FORWARD(length);

    for (let index = values.length - 1; index > 0; index--) {
        const swap = (index * 7 + 3) % (index + 1);
        [values[index], values[swap]] = [values[swap], values[index]];
    }

    return values;
};

test("состав ответа не зависит от порядка загрузки файлов", () => {
    const query = "Handler";
    const answers = [FORWARD, BACKWARD, SHUFFLED].map(order =>
        findRslWorkspaceSymbols(buildProject(120, order), query)
            .map(item => item.name + "@" + item.location.uri)
    );

    assert.ok(answers[0].length > 0, "ответ обязан быть непустым");
    assert.deepStrictEqual(
        answers[1],
        answers[0],
        "обратный порядок загрузки не имеет права менять ответ"
    );
    assert.deepStrictEqual(
        answers[2],
        answers[0],
        "перемешанный порядок загрузки — тоже"
    );
});

test("вытесненная модель остаётся в ответе", () => {
    /*
     * Лимит подробных моделей — сорок, файлов сто двадцать. Прежде первые
     * восемьдесят исчезали из Ctrl+T вместе с моделью.
     */
    const index = buildProject(120, FORWARD);

    assert.ok(
        index.getIndexedModules().length <= 40,
        "подробные модели обязаны вытесняться: " +
            index.getIndexedModules().length
    );

    const found = findRslWorkspaceSymbols(index, "Handler1");
    const first = found[0];

    assert.ok(first, "ответ обязан быть непустым");
    assert.strictEqual(
        first.name,
        "Handler1",
        "точное имя обязано идти первым"
    );
    assert.strictEqual(
        first.location.uri,
        "file:///d:/project/module0001.mac",
        "символ вытесненного файла обязан находиться"
    );
    assert.ok(
        !index.getModule(first.location.uri),
        "этот модуль обязан быть вытеснен из подробных моделей"
    );
});

test("сортировка идёт до лимита: точное имя впереди", () => {
    const index = new WorkspaceIndex();
    const uris = [
        "file:///d:/project/zzz.mac",
        "file:///d:/project/aaa.mac"
    ];
    index.registerWorkspaceFiles(uris);
    /* Точное совпадение лежит в файле, который загружен последним. */
    index.updateExternalModule(uris[0], "Macro ValueHolder()\nEnd;\n", 1);
    index.updateExternalModule(uris[1], "Macro Value()\nEnd;\n", 1);

    assert.deepStrictEqual(
        findRslWorkspaceSymbols(index, "Value").map(item => item.name),
        ["Value", "ValueHolder"],
        "точное имя обязано идти первым независимо от порядка загрузки"
    );
});

test("удалённый из проекта файл уходит из каталога", () => {
    const index = new WorkspaceIndex();
    const uri = "file:///d:/project/gone.mac";
    index.registerWorkspaceFiles([uri]);
    index.updateExternalModule(uri, "Macro Gone()\nEnd;\n", 1);

    assert.strictEqual(findRslWorkspaceSymbols(index, "Gone").length, 1);

    index.unregisterWorkspaceFile(uri);

    assert.deepStrictEqual(
        findRslWorkspaceSymbols(index, "Gone"),
        [],
        "файла нет в проекте — и записи о нём быть не должно"
    );
});

test("каталог знает наследников класса и экспортирующие модули", () => {
    const index = new WorkspaceIndex();
    const base = "file:///d:/project/base.mac";
    const child = "file:///d:/project/child.mac";
    index.registerWorkspaceFiles([base, child]);
    index.updateExternalModule(base, "Class Base\n  Var Field;\nEnd;\n", 1);
    index.updateExternalModule(
        child,
        "Import base;\nClass(Base) Child\n  Var Own;\nEnd;\n",
        1
    );

    assert.deepStrictEqual(
        index.catalog.implementationsOf("Base").map(item => item.name),
        ["Child"]
    );
    assert.deepStrictEqual(
        index.catalog.modulesExporting("Base"),
        [base]
    );
});

test("порядок ответа не зависит от способа отбора", () => {
    /*
     * Поиск раскладывает совпадения по корзинам ранга и сортирует только ту,
     * что попадает в ответ, а самую дорогую проверку — подпоследовательность —
     * пропускает, когда лучших совпадений уже набралось на весь лимит. Ответ
     * от этого меняться не должен: ни составом, ни порядком.
     */
    const index = new WorkspaceIndex();
    const uris = [];

    for (let file = 0; file < 40; file++) {
        uris.push("file:///d:/project/module" + file + ".mac");
    }

    index.registerWorkspaceFiles(uris);

    for (let file = 0; file < 40; file++) {
        index.updateExternalModule(
            uris[file],
            [
                "Macro Check" + file + "()",
                "End;",
                "Macro PrepareCheck" + file + "()",
                "End;",
                "Macro CalculateHugeCost" + file + "()",
                "End;",
                ""
            ].join(String.fromCharCode(10)),
            1
        );
    }

    /* Точных и префиксных совпадений больше лимита: хвост не нужен. */
    const narrow = index.catalog.find("check", 5).map(item => item.name);

    assert.strictEqual(narrow.length, 5);
    assert.deepStrictEqual(
        narrow,
        [...narrow].sort((left, right) =>
            left.toLowerCase().localeCompare(right.toLowerCase())),
        "внутри одного ранга ответ упорядочен по имени: " + narrow.join(", ")
    );

    /* Совпадение только подпоследовательностью обязано находиться. */
    const sparse = index.catalog.find("cek", 10).map(item => item.name);

    assert.ok(
        sparse.length > 0 && sparse.every(name => /Check/.test(name)),
        "подпоследовательность найдена: " + sparse.join(", ")
    );

    /* Лимит больше числа совпадений: отбор не теряет ничего. */
    const all = index.catalog.find("CalculateHugeCost", 100);

    assert.strictEqual(all.length, 40, "нашлись все одноимённые");
});

if (failed > 0) {
    console.error(`\nПройдено: ${passed}\nОшибок: ${failed}`);
    process.exitCode = 1;
} else {
    console.log(`\nПройдено: ${passed}\nОшибок: ${failed}`);
}

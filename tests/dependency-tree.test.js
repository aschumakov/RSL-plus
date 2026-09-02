"use strict";

/**
 * Дерево зависимостей проекта.
 *
 * Import-граф у сервера был, а пользователю его видно не было: почему имя
 * доступно, чего не хватает и от чего зависит файл, приходилось выяснять
 * чтением кода.
 *
 * Проверяется то, ради чего дерево и заведено: недостающее и неоднозначное
 * видно наравне с найденным, цикл не уводит обход в бесконечность, а уровень
 * считается по одному — дерево проекта целиком не строится.
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
    buildRslDependencyLevel,
    findRslDependencyPath,
    findRslImportRange
} = require("../server/out/features/dependencyTree");
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

const MAIN = "file:///d:/tree/payment.mac";
const COMMON = "file:///d:/tree/common.mac";
const UTILS = "file:///d:/tree/utils.mac";
const CARDS_ONE = "file:///d:/tree/a/cards.mac";
const CARDS_TWO = "file:///d:/tree/b/cards.mac";

/** Проект: payment -> common -> utils, плюс неоднозначное и недостающее. */
function project() {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN, COMMON, UTILS, CARDS_ONE, CARDS_TWO]);
    index.updateExternalModule(UTILS, "Macro Util()\nEnd;\n", 1);
    index.updateExternalModule(COMMON, "Import utils;\nMacro Common()\nEnd;\n", 1);
    index.updateExternalModule(CARDS_ONE, "Macro CardsOne()\nEnd;\n", 1);
    index.updateExternalModule(CARDS_TWO, "Macro CardsTwo()\nEnd;\n", 1);
    index.updateOpenModule(
        MAIN,
        "Import common, cards, missing, SomeInter;\nMacro Run()\nEnd;\n",
        1
    );

    return index;
}

const PLATFORM = new Set(["someinter"]);

function level(index, uri, options = {}) {
    return buildRslDependencyLevel(
        {
            index,
            knowsPlatformModule: name => PLATFORM.has(name.toLowerCase())
        },
        { uri, ...options }
    );
}

test("уровень показывает все виды зависимостей", () => {
    const nodes = level(project(), MAIN);
    const byName = new Map(nodes.map(node => [node.name, node.state]));

    assert.strictEqual(byName.get("common"), "resolved");
    assert.strictEqual(byName.get("cards"), "ambiguous", "два файла с этим именем");
    assert.strictEqual(byName.get("missing"), "missing");
    assert.strictEqual(byName.get("SomeInter"), "platform");
});

test("раскрывается только то, у чего есть дети", () => {
    const nodes = level(project(), MAIN);
    const common = nodes.find(node => node.name === "common");

    assert.strictEqual(common.expandable, true, "common подключает utils");

    const deeper = level(project(), common.uri);

    assert.deepStrictEqual(
        deeper.map(node => node.name),
        ["utils"]
    );
    assert.ok(
        !deeper[0].expandable,
        "у utils своих Import нет: раскрывать нечего"
    );
});

test("уровень считается по одному, а не всё дерево", () => {
    /*
     * Обход всего проекта здесь недопустим: на 6166 файлах это тысячи узлов,
     * из которых пользователь раскроет пять. Признак — utils в ответе на
     * запрос про payment не появляется.
     */
    const nodes = level(project(), MAIN);

    assert.ok(
        !nodes.some(node => node.name === "utils"),
        "транзитивная зависимость на первом уровне не показывается"
    );
});

test("цикл не уводит обход в бесконечность", () => {
    const index = project();

    index.updateExternalModule(UTILS, "Import payment;\nMacro Util()\nEnd;\n", 2);

    const nodes = buildRslDependencyLevel(
        { index },
        { uri: UTILS, ancestors: [MAIN, COMMON] }
    );
    const back = nodes.find(node => node.name === "payment");

    assert.ok(back, "обратная ссылка показана");
    assert.strictEqual(back.cycle, true, "и помечена циклом");
    assert.ok(!back.expandable, "раскрывать её нельзя");
});

test("обратные зависимости показывают, кто ссылается", () => {
    const nodes = level(project(), COMMON, { direction: "dependents" });

    assert.deepStrictEqual(
        nodes.map(node => node.uri),
        [MAIN]
    );
});

test("путь зависимости — кратчайший", () => {
    const index = project();

    assert.deepStrictEqual(
        findRslDependencyPath(index, MAIN, UTILS),
        [MAIN, COMMON, UTILS],
        "через common: другого пути нет"
    );
});

test("пути нет — пустой ответ", () => {
    assert.deepStrictEqual(
        findRslDependencyPath(project(), UTILS, MAIN),
        [],
        "utils про payment ничего не знает"
    );
});

test("незагруженный модуль отличается от недостающего", () => {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN, COMMON]);
    index.updateOpenModule(MAIN, "Import common;\nMacro Run()\nEnd;\n", 1);

    const nodes = level(index, MAIN);

    assert.strictEqual(
        nodes[0].state,
        "unloaded",
        "файл в проекте есть, но ещё не прочитан — это не отсутствие"
    );
});

test("обратные зависимости берутся из каталога, а не из загруженного", () => {
    /*
     * При обычном режиме индексации значительная часть проекта в память не
     * загружена. Ответ по графу загруженных модулей зависел бы от того, что
     * успела прочитать фоновая индексация: тот же вопрос давал бы разные
     * ответы в разные минуты работы.
     */
    const LIB = "file:///d:/tree/lib.mac";
    const MIDDLE = "file:///d:/tree/middle.mac";
    const OTHER = "file:///d:/tree/other.mac";
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN, MIDDLE, OTHER, LIB]);

    /* Только каталог: полных модулей в индексе нет. */
    const record = (uri, imports) => index.catalog.recordDeclarations({
        uri,
        version: 1,
        declarations: [],
        imports
    });

    record(LIB, []);
    record(MIDDLE, ["lib"]);
    record(OTHER, ["lib"]);
    record(MAIN, ["middle"]);

    assert.strictEqual(
        index.getModules().length,
        0,
        "полные модули ради панели не грузятся"
    );

    const nodes = level(index, LIB, { direction: "dependents" });

    assert.deepStrictEqual(
        nodes.map(node => node.uri).sort(),
        [MIDDLE, OTHER].sort(),
        "ответ полный: оба файла подключают lib"
    );
    assert.ok(
        nodes.find(node => node.uri === MIDDLE).expandable,
        "у middle свой зависимый есть — main"
    );
});

test("путь Import понимается и со строкой, и с путём", () => {
    const index = new WorkspaceIndex();
    const source = [
        "// сначала про utils в комментарии",
        'Import "sub/utils.mac";',
        "Macro Run()",
        "  return utils;",
        "End;",
        ""
    ].join("\n");

    index.registerWorkspaceFiles([MAIN]);
    index.updateOpenModule(MAIN, source, 1);

    const range = findRslImportRange({ index }, MAIN, "utils");

    assert.ok(range, "директива обязана найтись");
    assert.strictEqual(
        range.start.line,
        1,
        "это строка с Import, а не комментарий выше: " + JSON.stringify(range)
    );
});

test("имя в комментарии за директиву не принимается", () => {
    const index = new WorkspaceIndex();
    const source = [
        "// common ниже по файлу",
        "Var common = 1;",
        "Import common;",
        ""
    ].join("\n");

    index.registerWorkspaceFiles([MAIN]);
    index.updateOpenModule(MAIN, source, 1);

    const range = findRslImportRange({ index }, MAIN, "common");

    assert.strictEqual(
        range.start.line,
        2,
        "поиск подстроки привёл бы на первую строку"
    );
});

test("ненаписанный Import диапазона не имеет", () => {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN]);
    index.updateOpenModule(MAIN, "Macro Run()\nEnd;\n", 1);

    assert.strictEqual(
        findRslImportRange({ index }, MAIN, "common"),
        undefined
    );
});

const A_LIB = "file:///d:/ident/a/lib.mac";
const B_LIB = "file:///d:/ident/b/lib.mac";
const ONE = "file:///d:/ident/one.mac";
const TWO = "file:///d:/ident/two.mac";
const THREE = "file:///d:/ident/three.mac";

/**
 * Два одноимённых модуля в разных каталогах.
 *
 * one подключает a/lib, two подключает b/lib, three пишет просто lib —
 * и это неоднозначно.
 */
function identityProject() {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([A_LIB, B_LIB, ONE, TWO, THREE]);

    const record = (uri, imports) => index.catalog.recordDeclarations({
        uri,
        version: 1,
        declarations: [],
        imports
    });

    record(A_LIB, []);
    record(B_LIB, []);
    record(ONE, ["a/lib.mac"]);
    record(TWO, ["b/lib.mac"]);
    record(THREE, ["lib"]);

    return index;
}

test("зависимые различаются по пути, а не по имени файла", () => {
    const index = identityProject();
    const resolved = uri => level(index, uri, { direction: "dependents" })
        .filter(node => node.state === "resolved")
        .map(node => node.uri);

    assert.deepStrictEqual(
        resolved(A_LIB),
        [ONE],
        "two подключает b/lib и зависимым a/lib не является"
    );
    assert.deepStrictEqual(resolved(B_LIB), [TWO]);
});

test("неоднозначная ссылка помечается, а не приписывается одному", () => {
    /*
     * `Import lib` при двух файлах lib.mac ведёт сразу в оба. Выбрать
     * за пользователя один значит соврать; спрятать связь вовсе — тоже:
     * на настоящем проекте у популярного модуля три одноимённых файла,
     * и умолчание потеряло бы 1353 настоящих зависимых.
     *
     * Поэтому файл показан у обоих кандидатов и помечен неоднозначным.
     */
    const index = identityProject();

    for (const target of [A_LIB, B_LIB]) {
        const node = level(index, target, { direction: "dependents" })
            .find(item => item.uri === THREE);

        assert.ok(node, "three обязан быть виден у " + target);
        assert.strictEqual(
            node.state,
            "ambiguous",
            "и помечен: который из двух имелся в виду, не знает никто"
        );
    }
});

test("переход к Import выбирает нужную директиву", () => {
    const index = identityProject();
    const source = [
        'Import "a/lib.mac";',
        'Import "b/lib.mac";',
        "Macro Run()",
        "End;",
        ""
    ].join("\n");

    index.updateOpenModule(ONE, source, 1);

    const first = findRslImportRange({ index }, ONE, "lib", A_LIB);
    const second = findRslImportRange({ index }, ONE, "lib", B_LIB);

    assert.strictEqual(first.start.line, 0, "первая строка ведёт в a/lib");
    assert.strictEqual(second.start.line, 1, "вторая — в b/lib");
});

test("обратный индекс переживает удаление файла", () => {
    const index = identityProject();

    assert.deepStrictEqual(
        level(index, A_LIB, { direction: "dependents" })
            .filter(node => node.state === "resolved")
            .map(node => node.uri),
        [ONE]
    );

    index.catalog.remove(ONE);

    assert.deepStrictEqual(
        level(index, A_LIB, { direction: "dependents" })
            .filter(node => node.state === "resolved")
            .map(node => node.uri),
        [],
        "файла больше нет — и зависимости от него тоже"
    );
});

test("перезапись Import обновляет обратный индекс", () => {
    const index = identityProject();

    index.catalog.recordDeclarations({
        uri: ONE,
        version: 2,
        declarations: [],
        imports: ["b/lib.mac"]
    });

    const resolved = uri => level(index, uri, { direction: "dependents" })
        .filter(node => node.state === "resolved")
        .map(node => node.uri)
        .sort();

    assert.deepStrictEqual(
        resolved(A_LIB),
        [],
        "one больше не подключает a/lib"
    );
    assert.deepStrictEqual(resolved(B_LIB), [ONE, TWO].sort());
});

console.log(
    failed === 0
        ? "\nПройдено: " + passed
        : "\nПройдено: " + passed + ", провалено: " + failed
);

if (failed > 0) {
    process.exitCode = 1;
}

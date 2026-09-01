"use strict";

/**
 * Внешний интерфейс модуля отдельно от его тела.
 *
 * Соседний файл видит от модуля только Import и публичные объявления с
 * подписями, типами и базовыми классами. Что написано внутри Macro — его дело,
 * и от правки тела ни один вывод в соседнем файле не меняется.
 *
 * Проверяется два утверждения: интерфейс не замечает правок тела и замечает всё
 * внешне значимое — и ключ замыкания у зависимого файла ведёт себя так же.
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
    computeRslModuleInterface
} = require("../server/out/indexing/moduleInterface");
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

const LIB = "file:///d:/interface/lib.mac";
const USER = "file:///d:/interface/user.mac";
const OTHER = "file:///d:/interface/other.mac";

/** Отпечаток интерфейса по тексту. */
function print(source) {
    return computeRslModuleInterface(createOpenModuleModel(source)).fingerprint;
}

const BASE = [
    "Import shared;",
    "",
    "Const LIMIT = 10;",
    "",
    "Macro Send(document, silent)",
    "  Var local = document;",
    "  return local;",
    "End;",
    "",
    "Private Macro Hidden(x)",
    "  return x;",
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

/** Тот же файл с изменённым телом: снаружи ничего не поменялось. */
const BODY_CHANGED = BASE
    .replace("  Var local = document;", "  Var local = document;\n  local = 1;")
    .replace("    return id;", "    Var tmp = id;\n    return tmp;");

test("правка тела интерфейс не меняет", () => {
    assert.strictEqual(print(BODY_CHANGED), print(BASE));
});

test("правка тела приватного Macro интерфейс не меняет", () => {
    assert.strictEqual(
        print(BASE.replace("  return x;", "  return x + 1;")),
        print(BASE)
    );
});

test("подпись приватного Macro интерфейс не меняет", () => {
    assert.strictEqual(
        print(BASE.replace("Private Macro Hidden(x)", "Private Macro Hidden(x, y)")),
        print(BASE),
        "приватное имя снаружи не видно вовсе"
    );
});

test("порядок Import значения не имеет", () => {
    assert.strictEqual(
        print("Import beta, alpha;\n" + BASE.replace("Import shared;\n", "")),
        print("Import alpha, beta;\n" + BASE.replace("Import shared;\n", ""))
    );
});

test("регистр имени интерфейс не меняет", () => {
    /* RSL сравнивает имена без регистра: Send и send — одно объявление. */
    assert.strictEqual(
        print(BASE.replace("Macro Send(document, silent)", "macro SEND(Document, Silent)")),
        print(BASE)
    );
});

test("регистр литерала интерфейс меняет", () => {
    /* А значение — литерал: соседний файл показывает его как написано. */
    assert.notStrictEqual(
        print(BASE.replace("Const LIMIT = 10;", "Const LIMIT = \"да\";")),
        print(BASE.replace("Const LIMIT = 10;", "Const LIMIT = \"ДА\";"))
    );
});

test("разные интерфейсы дают разные отпечатки", () => {
    /*
     * Совпадение отпечатка означает «ничего не пересчитывать», поэтому
     * случайное совпадение у РАЗНЫХ интерфейсов — не косметическая ошибка:
     * соседний файл остался бы с устаревшими межфайловыми проверками.
     *
     * Первая версия брала два накопителя с одним множителем и постоянной
     * добавкой; они оказались связаны, и вместо заявленных 64 бит выходило
     * около 32. На настоящем проекте это давало шесть совпадений.
     */
    const prints = new Map();

    for (let index = 0; index < 4000; index++) {
        const source = [
            "Import lib" + (index % 37) + ";",
            "Const LIMIT" + (index % 11) + " = " + index + ";",
            "Macro Send" + (index % 53) + "(a" + (index % 7) + ", b)",
            "End;",
            "Class (TBase" + (index % 13) + ") THolder" + (index % 17),
            "  Var Code" + (index % 23) + ": String;",
            "End;",
            ""
        ].join("\n");
        const fingerprint = print(source);
        const known = prints.get(fingerprint);

        assert.ok(
            known === undefined || known === source,
            "совпал отпечаток у разных интерфейсов:" + "\n" + known + "\n" + source
        );
        prints.set(fingerprint, source);
    }
});

const CHANGES = [
    ["добавленный параметр", "Macro Send(document, silent)", "Macro Send(document, silent, force)"],
    ["переименованный параметр", "Macro Send(document, silent)", "Macro Send(document, quiet)"],
    ["тип параметра", "Macro Send(document, silent)", "Macro Send(document: TBFile, silent)"],
    ["новый Import", "Import shared;", "Import shared, extra;"],
    ["убранный Import", "Import shared;", ""],
    ["базовый класс", "Class (TBase) THolder", "Class (TOther) THolder"],
    ["новое публичное поле", "  Var Code: String;", "  Var Code: String;\n  Var Extra: Number;"],
    ["тип публичного поля", "  Var Code: String;", "  Var Code: Number;"],
    ["значение константы", "Const LIMIT = 10;", "Const LIMIT = 20;"],
    ["публичное стало приватным", "Macro Send(document, silent)", "Private Macro Send(document, silent)"],
    ["новый публичный Macro", "Const LIMIT = 10;", "Const LIMIT = 10;\nMacro Extra()\nEnd;"],
    ["новый метод класса", "  Macro Load(id)", "  Macro Save()\n  End;\n  Macro Load(id)"]
];

for (const [name, from, to] of CHANGES) {
    test("интерфейс меняется: " + name, () => {
        const changed = BASE.replace(from, to);

        assert.notStrictEqual(changed, BASE, "текст обязан отличаться");
        assert.notStrictEqual(
            print(changed),
            print(BASE),
            "это внешне значимое изменение"
        );
    });
}

/** Проект: user импортирует lib. */
function project() {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([LIB, USER, OTHER]);
    index.updateExternalModule(LIB, BASE, 1);
    index.updateExternalModule(OTHER, "Macro Alone()\nEnd;\n", 1);
    index.updateOpenModule(USER, "Import lib;\nMacro Run()\n  return Send(1, 0);\nEnd;\n", 1);

    return index;
}

test("ревизия интерфейса переживает правку тела зависимости", () => {
    const index = project();
    const before = index.getInterfaceRevision(LIB);

    index.updateExternalModule(LIB, BODY_CHANGED, 2);

    assert.strictEqual(
        index.getInterfaceRevision(LIB),
        before,
        "снаружи модуль прежний"
    );

    index.updateExternalModule(
        LIB,
        BASE.replace("Macro Send(document, silent)", "Macro Send(document)"),
        3
    );

    assert.notStrictEqual(
        index.getInterfaceRevision(LIB),
        before,
        "подпись изменилась"
    );
});

test("ключ замыкания зависимого не меняется от чужого тела", () => {
    const index = project();
    const before = index.getImportedClosureKey(USER);

    index.updateExternalModule(LIB, BODY_CHANGED, 2);

    assert.strictEqual(
        index.getImportedClosureKey(USER),
        before,
        "правка тела зависимости — не новость для проверок соседа"
    );

    /* И фоновое перечитывание того же файла тоже. */
    index.updateExternalModule(LIB, BODY_CHANGED, 3);

    assert.strictEqual(index.getImportedClosureKey(USER), before);

    index.updateExternalModule(
        LIB,
        BASE.replace("Macro Send(document, silent)", "Macro Send(document)"),
        4
    );

    assert.notStrictEqual(
        index.getImportedClosureKey(USER),
        before,
        "изменившаяся подпись обязана дойти до соседа"
    );
});

test("посторонний модуль ключа замыкания не касается", () => {
    const index = project();
    const before = index.getImportedClosureKey(USER);

    index.updateExternalModule(OTHER, "Macro Alone()\n  Var x = 1;\nEnd;\n", 2);

    assert.strictEqual(index.getImportedClosureKey(USER), before);
});

test("счётчики считают несделанную работу", () => {
    const index = project();
    const before = index.interfaceCounters;

    index.updateExternalModule(LIB, BODY_CHANGED, 2);

    const afterBody = index.interfaceCounters;

    assert.strictEqual(
        afterBody.interfaceChanges - before.interfaceChanges,
        0,
        "интерфейс не менялся"
    );
    assert.ok(
        afterBody.skippedDependentInvalidations -
            before.skippedDependentInvalidations > 0,
        "и зависимые не пересчитывались: " + JSON.stringify(afterBody)
    );

    index.updateExternalModule(
        LIB,
        BASE.replace("Macro Send(document, silent)", "Macro Send(document)"),
        3
    );

    const afterSignature = index.interfaceCounters;

    assert.strictEqual(
        afterSignature.interfaceChanges - afterBody.interfaceChanges,
        1
    );
    assert.ok(
        afterSignature.dependentInvalidations -
            afterBody.dependentInvalidations > 0,
        "зависимые обязаны быть учтены: " + JSON.stringify(afterSignature)
    );
});

test("рёбра Import не перестраиваются от правки тела", () => {
    const index = project();
    const before = index.interfaceCounters.importGraphUpdates;

    index.updateExternalModule(LIB, BODY_CHANGED, 2);

    assert.strictEqual(
        index.interfaceCounters.importGraphUpdates - before,
        0,
        "набор Import тот же: граф трогать незачем"
    );

    index.updateExternalModule(LIB, "Import extra;" + BODY_CHANGED, 3);

    assert.strictEqual(
        index.interfaceCounters.importGraphUpdates - before,
        1,
        "а новый Import обязан дойти до графа"
    );
    assert.ok(
        index.getDependents(LIB).includes(USER),
        "и прежние рёбра при этом целы"
    );
});

test("положения объявлений в интерфейс не входят", () => {
    /*
     * Строка, вставленная выше по файлу, сдвигает всё, что ниже. Если бы
     * диапазоны входили в отпечаток, интерфейс менялся бы от каждой правки, и
     * весь расчёт был бы бесполезен.
     */
    assert.strictEqual(
        print("\n\n// комментарий\n" + BASE),
        print(BASE)
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

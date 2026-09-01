"use strict";

/**
 * Structure показывает Macro, объявленные внутри другого Macro.
 *
 * Извлекатель объявлений один на два дела: он строит Structure открытого
 * документа и внешнюю сводку модуля для соседних файлов. Требования у них
 * противоположные. Соседний файл вложенный Macro вызвать не может, и во
 * внешней сводке его быть не должно; в Structure своего файла он обязан быть
 * виден — иначе панель просто умалчивает о куске кода.
 *
 * Раньше вложенные не попадали никуда: сканер не заводил дескриптор, если уже
 * находился внутри Macro. Теперь у режима есть явный ключ
 * includeNestedCallables, а не догадка по includePrivate.
 */

const assert = require("assert");

const {
    TextDocument
} = require("../server/node_modules/vscode-languageserver-textdocument");
const {
    createFastDocumentSnapshot,
    getFastDocumentSymbols
} = require("../server/out/services/fastDocumentSnapshot");
const {
    extractCompactDeclarations
} = require("../server/out/analysis/declarationExtractor");
const { createExternalModuleSummary } = require("../server/out/moduleModel");

let passed = 0;
let failed = 0;
let counter = 0;

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

/** Structure так, как её отдаёт сервер: быстрый снимок, без полного разбора. */
function outline(source) {
    const document = TextDocument.create(
        "file:///d:/outline/sample" + (counter++) + ".mac",
        "rsl",
        1,
        source
    );

    return getFastDocumentSymbols(document, createFastDocumentSnapshot(document));
}

/** Дерево «имя -> дети» в виде, удобном для сравнения. */
function shape(symbols) {
    return (symbols || []).map(symbol => ({
        name: symbol.name,
        children: shape(symbol.children)
    }));
}

/** Имена верхнего уровня внешней сводки. */
function exported(source) {
    return createExternalModuleSummary(source)
        .symbolTree.children.map(symbol => symbol.name);
}

const NESTED = [
    "Macro Outer(a)",
    "  Macro Inner(b)",
    "    Macro Deep()",
    "    End;",
    "  End;",
    "End;",
    ""
].join("\n");

test("Macro внутри Macro виден дочерним", () => {
    const [outer] = outline("Macro Outer(a)\n  Macro Inner(b)\n  End;\nEnd;\n");

    assert.ok(outer, "верхний Macro обязан быть");
    assert.deepStrictEqual(
        outer.children.map(child => child.name),
        ["a", "Inner"],
        "параметр и вложенный Macro — оба дети Outer"
    );
});

test("два уровня вложенности", () => {
    assert.deepStrictEqual(shape(outline(NESTED)), [{
        name: "Outer",
        children: [
            { name: "a", children: [] },
            {
                name: "Inner",
                children: [
                    { name: "b", children: [] },
                    { name: "Deep", children: [] }
                ]
            }
        ]
    }]);
});

test("параметры вложенного Macro показаны как обычные", () => {
    const source = "Macro Outer()\n" +
        "  Macro Inner(first, second:Integer)\n  End;\nEnd;\n" +
        "Macro Plain(first, second:Integer)\nEnd;\n";
    const [outer, plain] = outline(source);
    const inner = outer.children[0];

    assert.strictEqual(inner.name, "Inner");
    assert.deepStrictEqual(
        inner.children.map(child => child.name),
        plain.children.map(child => child.name),
        "у вложенного те же параметры, что у обычного"
    );
    assert.deepStrictEqual(
        inner.children.map(child => child.kind),
        plain.children.map(child => child.kind),
        "и того же вида"
    );
    assert.deepStrictEqual(
        inner.children.map(child => child.detail),
        plain.children.map(child => child.detail),
        "и с тем же типом"
    );
});

test("соседний Macro остаётся на верхнем уровне", () => {
    const source = "Macro Outer()\n  Macro Inner()\n  End;\nEnd;\n" +
        "Macro Neighbour()\nEnd;\n";

    assert.deepStrictEqual(shape(outline(source)), [
        { name: "Outer", children: [{ name: "Inner", children: [] }] },
        { name: "Neighbour", children: [] }
    ]);
});

test("вложенный Macro внутри метода класса", () => {
    const source = [
        "Class Holder",
        "  Var Code: String;",
        "  Macro Load(id)",
        "    Macro Helper()",
        "    End;",
        "  End;",
        "End;",
        ""
    ].join("\n");

    assert.deepStrictEqual(shape(outline(source)), [{
        name: "Holder",
        children: [
            { name: "Code", children: [] },
            {
                name: "Load",
                children: [
                    { name: "id", children: [] },
                    { name: "Helper", children: [] }
                ]
            }
        ]
    }]);
});

test("внешняя сводка вложенных Macro не содержит", () => {
    assert.deepStrictEqual(
        exported(NESTED),
        ["Outer"],
        "соседний файл вызвать Inner и Deep не может"
    );

    const inClass = exported([
        "Class Holder",
        "  Macro Load(id)",
        "    Macro Helper()",
        "    End;",
        "  End;",
        "End;",
        ""
    ].join("\n"));

    assert.deepStrictEqual(inClass, ["Holder"]);
});

test("компактное сканирование по умолчанию вложенных не собирает", () => {
    /*
     * Тот же извлекатель зовут и worker, и достройка каталога. Их ответ
     * меняться не должен: вложенное имя в каталоге проекта — это ложная
     * цель для Ctrl+T и перехода.
     */
    const declarations = extractCompactDeclarations(NESTED, {
        includePrivate: true
    }).declarations;
    const names = list => (list || [])
        .flatMap(item => [item.name, ...names(item.children)]);

    assert.ok(
        !names(declarations).includes("Inner"),
        "включённый includePrivate не должен тянуть за собой вложенные"
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

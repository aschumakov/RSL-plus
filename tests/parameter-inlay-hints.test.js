"use strict";

/**
 * Имена параметров рядом с аргументами вызова.
 *
 * Подсказка выглядит как факт, поэтому здесь важнее всего границы: где она
 * обязана молчать. Неразрешённый вызов, лишний аргумент, аргумент, названный
 * так же, как параметр, — во всех этих случаях подсказки быть не должно.
 */

const assert = require("assert");

const {
    buildRslParameterInlayHints
} = require("../server/out/features/parameterInlayHints");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

let passed = 0;
let failed = 0;

function test(name, action) {
    try {
        action();
        passed++;
        console.log(`[OK] ${name}`);
    } catch (error) {
        failed++;
        console.error(`[FAIL] ${name}`);
        console.error(error);
    }
}

const MAIN = "file:///hints.mac";
const WHOLE_FILE = {
    start: { line: 0, character: 0 },
    end: { line: 200, character: 0 }
};

function hints(lines, range) {
    const source = Array.isArray(lines) ? lines.join("\n") : lines;
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN]);

    const module = index.updateOpenModule(MAIN, source, 1);

    return buildRslParameterInlayHints(
        module,
        new RslScopeResolver(index),
        range || WHOLE_FILE
    ).map(hint => ({
        line: hint.position.line + 1,
        character: hint.position.character,
        label: hint.label
    }));
}

test("имя параметра подписывается к аргументу", () => {
    const result = hints([
        "Macro Send(document, count, silent)",
        "End;",
        "Macro Test()",
        "  Var doc = 0;",
        "  Send(doc, 1, true);",
        "End;"
    ]);

    assert.deepStrictEqual(
        result.map(hint => hint.label),
        ["document:", "count:", "silent:"]
    );
    assert.deepStrictEqual(
        result.map(hint => hint.line),
        [5, 5, 5],
        "подсказки стоят у самих аргументов"
    );
});

test("аргумент, названный как параметр, подсказки не получает", () => {
    const result = hints([
        "Macro Send(document, count)",
        "End;",
        "Macro Test()",
        "  Var document = 0;",
        "  Send(document, 5);",
        "End;"
    ]);

    assert.deepStrictEqual(
        result.map(hint => hint.label),
        ["count:"],
        "повторять написанное незачем"
    );
});

test("обращение к полю тем же именем тоже очевидно", () => {
    const result = hints([
        "Class Holder",
        "  Var document;",
        "  Macro Send(document, count)",
        "  End;",
        "  Macro Test()",
        "    Send(this.document, 5);",
        "  End;",
        "End;"
    ]);

    assert.deepStrictEqual(
        result.map(hint => hint.label),
        ["count:"],
        "последнее имя цепочки и есть ответ"
    );
});

test("выражение в аргументе подсказку получает", () => {
    const result = hints([
        "Macro Send(count)",
        "End;",
        "Macro Test()",
        "  Var count = 1;",
        "  Send(count + 1);",
        "End;"
    ]);

    assert.deepStrictEqual(
        result.map(hint => hint.label),
        ["count:"],
        "count + 1 — это уже не имя параметра"
    );
});

test("неизвестный вызов подсказок не даёт", () => {
    assert.deepStrictEqual(
        hints([
            "Macro Test()",
            "  Unknown(1, 2);",
            "End;"
        ]),
        [],
        "объявление не найдено — говорить нечего"
    );
});

test("лишний аргумент отменяет подсказки всего вызова", () => {
    assert.deepStrictEqual(
        hints([
            "Macro Send(document)",
            "End;",
            "Macro Test()",
            "  Send(1, 2, 3);",
            "End;"
        ]),
        [],
        "подсказка не превращается в проверку числа аргументов"
    );
});

test("аргументов меньше, чем параметров — подсказки для написанных", () => {
    const result = hints([
        "Macro Send(document, count, silent)",
        "End;",
        "Macro Test()",
        "  Send(1, 2);",
        "End;"
    ]);

    assert.deepStrictEqual(
        result.map(hint => hint.label),
        ["document:", "count:"],
        "недописанный вызов — это набор текста, а не ошибка"
    );
});

test("вызов без аргументов и незакрытый вызов молчат", () => {
    assert.deepStrictEqual(
        hints([
            "Macro Send(document)",
            "End;",
            "Macro Test()",
            "  Send();",
            "  Send(1",
            "End;"
        ]),
        [],
        "пустых скобок и незакрытого вызова подсказка не касается"
    );
});

test("вложенный вызов получает свои подсказки", () => {
    const result = hints([
        "Macro Inner(width)",
        "End;",
        "Macro Outer(size, flag)",
        "End;",
        "Macro Test()",
        "  Outer(Inner(2), false);",
        "End;"
    ]);

    assert.deepStrictEqual(
        result.map(hint => hint.label).sort(),
        ["flag:", "size:", "width:"].sort()
    );
});

test("подсказки считаются только для видимых строк", () => {
    const lines = ["Macro Send(document)", "End;", "Macro Test()"];

    for (let index = 0; index < 40; index++) {
        lines.push(`  Send(${index});`);
    }

    lines.push("End;");

    const visible = hints(lines, {
        start: { line: 3, character: 0 },
        end: { line: 6, character: 0 }
    });

    assert.strictEqual(
        visible.length,
        4,
        "за пределами диапазона работа не делается: " + visible.length
    );
    assert.deepStrictEqual(
        visible.map(hint => hint.line),
        [4, 5, 6, 7]
    );
});

if (failed > 0) {
    console.error(`\nПройдено: ${passed}\nОшибок: ${failed}`);
    process.exitCode = 1;
} else {
    console.log(`\nПройдено: ${passed}\nОшибок: ${failed}`);
}

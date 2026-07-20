"use strict";

const assert = require("assert");
const path = require("path");

const foldingPath = path.join(
    __dirname,
    "..",
    "server",
    "out",
    "folding.js"
);

const { GetFoldingRanges } = require(foldingPath);

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

test("Блоки сворачиваются независимо от отступов", () => {
    const source = [
        "MACRO Test()",
        "If enabled",
        "DoWork();",
        "End;",
        "END;"
    ].join("\n");

    assert.deepStrictEqual(
        GetFoldingRanges(source),
        [
            { startLine: 0, endLine: 4 },
            { startLine: 1, endLine: 2 }
        ]
    );
});

test("If, Elif и Else сворачиваются независимо", () => {
    const source = [
        "If firstCondition",
        "    DoFirst();",
        "    DoSecond();",
        "Elif secondCondition",
        "    DoThird();",
        "    DoFourth();",
        "Else",
        "    DoFifth();",
        "    DoSixth();",
        "End;"
    ].join("\n");

    assert.deepStrictEqual(
        GetFoldingRanges(source),
        [
            { startLine: 0, endLine: 2 },
            { startLine: 3, endLine: 5 },
            { startLine: 6, endLine: 8 }
        ]
    );
});

test("Вложенные If не смешивают ветви внешнего If", () => {
    const source = [
        "If outerCondition",
        "    If innerCondition",
        "        DoInnerFirst();",
        "    Else",
        "        DoInnerElse();",
        "    End;",
        "Elif outerAlternative",
        "    DoOuterAlternative();",
        "End;"
    ].join("\n");

    assert.deepStrictEqual(
        GetFoldingRanges(source),
        [
            { startLine: 0, endLine: 5 },
            { startLine: 1, endLine: 2 },
            { startLine: 3, endLine: 4 },
            { startLine: 6, endLine: 7 }
        ]
    );
});

test("Однострочный If не создаёт пустой folding range", () => {
    const source = [
        "Macro Test()",
        "    if (ready) return true; end;",
        "End;"
    ].join("\n");

    assert.deepStrictEqual(
        GetFoldingRanges(source),
        [
            { startLine: 0, endLine: 2 }
        ]
    );
});

test("OnError не создаёт отдельный блок", () => {
    const source = [
        "MACRO Get_Request()",
        "BegAction();",
        "OnError",
        "EndAction();",
        "END;"
    ].join("\n");

    assert.deepStrictEqual(
        GetFoldingRanges(source),
        [
            { startLine: 0, endLine: 4 }
        ]
    );
});

test("Ключевые слова в специальных областях игнорируются", () => {
    const source = [
        "MACRO Test()",
        "q = \"If fake Elif fake Else fake End\";",
        "[",
        "begin",
        "  if x then",
        "    null;",
        "  end if;",
        "end;",
        "]",
        "/*",
        "If fake",
        "Elif fake",
        "Else",
        "End",
        "*/",
        "// If fake Elif fake Else fake End",
        "END;"
    ].join("\n");

    assert.deepStrictEqual(
        GetFoldingRanges(source),
        [
            { startLine: 0, endLine: 16 },
            { startLine: 2, endLine: 8 },
            {
                startLine: 9,
                endLine: 14,
                kind: "comment"
            }
        ]
    );
});

test("Последовательные однострочные комментарии сворачиваются", () => {
    const source = [
        "// Первая строка",
        "// Вторая строка",
        "// Третья строка",
        "DoWork();"
    ].join("\n");

    assert.deepStrictEqual(
        GetFoldingRanges(source),
        [
            {
                startLine: 0,
                endLine: 2,
                kind: "comment"
            }
        ]
    );
});

test("Комментарии после кода не образуют диапазон", () => {
    const source = [
        "DoFirst(); // Первый комментарий",
        "DoSecond(); // Второй комментарий"
    ].join("\n");

    assert.deepStrictEqual(
        GetFoldingRanges(source),
        []
    );
});

test("Незакрытый блок внутри класса не сворачивает файл до конца", () => {
    const source = [
        "CLASS LargeClass",
        "MACRO Method()",
        "If enabled",
        "DoWork();",
        "END;", // Закрывается If; Macro остаётся незакрытым.
        "END;", // Закрывается Macro; Class остаётся незакрытым.
        "",
        "// Обязательный блок выполнения",
        "RunApplication();"
    ].join("\n");

    assert.deepStrictEqual(
        GetFoldingRanges(source),
        [
            { startLine: 1, endLine: 5 },
            { startLine: 2, endLine: 3 }
        ]
    );
});

test("Обычный корректно закрытый класс продолжает сворачиваться", () => {
    const source = [
        "CLASS TestClass",
        "MACRO Method()",
        "DoWork();",
        "END;",
        "END;",
        "RunApplication();"
    ].join("\n");

    assert.deepStrictEqual(GetFoldingRanges(source), [
        { startLine: 0, endLine: 4 },
        { startLine: 1, endLine: 3 }
    ]);
});

console.log("");
console.log(`Пройдено: ${passed}`);
console.log(`Ошибок: ${failed}`);

if (failed > 0) {
    process.exitCode = 1;
}

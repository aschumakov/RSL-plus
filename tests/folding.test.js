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
            { startLine: 1, endLine: 3 }
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
        "q = \"If fake End\";",
        "[",
        "begin",
        "  if x then",
        "    null;",
        "  end if;",
        "end;",
        "]",
        "/*",
        "If fake",
        "End",
        "*/",
        "// If fake End",
        "END;"
    ].join("\n");

    assert.deepStrictEqual(
        GetFoldingRanges(source),
        [
            { startLine: 0, endLine: 14 },
            { startLine: 2, endLine: 8 },
            {
                startLine: 9,
                endLine: 12,
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
            { startLine: 2, endLine: 4 }
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

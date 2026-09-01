"use strict";

/**
 * selectionRange объявления — это ровно диапазон его имени.
 *
 * На этом инварианте держится отказ от повторного поиска токена объявления.
 * Semantic Tokens и References получали символы из дерева, а потом заново
 * проходили весь поток токенов, чтобы для каждого символа найти тот самый
 * идентификатор, который дерево уже описало диапазоном выделения.
 *
 * Проверка идёт по всем поддерживаемым видам объявлений: если инвариант где-то
 * не выполняется, отказываться от поиска нельзя.
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

const { createOpenModuleModel } = require("../server/out/moduleModel");
const { normalizeIdentifier } = require("../server/out/lexer");

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

/** Все символы дерева, кроме корня. */
function allSymbols(root) {
    const result = [];
    const queue = [...root.children];

    while (queue.length > 0) {
        const symbol = queue.shift();

        result.push(symbol);
        queue.push(...symbol.children);
    }

    return result;
}

/**
 * Инвариант: у каждого символа selectionRange указывает на токен с его именем.
 */
function checkSelectionRanges(source, what) {
    const model = createOpenModuleModel(source);
    const byStart = new Map();

    for (const token of model.lex.tokens) {
        byStart.set(token.start, token);
    }

    const wrong = [];

    for (const symbol of allSymbols(model.symbolTree)) {
        const token = byStart.get(symbol.selectionRange.start);
        const sameRange = token && token.end === symbol.selectionRange.end;
        const sameName = token &&
            normalizeIdentifier(token.value) === normalizeIdentifier(symbol.name);

        if (!token || !sameRange || !sameName) {
            wrong.push(
                symbol.name + " [" + symbol.selectionRange.start + ".." +
                symbol.selectionRange.end + "] -> " +
                (token ? JSON.stringify(token.raw) : "токена нет")
            );
        }
    }

    assert.deepStrictEqual(
        wrong,
        [],
        what + ": selectionRange обязан совпадать с токеном имени\n  " +
        wrong.join("\n  ")
    );

    return model;
}

test("Macro, Class, Method, Var, Const, поля и параметры", () => {
    const model = checkSelectionRanges([
        "Const MAX = 10;",
        "Var moduleLevel: String;",
        "",
        "Macro Run(first, second)",
        "  Var local = first;",
        "  Const INNER = 2;",
        "  return local;",
        "End;",
        "",
        "private Macro Hidden(x)",
        "  return x;",
        "End;",
        "",
        "Class (BaseHolder) Holder",
        "  Var Code: String;",
        "  Const Kind = 1;",
        "  Macro Load(id)",
        "    Var inner = id;",
        "  End;",
        "End;",
        ""
    ].join("\n"), "основные виды объявлений");

    const names = allSymbols(model.symbolTree).map(item => item.name);

    for (const wanted of [
        "MAX", "moduleLevel", "Run", "Hidden", "Holder", "Code", "Kind", "Load"
    ]) {
        assert.ok(
            names.includes(wanted),
            wanted + " обязан быть в дереве: " + names.join(", ")
        );
    }
});

test("одинаковые имена в разных областях", () => {
    checkSelectionRanges([
        "Var value = 1;",
        "",
        "Macro First()",
        "  Var value = 2;",
        "  return value;",
        "End;",
        "",
        "Macro Second()",
        "  Var value = 3;",
        "  return value;",
        "End;",
        "",
        "Class Holder",
        "  Var value: Number;",
        "End;",
        ""
    ].join("\n"), "одно имя в четырёх местах");
});

test("кириллица в именах", () => {
    checkSelectionRanges([
        "Var Остаток: Number;",
        "",
        "Macro Пересчитать(Сумма)",
        "  Var Итого = Сумма;",
        "  return Итого;",
        "End;",
        "",
        "Class Документ",
        "  Var Номер: String;",
        "End;",
        ""
    ].join("\n"), "кириллические имена");
});

test("необычное форматирование", () => {
    checkSelectionRanges([
        "Var    spaced   :   String   ;",
        "",
        "Macro",
        "    Wrapped",
        "    (",
        "        first,",
        "        second",
        "    )",
        "  return first;",
        "End;",
        "",
        "Class(Base)Tight",
        "Var Packed:Number;",
        "End;",
        ""
    ].join("\n"), "переносы и лишние пробелы");
});

test("комментарии между словом и именем", () => {
    checkSelectionRanges([
        "Macro /* имя дальше */ Commented(value)",
        "  return value;",
        "End;",
        "",
        "Var /* тип дальше */ Marked: String;",
        ""
    ].join("\n"), "комментарий внутри объявления");
});

console.log(
    failed === 0
        ? "\nПройдено: " + passed
        : "\nПройдено: " + passed + ", провалено: " + failed
);

if (failed > 0) {
    process.exitCode = 1;
}

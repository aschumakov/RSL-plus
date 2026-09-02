"use strict";

/**
 * Подсказка вставляет вызов с заготовками параметров.
 *
 * Прежде вставлялось `Send()`, и имена параметров приходилось подсматривать в
 * подсказке и набирать руками. Теперь вставляется
 * `Send(${1:document}, ${2:silent})`, и Tab переводит между ними.
 *
 * Отдельно проверяется, что там, где заготовке взяться неоткуда, остаётся
 * обычный текст: лишний режим правки на пустом месте пользователю не нужен.
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

/* Формат вставки: 1 — обычный текст, 2 — заготовка. */
const PLAIN = 1;
const SNIPPET = 2;

/** Элемент подсказки объявления верхнего уровня по имени. */
function itemOf(source, name) {
    const model = createOpenModuleModel(source);
    const symbol = model.symbolTree.children
        .find(item => item.name === name);

    assert.ok(symbol, "объявление " + name + " обязано найтись");

    return symbol.completionItem;
}

test("параметры становятся заготовками", () => {
    const item = itemOf("Macro Send(document, silent)\nEnd;\n", "Send");

    assert.strictEqual(item.insertText, "Send(${1:document}, ${2:silent})");
    assert.strictEqual(item.insertTextFormat, SNIPPET);
});

test("тип параметра в заготовку не попадает", () => {
    const item = itemOf(
        "Macro Send(document: TBFile, count: Integer)\nEnd;\n",
        "Send"
    );

    assert.strictEqual(item.insertText, "Send(${1:document}, ${2:count})");
});

test("передача по ссылке пишется без собаки", () => {
    const item = itemOf("Macro Fill(@result, source)\nEnd;\n", "Fill");

    assert.strictEqual(item.insertText, "Fill(${1:result}, ${2:source})");
});

test("процедура без параметров вставляется как была", () => {
    const item = itemOf("Macro Plain()\nEnd;\n", "Plain");

    assert.strictEqual(item.insertText, "Plain()");
    assert.strictEqual(
        item.insertTextFormat,
        PLAIN,
        "заготовке тут взяться неоткуда"
    );
});

test("переменная вставляется как была", () => {
    const item = itemOf("Var counter;\n", "counter");

    assert.strictEqual(item.insertText, "counter");
    assert.strictEqual(item.insertTextFormat, PLAIN);
});

test("метод класса тоже получает заготовки", () => {
    const model = createOpenModuleModel(
        "Class THolder\n  Macro Load(id, force)\n  End;\nEnd;\n"
    );
    const holder = model.symbolTree.children[0];
    const method = holder.children.find(item => item.name === "Load");

    assert.strictEqual(method.completionItem.insertText, "Load(${1:id}, ${2:force})");
});

test("объявление, разложенное по строкам", () => {
    /* В коде проекта длинные списки параметров переносят — так и написано. */
    const item = itemOf(
        "Macro Send(\n    document,\n    silent\n)\nEnd;\n",
        "Send"
    );

    assert.strictEqual(item.insertText, "Send(${1:document}, ${2:silent})");
});

test("приватная процедура тоже получает заготовки", () => {
    const item = itemOf("Private Macro Hidden(value)\nEnd;\n", "Hidden");

    assert.strictEqual(item.insertText, "Hidden(${1:value})");
});

console.log(
    failed === 0
        ? "\nПройдено: " + passed
        : "\nПройдено: " + passed + ", провалено: " + failed
);

if (failed > 0) {
    process.exitCode = 1;
}

"use strict";

/*
 * Интерактивные запросы до готовности полной модели.
 *
 * Проверяется через настоящие обработчики LSP: переход, Hover и подсказка
 * параметров обязаны отвечать по токенам текущей версии и индексу проекта, а не
 * ждать разбор. В стенде разбор НЕ строит модель вовсе — значит любой ответ
 * получен быстрым путём, а его отсутствие означало бы ожидание впустую.
 *
 * Отдельно сверяется, что быстрый и полный путь отвечают одинаково: у
 * пользователя не должно быть разницы между «сразу после правки» и «через
 * мгновение».
 */

const assert = require("assert");

const {
    PlatformModuleCatalog
} = require("../server/out/builtins/platformModuleCatalog");
const {
    createCompletionRegistry,
    DEFAULT_SETTINGS
} = require("./completion-harness");

let passed = 0;
let failed = 0;
const planned = [];

function test(name, action) {
    planned.push({ name, action });
}

const MAIN = "file:///d:/fast/main.mac";
const LIB = "file:///d:/fast/lib.mac";

const LIB_SOURCE = [
    "Macro Shared(value)",
    "  return value;",
    "End;",
    ""
].join("\n");

const SOURCE = [
    "Import lib;",
    "Import RsbFormsInter;",
    "Macro Test()",
    "  Var Field7: TRsbEditField = TRsbEditField(7);",
    "  Field7.bindValue(",
    "  Var result = Shared(1);",
    "  ExecMacro(\"Shared\");",
    "End;",
    ""
].join("\n");

const cancellation = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined })
};

function stand(platform, modelReady) {
    return createCompletionRegistry({
        uri: MAIN,
        source: SOURCE,
        platform,
        modelReady,
        settings: DEFAULT_SETTINGS,
        workspace: [{ uri: LIB, text: LIB_SOURCE }]
    });
}

function offsetAfter(marker) {
    const at = SOURCE.indexOf(marker);
    assert.ok(at >= 0, "в образце нет: " + marker);

    return at + marker.length;
}

async function request(current, handler, marker, extra) {
    return current.handlers[handler]({
        textDocument: { uri: MAIN },
        position: current.document.positionAt(offsetAfter(marker)),
        ...(extra || {})
    }, cancellation);
}

/* --- Переход --- */

const NAVIGATION = [
    ["по имени модуля в Import", "Import li"],
    ["к процедуре подключённого модуля", "  Var result = Shar"],
    ["по строке ExecMacro", "  ExecMacro(\"Shar"]
];

for (const [name, marker] of NAVIGATION) {
    test("переход " + name + " не ждёт разбор", async () => {
        const platform = new PlatformModuleCatalog({ log: () => undefined });
        const current = stand(platform, false);
        const answer = await request(current, "definition", marker);

        assert.ok(answer, "ответ обязан быть без готовой модели");
        const target = Array.isArray(answer) ? answer[0] : answer;
        assert.strictEqual(
            target.uri,
            LIB,
            "переход обязан вести в файл модуля"
        );
    });
}

test("переход одинаков до и после готовности модели", async () => {
    const platform = new PlatformModuleCatalog({ log: () => undefined });
    const fast = stand(platform, false);
    const full = stand(platform, true);

    for (const [, marker] of NAVIGATION) {
        const before = await request(fast, "definition", marker);
        const after = await request(full, "definition", marker);
        const uriOf = value => {
            const target = Array.isArray(value) ? value[0] : value;

            return target ? target.uri : "нет ответа";
        };

        assert.strictEqual(
            uriOf(before),
            uriOf(after),
            "быстрый и полный путь обязаны вести в один файл: " + marker
        );
    }
});

/* --- Hover --- */

test("Hover по переменной с типом не ждёт разбор", async () => {
    const platform = new PlatformModuleCatalog({ log: () => undefined });
    const current = stand(platform, false);
    const answer = await request(current, "hover", "  Field7");

    assert.ok(answer, "Hover обязан отвечать без готовой модели");
    const text = typeof answer.contents === "string"
        ? answer.contents
        : answer.contents.value;
    assert.ok(
        /TRsbEditField/i.test(text),
        "в подсказке обязан быть объявленный тип: " + text
    );
});

test("Hover по члену каталожного класса не ждёт разбор", async () => {
    const platform = new PlatformModuleCatalog({ log: () => undefined });
    await platform.ensureModules(["RsbFormsInter"]);
    const current = stand(platform, false);
    const answer = await request(current, "hover", "  Field7.bindVal");

    assert.ok(answer, "Hover по члену обязан отвечать без готовой модели");
    const text = typeof answer.contents === "string"
        ? answer.contents
        : answer.contents.value;
    assert.ok(
        /bindValue/i.test(text),
        "в подсказке обязано быть имя члена: " + text
    );
});

/* --- Signature Help --- */

test("подсказка параметров по методу каталога не ждёт разбор", async () => {
    const platform = new PlatformModuleCatalog({ log: () => undefined });
    await platform.ensureModules(["RsbFormsInter"]);
    const current = stand(platform, false);
    const answer = await request(
        current,
        "signatureHelp",
        "  Field7.bindValue(",
        { context: { triggerKind: 2, triggerCharacter: "(" } }
    );

    assert.ok(answer, "подсказка обязана отвечать без готовой модели");
    assert.ok(answer.signatures.length > 0);
    assert.ok(
        /bindValue\(/.test(answer.signatures[0].label),
        "подпись обязана быть о вызванном методе: " +
            answer.signatures[0].label
    );
});

test("подсказка параметров по процедуре модуля", async () => {
    const platform = new PlatformModuleCatalog({ log: () => undefined });
    const current = stand(platform, false);
    const answer = await request(
        current,
        "signatureHelp",
        "  Var result = Shared(",
        { context: { triggerKind: 2, triggerCharacter: "(" } }
    );

    assert.ok(answer, "подсказка обязана отвечать без готовой модели");
    assert.ok(
        /^Shared\(/.test(answer.signatures[0].label),
        answer.signatures[0].label
    );
});

test("подсказка параметров одинакова до и после готовности модели", async () => {
    const platform = new PlatformModuleCatalog({ log: () => undefined });
    await platform.ensureModules(["RsbFormsInter"]);
    const fast = stand(platform, false);
    const full = stand(platform, true);
    const marker = "  Field7.bindValue(";
    const extra = { context: { triggerKind: 2, triggerCharacter: "(" } };
    const before = await request(fast, "signatureHelp", marker, extra);
    const after = await request(full, "signatureHelp", marker, extra);

    assert.ok(before && after);
    assert.strictEqual(
        before.signatures[0].label,
        after.signatures[0].label,
        "подпись обязана совпадать на обоих путях"
    );
    assert.strictEqual(before.activeParameter, after.activeParameter);
});

/* --- Незавершённые конструкции --- */

test("незавершённый вызов не мешает ответу", async () => {
    const platform = new PlatformModuleCatalog({ log: () => undefined });
    const current = stand(platform, false);
    /* В образце `Field7.bindValue(` не закрыт: так и выглядит набор текста. */
    const answer = await request(current, "definition", "  Var result = Shar");

    assert.ok(answer, "переход обязан работать при незакрытом вызове выше");
});

(async () => {
    for (const item of planned) {
        try {
            await item.action();
            passed++;
            console.log("[OK] " + item.name);
        } catch (error) {
            failed++;
            console.error("[FAIL] " + item.name);
            console.error(error);
        }
    }

    console.log("\nПройдено: " + passed + ", провалено: " + failed);

    if (failed > 0) {
        process.exitCode = 1;
    }
})();

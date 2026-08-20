"use strict";

/*
 * Небольшие функции: переход к типу и два исправления.
 *
 * Исправления проверяются на том же входе, что и диагностика, а переход к типу —
 * через обработчик LSP, до готовности полной модели и после.
 */

const assert = require("assert");

const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const {
    buildEnhancedRslCodeActions
} = require("../server/out/features/enhancedCodeActions");
const { buildRslDiagnostics } = require("../server/out/diagnostics");
const {
    PlatformModuleCatalog
} = require("../server/out/builtins/platformModuleCatalog");
const {
    createCompletionRegistry
} = require("./completion-harness");

let passed = 0;
let failed = 0;
const planned = [];

function test(name, action) {
    planned.push({ name, action });
}

const MAIN = "file:///d:/fixes/main.mac";

/** Диагностики и действия по ним — как их получает редактор. */
function actionsFor(source, codeFilter) {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([MAIN]);
    const module = index.updateOpenModule(MAIN, source, 1);
    const diagnostics = buildRslDiagnostics(module, index, {})
        .filter(item => item.code === codeFilter);

    if (diagnostics.length === 0) {
        return { diagnostics, actions: [] };
    }

    const actions = buildEnhancedRslCodeActions(module, {
        textDocument: { uri: MAIN },
        range: diagnostics[0].range,
        context: { diagnostics }
    });

    return { diagnostics, actions };
}

/** Текст после применения правок действия. */
function applied(source, action) {
    const edits = action.edit.changes[MAIN];
    const lines = source.split("\n");
    const offsetOf = position => {
        let offset = 0;

        for (let line = 0; line < position.line; line++) {
            offset += lines[line].length + 1;
        }

        return offset + position.character;
    };
    /* Правки применяются с конца: смещения ранних не сдвигаются. */
    const ordered = [...edits].sort((first, second) =>
        offsetOf(second.range.start) - offsetOf(first.range.start)
    );
    let result = source;

    for (const edit of ordered) {
        result = result.slice(0, offsetOf(edit.range.start)) +
            edit.newText +
            result.slice(offsetOf(edit.range.end));
    }

    return result;
}

test("двойная точка исправляется удалением лишней точки", () => {
    const source = [
        "Macro Test()",
        "  Var obj;",
        "  obj = PaymentObj..ReceiverBankID;",
        "End;",
        ""
    ].join("\n");
    const { diagnostics, actions } = actionsFor(source, "missing-member-name");

    assert.ok(diagnostics.length > 0, "проверка обязана найти двойную точку");
    const fix = actions.find(item => /точк/i.test(item.title));
    assert.ok(fix, "исправление обязано предлагаться: " +
        actions.map(item => item.title).join(", "));
    assert.ok(
        applied(source, fix).includes("PaymentObj.ReceiverBankID"),
        "после исправления остаётся одна точка"
    );
});

test("тройная точка исправлением не трогается", () => {
    const source = [
        "Macro Test()",
        "  Var obj;",
        "  obj = PaymentObj...ReceiverBankID;",
        "End;",
        ""
    ].join("\n");
    const { actions } = actionsFor(source, "missing-member-name");

    assert.ok(
        !actions.some(item => /точк/i.test(item.title)),
        "три точки — это не опечатка одного символа"
    );
});

test("единственный незакрытый блок закрывается", () => {
    const source = [
        "Macro Test()",
        "  Var value = 1;",
        ""
    ].join("\n");
    const { diagnostics, actions } = actionsFor(source, "missing-end");

    assert.ok(diagnostics.length > 0);
    const fix = actions.find(item => /end;/i.test(item.title));
    assert.ok(fix, "исправление обязано предлагаться: " +
        actions.map(item => item.title).join(", "));

    const result = applied(source, fix);
    assert.ok(
        /end;\s*$/.test(result.trim()),
        "блок закрывается в нижнем регистре: " + JSON.stringify(result)
    );
});

test("при двух незакрытых блоках исправление не предлагается", () => {
    const source = [
        "Macro Test()",
        "  If (1)",
        "    Var value = 1;",
        ""
    ].join("\n");
    const { actions } = actionsFor(source, "missing-end");

    assert.ok(
        !actions.some(item => /end;/i.test(item.title)),
        "закрывать наугад нельзя: непонятно, какой блок закрывать"
    );
});

/* --- Переход к типу --- */

const TYPE_SOURCE = [
    "Import RsbFormsInter;",
    "Macro Test()",
    "  Var Field7: TRsbEditField = TRsbEditField(7);",
    "  Field7.value;",
    "End;",
    ""
].join("\n");

const LIB = "file:///d:/fixes/lib.mac";
const LIB_SOURCE = ["Class Ledger", "  Var Balance;", "End;", ""].join("\n");

const IMPORTED_TYPE_SOURCE = [
    "Import lib;",
    "Macro Test()",
    "  Var book: Ledger;",
    "  book.Balance;",
    "End;",
    ""
].join("\n");

const LOCAL_TYPE_SOURCE = [
    "Class Ledger",
    "  Var Balance;",
    "End;",
    "Macro Test()",
    "  Var book: Ledger;",
    "  book.Balance;",
    "End;",
    ""
].join("\n");

async function typeDefinitionAt(source, marker, modelReady, platform) {
    const stand = createCompletionRegistry({
        uri: MAIN,
        source,
        platform,
        modelReady,
        workspace: [{ uri: LIB, text: LIB_SOURCE }]
    });
    const at = source.indexOf(marker);
    assert.ok(at >= 0, "в образце нет: " + marker);

    return stand.handlers.typeDefinition({
        textDocument: { uri: MAIN },
        position: stand.document.positionAt(at + marker.length)
    }, {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => undefined })
    });
}

test("переход к типу ведёт к классу того же файла", async () => {
    const answer = await typeDefinitionAt(
        LOCAL_TYPE_SOURCE,
        "  book",
        false
    );

    assert.ok(answer, "ответ обязан быть и без готовой модели");
    assert.strictEqual(answer.uri, MAIN);
    assert.strictEqual(
        answer.range.start.line,
        0,
        "класс объявлен в первой строке"
    );
});

test("переход к типу ведёт к классу подключённого модуля", async () => {
    const answer = await typeDefinitionAt(
        IMPORTED_TYPE_SOURCE,
        "  book",
        false
    );

    assert.ok(answer, "ответ обязан быть и без готовой модели");
    assert.strictEqual(answer.uri, LIB, "переход ведёт в файл модуля");
});

/*
 * Класс прикладного каталога — не файл.
 *
 * Каталог читается из поставки, открывать в редакторе нечего; переход к
 * определению встроенного символа сервер по той же причине не отдаёт.
 */
test("переход к типу каталожного класса ответа не даёт", async () => {
    const platform = new PlatformModuleCatalog({ log: () => undefined });
    await platform.ensureModules(["RsbFormsInter"]);
    const answer = await typeDefinitionAt(
        TYPE_SOURCE,
        "  Field7",
        false,
        platform
    );

    assert.strictEqual(answer, null);
});

test("переход к типу одинаков до и после готовности модели", async () => {
    const fast = await typeDefinitionAt(IMPORTED_TYPE_SOURCE, "  book", false);
    const full = await typeDefinitionAt(IMPORTED_TYPE_SOURCE, "  book", true);

    assert.ok(fast && full);
    assert.strictEqual(fast.uri, full.uri);
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
        process.exit(1);
    }
})();

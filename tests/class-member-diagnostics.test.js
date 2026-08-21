"use strict";

/*
 * Проверка состава класса и правила пропущенной «;».
 *
 * Обе проверки легко сделать слишком громкими: у прикладных классов состав
 * известен из документации, а она неполна; «;» перед END не обязательна. Здесь
 * закреплено, где проверки говорят и где обязаны молчать.
 */

const assert = require("assert");

const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { buildRslDiagnostics } = require("../server/out/diagnostics");
const {
    buildEnhancedRslCodeActions
} = require("../server/out/features/enhancedCodeActions");

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

const MAIN = "file:///d:/members/main.mac";
const LIB = "file:///d:/members/lib.mac";
const LIB_SOURCE = [
    "Class TLibBase()",
    "  Var BaseField;",
    "End;",
    ""
].join("\n");

/** Диагностики файла; вторым файлом всегда идёт lib.mac. */
function diagnose(source, settings) {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([MAIN, LIB]);
    index.updateExternalModule(LIB, LIB_SOURCE, 1);
    const module = index.updateOpenModule(MAIN, source, 1);

    return {
        module,
        diagnostics: buildRslDiagnostics(module, index, settings)
    };
}

function codes(diagnostics, code) {
    return diagnostics
        .filter(item => item.code === code)
        .map(item => item.message);
}

const WITH_CLASS = [
    "Import lib;",
    "Class (TLibBase) TLocal()",
    "  Var Field: String;",
    "  Macro Open(alpha)",
    "    return alpha;",
    "  End;",
    "End;",
    "Macro Test()",
    "  Var thing: TLocal = TLocal();",
    "  Var a = thing.Field;",
    "  Var b = thing.BaseField;",
    "  Var c = thing.Open(1);",
    "  Var d = thing.Missing;",
    "  return a + b + c + d;",
    "End;",
    ""
].join("\n");

test("отсутствующий член полностью известного класса находится", () => {
    const found = codes(diagnose(WITH_CLASS).diagnostics, "unknown-member");

    assert.deepStrictEqual(found, ["У класса TLocal нет члена Missing"]);
});

test("существующий, унаследованный и метод не считаются ошибкой", () => {
    const messages = codes(diagnose(WITH_CLASS).diagnostics, "unknown-member");

    for (const name of ["Field", "BaseField", "Open"]) {
        assert.ok(
            !messages.some(message => message.includes(name)),
            name + " у класса есть: " + messages.join("; ")
        );
    }
});

test("объект без известного типа не проверяется", () => {
    /* Variant — это «тип неизвестен»: состав определится при исполнении. */
    const source = [
        "Macro Test()",
        "  Var thing;",
        "  return thing.Whatever;",
        "End;",
        ""
    ].join("\n");

    assert.deepStrictEqual(
        codes(diagnose(source).diagnostics, "unknown-member"),
        []
    );
});

test("класс с непрочитанной базой не проверяется", () => {
    /*
     * База не найдена ни в файле, ни в подключённых модулях: часть состава
     * сервер не видел, и «нет такого члена» было бы догадкой.
     */
    const source = [
        "Class (TUnknownBase) TLocal()",
        "  Var Field;",
        "End;",
        "Macro Test()",
        "  Var thing: TLocal = TLocal();",
        "  return thing.Missing;",
        "End;",
        ""
    ].join("\n");

    assert.deepStrictEqual(
        codes(diagnose(source).diagnostics, "unknown-member"),
        []
    );
});

test("одноимённые классы файла отключают проверку", () => {
    const source = [
        "Class TLocal()",
        "  Var First;",
        "End;",
        "Class TLocal()",
        "  Var Second;",
        "End;",
        "Macro Test()",
        "  Var thing: TLocal = TLocal();",
        "  return thing.Second;",
        "End;",
        ""
    ].join("\n");

    assert.deepStrictEqual(
        codes(diagnose(source).diagnostics, "unknown-member"),
        []
    );
});

test("проверку членов можно выключить", () => {
    assert.deepStrictEqual(
        codes(
            diagnose(WITH_CLASS, { unknownMembers: false }).diagnostics,
            "unknown-member"
        ),
        []
    );
});

/* --- Пропущенная «;» и лишняя «;» после заголовка --- */

const SAMPLE = [
    "Macro Test()",
    "  Var ok = 1;",
    '  sss = "ddfdf"',
    "  if (ok == 1);",
    '    MsgBox("1212")',
    "    return ok;",
    "  end;",
    "end;",
    ""
].join("\n");

test("пропущенная «;» находится между инструкциями", () => {
    const found = diagnose(SAMPLE).diagnostics
        .filter(item => item.code === "missing-semicolon")
        .map(item => item.range.start.line);

    assert.deepStrictEqual(
        found,
        [3, 5],
        "ожидались две находки: перед IF и перед RETURN"
    );
});

test("«;» перед END не требуется", () => {
    const source = [
        "Macro Test()",
        "  Var ok = 1;",
        "  if (ok == 1)",
        "    return ok",
        "  end;",
        "end;",
        ""
    ].join("\n");

    assert.deepStrictEqual(
        codes(diagnose(source).diagnostics, "missing-semicolon"),
        [],
        "перед END, ELSE и ELIF точка с запятой необязательна"
    );
});

test("восстановление Public Var не даёт второй жалобы", () => {
    const source = [
        "Macro Test()",
        "  Public Var x;",
        "  return x;",
        "End;",
        ""
    ].join("\n");
    const found = diagnose(source).diagnostics;

    assert.deepStrictEqual(
        codes(found, "missing-semicolon"),
        [],
        "настоящая ошибка тут одна — неизвестное имя Public: " +
            found.map(item => item.code).join(", ")
    );
});

test("лишняя «;» после заголовка находится и убирается исправлением", () => {
    const { module, diagnostics } = diagnose(SAMPLE);
    const found = diagnostics.filter(item =>
        item.code === "redundant-header-semicolon"
    );

    assert.strictEqual(found.length, 1, "ожидалась одна находка");

    const actions = buildEnhancedRslCodeActions(module, {
        textDocument: { uri: MAIN },
        range: found[0].range,
        context: { diagnostics: [found[0]] }
    });
    const fix = actions.find(item => /Удалить лишнюю/.test(item.title));

    assert.ok(fix, "исправление обязано предлагаться");
    const edits = fix.edit.changes[MAIN];
    assert.strictEqual(edits.length, 1);
    assert.strictEqual(edits[0].newText, "");
});

test("«;» после заголовка процедуры не считается ошибкой", () => {
    /*
     * В проверенном репозитории это устоявшийся стиль: 229 случаев после
     * MACRO и 20 после CLASS на 800 файлов. Предупреждение о стиле утопило бы
     * в шуме находки об IF, ради которых проверка и сделана.
     */
    const source = [
        "macro Border(y, x);",
        "  Var ok = 1;",
        "  return ok;",
        "end;",
        ""
    ].join(String.fromCharCode(10));

    assert.deepStrictEqual(
        codes(diagnose(source).diagnostics, "redundant-header-semicolon"),
        []
    );
});

test("пустая ветка с «;» предупреждения не даёт", () => {
    const source = [
        "Macro Test()",
        "  Var ok = 1;",
        "  if (ok == 1);",
        "  end;",
        "  return ok;",
        "end;",
        ""
    ].join("\n");

    assert.deepStrictEqual(
        codes(diagnose(source).diagnostics, "redundant-header-semicolon"),
        [],
        "пустая ветка — законная запись"
    );
});

console.log("\nПройдено: " + passed + ", провалено: " + failed);

if (failed > 0) {
    process.exitCode = 1;
}

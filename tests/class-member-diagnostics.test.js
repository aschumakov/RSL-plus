"use strict";

/*
 * Проверка состава класса и правила пропущенной «;».
 *
 * Обе проверки легко сделать слишком громкими: у прикладных классов состав
 * известен из документации, а она неполна; «;» перед END не обязательна. Здесь
 * закреплено, где проверки говорят и где обязаны молчать.
 */

const assert = require("assert");
const { assertLinearGrowth } = require("./measure");
const { isFullTestRun } = require("./test-mode");

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

    assert.deepStrictEqual(found, ["У TLocal нет члена Missing"]);
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


test("проверка обращений через точку растёт линейно", () => {
    if (!isFullTestRun()) {
        /* Замер времени — в полном наборе: см. tests/test-mode.js. */
        return;
    }

    /*
     * Здесь был квадратичный рост: получатель перед точкой искался поиском
     * токена от начала файла, и на восьми тысячах обращений проверка
     * занимала 73 мс вместо шести. Правило теперь работает по индексам.
     *
     * Замер сравнительный: удвоение объектного кода не имеет права
     * удорожать проверку больше чем в два с половиной раза.
     */
    const sample = count => {
        const lines = [
            "Class TLocal()",
            "  Var Field;",
            "End;",
            "Macro Test()",
            "  Var thing: TLocal = TLocal();",
            "  Var total = 0;"
        ];

        for (let index = 0; index < count; index++) {
            lines.push("  total = total + thing.Field;");
        }

        lines.push("  return total;", "End;", "");

        return lines.join(String.fromCharCode(10));
    };
    /*
     * Контексты готовятся заранее: замер обязан мерить проверку, а не
     * постройку текста и разбор. Внутри цикла повторов большой файл даёт
     * вчетверо больше мусора, и уборка памяти — тоже процессорное время.
     */
    const prepared = new Map([2000, 4000].map(count => {
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([MAIN]);

        return [count, {
            index,
            module: index.updateOpenModule(MAIN, sample(count), 1)
        }];
    }));
    const measure = count => {
        const context = prepared.get(count);

        buildRslDiagnostics(context.module, context.index);
    };
    assertLinearGrowth(
        assert,
        measure,
        2000,
        4000,
        "удвоение обращений"
    );
});

test("объявление модуля после первой процедуры тоже включает проверку", () => {
    /*
     * Первая Macro начинается с нулевого смещения — как и область файла. По
     * одному началу они склеивались в одну область, и объявление модуля
     * терялось вместе с проверкой.
     */
    const source = [
        "Macro First()",
        "    Var foo;",
        "    return foo;",
        "End;",
        "Var global;",
        "Typo = 1;",
        ""
    ].join(String.fromCharCode(10));

    assert.deepStrictEqual(
        codes(diagnose(source).diagnostics, "undeclared-variable"),
        ["Переменная Typo не объявлена в текущей области"]
    );
});

test("много областей с Var — рост линейный", () => {
    if (!isFullTestRun()) {
        /* Замер времени — в полном наборе: см. tests/test-mode.js. */
        return;
    }

    /*
     * Прежде каждый идентификатор сверялся со всеми областями, где есть Var:
     * на четырёх тысячах процедур проверка занимала 451 мс.
     */
    const sample = count => {
        const lines = [];

        for (let index = 0; index < count; index++) {
            lines.push(
                "Macro Proc" + index + "(argument)",
                "  Var local" + index + " = argument;",
                "  implicit" + index + " = local" + index + ";",
                "  return implicit" + index + ";",
                "End;",
                ""
            );
        }

        return lines.join(String.fromCharCode(10));
    };
    /*
     * Контексты готовятся заранее: замер обязан мерить проверку, а не
     * постройку текста и разбор. Внутри цикла повторов большой файл даёт
     * вчетверо больше мусора, и уборка памяти — тоже процессорное время.
     */
    const prepared = new Map([1000, 2000].map(count => {
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([MAIN]);

        return [count, {
            index,
            module: index.updateOpenModule(MAIN, sample(count), 1)
        }];
    }));
    const measure = count => {
        const context = prepared.get(count);

        buildRslDiagnostics(context.module, context.index);
    };
    assertLinearGrowth(
        assert,
        measure,
        1000,
        2000,
        "удвоение областей"
    );
});

test("непустой OnError с «;» отмечается", () => {
    const source = [
        "Macro Test()",
        "  Var ok = 1;",
        "  return ok;",
        "onerror(err);",
        "  msgbox(err.Description);",
        "end;",
        ""
    ].join(String.fromCharCode(10));

    assert.strictEqual(
        codes(diagnose(source).diagnostics, "redundant-header-semicolon")
            .length,
        1,
        "у ONERROR тоже есть заголовок"
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

test("«;» после заголовка процедуры и класса тоже отмечается", () => {
    /*
     * Синтаксис не зависит от того, как часто так пишут: в проверенном
     * репозитории это 229 случаев после MACRO, 20 после CLASS и 15 после
     * ONERROR — все они теперь видны в Problems, и у каждого есть
     * исправление.
     */
    for (const header of [
        "macro Border(y, x);",
        "class TBorder();"
    ]) {
        const source = [
            header,
            "  Var ok = 1;",
            "  return ok;",
            "end;",
            ""
        ].join(String.fromCharCode(10));

        assert.strictEqual(
            codes(diagnose(source).diagnostics, "redundant-header-semicolon")
                .length,
            1,
            header
        );
    }
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

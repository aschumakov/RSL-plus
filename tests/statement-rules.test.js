"use strict";

/**
 * Пять проверок одного оператора.
 *
 * У всех пяти общая опасность: каждая легко превращается в ложную тревогу,
 * стоит начать угадывать. Поэтому на каждое правило здесь есть не только
 * находка, но и похожий верный код, который обязан остаться без замечания, —
 * прежде всего вызовы, индексы и обращения к членам.
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

const {
    DiagnosticSeverity
} = require("../server/node_modules/vscode-languageserver");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { buildRslDiagnostics } = require("../server/out/diagnostics");

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

const URI = "file:///rules.mac";

/** Диагностики файла; settings — как их видит сервер. */
function diagnose(lines, settings) {
    const source = Array.isArray(lines) ? lines.join("\n") : lines;
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([URI]);

    return buildRslDiagnostics(
        index.updateOpenModule(URI, source, 1),
        index,
        settings
    );
}

/** Коды находок нужного правила с номерами строк (с единицы). */
function findings(lines, code, settings) {
    return diagnose(lines, settings)
        .filter(item => item.code === code)
        .map(item => item.range.start.line + 1);
}

/** Тело процедуры: правила работают внутри Macro, а не на верхнем уровне. */
function inMacro(body) {
    return [
        "Macro Check(kind, amount, commission, status, document)",
        ...body.map(line => "  " + line),
        "End;",
        ""
    ];
}

/* ─── Присваивание самому себе ───────────────────────────────────────────── */

test("self-assignment: находит присваивание самому себе", () => {
    assert.deepStrictEqual(
        findings(inMacro([
            "Var clientIIN = 1;",
            "clientIIN = clientIIN;",
            "Payment.Amount = Payment.Amount;",
            "CLIENTIIN = clientIIN;"
        ]), "self-assignment"),
        [3, 4, 5],
        "регистр в RSL не значим, цепочка через точку тоже считается"
    );
});

test("self-assignment: молчит там, где эффект возможен", () => {
    assert.deepStrictEqual(
        findings(inMacro([
            "Var a = 1;",
            "a = a + 1;",
            "a = Next();",
            "items[i] = items[i];",
            "document.Field = document.Other;",
            "a = b;"
        ]), "self-assignment"),
        [],
        "вызовы, индексы и разные стороны замечаний не дают"
    );
});

/* ─── Сравнение с самим собой ────────────────────────────────────────────── */

test("self-comparison: находит сравнение значения с собой", () => {
    assert.deepStrictEqual(
        findings(inMacro([
            "if (status == status)",
            "end;",
            "if (amount != amount)",
            "end;",
            "if (document.Field >= document.Field)",
            "end;"
        ]), "self-comparison"),
        [2, 4, 6]
    );
});

test("self-comparison: вызовы и разные операнды не считаются", () => {
    assert.deepStrictEqual(
        findings(inMacro([
            "if (Next() == Next())",
            "end;",
            "if (status == kind)",
            "end;",
            "if (items[i] == items[i])",
            "end;",
            "if (status == status and kind == 1)",
            "end;"
        ]), "self-comparison"),
        [],
        "вызов, индекс и связка верхнего уровня отменяют вывод"
    );
});

/* ─── Постоянное условие ─────────────────────────────────────────────────── */

test("constant-condition: находит заведомо известное условие", () => {
    assert.deepStrictEqual(
        findings(inMacro([
            "if (true)",
            "end;",
            "while (false)",
            "end;",
            "if (1 == 2)",
            "end;",
            "if (not true)",
            "end;",
            "if (true and false)",
            "end;",
            "if (\"a\" == \"a\")",
            "end;"
        ]), "constant-condition"),
        [2, 4, 6, 8, 10, 12]
    );
});

test("constant-condition: переменные и вызовы не вычисляются", () => {
    assert.deepStrictEqual(
        findings(inMacro([
            "if (status)",
            "end;",
            "if (kind == 1)",
            "end;",
            "if (Next() == 1)",
            "end;",
            "if (amount > 0 and true)",
            "end;"
        ]), "constant-condition"),
        [],
        "неизвестное значение отменяет вывод целиком"
    );
});

/* ─── Повторное условие ветки ────────────────────────────────────────────── */

test("duplicate-branch-condition: находит повтор в цепочке", () => {
    const found = diagnose(inMacro([
        "if (kind == 1)",
        "elif (kind == 2)",
        "elif (kind == 1)",
        "end;"
    ])).filter(item => item.code === "duplicate-branch-condition");

    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].range.start.line + 1, 4);
    assert.ok(
        /строка 2/.test(found[0].message),
        "сообщение показывает, где условие встретилось впервые: " +
            found[0].message
    );
});

test("duplicate-branch-condition: лишние скобки и регистр не мешают", () => {
    assert.deepStrictEqual(
        findings(inMacro([
            "if (kind == 1)",
            "elif ((KIND == 1))",
            "end;"
        ]), "duplicate-branch-condition"),
        [3]
    );
});

test("duplicate-branch-condition: разные цепочки и вызовы не считаются", () => {
    assert.deepStrictEqual(
        findings(inMacro([
            "if (kind == 1)",
            "end;",
            "if (kind == 1)",
            "end;",
            "if (Next() == 1)",
            "elif (Next() == 1)",
            "end;",
            "if (kind == 1)",
            "elif (kind == 2)",
            "else",
            "end;"
        ]), "duplicate-branch-condition"),
        [],
        "соседняя цепочка — другой вопрос, а вызов может вернуть разное"
    );
});

test("duplicate-branch-condition: вложенная цепочка не мешает внешней", () => {
    assert.deepStrictEqual(
        findings(inMacro([
            "if (kind == 1)",
            "  if (status == 1)",
            "  elif (status == 2)",
            "  end;",
            "elif (kind == 2)",
            "end;"
        ]), "duplicate-branch-condition"),
        []
    );
});

/* ─── Выражение без эффекта ──────────────────────────────────────────────── */

test("unused-expression: находит вычисление в пустоту", () => {
    assert.deepStrictEqual(
        findings(inMacro([
            "amount + commission;",
            "status == 1;",
            "\"отладочный текст\";",
            "42;"
        ]), "unused-expression"),
        [2, 3, 4, 5]
    );
});

test("unused-expression: вызовы и обращения бесполезными не считаются", () => {
    assert.deepStrictEqual(
        findings(inMacro([
            "Send(amount);",
            "document.Save();",
            "amount = amount + commission;",
            "document.Field;",
            "items[i];",
            "status;",
            "return amount + commission;"
        ]), "unused-expression"),
        [],
        "вызов, свойство, индекс и одиночное имя могут иметь эффект"
    );
});

/* ─── Общие требования ко всем пяти ──────────────────────────────────────── */

const SAMPLE = inMacro([
    "Var clientIIN = 1;",
    "clientIIN = clientIIN;",
    "if (status == status)",
    "end;",
    "if (true)",
    "end;",
    "if (kind == 1)",
    "elif (kind == 1)",
    "end;",
    "amount + commission;"
]);

const RULES = [
    ["self-assignment", "selfAssignment"],
    ["self-comparison", "selfComparison"],
    ["constant-condition", "constantCondition"],
    ["duplicate-branch-condition", "duplicateBranchCondition"],
    ["unused-expression", "unusedExpression"]
];

test("все пять включены по умолчанию и это предупреждения", () => {
    const found = diagnose(SAMPLE);

    for (const [code] of RULES) {
        const items = found.filter(item => item.code === code);

        assert.ok(items.length > 0, "правило " + code + " не сработало");
        assert.strictEqual(
            items[0].severity,
            DiagnosticSeverity.Warning,
            "правило " + code + " обязано быть предупреждением"
        );
    }
});

test("каждое правило выключается своей настройкой", () => {
    for (const [code, setting] of RULES) {
        const off = diagnose(SAMPLE, { [setting]: false });

        assert.deepStrictEqual(
            off.filter(item => item.code === code),
            [],
            "выключенное правило " + code + " продолжает сообщать"
        );

        for (const [other] of RULES) {
            if (other === code) {
                continue;
            }

            assert.ok(
                off.some(item => item.code === other),
                "выключение " + setting + " погасило чужое правило " + other
            );
        }
    }
});

test("повторный анализ даёт тот же ответ без дублей", () => {
    const first = diagnose(SAMPLE);
    const second = diagnose(SAMPLE);
    const signature = items => items
        .filter(item => RULES.some(([code]) => code === item.code))
        .map(item => [
            item.code,
            item.range.start.line,
            item.range.start.character,
            item.range.end.line,
            item.range.end.character,
            item.message
        ].join(":"))
        .sort();
    const codes = signature(first);

    assert.deepStrictEqual(codes, signature(second), "ответ повторяем");
    assert.strictEqual(
        new Set(codes).size,
        codes.length,
        "дублей нет: " + JSON.stringify(codes)
    );
});

test("правила работают в методе класса и во вложенном блоке", () => {
    const found = diagnose([
        "Class Holder",
        "  Var field;",
        "  Macro Method(kind)",
        "    if (kind == 1)",
        "      if (true)",
        "        field = field;",
        "      end;",
        "    end;",
        "  End;",
        "End;",
        ""
    ]);

    assert.deepStrictEqual(
        found.filter(item => item.code === "self-assignment")
            .map(item => item.range.start.line + 1),
        [6]
    );
    assert.deepStrictEqual(
        found.filter(item => item.code === "constant-condition")
            .map(item => item.range.start.line + 1),
        [5]
    );
});

test("while (true) идиомой считается, а не ошибкой", () => {
    /*
     * Бесконечный цикл с выходом по BREAK — обычный приём, и на настоящем
     * проекте это было единственное, что находило правило постоянного
     * условия. Ложная тревога в каждом таком цикле обесценила бы правило.
     */
    assert.deepStrictEqual(
        findings(inMacro([
            "while (true)",
            "  break;",
            "end;",
            "while (false)",
            "end;"
        ]), "constant-condition"),
        [5],
        "while (false) — по-прежнему находка"
    );
});

test("диапазон находки указывает на само выражение", () => {
    const source = inMacro(["Var a = 1;", "a = a;"]).join("\n");
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([URI]);

    const [found] = buildRslDiagnostics(
        index.updateOpenModule(URI, source, 1),
        index
    ).filter(item => item.code === "self-assignment");
    const lines = source.split("\n");
    const text = lines[found.range.start.line].slice(
        found.range.start.character,
        found.range.end.character
    );

    assert.strictEqual(text, "a = a", "подчёркнуто выражение целиком");
});

if (failed > 0) {
    console.error(`\nПройдено: ${passed}\nОшибок: ${failed}`);
    process.exitCode = 1;
} else {
    console.log(`\nПройдено: ${passed}\nОшибок: ${failed}`);
}

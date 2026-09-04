"use strict";

/**
 * Присваивание в условии `if` и `elif`.
 *
 * `if (i = 0)` — обычная описка: вместо сравнения написано присваивание, и
 * условие отвечает не то, что имел в виду автор. Язык такое допускает, поэтому
 * это предупреждение, а не ошибка, и быстрого исправления у него нет: `=` в
 * условии бывает и задуманным, а переписать за автора значит поменять смысл
 * программы там, где он, возможно, прав.
 *
 * Отличать `=` от `==`, `!=`, `>=` и `<=` помогает сам разбор: лексер держит
 * их отдельными токенами, а разбор говорит, где кончается условие и начинается
 * тело. Ни того, ни другого по тексту не видно.
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

const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const {
    buildRslConditionAssignmentDiagnostics,
    RSL_CONDITION_ASSIGNMENT_CODE
} = require("../server/out/diagnostics/conditionAssignmentDiagnostics");
const {
    rslDiagnosticRules
} = require("../server/out/diagnostics/ruleRegistry");
const {
    RSL_KNOWN_DIAGNOSTIC_CODES
} = require("../server/out/diagnostics/ruleSeverity");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

let counter = 0;

/** Находки проверки в теле Macro. */
function check(body) {
    const source = ["Macro Test()", ...body, "End;", ""].join("\n");
    const index = new WorkspaceIndex();
    const uri = "file:///d:/cond/case" + ++counter + ".mac";
    const module = index.updateOpenModule(uri, source, 1);

    return {
        source,
        found: buildRslConditionAssignmentDiagnostics(module, 20)
    };
}

test("присваивание в условии находится", () => {
    for (const line of [
        "  if (i = 0)",
        "  if (x = Func())",
        "  if ((x = Func()) > 0)"
    ]) {
        const answer = check([line, "  end;"]);

        assert.strictEqual(
            answer.found.length,
            1,
            line + ": ожидалось одно предупреждение, получено " +
                answer.found.length
        );
        assert.strictEqual(
            answer.found[0].message,
            "Присваивание внутри условия. Возможно, требуется `==`."
        );
        assert.strictEqual(
            answer.found[0].code,
            RSL_CONDITION_ASSIGNMENT_CODE
        );
        /* Уровень — предупреждение: язык такое допускает. */
        assert.strictEqual(answer.found[0].severity, 2);
    }
});

test("присваивание в elif находится", () => {
    const answer = check([
        "  if (a == 1)",
        "  elif (value = GetValue())",
        "  end;"
    ]);

    assert.strictEqual(
        answer.found.length,
        1,
        "ожидалось одно предупреждение на elif"
    );

    /* И показано именно на `=`, а не на всём условии. */
    const at = answer.source.indexOf("value = GetValue");
    const line = answer.source.slice(0, at).split("\n").length - 1;

    assert.strictEqual(answer.found[0].range.start.line, line);
});

test("сравнение предупреждения не даёт", () => {
    for (const line of [
        "  if (i == 0)",
        "  if (i != 0)",
        "  if (i >= 0)",
        "  if (i <= 0)",
        "  if (i > 0)",
        "  if (i < 0)",
        "  if (a == 1 && b != 2)"
    ]) {
        const answer = check([line, "  end;"]);

        assert.deepStrictEqual(
            answer.found.map(item => item.message),
            [],
            line + ": сравнение предупреждением не является"
        );
    }
});

test("присваивание вне условия не трогается", () => {
    /*
     * Проверка про условие, а не про присваивание вообще: в теле оператора
     * `=` — обычное дело, и говорить о нём нечего.
     */
    const answer = check([
        "  if (i == 0)",
        "    x = 1;",
        "    y = Func();",
        "  elif (j == 2)",
        "    z = 3;",
        "  else",
        "    w = 4;",
        "  end;"
    ]);

    assert.deepStrictEqual(answer.found.map(item => item.message), []);
});

test("несколько условий подряд считаются каждое", () => {
    const answer = check([
        "  if (a = 1)",
        "  elif (b = 2)",
        "  elif (c == 3)",
        "  end;",
        "  if (d = 4)",
        "  end;"
    ]);

    assert.strictEqual(
        answer.found.length,
        3,
        "ожидалось три предупреждения, получено " + answer.found.length
    );
});

test("вложенный if внутри тела считается сам по себе", () => {
    const answer = check([
        "  if (outer == 1)",
        "    if (inner = 2)",
        "    end;",
        "  end;"
    ]);

    assert.strictEqual(answer.found.length, 1);

    const at = answer.source.indexOf("inner = 2");
    const line = answer.source.slice(0, at).split("\n").length - 1;

    assert.strictEqual(
        answer.found[0].range.start.line,
        line,
        "предупреждение обязано указывать на вложенное условие"
    );
});

test("правило объявлено в реестре и знакомо системе уровней", () => {
    /*
     * Без этого правило нельзя ни выключить, ни поднять до ошибки: и то и
     * другое делается по коду через общую настройку.
     */
    const local = rslDiagnosticRules("local").map(rule => rule.id);

    assert.ok(
        local.includes("conditionAssignment"),
        "правило обязано быть в реестре локальной фазы: " + local.join(", ")
    );
    assert.ok(
        RSL_KNOWN_DIAGNOSTIC_CODES.includes(RSL_CONDITION_ASSIGNMENT_CODE),
        "код обязан быть известен системе уровней"
    );
});

test("предел Problems соблюдается", () => {
    const body = [];

    for (let index = 0; index < 10; index++) {
        body.push("  if (v" + index + " = " + index + ")", "  end;");
    }

    const source = ["Macro Test()", ...body, "End;", ""].join("\n");
    const index = new WorkspaceIndex();
    const module = index.updateOpenModule(
        "file:///d:/cond/limit.mac",
        source,
        1
    );

    assert.strictEqual(
        buildRslConditionAssignmentDiagnostics(module, 3).length,
        3
    );
    assert.strictEqual(
        buildRslConditionAssignmentDiagnostics(module, 0).length,
        0
    );
});

(async () => {
    for (const item of tests) {
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

    console.log(
        failed === 0
            ? "\nПройдено: " + passed
            : "\nПройдено: " + passed + ", провалено: " + failed
    );

    if (failed > 0) {
        process.exitCode = 1;
    }
})();

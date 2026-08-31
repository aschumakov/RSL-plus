"use strict";

/**
 * Четыре рефакторинга: Extract Variable, Extract Macro, Inline Variable и
 * заготовка переопределения.
 *
 * Формат один на все: в исходном тексте маркерами «[» и «]» отмечено
 * выделение, а ожидается либо получившийся текст, либо `null` — «действие не
 * предлагается». Половина случаев здесь именно про отказ, и это не перекос:
 * рефакторинг, который иногда портит код, хуже отсутствующего. За отсутствующим
 * человек идёт править руками, а испорченное находит на рабочем месте.
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
    createRslRefactorRegistry
} = require("../server/out/features/refactorRegistry");
const {
    extractVariableRefactor,
    inlineVariableRefactor
} = require("../server/out/features/extractRefactors");
const {
    extractMacroRefactor
} = require("../server/out/features/extractMacro");
const {
    generateOverrideRefactor
} = require("../server/out/features/generateOverride");

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

const MAIN = "file:///d:/ref/main.mac";

const REFACTORS = {
    extractVariable: extractVariableRefactor,
    extractMacro: extractMacroRefactor,
    inlineVariable: inlineVariableRefactor,
    generateOverride: generateOverrideRefactor
};

/**
 * Применить действие к размеченному тексту.
 *
 * Возвращает получившийся текст или undefined, если действие не предложено.
 */
function apply(refactorId, marked, options = {}) {
    const start = marked.indexOf("[");
    const withoutStart = marked.replace("[", "");
    const end = withoutStart.indexOf("]");
    const source = withoutStart.replace("]", "");

    assert.ok(start >= 0 && end >= 0, "выделение обязано быть размечено");

    const index = new WorkspaceIndex();
    const library = options.library || {};

    index.registerWorkspaceFiles([MAIN, ...Object.keys(library)]);

    for (const [uri, text] of Object.entries(library)) {
        index.updateOpenModule(uri, text, 1);
    }

    const module = index.updateOpenModule(MAIN, source, 1);
    const registry = createRslRefactorRegistry([REFACTORS[refactorId]]);
    const settings = { indent: "  ", keywordCase: options.keywordCase };
    const actions = registry.build({
        module,
        index,
        start,
        end,
        options: settings,
        isCancelled: () => false
    });

    if (actions.length === 0) {
        return undefined;
    }

    const chosen = options.pick ? actions[options.pick] : actions[0];
    const resolved = registry.resolve(chosen, () => module, index, settings);
    const edits = resolved.edit?.changes?.[MAIN] || [];
    const offsetAt = position =>
        module.lex.lineStarts[position.line] + position.character;
    const ordered = [...edits].sort((left, right) =>
        offsetAt(right.range.start) - offsetAt(left.range.start));
    let result = source;

    for (const edit of ordered) {
        result = result.slice(0, offsetAt(edit.range.start)) +
            edit.newText +
            result.slice(offsetAt(edit.range.end));
    }

    return { text: result, title: chosen.title, count: actions.length };
}

/** Один случай таблицы. */
function check(name, refactorId, marked, expected, options) {
    test(name, () => {
        const result = apply(refactorId, marked, options);

        if (expected === null) {
            assert.strictEqual(
                result,
                undefined,
                "действие не должно предлагаться, а оно дало:\n" +
                    (result && result.text)
            );

            return;
        }

        assert.ok(result, "действие обязано предлагаться");
        assert.strictEqual(result.text, expected);
    });
}

/* ── Extract Variable ───────────────────────────────────────────────────── */

check(
    "выражение выносится в переменную",
    "extractVariable",
    "Macro Run(a, b)\n  total = [a + b] * 2;\n  Log(total);\nEnd;\n",
    "Macro Run(a, b)\n  Var value = a + b;\n  total = value * 2;\n  Log(total);\nEnd;\n"
);

check(
    "вызов выносится вместе со скобками",
    "extractVariable",
    "Macro Run(a)\n  total = [Calc(a)] + 1;\n  Log(total);\nEnd;\n",
    "Macro Run(a)\n  Var value = Calc(a);\n  total = value + 1;\n  Log(total);\nEnd;\n"
);

check(
    "занятое имя обходится",
    "extractVariable",
    "Macro Run(a, b)\n  Var value = 1;\n  total = [a + b];\n  Log(total);\nEnd;\n",
    "Macro Run(a, b)\n  Var value = 1;\n  Var value2 = a + b;\n  total = value2;\n  Log(total);\nEnd;\n"
);

check(
    "одно имя выносить незачем",
    "extractVariable",
    "Macro Run(a)\n  total = [a];\n  Log(total);\nEnd;\n",
    null
);

check(
    "передача по ссылке — не значение",
    "extractVariable",
    "Macro Run(a)\n  Fill([@a]);\n  Log(a);\nEnd;\n",
    null
);

check(
    "оператор не со своей строки",
    "extractVariable",
    "Macro Run(a, b)\n  if (a > 0) total = [a + b];\n  Log(1);\nEnd;\n",
    null,
    undefined
);

check(
    "выделение разрезает токен",
    "extractVariable",
    "Macro Run(a, b)\n  total = [a + b] + c;\n  Log(total);\nEnd;\n".replace(
        "[a + b]",
        "a [+ b]"
    ),
    null
);

check(
    "регистр ключевого слова берётся из настроек",
    "extractVariable",
    "Macro Run(a, b)\n  total = [a + b] * 2;\n  Log(total);\nEnd;\n",
    "Macro Run(a, b)\n  VAR value = a + b;\n  total = value * 2;\n  Log(total);\nEnd;\n",
    { keywordCase: "upper" }
);

check(
    "CRLF сохраняется",
    "extractVariable",
    "Macro Run(a, b)\r\n  total = [a + b] * 2;\r\n  Log(total);\r\nEnd;\r\n",
    "Macro Run(a, b)\r\n  Var value = a + b;\r\n  total = value * 2;\r\n  Log(total);\r\nEnd;\r\n"
);

/* ── Inline Variable ────────────────────────────────────────────────────── */

check(
    "значение подставляется в скобках",
    "inlineVariable",
    "Macro Run(a)\n  Var [sum] = a + 1;\n  Log(sum * 2);\nEnd;\n",
    "Macro Run(a)\n  Log((a + 1) * 2);\nEnd;\n"
);

check(
    "действие работает и от места чтения",
    "inlineVariable",
    "Macro Run(a)\n  Var sum = a + 1;\n  Log([sum] * 2);\nEnd;\n",
    "Macro Run(a)\n  Log((a + 1) * 2);\nEnd;\n"
);

check(
    "два чтения простого значения",
    "inlineVariable",
    "Macro Run(a)\n  Var sum = a + 1;\n  Log([sum] + sum);\nEnd;\n",
    "Macro Run(a)\n  Log((a + 1) + (a + 1));\nEnd;\n"
);

check(
    "два чтения значения с вызовом — побочное действие повторилось бы",
    "inlineVariable",
    "Macro Run(a)\n  Var sum = Calc(a);\n  Log([sum] + sum);\nEnd;\n",
    null
);

check(
    "переприсваивание делает подстановку неверной",
    "inlineVariable",
    "Macro Run(a)\n  Var sum = a + 1;\n  sum = 2;\n  Log([sum]);\nEnd;\n",
    null
);

check(
    "передача по ссылке пишет в переменную мимо нас",
    "inlineVariable",
    "Macro Run(a)\n  Var sum = a + 1;\n  Fill(@sum);\n  Log([sum]);\nEnd;\n",
    null
);

check(
    "два объявления одного имени",
    "inlineVariable",
    "Macro Run(a)\n  Var sum = a + 1;\n  if (a > 0)\n    Var sum = 2;\n  end;\n  Log([sum]);\nEnd;\n",
    null
);

check(
    "объявление без значения подставлять нечем",
    "inlineVariable",
    "Macro Run(a)\n  Var sum;\n  Log([sum]);\nEnd;\n",
    null
);

/* ── Extract Macro ──────────────────────────────────────────────────────── */

check(
    "операторы выносятся в процедуру",
    "extractMacro",
    "Macro Run(a, b)\n  Var total = 0;\n[  total = a + b;\n  total = total * 2;]\n  Log(total);\nEnd;\n",
    "Macro Run(a, b)\n  Var total = 0;\n  total = Extracted(total, a, b);\n  Log(total);\nEnd;\n" +
    "\nMacro Extracted(total, a, b)\n  total = a + b;\n  total = total * 2;\n  return total;\nEnd;\n"
);

check(
    "переменная, читаемая дальше, возвращается",
    "extractMacro",
    "Macro Run(a)\n  Var total = 0;\n[  total = a + 1;]\n  Log(total);\nEnd;\n",
    "Macro Run(a)\n  Var total = 0;\n  total = Extracted(total, a);\n  Log(total);\nEnd;\n" +
    "\nMacro Extracted(total, a)\n  total = a + 1;\n  return total;\nEnd;\n"
);

check(
    "две переменные, читаемые дальше, вернуть нечем",
    "extractMacro",
    "Macro Run(a)\n  Var one = 0;\n  Var two = 0;\n[  one = a + 1;\n  two = a + 2;]\n  Log(one + two);\nEnd;\n",
    null
);

check(
    "объявление уровня модуля не переносится",
    "extractMacro",
    "Macro Run(a)\n  Var total = 0;\n[  private array names;]\n  Log(total);\nEnd;\n",
    null
);

check(
    "блок IF выносится целиком",
    "extractMacro",
    "Macro Run(a)\n  Var total = 0;\n[  if (a > 0)\n    Log(a);\n  end;]\n  Log(total);\nEnd;\n",
    "Macro Run(a)\n  Var total = 0;\n  Extracted(a);\n  Log(total);\nEnd;\n" +
    "\nMacro Extracted(a)\n  if (a > 0)\n    Log(a);\n  end;\nEnd;\n"
);

check(
    "разрезанный блок не выносится",
    "extractMacro",
    "Macro Run(a)\n  if (a > 0)\n[    Log(a);\n  end;]\n  Log(1);\nEnd;\n",
    null
);

check(
    "RETURN увёл бы управление из новой процедуры",
    "extractMacro",
    "Macro Run(a)\n[  if (a > 0)\n    return 1;\n  end;]\n  Log(a);\nEnd;\n",
    null
);

check(
    "объявление, читаемое после выделения, уехало бы вместе с ним",
    "extractMacro",
    "Macro Run(a)\n[  Var total = a + 1;]\n  Log(total);\nEnd;\n",
    null
);

check(
    "огрызок продолженного выражения не выносится",
    "extractMacro",
    "Macro Run(a, b)\n  Var total = 0;\n  total = a +\n[    b;]\n  Log(total);\nEnd;\n",
    null
);

/* ── Generate Override ──────────────────────────────────────────────────── */

const BASE = [
    "Class Base",
    "  Macro Handle(document, options:@string)",
    "    return document;",
    "  End;",
    "  Macro Same(one)",
    "    return one;",
    "  End;",
    "End;",
    ""
].join("\n");

check(
    "заготовка переносит список параметров как есть",
    "generateOverride",
    BASE + "\nClass(Base) Child\n  Macro Same(one)\n[]    return one;\n  End;\nEnd;\n",
    BASE + "\nClass(Base) Child\n  Macro Same(one)\n    return one;\n  End;\n" +
    "\n  Macro Handle(document, options:@string)\n    \n  End;\nEnd;\n"
);

test("предлагается по одному действию на недостающий метод", () => {
    const result = apply(
        "generateOverride",
        "Class Base\n  Macro First(a)\n    return a;\n  End;\n  Macro Second(b)\n    return b;\n  End;\nEnd;\n" +
        "\nClass(Base) Child\n  Macro Own()\n[]    return 1;\n  End;\nEnd;\n"
    );

    assert.ok(result, "действия обязаны быть");
    assert.strictEqual(result.count, 2, "по одному на каждый метод базы");
});

check(
    "уже переопределённый метод не предлагается",
    "generateOverride",
    "Class Base\n  Macro Handle(a)\n    return a;\n  End;\nEnd;\n" +
    "\nClass(Base) Child\n  Macro Handle(a)\n[]    return a;\n  End;\nEnd;\n",
    null
);

check(
    "без базового класса предлагать нечего",
    "generateOverride",
    "Class Alone\n  Macro Own()\n[]    return 1;\n  End;\nEnd;\n",
    null
);

check(
    "неразрешённый базовый класс — молчание",
    "generateOverride",
    "Class(Unknown) Child\n  Macro Own()\n[]    return 1;\n  End;\nEnd;\n",
    null
);

check(
    "базовый класс из подключённого модуля",
    "generateOverride",
    "Import library;\n\nClass(Base) Child\n  Macro Own()\n[]    return 1;\n  End;\nEnd;\n",
    "Import library;\n\nClass(Base) Child\n  Macro Own()\n    return 1;\n  End;\n" +
    "\n  Macro Handle(document)\n    \n  End;\nEnd;\n",
    {
        library: {
            "file:///d:/ref/library.mac":
                "Class Base\n  Macro Handle(document)\n    return document;\n  End;\nEnd;\n"
        }
    }
);

/* ── Общее ──────────────────────────────────────────────────────────────── */

test("один и тот же вход даёт один и тот же результат", () => {
    /*
     * Идемпотентности здесь и не должно быть: вынести выражение из уже
     * вынесенного — законное действие. Проверяется другое — что результат не
     * зависит от порядка обхода и повторный расчёт даёт то же самое.
     */
    const cases = [
        ["extractVariable", "Macro Run(a, b)\n  total = [a + b] * 2;\n  Log(total);\nEnd;\n"],
        ["extractMacro", "Macro Run(a, b)\n  Var total = 0;\n[  total = a + b;]\n  Log(total);\nEnd;\n"],
        ["inlineVariable", "Macro Run(a)\n  Var [sum] = a + 1;\n  Log(sum * 2);\nEnd;\n"]
    ];

    for (const [refactorId, marked] of cases) {
        const first = apply(refactorId, marked);
        const second = apply(refactorId, marked);

        assert.ok(first, refactorId + ": действие обязано сработать");
        assert.strictEqual(second.text, first.text, refactorId);
    }
});

test("действие не считает правку, пока его не выбрали", () => {
    const source = "Macro Run(a, b)\n  total = a + b * 2;\n  Log(total);\nEnd;\n";
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN]);

    const module = index.updateOpenModule(MAIN, source, 1);
    const registry = createRslRefactorRegistry(Object.values(REFACTORS));
    const actions = registry.build({
        module,
        index,
        start: source.indexOf("a + b"),
        end: source.indexOf("a + b") + 5,
        options: {},
        isCancelled: () => false
    });

    assert.ok(actions.length > 0, "хотя бы одно действие");
    assert.ok(
        actions.every(action => action.edit === undefined),
        "правка считается в codeAction/resolve"
    );
});

test("отменённый запрос действий не даёт", () => {
    const source = "Macro Run(a, b)\n  total = a + b * 2;\n  Log(total);\nEnd;\n";
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN]);

    const module = index.updateOpenModule(MAIN, source, 1);
    const registry = createRslRefactorRegistry(Object.values(REFACTORS));

    assert.deepStrictEqual(
        registry.build({
            module,
            index,
            start: source.indexOf("a + b"),
            end: source.indexOf("a + b") + 5,
            options: {},
            isCancelled: () => true
        }),
        []
    );
});

if (failed > 0) {
    console.error("\nПройдено: " + passed + "\nОшибок: " + failed);
    process.exitCode = 1;
} else {
    console.log("\nПройдено: " + passed + "\nОшибок: " + failed);
}

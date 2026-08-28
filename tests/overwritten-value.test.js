"use strict";

/**
 * Значение записано и перезаписано, а между записями его никто не прочитал.
 *
 * Правило работает только на прямолинейном участке. Всё, что делает вывод
 * недоказуемым, участок обрывает: заголовок блока, ветвление, цикл, выход,
 * вызов, передача по ссылке, обращение через точку и любой оператор, который
 * не является присваиванием.
 *
 * Последнее ограничение стоит на замере: в RSL вызов процедуры пишется и без
 * скобок. Строка «Itogo;» в crdmoves.mac — вызов макроса, который читает
 * Itog3, и без этого ограничения правило уверенно сообщало неправду о
 * присваивании строкой выше. По той же причине имя процедуры файла в любом
 * месте оператора обрывает участок: «x = Itogo;» — тоже вызов.
 *
 * После обоих ограничений на проекте макросов остаётся 58 находок в 25 файлах
 * из 3032, и просмотренные — настоящие: перезаписанные коды ошибок в
 * скопированном блоке, «BegDate = RDate1; BegDate = RDate2;» под комментарием
 * про предыдущий месяц, дважды написанная строка.
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
    RslDiagnosticEngine
} = require("../server/out/diagnostics/diagnosticEngine");

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

const MAIN = "file:///d:/dead/main.mac";

/** Сообщения правила целиком. */
function diagnostics(lines, settings) {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN]);

    const module = index.updateOpenModule(MAIN, lines.join("\n") + "\n", 1);

    return new RslDiagnosticEngine()
        .buildLocal(module, index, settings)
        .filter(item => item.code === "overwritten-value");
}

/** Строки находок, считая с единицы, как их видит человек. */
function findings(lines, settings) {
    return diagnostics(lines, settings).map(item => item.range.start.line + 1);
}

/** Тело макроса вокруг переданных строк; первая строка тела — вторая в файле. */
function body(lines) {
    return ["Macro Run(flag, other)", ...lines, "  return status;", "End;"];
}

test("перезапись без чтения находится", () => {
    const found = findings(body([
        "  Var status = 0;",
        "  status = 1;",
        "  status = 2;"
    ]));

    assert.deepStrictEqual(found, [3], "подчёркивается первая запись");
});

test("сообщение называет переменную, уровень — предупреждение", () => {
    const found = diagnostics(body([
        "  Var status = 0;",
        "  status = 1;",
        "  status = 2;"
    ]));

    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].severity, 2, "по умолчанию предупреждение");
    assert.ok(
        found[0].message.includes("status"),
        "имя обязано быть в сообщении: " + found[0].message
    );
});

test("чтение между записями молчит", () => {
    assert.deepStrictEqual(
        findings(body([
            "  Var status = 0;",
            "  status = 1;",
            "  other = status;",
            "  status = 2;"
        ])),
        []
    );
});

test("чтение в правой части той же записи молчит", () => {
    assert.deepStrictEqual(
        findings(body([
            "  Var status = 0;",
            "  status = 1;",
            "  status = status + 1;"
        ])),
        []
    );
});

test("ветвление между записями молчит", () => {
    assert.deepStrictEqual(
        findings(body([
            "  Var status = 0;",
            "  status = 1;",
            "  if (flag == 1)",
            "    return status;",
            "  end;",
            "  status = 2;"
        ])),
        [],
        "до второй записи могли и не дойти"
    );
});

test("разные ветви одного if не считаются перезаписью", () => {
    assert.deepStrictEqual(
        findings(body([
            "  Var status = 0;",
            "  if (flag == 1)",
            "    status = 1;",
            "  else",
            "    status = 2;",
            "  end;"
        ])),
        [],
        "выполняется ровно одна ветвь"
    );
});

test("запись до блока и запись после него молчат", () => {
    assert.deepStrictEqual(
        findings(body([
            "  Var status = 0;",
            "  status = 1;",
            "  while (flag == 1)",
            "    flag = 0;",
            "  end;",
            "  status = 2;"
        ])),
        [],
        "тело цикла могло прочитать значение"
    );
});

test("вызов между записями молчит", () => {
    assert.deepStrictEqual(
        findings(body([
            "  Var status = 0;",
            "  status = 1;",
            "  Log(flag);",
            "  status = 2;"
        ])),
        [],
        "вызов мог прочитать переменную"
    );
});

test("вызов процедуры файла без скобок молчит", () => {
    assert.deepStrictEqual(
        findings([
            "Macro Itogo()",
            "  return status;",
            "End;",
            "",
            "Macro Run(flag)",
            "  status = 1;",
            "  Itogo;",
            "  status = 2;",
            "  return status;",
            "End;"
        ]),
        [],
        "оператор из одного имени — вызов, а не чтение"
    );
});

test("вызов без скобок в правой части молчит", () => {
    assert.deepStrictEqual(
        findings([
            "Macro Itogo()",
            "  return status;",
            "End;",
            "",
            "Macro Run(flag, other)",
            "  status = 1;",
            "  other = Itogo;",
            "  status = 2;",
            "  return status;",
            "End;"
        ]),
        []
    );
});

test("передача по ссылке молчит", () => {
    assert.deepStrictEqual(
        findings(body([
            "  Var status = 0;",
            "  status = 1;",
            "  Fill(@status);",
            "  status = 2;"
        ])),
        []
    );
});

test("запись через точку не проверяется", () => {
    assert.deepStrictEqual(
        findings([
            "Macro Run(doc)",
            "  doc.status = 1;",
            "  doc.status = 2;",
            "  return doc;",
            "End;"
        ]),
        [],
        "слева не простое имя: доказать нечем"
    );
});

test("выход между записями молчит", () => {
    assert.deepStrictEqual(
        findings(body([
            "  Var status = 0;",
            "  status = 1;",
            "  break;",
            "  status = 2;"
        ])),
        []
    );
});

test("записи в разных процедурах не связаны", () => {
    assert.deepStrictEqual(
        findings([
            "Macro First()",
            "  status = 1;",
            "  return 1;",
            "End;",
            "",
            "Macro Second()",
            "  status = 2;",
            "  return 2;",
            "End;"
        ]),
        []
    );
});

test("подряд идущие записи в цикле находятся", () => {
    assert.deepStrictEqual(
        findings(body([
            "  Var status = 0;",
            "  while (flag == 1)",
            "    status = 1;",
            "    status = 2;",
            "  end;"
        ])),
        [4],
        "внутри одной итерации участок прямолинейный"
    );
});

test("правило выключается и меняет уровень", () => {
    const source = body([
        "  Var status = 0;",
        "  status = 1;",
        "  status = 2;"
    ]);

    assert.deepStrictEqual(
        findings(source, { overwrittenValue: false }),
        [],
        "булева настройка выключает проверку"
    );
    assert.deepStrictEqual(
        findings(source, { rules: { "overwritten-value": "none" } }),
        [],
        "уровень none тоже"
    );
    assert.strictEqual(
        diagnostics(source, { rules: { "overwritten-value": "error" } })[0]
            .severity,
        1,
        "уровень меняется настройкой"
    );
});

test("подавление комментарием действует", () => {
    assert.deepStrictEqual(
        findings(body([
            "  Var status = 0;",
            "  // rsl-disable-next-line overwritten-value",
            "  status = 1;",
            "  status = 2;"
        ])),
        []
    );
});

test("повторный анализ не удваивает находки", () => {
    const source = body([
        "  Var status = 0;",
        "  status = 1;",
        "  status = 2;"
    ]).join("\n") + "\n";
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN]);

    const engine = new RslDiagnosticEngine();
    const first = engine
        .buildLocal(index.updateOpenModule(MAIN, source, 1), index)
        .filter(item => item.code === "overwritten-value");
    const second = engine
        .buildLocal(index.updateOpenModule(MAIN, source, 2), index)
        .filter(item => item.code === "overwritten-value");

    assert.strictEqual(second.length, first.length);
});

if (failed > 0) {
    console.error("\nПройдено: " + passed + "\nОшибок: " + failed);
    process.exitCode = 1;
} else {
    console.log("\nПройдено: " + passed + "\nОшибок: " + failed);
}

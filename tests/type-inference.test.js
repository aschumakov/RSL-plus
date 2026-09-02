"use strict";

/**
 * Тип переменной без декларации: он задан присваиванием.
 *
 * Руководство приравнивает переменную без декларации типа к Variant — «может
 * содержать значение любого типа». Тип у неё тем не менее известен, из
 * присваивания, и resolver это умеет: по такой переменной он предлагает члены
 * класса, а Hover показывает выведенный тип.
 *
 * Умел он это для ОДНОГО потребителя. Слой вывода типов отдавал только
 * ОБЪЯВЛЕННЫЙ тип, и писал `variant` там, где подсказка и переход в том же
 * месте показывали класс. Отсюда и берётся расхождение: подсказка после точки
 * работала, а ранжирование по ожидаемому типу и отчёт инспектора — нет.
 *
 * Величина, ради которой это сделано, измерена на 400 настоящих файлах
 * (scratchpad/audit-type-coverage.cjs): тип получателя известен у 25,0%
 * обращений к члену до и у 47,5% после. Остальное — параметры без написанного
 * типа (42,9% неизвестных) и расхождение типов между ветками (32,2%): и то и
 * другое требует межпроцедурного или потокового анализа, которого измерения не
 * оправдывают.
 *
 * Здесь же проверяется, чего делать НЕЛЬЗЯ: объявленный тип сильнее
 * присваивания, расхождение веток оставляет тип неизвестным, а имя
 * неразрешённого вызова типом не считается.
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

const { RslTypeEngine } = require("../server/out/analysis/typeEngine");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

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

const MAIN = "file:///d:/infer/main.mac";

const PRELUDE = [
    "Class TBFile",
    "  Var Code: String;",
    "End;",
    "",
    "Macro OpenFile(name: String): TBFile",
    "  Var result: TBFile;",
    "  return result;",
    "End;",
    "",
    "Macro Send(document: TBFile, silent)",
    "End;",
    "",
    "Class TBName",
    "  Var Title: String;",
    "End;",
    "",
    "Macro OpenName(name: String): TBName",
    "  Var result: TBName;",
    "  return result;",
    "End;",
    ""
].join("\n");

/** Стенд: текст с маркером | вместо курсора. */
function stand(bodyLines) {
    const text = PRELUDE + bodyLines.join("\n") + "\n";
    const offset = text.indexOf("|");
    const source = text.replace("|", "");
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN]);
    index.updateOpenModule(MAIN, source, 1);

    return {
        index,
        offset,
        engine: new RslTypeEngine(index, new RslScopeResolver(index))
    };
}

/** Пусто и variant — одно и то же: «тип неизвестен». */
function unknown(type) {
    return type === "" || type === "variant";
}

test("тип переменной без декларации — из вызова", () => {
    const board = stand([
        "Macro Run()",
        "  doc = OpenFile(\"a\");",
        "  d|oc = 1;",
        "End;"
    ]);

    assert.strictEqual(
        board.engine.typeOfSymbolAt(MAIN, board.offset),
        "TBFile",
        "тип задан присваиванием"
    );
});

test("объявленный тип сильнее присваивания", () => {
    /*
     * Декларация типа — это приведение, и присваивание её не меняет:
     * `Var sql: String` держит строку, чем бы её потом ни присваивали.
     */
    const board = stand([
        "Macro Run()",
        "  Var doc: String;",
        "  doc = OpenFile(\"a\");",
        "  d|oc = 1;",
        "End;"
    ]);

    assert.strictEqual(
        board.engine.typeOfSymbolAt(MAIN, board.offset),
        "string",
        "встроенные имена типов приводятся к каноническому виду"
    );
});

test("расхождение типов между ветками оставляет тип неизвестным", () => {
    /*
     * Подставить один из двух значило бы предложить члены класса, которого в
     * этой ветке нет. Честнее не отвечать.
     *
     * Речь о расхождении двух ИЗВЕСТНЫХ типов. Присваивание литерала в одной
     * из ветвей типа не задаёт вовсе и общий ответ не отменяет: индекс
     * присваиваний помнит только те, из которых тип выводится, — вызовы,
     * вызовы членов и голый класс справа.
     */
    const board = stand([
        "Macro Run(flag)",
        "  if ( flag )",
        "    doc = OpenFile(\"a\");",
        "  else",
        "    doc = OpenName(\"b\");",
        "  end;",
        "  d|oc = 1;",
        "End;"
    ]);
    const type = board.engine.typeOfSymbolAt(MAIN, board.offset);

    assert.ok(
        unknown(type),
        "выдуманный тип хуже пустого ответа, получено: " + type
    );
});

test("имя неразрешённого вызова типом не считается", () => {
    const board = stand([
        "Macro Run()",
        "  doc = НетТакогоВызова(\"a\");",
        "  d|oc = 1;",
        "End;"
    ]);
    const type = board.engine.typeOfSymbolAt(MAIN, board.offset);

    assert.ok(
        unknown(type),
        "назвать типом то, что типом не является, нельзя: " + type
    );
});

test("присваивание ниже точки запроса типа не задаёт", () => {
    /*
     * В этой точке переменная ещё ничего не содержит. Тип, который ей дадут
     * позже, к ней здесь отношения не имеет.
     */
    const board = stand([
        "Macro Run()",
        "  d|oc = 1;",
        "  doc = OpenFile(\"a\");",
        "End;"
    ]);
    const type = board.engine.typeOfSymbolAt(MAIN, board.offset);

    assert.ok(unknown(type), "получено: " + type);
});

test("одноимённая переменная соседней процедуры не влияет", () => {
    const board = stand([
        "Macro Other()",
        "  doc = OpenFile(\"a\");",
        "End;",
        "",
        "Macro Run()",
        "  d|oc = 1;",
        "End;"
    ]);
    const type = board.engine.typeOfSymbolAt(MAIN, board.offset);

    assert.ok(
        unknown(type),
        "область видимости у них разная, получено: " + type
    );
});

test("ожидаемый тип справа от присваивания", () => {
    const board = stand([
        "Macro Run()",
        "  Var doc: TBFile;",
        "  doc = |",
        "End;"
    ]);

    assert.strictEqual(
        board.engine.expectedTypeAt(MAIN, board.offset),
        "TBFile",
        "по нему ранжируется подсказка"
    );
});

test("тип чужого объявления не выводится из нашего текста", () => {
    /*
     * Позиции символа чужого модуля к нашему потоку токенов отношения не
     * имеют, а сам символ уже несёт готовый тип.
     */
    const LIB = "file:///d:/infer/lib.mac";
    const text = "Import lib;\n\nMacro Run()\n  Shar|ed = 1;\nEnd;\n";
    const offset = text.indexOf("|");
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN, LIB]);
    index.updateExternalModule(LIB, "Var Shared: String;\n", 1);
    index.updateOpenModule(MAIN, text.replace("|", ""), 1);

    const engine = new RslTypeEngine(index, new RslScopeResolver(index));

    assert.strictEqual(engine.typeOfSymbolAt(MAIN, offset), "string");
});

test("вывод согласован с тем, что показывает подсказка", () => {
    /*
     * Главное утверждение: два ответа об одном и том же месте обязаны
     * совпадать. Расхождение между ними и было тем, что здесь исправлено.
     */
    const board = stand([
        "Macro Run()",
        "  doc = OpenFile(\"a\");",
        "  d|oc = 1;",
        "End;"
    ]);
    const module = board.index.getModule(MAIN);
    const resolver = new RslScopeResolver(board.index);
    const byResolver = resolver.effectiveTypeNameAt(
        MAIN,
        module.symbolTree,
        board.offset
    );

    assert.strictEqual(byResolver, "TBFile");
    assert.strictEqual(
        board.engine.typeOfSymbolAt(MAIN, board.offset).toLowerCase(),
        byResolver.toLowerCase(),
        "два ответа об одном месте обязаны совпадать"
    );
});

console.log(
    failed === 0
        ? "\nПройдено: " + passed
        : "\nПройдено: " + passed + ", провалено: " + failed
);

if (failed > 0) {
    process.exitCode = 1;
}

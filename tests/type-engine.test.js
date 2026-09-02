"use strict";

/**
 * Семантика выражений отдельно от разрешения имён.
 *
 * Resolver отвечает «какой символ здесь имеется в виду», TypeEngine — «какой
 * тип». Проверяется то, ради чего слой заведён: ожидаемый тип в присваивании и
 * на месте аргумента, тип результата вызова, тип объявления и члена.
 *
 * И отдельно — что слой честно молчит там, где не знает: выдуманный тип хуже
 * пустого ответа, потому что по нему ранжируется подсказка.
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

const MAIN = "file:///d:/types/main.mac";

/** Стенд: текст с маркером | вместо курсора. */
function stand(sourceWithCursor) {
    const offset = sourceWithCursor.indexOf("|");
    const source = sourceWithCursor.replace("|", "");
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN]);
    index.updateOpenModule(MAIN, source, 1);

    const resolver = new RslScopeResolver(index);

    return {
        index,
        source,
        offset,
        engine: new RslTypeEngine(index, resolver)
    };
}

const WITH_TYPES = [
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
    ""
].join("\n");

test("тип объявленной переменной", () => {
    const board = stand(
        WITH_TYPES + "Macro Run()\n  Var doc: TBFile;\n  do|c = 1;\nEnd;\n"
    );

    assert.strictEqual(
        board.engine.typeOfSymbolAt(MAIN, board.offset),
        "TBFile"
    );
});

test("тип результата процедуры", () => {
    /* Курсор внутри скобок: именно про такое место отвечает resolveCall. */
    const board = stand(
        WITH_TYPES + "Macro Run()\n  Var doc = OpenFile(|\"a\");\nEnd;\n"
    );
    const call = board.engine.resolveCall(MAIN, board.offset);

    assert.ok(call, "вызов обязан найтись");
    assert.strictEqual(board.engine.typeOfSymbol(call.symbol), "TBFile");
});

test("ожидаемый тип справа от присваивания", () => {
    const board = stand(
        WITH_TYPES + "Macro Run()\n  Var doc: TBFile;\n  doc = |\nEnd;\n"
    );

    assert.strictEqual(
        board.engine.expectedTypeAt(MAIN, board.offset),
        "TBFile"
    );
});

test("ожидаемый тип при уже набранном начале имени", () => {
    const board = stand(
        WITH_TYPES + "Macro Run()\n  Var doc: TBFile;\n  doc = Ope|\nEnd;\n"
    );

    assert.strictEqual(
        board.engine.expectedTypeAt(MAIN, board.offset),
        "TBFile",
        "набранное начало имени не должно сбивать вывод"
    );
});

test("ожидаемый тип аргумента вызова", () => {
    const board = stand(
        WITH_TYPES + "Macro Run()\n  Send(|\nEnd;\n"
    );

    assert.strictEqual(
        board.engine.expectedTypeAt(MAIN, board.offset),
        "TBFile"
    );
});

test("у аргумента без написанного типа ожидания нет", () => {
    const board = stand(
        WITH_TYPES + "Macro Run()\n  Send(doc, |\nEnd;\n"
    );

    assert.strictEqual(
        board.engine.expectedTypeAt(MAIN, board.offset),
        "",
        "второй параметр объявлен без типа"
    );
});

test("вне присваивания и вызова ожидания нет", () => {
    const board = stand(
        WITH_TYPES + "Macro Run()\n  |\nEnd;\n"
    );

    assert.strictEqual(board.engine.expectedTypeAt(MAIN, board.offset), "");
});

test("тип неизвестного имени пуст", () => {
    const board = stand(
        WITH_TYPES + "Macro Run()\n  unkno|wn = 1;\nEnd;\n"
    );

    assert.strictEqual(
        board.engine.typeOfSymbolAt(MAIN, board.offset),
        "",
        "выдуманный тип хуже пустого"
    );
});

test("член класса разрешается", () => {
    const source = WITH_TYPES +
        "Macro Run()\n  Var doc: TBFile;\n  doc.Code = \"a\";\nEnd;\n";
    const board = stand(source);
    const receiver = source.lastIndexOf("doc.Code");
    const member = board.engine.resolveMember(MAIN, receiver, "Code");

    assert.ok(member, "член обязан найтись");
    assert.strictEqual(
        board.engine.typeOfSymbol(member.symbol),
        "string",
        "тип приводится к каноническому виду: сравнивают его, а не показывают"
    );
});

test("ответ запоминается на версию документа", () => {
    const board = stand(
        WITH_TYPES + "Macro Run()\n  Var doc: TBFile;\n  do|c = 1;\nEnd;\n"
    );

    assert.strictEqual(
        board.engine.typeOfSymbolAt(MAIN, board.offset),
        "TBFile"
    );

    /* Новая версия — новая модель, прежние ответы к ней не относятся. */
    board.index.updateOpenModule(
        MAIN,
        board.source.replace("Var doc: TBFile;", "Var doc: String;"),
        2
    );

    assert.strictEqual(
        board.engine.typeOfSymbolAt(MAIN, board.offset),
        "string",
        "устаревший ответ отдавать нельзя"
    );
});

const LIB = "file:///d:/types/lib.mac";

/** Проект: main подключает lib и вызывает Send из него. */
function project(libSource) {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN, LIB]);

    if (libSource !== undefined) {
        index.updateExternalModule(LIB, libSource, 1);
    }

    const source = "Import lib;\nMacro Run()\n  Send(\nEnd;\n";

    index.updateOpenModule(MAIN, source, 1);

    const resolver = new RslScopeResolver(index);

    return {
        index,
        engine: new RslTypeEngine(index, resolver),
        offset: source.indexOf("Send(") + 5
    };
}

const SEND_STRING = "Macro Send(value: String)\nEnd;\n";
const SEND_INTEGER = "Macro Send(value: Integer)\nEnd;\n";

test("правка подписи в зависимости меняет ожидаемый тип", () => {
    /*
     * Сам main.mac не менялся, и объект его модели остался тем же. Кэша по
     * объекту модуля тут мало: тип аргумента берётся из ПОДКЛЮЧЁННОГО файла,
     * и правка его подписи обязана дойти.
     */
    const board = project(SEND_STRING);

    assert.strictEqual(
        board.engine.expectedTypeAt(MAIN, board.offset),
        "string"
    );

    const before = board.index.getModule(MAIN);

    board.index.updateExternalModule(LIB, SEND_INTEGER, 2);

    assert.strictEqual(
        board.index.getModule(MAIN),
        before,
        "модель main.mac обязана остаться прежним объектом"
    );
    assert.strictEqual(
        board.engine.expectedTypeAt(MAIN, board.offset),
        "integer",
        "устаревший ответ отдавать нельзя"
    );
});

test("догруженная зависимость меняет ответ", () => {
    /* Пока lib не прочитан, тип неизвестен — и это честный ответ. */
    const board = project(undefined);

    assert.strictEqual(board.engine.expectedTypeAt(MAIN, board.offset), "");

    board.index.updateExternalModule(LIB, SEND_STRING, 1);

    assert.strictEqual(
        board.engine.expectedTypeAt(MAIN, board.offset),
        "string",
        "после загрузки зависимости ответ обязан появиться"
    );
});

test("правка постороннего файла ответ не сбрасывает", () => {
    /*
     * Обратная сторона: сбрасывать весь слой из-за чужого файла нельзя, иначе
     * фоновая индексация обнуляла бы кэш тысячи раз подряд.
     */
    const other = "file:///d:/types/other.mac";
    const board = project(SEND_STRING);

    board.index.registerWorkspaceFile(other);

    const first = board.engine.expectedTypeAt(MAIN, board.offset);

    board.index.updateExternalModule(other, "Macro Alone()\nEnd;\n", 1);

    assert.strictEqual(
        board.engine.expectedTypeAt(MAIN, board.offset),
        first
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

"use strict";

/**
 * Журнал правок: где именно менялся документ.
 *
 * Редактор присылает точные диапазоны изменений, а служба разбора их
 * выбрасывала и искала правку заново — сравнением общего префикса и суффикса
 * двух версий текста. На файле 700 КБ это два прохода по мегабайту символов на
 * каждое нажатие клавиши, и делаются они ради сведений, которые уже пришли.
 *
 * Журнал обязан отвечать либо точным участком, либо молчанием: неверный
 * участок означал бы неверный разбор, а молчание — всего лишь прежний полный
 * путь. Поэтому проверяется и то, что он находит, и то, от чего отказывается.
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
    RslDocumentChangeLog
} = require("../server/out/services/documentChangeLog");
const {
    tryIncrementalRelex
} = require("../server/out/services/incrementalLex");
const { lexRsl } = require("../server/out/lexer");
const {
    TextDocument
} = require("../server/node_modules/vscode-languageserver-textdocument");

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

const URI = "file:///d:/change-log/main.mac";

/**
 * Документ и журнал, связанные так же, как на сервере.
 *
 * Журнал записывает правку по тексту ДО неё, документ применяет её после —
 * именно этот порядок и обеспечивает обёртка соединения в рабочем сервере.
 */
function stand(initial) {
    const log = new RslDocumentChangeLog();
    let document = TextDocument.create(URI, "rsl", 1, initial);

    return {
        log,
        get text() {
            return document.getText();
        },
        get version() {
            return document.version;
        },
        /** Применить одно событие редактора с любым числом изменений. */
        apply(changes) {
            const before = document.getText();
            const beforeVersion = document.version;
            const version = beforeVersion + 1;

            log.record(URI, document, version, changes);
            document = TextDocument.update(document, changes, version);

            return { before, beforeVersion, version };
        },
        /** Участок между версией from и текущей. */
        spanFrom(fromVersion, previousLength) {
            return log.changedSpan(
                URI,
                fromVersion,
                document.version,
                previousLength,
                document.getText().length
            );
        }
    };
}

/** Изменение в виде, в каком его присылает редактор. */
function change(startLine, startCharacter, endLine, endCharacter, text) {
    return {
        range: {
            start: { line: startLine, character: startCharacter },
            end: { line: endLine, character: endCharacter }
        },
        text
    };
}

/**
 * Участок обязан описывать настоящую разницу текстов.
 *
 * Проверяется по определению: то, что снаружи участка, обязано совпадать до
 * символа, а то, что внутри, — быть ровно заменённым куском.
 */
function assertSpanDescribes(before, after, span, what) {
    assert.ok(span, what + ": участок обязан быть найден");
    assert.strictEqual(
        before.slice(0, span.oldStart),
        after.slice(0, span.oldStart),
        what + ": текст до участка обязан совпадать"
    );
    assert.strictEqual(
        before.slice(span.oldEnd),
        after.slice(span.newEnd),
        what + ": текст после участка обязан совпадать"
    );
    assert.strictEqual(
        before.slice(0, span.oldStart) +
            after.slice(span.oldStart, span.newEnd) +
            before.slice(span.oldEnd),
        after,
        what + ": замена участка обязана давать новый текст"
    );
}

const SAMPLE = [
    "Import common;",
    "",
    "Macro First(value)",
    "  Var result = 0;",
    "  result = value;",
    "  return result;",
    "End;",
    "",
    "Macro Second(value)",
    "  return value;",
    "End;",
    ""
].join("\n");

test("вставка: участок описывает разницу", () => {
    const board = stand(SAMPLE);
    const { before } = board.apply([change(3, 18, 3, 18, " // добавлено")]);

    assertSpanDescribes(
        before,
        board.text,
        board.spanFrom(1, before.length),
        "вставка"
    );
});

test("удаление: участок описывает разницу", () => {
    const board = stand(SAMPLE);
    const { before } = board.apply([change(4, 0, 5, 0, "")]);

    assertSpanDescribes(
        before,
        board.text,
        board.spanFrom(1, before.length),
        "удаление"
    );
});

test("замена: участок описывает разницу", () => {
    const board = stand(SAMPLE);
    const { before } = board.apply([change(4, 2, 4, 8, "answer")]);

    assertSpanDescribes(
        before,
        board.text,
        board.spanFrom(1, before.length),
        "замена"
    );
});

test("несколько изменений в одном событии", () => {
    const board = stand(SAMPLE);
    /*
     * Множественный курсор: изменения применяются подряд, и второе задано уже
     * в координатах текста, изменённого первым.
     */
    const { before } = board.apply([
        change(9, 2, 9, 8, "return"),
        change(3, 2, 3, 5, "Let")
    ]);

    assertSpanDescribes(
        before,
        board.text,
        board.spanFrom(1, before.length),
        "два изменения"
    );
});

test("изменение числа строк", () => {
    for (const [name, edit] of [
        ["добавление строк", change(3, 18, 3, 18, "\n  Var extra = 1;\n")],
        ["удаление строк", change(2, 0, 6, 0, "")],
        ["замена на многострочный текст", change(4, 0, 4, 17, "  a = 1;\n  b = 2;")]
    ]) {
        const board = stand(SAMPLE);
        const { before } = board.apply([edit]);

        assertSpanDescribes(
            before,
            board.text,
            board.spanFrom(1, before.length),
            name
        );
    }
});

test("CRLF и LF дают одинаково верный участок", () => {
    for (const eol of ["\n", "\r\n"]) {
        const text = SAMPLE.split("\n").join(eol);
        const board = stand(text);
        const { before } = board.apply([change(4, 2, 4, 8, "answer")]);

        assertSpanDescribes(
            before,
            board.text,
            board.spanFrom(1, before.length),
            eol === "\n" ? "LF" : "CRLF"
        );
    }
});

test("цепочка правок сводится в один участок", () => {
    const board = stand(SAMPLE);
    const before = board.text;

    board.apply([change(3, 18, 3, 18, " // раз")]);
    board.apply([change(9, 15, 9, 15, " // два")]);
    board.apply([change(4, 2, 4, 8, "answer")]);

    assertSpanDescribes(
        before,
        board.text,
        board.spanFrom(1, before.length),
        "три правки подряд"
    );
});

test("устаревшее поколение: участка нет", () => {
    const board = stand(SAMPLE);

    board.apply([change(3, 18, 3, 18, " // раз")]);

    assert.strictEqual(
        board.log.changedSpan(URI, 0, board.version, 1, 2),
        undefined,
        "версии, которой журнал не видел, участка нет"
    );
    assert.strictEqual(
        board.log.changedSpan(URI, 1, board.version + 5, 1, 2),
        undefined,
        "версии, до которой журнал не дошёл, участка нет"
    );
});

test("несовпадение длин обрывает доверие", () => {
    const board = stand(SAMPLE);
    const { before } = board.apply([change(3, 18, 3, 18, " // раз")]);

    assert.ok(
        board.spanFrom(1, before.length),
        "при верных длинах участок обязан находиться"
    );
    assert.strictEqual(
        board.log.changedSpan(
            URI,
            1,
            board.version,
            before.length + 1,
            board.text.length
        ),
        undefined,
        "чужая длина исходного текста обязана отменять ответ"
    );
    assert.strictEqual(
        board.log.changedSpan(
            URI,
            1,
            board.version,
            before.length,
            board.text.length + 1
        ),
        undefined,
        "чужая длина нового текста обязана отменять ответ"
    );
});

test("полнотекстовое изменение обрывает цепочку", () => {
    const board = stand(SAMPLE);

    board.apply([change(3, 18, 3, 18, " // раз")]);

    const before = board.text;
    const version = board.version;

    /* Замена без диапазона: о месте правки не известно ничего. */
    board.log.record(
        URI,
        TextDocument.create(URI, "rsl", version, before),
        version + 1,
        [{ text: before + "\nMacro Third()\nEnd;\n" }]
    );

    assert.strictEqual(
        board.log.changedSpan(URI, version, version + 1, before.length, 1),
        undefined,
        "полнотекстовая замена не имеет права давать участок"
    );
    assert.strictEqual(
        board.log.size,
        0,
        "оборванная цепочка не удерживается в памяти"
    );
});

test("закрытый документ уходит из журнала", () => {
    const board = stand(SAMPLE);

    board.apply([change(3, 18, 3, 18, " // раз")]);
    assert.ok(board.log.size > 0);

    board.log.forget(URI);
    assert.strictEqual(board.log.size, 0);
    assert.strictEqual(
        board.spanFrom(1, SAMPLE.length),
        undefined,
        "после закрытия участка быть не должно"
    );
});

test("точечный lex с участком совпадает с полным lex", () => {
    /*
     * Точечный путь включается только на крупных файлах, поэтому образец
     * заведомо больше порога. Проверяется главное: участок из журнала обязан
     * давать ровно тот же результат, что и обычное полное лексирование.
     */
    const lines = ["Import common;", ""];

    for (let index = 0; index < 3000; index++) {
        lines.push(
            "Macro Process" + index + "(document, options)",
            "  Var result = 0;",
            "  result = document.Value;",
            "  return result;",
            "End;",
            ""
        );
    }

    const text = lines.join("\n");

    assert.ok(text.length > 50_000, "образец обязан быть больше порога");

    const board = stand(text);
    const baseLex = lexRsl(text, { includeTrivia: true });
    /* Правка в середине тела: строка «  result = document.Value;». */
    const line = 2 + 1500 * 6 + 2;
    const { before } = board.apply([change(line, 2, line, 8, "answer")]);
    const span = board.spanFrom(1, before.length);

    assert.ok(span, "участок обязан быть найден");

    const withSpan = tryIncrementalRelex(
        before,
        baseLex,
        board.text,
        undefined,
        span
    );
    const withoutSpan = tryIncrementalRelex(before, baseLex, board.text);
    const full = lexRsl(board.text, { includeTrivia: true });

    assert.ok(withSpan, "точечный lex с участком обязан сработать");
    assert.deepStrictEqual(
        withSpan.tokens,
        full.tokens,
        "точечный lex с участком обязан совпадать с полным"
    );
    assert.deepStrictEqual(
        withSpan.tokens,
        withoutSpan.tokens,
        "участок не имеет права менять результат точечного lex"
    );
    assert.deepStrictEqual(
        withSpan.lineStarts,
        full.lineStarts,
        "начала строк обязаны совпадать с полным lex"
    );
});

test("заведомо неверный участок не принимается на веру", () => {
    /*
     * Журнал такого участка не выдаст, но проверка обязана быть: точечный lex
     * получает участок снаружи, и его собственные проверки — последняя защита.
     * Здесь участок указывает на середину другой строки.
     */
    const lines = ["Import common;", ""];

    for (let index = 0; index < 3000; index++) {
        lines.push(
            "Macro Process" + index + "(document)",
            "  return document.Value;",
            "End;",
            ""
        );
    }

    const text = lines.join("\n");
    const baseLex = lexRsl(text, { includeTrivia: true });
    const at = text.indexOf("Process1500");
    const next = text.slice(0, at) + "Renamed" + text.slice(at + 7);
    const wrong = { oldStart: 0, oldEnd: 0, newEnd: 0 };
    const result = tryIncrementalRelex(
        text,
        baseLex,
        next,
        undefined,
        wrong
    );

    /*
     * Пустой участок означает «ничего не менялось». Результат обязан либо
     * совпасть с полным lex, либо отсутствовать — но не быть тихо неверным.
     */
    if (result) {
        assert.deepStrictEqual(
            result.tokens,
            lexRsl(next, { includeTrivia: true }).tokens,
            "точечный lex обязан либо отказаться, либо дать верный ответ"
        );
    }
});

if (failed > 0) {
    console.error("\nПройдено: " + passed + "\nОшибок: " + failed);
    process.exitCode = 1;
} else {
    console.log("\nПройдено: " + passed + "\nОшибок: " + failed);
}

"use strict";

/*
 * Форматирование выделения.
 *
 * Два требования, и оба проверяются здесь: результат обязан совпадать с
 * форматированием всего документа для этих же строк, а работа — не зависеть от
 * размера файла за пределами блока, в котором стоит выделение.
 */

const assert = require("assert");

const {
    formatRslDocumentRange
} = require("../server/out/features/rangeFormatting");
const { FormatCode } = require("../server/out/format");
const lexerModule = require("../server/out/lexer");
const { lexRsl } = lexerModule;
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const {
    splitRslDocumentUnits
} = require("../server/out/analysis/documentUnits");
const {
    positionAtOffset
} = require("../server/out/core/documentPosition");
const {
    TextDocument
} = require("../server/node_modules/vscode-languageserver-textdocument");

let passed = 0;
let failed = 0;

function test(name, action) {
    try {
        action();
        passed++;
        console.log(`[OK] ${name}`);
    } catch (error) {
        failed++;
        console.error(`[FAIL] ${name}`);
        console.error(error);
    }
}

/** Строки верхнеуровневых блоков — так их считает сервер. */
function blockStartLines(source) {
    const uri = "file:///format.mac";
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([uri]);
    const module = index.updateOpenModule(uri, source, 1);
    const lines = new Set();

    for (const unit of splitRslDocumentUnits(
        module.source,
        module.lex.tokens,
        module.symbolTree
    )) {
        if (unit.kind === "macro" || unit.kind === "class") {
            lines.add(
                positionAtOffset(module.lex.lineStarts, unit.start).line
            );
        }
    }

    return [...lines].sort((left, right) => left - right);
}

function formatRange(source, startLine, endLine, options = {}) {
    const document = TextDocument.create(
        "file:///format.mac",
        "rsl",
        1,
        source
    );
    const params = {
        textDocument: { uri: document.uri },
        range: {
            start: { line: startLine, character: 0 },
            end: { line: endLine + 1, character: 0 }
        },
        options: {
            tabSize: options.tabSize || 4,
            insertSpaces: options.insertSpaces !== false
        }
    };
    const edits = formatRslDocumentRange(document, params, {
        blockStartLines: options.withoutBlocks
            ? undefined
            : blockStartLines(source),
        lex: options.withoutTokens ? undefined : lexRsl(source)
    });

    return edits.length === 0
        ? document.getText(params.range)
        : edits[0].newText;
}

/** Те же строки из форматирования всего документа. */
function wholeDocumentLines(source, startLine, endLine, options = {}) {
    const formatted = FormatCode(source, options.tabSize || 4, {
        insertSpaces: options.insertSpaces !== false
    });
    const lines = formatted.split(/\r\n|\n|\r/);
    const selected = lines.slice(startLine, endLine + 1);

    return selected.join("\n") + (endLine + 1 < lines.length ? "\n" : "");
}

/** Файл из нескольких процедур; наполнение — вокруг выделения. */
function sample(padding) {
    const lines = ["Macro First()", "  Var a = 1;", "End;", ""];

    for (let index = 0; index < padding; index++) {
        lines.push(
            `Macro Filler${index}()`,
            `      Var x${index}=${index};`,
            "  If (x" + index + ">0)",
            "  Var y=1;",
            "End;",
            "End;",
            ""
        );
    }

    lines.push(
        "Macro Target()",
        "        Var first=1;",
        "  If (first>0)",
        "      Var second   =2;",
        "  End;",
        "End;",
        ""
    );

    return lines.join("\n");
}

test("выделение форматируется так же, как весь документ", () => {
    for (const padding of [0, 5, 40]) {
        const source = sample(padding);
        const target = source.split("\n").indexOf("        Var first=1;");
        assert.ok(target > 0);

        for (const [from, to] of [
            [target, target],
            [target, target + 3],
            [target + 1, target + 2]
        ]) {
            assert.strictEqual(
                formatRange(source, from, to),
                wholeDocumentLines(source, from, to),
                `наполнение ${padding}, строки ${from}..${to}`
            );
        }
    }
});

test("без границ блоков ответ тот же", () => {
    const source = sample(3);
    const target = source.split("\n").indexOf("        Var first=1;");

    assert.strictEqual(
        formatRange(source, target, target + 3, { withoutBlocks: true }),
        wholeDocumentLines(source, target, target + 3),
        "пока модель не готова, форматируется документ целиком — и тем же текстом"
    );
});

test("работа не растёт вместе с файлом", () => {
    /*
     * Замер в тесте — сравнительный, а не абсолютный: он проверяет не
     * миллисекунды, а то, что за пределами блока файл не форматируется.
     * Абсолютные числа меряет build/bench-range-format.
     */
    const small = sample(20);
    const large = sample(400);
    const targetOf = source =>
        source.split("\n").indexOf("        Var first=1;");
    const prepare = source => {
        const from = targetOf(source);
        const document = TextDocument.create(
            "file:///format.mac",
            "rsl",
            1,
            source
        );

        return {
            document,
            options: {
                blockStartLines: blockStartLines(source),
                lex: lexRsl(source)
            },
            params: {
                textDocument: { uri: document.uri },
                range: {
                    start: { line: from, character: 0 },
                    end: { line: from + 4, character: 0 }
                },
                options: { tabSize: 4, insertSpaces: true }
            }
        };
    };
    const once = prepared => {
        const started = process.hrtime.bigint();
        formatRslDocumentRange(
            prepared.document,
            prepared.params,
            prepared.options
        );

        return Number(process.hrtime.bigint() - started) / 1e6;
    };
    const smallStand = prepare(small);
    const largeStand = prepare(large);
    let smallMs = Infinity;
    let largeMs = Infinity;

    /*
     * Замеры чередуются, и от каждого берётся лучший: две серии подряд
     * попадали в разную загрузку машины, и на общем прогоне тестов
     * проверка падала не из-за форматирования.
     */
    for (let run = 0; run < 7; run++) {
        smallMs = Math.min(smallMs, once(smallStand));
        largeMs = Math.min(largeMs, once(largeStand));
    }

    assert.ok(
        largeMs < smallMs * 4 + 3,
        `файл в двадцать раз больше не должен стоить дороже: ${
            smallMs.toFixed(2)} против ${largeMs.toFixed(2)} мс`
    );
});

test("строка, продолженная слешом, не уводит отступ вправо", () => {
    /*
     * Строковый литерал, продолженный обратным слешом, содержит скобки. Они
     * относятся к тексту строки, а не к коду, и отступ следующих строк файла
     * менять не должны. Прежде такая скобка оставалась в стеке форматтера до
     * конца файла, и каждая следующая строка выравнивалась по её колонке: на
     * реальном файле репозитория так набегало 297 пробелов отступа.
     */
    const source = String.raw`Macro First()
    Var us_f = 0;
    us_f = LnSelectValue("select max(a.t_x) KEEP(dense_rank last) from t  \
                    where a.t_y = "+us_f+" ", v_date);
    Var after = 1;
End;

Macro Target()
    Var first = 1;
End;
`;
    const lines = FormatCode(source, 4, { insertSpaces: true })
        .split(/\r\n|\n|\r/);
    const indentOf = fragment => {
        const line = lines.find(item => item.trim().startsWith(fragment));

        assert.ok(line !== undefined, "нет строки " + fragment);

        return line.length - line.trimStart().length;
    };

    assert.strictEqual(indentOf("Var after"), 4, "строка внутри процедуры");
    assert.strictEqual(indentOf("Macro Target"), 0, "следующая процедура");
});

test("выделение после незакрытого блока форматируется как весь документ", () => {
    /*
     * ONERROR верхнего уровня форматтер считает открытым блоком до конца
     * файла. Кусок с нулевого уровня дал бы другой отступ, поэтому такой
     * файл форматируется целиком — и ответ обязан совпасть с полным.
     */
    const source = [
        "Macro First()",
        "    Var a = 1;",
        "End;",
        "",
        "onerror",
        '    msgbox("ошибка");',
        "",
        "Macro Target()",
        "        Var first=1;",
        "    If (first>0)",
        "  Var second=2;",
        "    End;",
        "End;",
        ""
    ].join(String.fromCharCode(10));
    const target = source
        .split(String.fromCharCode(10))
        .indexOf("        Var first=1;");

    assert.ok(target > 0);
    assert.strictEqual(
        formatRange(source, target, target + 3),
        wholeDocumentLines(source, target, target + 3),
        "текст ответа обязан совпасть с полным форматированием"
    );

    /*
     * И этого мало: ответ обязан остаться быстрым. Если точка в конце
     * строки «съедает» следующий END, счёт блоков не сходится и файл
     * форматируется целиком — текст тот же, а цена как у всего документа.
     */
    const withDot = growing(true);
    const withoutDot = growing(false);

    assert.ok(
        withDot < withoutDot * 4 + 3,
        "незавершённая точка не должна возвращать к полному форматированию: " +
            withDot.toFixed(2) + " против " + withoutDot.toFixed(2) + " мс"
    );
});

/** Время ответа на большом файле: с незавершённой точкой и без неё. */
function growing(withUnfinishedDot) {
    const lines = [];

    for (let index = 0; index < 3000; index++) {
        lines.push("Macro Filler" + index + "()");

        lines.push("  Var x" + index + "=" + index + ";");

        /* Точка последней строкой тела: следующий токен — как раз END. */
        if (withUnfinishedDot && index === 0) {
            lines.push("  obj.");
        }

        lines.push("End;", "");
    }

    lines.push(
        "Macro Target()",
        "        Var first=1;",
        "  If (first>0)",
        "      Var second   =2;",
        "  End;",
        "End;",
        ""
    );

    const source = lines.join(String.fromCharCode(10));
    const target = source
        .split(String.fromCharCode(10))
        .indexOf("        Var first=1;");
    const document = TextDocument.create(
        "file:///format.mac",
        "rsl",
        1,
        source
    );
    const params = {
        textDocument: { uri: document.uri },
        range: {
            start: { line: target, character: 0 },
            end: { line: target + 4, character: 0 }
        },
        options: { tabSize: 4, insertSpaces: true }
    };
    const options = {
        blockStartLines: blockStartLines(source),
        lex: lexRsl(source)
    };
    let best = Infinity;

    for (let run = 0; run < 7; run++) {
        const started = process.hrtime.bigint();
        formatRslDocumentRange(document, params, options);
        best = Math.min(
            best,
            Number(process.hrtime.bigint() - started) / 1e6
        );
    }

    return best;
}

test("незавершённое обращение через точку не меняет ответ", () => {
    /*
     * Так выглядит текст в момент набора: точка есть, имени члена ещё нет.
     * Проверка границ блока не имеет права принять следующий END за имя
     * после точки — иначе кусок считается с чужого уровня отступа.
     */
    const source = [
        "Macro First()",
        "  Var obj = 1;",
        "  obj.",
        "End;",
        "",
        "Macro Target()",
        "        Var first=1;",
        "  If (first>0)",
        "      Var second   =2;",
        "  End;",
        "End;",
        ""
    ].join(String.fromCharCode(10));
    const target = source
        .split(String.fromCharCode(10))
        .indexOf("        Var first=1;");

    assert.ok(target > 0);
    assert.strictEqual(
        formatRange(source, target, target + 3),
        wholeDocumentLines(source, target, target + 3),
        "текст ответа обязан совпасть с полным форматированием"
    );

    /*
     * И этого мало: ответ обязан остаться быстрым. Если точка в конце
     * строки «съедает» следующий END, счёт блоков не сходится и файл
     * форматируется целиком — текст тот же, а цена как у всего документа.
     */
    const withDot = growing(true);
    const withoutDot = growing(false);

    assert.ok(
        withDot < withoutDot * 4 + 3,
        "незавершённая точка не должна возвращать к полному форматированию: " +
            withDot.toFixed(2) + " против " + withoutDot.toFixed(2) + " мс"
    );
});

/** Время ответа на большом файле: с незавершённой точкой и без неё. */
function growing(withUnfinishedDot) {
    const lines = [];

    for (let index = 0; index < 300; index++) {
        lines.push("Macro Filler" + index + "()");

        lines.push("  Var x" + index + "=" + index + ";");

        /* Точка последней строкой тела: следующий токен — как раз END. */
        if (withUnfinishedDot && index === 0) {
            lines.push("  obj.");
        }

        lines.push("End;", "");
    }

    lines.push(
        "Macro Target()",
        "        Var first=1;",
        "  If (first>0)",
        "      Var second   =2;",
        "  End;",
        "End;",
        ""
    );

    const source = lines.join(String.fromCharCode(10));
    const target = source
        .split(String.fromCharCode(10))
        .indexOf("        Var first=1;");
    const document = TextDocument.create(
        "file:///format.mac",
        "rsl",
        1,
        source
    );
    const params = {
        textDocument: { uri: document.uri },
        range: {
            start: { line: target, character: 0 },
            end: { line: target + 4, character: 0 }
        },
        options: { tabSize: 4, insertSpaces: true }
    };
    const options = {
        blockStartLines: blockStartLines(source),
        lex: lexRsl(source)
    };
    let best = Infinity;

    for (let run = 0; run < 7; run++) {
        const started = process.hrtime.bigint();
        formatRslDocumentRange(document, params, options);
        best = Math.min(
            best,
            Number(process.hrtime.bigint() - started) / 1e6
        );
    }

    return best;
}

test("табуляции и размер отступа берутся у редактора", () => {
    const source = sample(0);
    const target = source.split("\n").indexOf("        Var first=1;");
    const spaces = formatRange(source, target, target, { tabSize: 2 });
    const tabs = formatRange(source, target, target, {
        insertSpaces: false
    });

    assert.strictEqual(spaces, "  Var first = 1;\n");
    assert.strictEqual(tabs, "\tVar first = 1;\n");
});

test("готовый разбор не лексируется заново", () => {
    /*
     * Форматирование всего документа получает разбор снаружи: снимок текущей
     * версии его уже посчитал. Прежде FormatCode первым делом лексировал тот
     * же текст сам.
     */
    const source = Array.from({ length: 400 }, (_ignored, at) => [
        "Macro Run" + at + "()",
        "  Var value = " + at + ";",
        "  if (value > 0)",
        "    value = value + 1;",
        "  end;",
        "End;",
        ""
    ].join("\n")).join("\n");
    const prepared = lexRsl(source);
    const original = lexerModule.lexRsl;
    let whole = 0;

    lexerModule.lexRsl = function (text, ...rest) {
        if (text === source) {
            whole++;
        }

        return original.call(this, text, ...rest);
    };

    let formatted;

    try {
        formatted = FormatCode(source, 4, {}, prepared);
    } finally {
        lexerModule.lexRsl = original;
    }

    assert.strictEqual(
        formatted,
        FormatCode(source, 4, {}),
        "результат обязан совпасть с прежним путём"
    );
    assert.strictEqual(
        whole,
        0,
        "весь документ не имеет права лексироваться второй раз"
    );
});

console.log(`\nПройдено: ${passed}, провалено: ${failed}`);

if (failed > 0) {
    process.exit(1);
}

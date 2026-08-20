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
            : blockStartLines(source)
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
    const measure = source => {
        const from = targetOf(source);
        const blocks = blockStartLines(source);
        const document = TextDocument.create(
            "file:///format.mac",
            "rsl",
            1,
            source
        );
        const params = {
            textDocument: { uri: document.uri },
            range: {
                start: { line: from, character: 0 },
                end: { line: from + 4, character: 0 }
            },
            options: { tabSize: 4, insertSpaces: true }
        };
        let best = Infinity;

        for (let run = 0; run < 5; run++) {
            const started = process.hrtime.bigint();
            formatRslDocumentRange(document, params, {
                blockStartLines: blocks
            });
            best = Math.min(
                best,
                Number(process.hrtime.bigint() - started) / 1e6
            );
        }

        return best;
    };

    const smallMs = measure(small);
    const largeMs = measure(large);

    assert.ok(
        largeMs < smallMs * 4 + 2,
        `файл в двадцать раз больше не должен стоить дороже: ${
            smallMs.toFixed(2)} против ${largeMs.toFixed(2)} мс`
    );
});

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

console.log(`\nПройдено: ${passed}, провалено: ${failed}`);

if (failed > 0) {
    process.exit(1);
}

"use strict";

/**
 * Точечная модель на рабочем пути.
 *
 * Дифференциальные проверки сравнивают точечный путь с полным напрямую. Здесь
 * проверяется другое: что этим путём вообще идёт служба разбора — та, через
 * которую работает редактор, — и что модель, попавшая в индекс, совпадает с
 * моделью полного расчёта.
 *
 * Без этой проверки точечный путь мог бы оказаться выключенным на рабочем
 * пути, а дифференциальные тесты продолжали бы проходить.
 */

const assert = require("assert");

const {
    TextDocument
} = require("../server/node_modules/vscode-languageserver-textdocument");
const {
    DocumentAnalysisService
} = require("../server/out/services/documentAnalysisService");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const {
    createRslVirtualClock
} = require("../server/out/core/clock");
const { lexRsl } = require("../server/out/lexer");
const { parseRslSyntax } = require("../server/out/syntaxParser");
const {
    createRslModelState
} = require("../server/out/services/incrementalModel");

let passed = 0;
let failed = 0;

const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const URI = "file:///service-incremental.mac";

/** Файл заведомо больше порога точечного пути. */
function sample(count, tail) {
    const lines = ["Import common;", ""];

    for (let index = 0; index < count; index++) {
        lines.push(
            "Macro Process" + index + "(document, options)",
            "  Var result = 0;",
            "  if (options == 1)",
            "    result = document.Value;",
            "  end;",
            "  return result" + (index === count - 1 ? tail : "") + ";",
            "End;",
            ""
        );
    }

    return lines.join("\n");
}

/** Подпись дерева символов: то, чем живут навигация и подсветка. */
function symbolSignature(module) {
    const parts = [];

    const walk = symbol => {
        parts.push([
            symbol.id,
            symbol.name,
            symbol.kind,
            symbol.range.start,
            symbol.range.end,
            symbol.typeName || ""
        ].join(":"));

        for (const child of symbol.children) {
            walk(child);
        }
    };

    walk(module.symbolTree);

    return module.imports.join(",") + "#" + parts.join("|");
}

test("служба разбора правит модель точечно и получает тот же ответ", async () => {
    const first = sample(400, "");
    const second = sample(400, " + 0");

    assert.ok(first.length > 50_000, "файл обязан быть больше порога");

    let document = TextDocument.create(URI, "rsl", 1, first);
    const documents = { get: uri => (uri === URI ? document : undefined) };
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([URI]);

    const clock = createRslVirtualClock(1000);
    const marks = [];
    const analysis = new DocumentAnalysisService(
        documents,
        index,
        { getAvailable: () => ({ imports: { enabled: false } }) },
        {
            log: () => undefined,
            clock,
            invalidateProviderCaches: () => undefined,
            onParsed: () => undefined,
            onImports: () => undefined,
            initialParseDelayMs: 0,
            changeDebounceMs: 10,
            performance: {
                enabled: false,
                mark: (name, fields) => marks.push({ name, fields })
            }
        }
    );

    analysis.setActiveDocument(URI);
    analysis.open(document);
    await clock.advance(60);

    /* Первая версия — полный путь: сравнивать пока нечего. */
    assert.ok(
        index.getCurrentModule(URI, 1),
        "модель первой версии готова"
    );

    document = TextDocument.create(URI, "rsl", 2, second);
    analysis.changed(document);
    await clock.advance(60);

    const decisions = marks
        .filter(item => item.name === "analysis.incrementalParse")
        .map(item => item.fields.reason);

    assert.deepStrictEqual(
        decisions,
        ["incremental"],
        "правка обязана пойти точечным путём: " + JSON.stringify(decisions)
    );

    const model = index.getCurrentModule(URI, 2);

    assert.ok(model, "модель второй версии готова");

    const full = createRslModelState(
        second,
        parseRslSyntax(
            second,
            lexRsl(second, { includeTrivia: true }),
            { buildExpressionTree: false }
        )
    ).model;

    assert.strictEqual(
        symbolSignature(model),
        symbolSignature(full),
        "дерево символов совпадает с полным расчётом"
    );
    assert.strictEqual(
        model.syntax.root.children.length,
        full.syntax.root.children.length,
        "число единиц верхнего уровня совпадает"
    );
});

(async () => {
    for (const item of tests) {
        try {
            await item.action();
            passed++;
            console.log(`[OK] ${item.name}`);
        } catch (error) {
            failed++;
            console.error(`[FAIL] ${item.name}`);
            console.error(error);
        }
    }

    if (failed > 0) {
        console.error(`\nПройдено: ${passed}\nОшибок: ${failed}`);
        process.exitCode = 1;
    } else {
        console.log(`\nПройдено: ${passed}\nОшибок: ${failed}`);
    }
})();

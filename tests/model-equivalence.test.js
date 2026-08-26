"use strict";

/**
 * Эталонное сравнение: модель после серии правок обязана совпадать с моделью,
 * построенной по итоговому тексту с нуля.
 *
 * Это защитный контур инкрементальной модели документа: правка идёт через
 * точечный lex, точечный разбор и точечную сборку символов. Разойдись любой из
 * трёх хоть на смещение — разойдутся AST, symbol tree и Problems. Тест лексера
 * сравнивает токены; здесь сравнивается то, что из них построено, включая
 * диагностику.
 *
 * Сам компаратор обязан быть чувствительным, иначе он проверяет ничто. Поэтому
 * первым делом он проверяется на намеренно испорченной копии.
 */

const assert = require("assert");

const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { lexRsl } = require("../server/out/lexer");
const { parseRslSyntax } = require("../server/out/syntaxParser");
const { createOpenModuleModel } = require("../server/out/moduleModel");
const {
    createRslModelState,
    tryUpdateRslModelState
} = require("../server/out/services/incrementalModel");
const { buildRslDiagnostics } = require("../server/out/diagnostics");
const {
    createFastDocumentSnapshot
} = require("../server/out/services/fastDocumentSnapshot");
const {
    TextDocument
} = require("../server/node_modules/vscode-languageserver-textdocument");
const {
    SYMBOL_FIELDS,
    compareSyntaxNodes,
    compareSymbols,
    compareDiagnostics,
    mirrorSymbol
} = require("./helpers/modelComparators");

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

/** Полная модель по тексту, без единой переиспользованной части. */
function buildFromScratch(uri, source) {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([uri]);
    const module = index.updateOpenModule(uri, source, 1);
    return {
        index,
        module,
        diagnostics: buildRslDiagnostics(module, index)
    };
}

/*
 * ─── Чувствительность компаратора ───────────────────────────────────────────
 */

test("компаратор находит расхождение там, где оно есть", () => {
    const source = [
        "Import utils;",
        "Class Doc",
        "  Macro Save(target)",
        "    Var name: String;",
        "  End;",
        "End;",
        "Macro Test()",
        "  Var doc = Doc();",
        "  If (doc)",
        "    doc.Save(1);",
        "  End;",
        "End;"
    ].join("\n");
    const first = buildFromScratch("file:///eq.mac", source);
    const second = buildFromScratch("file:///eq.mac", source);

    /* Одинаковые входы обязаны сходиться: иначе компаратор шумит. */
    assert.strictEqual(
        compareSyntaxNodes(first.module.syntax.root, second.module.syntax.root),
        undefined
    );
    assert.strictEqual(
        compareSymbols(first.module.symbolTree, second.module.symbolTree),
        undefined
    );
    assert.strictEqual(
        compareDiagnostics(first.diagnostics, second.diagnostics),
        undefined
    );

    /* А теперь портим копию — каждое искажение обязано быть замечено. */
    const damagedSyntax = parseRslSyntax(
        source,
        lexRsl(source),
        { buildExpressionTree: false }
    );
    damagedSyntax.root.children[1].children[0].start += 1;
    assert.match(
        String(compareSyntaxNodes(
            first.module.syntax.root,
            damagedSyntax.root
        )),
        /children\[1\]\.children\[0\]\.start/,
        "сдвиг границы узла обязан находиться вместе с путём до него"
    );

    /*
     * RslSymbol неизменяем, поэтому портится его зеркало из простых объектов.
     * Компаратор читает только поля, так что зеркала ему достаточно.
     */
    const mirror = mirrorSymbol;
    const damaged = mirror(first.module.symbolTree);
    damaged.children[1].children[0].typeName = "Другой";
    assert.match(
        String(compareSymbols(first.module.symbolTree, damaged)),
        /typeName/,
        "подмена типа обязана находиться"
    );

    /* И сдвиг диапазона — он ломает переходы и переименование. */
    const shifted = mirror(first.module.symbolTree);
    shifted.children[1].range.start += 2;
    assert.match(
        String(compareSymbols(first.module.symbolTree, shifted)),
        /range/,
        "сдвиг диапазона символа обязан находиться"
    );

    const damagedDiagnostics = first.diagnostics.concat([{
        code: "выдуманная",
        severity: 1,
        message: "нет такой",
        range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 }
        }
    }]);
    assert.match(
        String(compareDiagnostics(first.diagnostics, damagedDiagnostics)),
        /лишние/,
        "лишняя диагностика обязана находиться"
    );

    /* Пропажу тоже. */
    assert.match(
        String(compareDiagnostics(damagedDiagnostics, first.diagnostics)),
        /пропали/,
        "пропавшая диагностика обязана находиться"
    );
});

/*
 * ─── Серия правок против расчёта с нуля ─────────────────────────────────────
 */

/** Детерминированный генератор: расхождение обязано воспроизводиться. */
function createRandom(seed) {
    let state = seed;
    return () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x7fffffff;
    };
}

function baseSource(macroCount) {
    const lines = ["Import utils, common;"];

    for (let index = 0; index < macroCount; index++) {
        lines.push(
            `Macro Macro${index}(param${index})`,
            `  Var value${index} = ${index};`,
            `  If (value${index} > 0)`,
            `    value${index} = value${index} + 1;`,
            "  End;",
            `  Return value${index};`,
            "End;",
            `Class Class${index}`,
            `  Var field${index}: String;`,
            `  Macro Method${index}()`,
            `    this.field${index} = "текст";`,
            "  End;",
            "End;"
        );
    }

    return lines.join("\n");
}

const EDITS = [
    "\n",
    " ",
    ";",
    "x",
    "Var extra = 1;",
    "  ",
    ")",
    "(",
    "+ 1",
    "\n  Var inserted = 2;",
    "// комментарий",
    "\"строка\""
];

test("серия правок даёт ту же модель, что расчёт с нуля", () => {
    const uri = "file:///incremental.mac";
    const random = createRandom(20260814);
    /* Файл больше порога точечного лексирования: иначе путь не включится. */
    let source = baseSource(700);
    assert.ok(
        source.length > 50_000,
        `нужен файл сверх порога, получено ${source.length}`
    );

    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([uri]);
    let version = 1;
    let applied = 0;
    let incremental = 0;
    let incrementalModel = 0;

    /*
     * Правки идут через ту же цепочку, что и в службе разбора: снимок этой
     * версии строится ОТ ПРЕДЫДУЩЕГО, то есть через точечный пересчёт токенов,
     * и уже его поток отдаётся парсеру. Если сравнивать модель, построенную
     * updateOpenModule (он лексирует заново), проверка была бы полного пути
     * против полного и не значила бы ничего.
     */
    let snapshot = createFastDocumentSnapshot(
        TextDocument.create(uri, "rsl", version, source)
    );
    let state = createRslModelState(
        source,
        parseRslSyntax(source, snapshot.lex, { buildExpressionTree: false })
    ).state;
    let module = index.updateOpenModuleModel(
        uri,
        createRslModelState(source, state.parse).model,
        version
    );

    for (let round = 0; round < 60; round++) {
        const insert = EDITS[Math.floor(random() * EDITS.length)];
        const at = Math.floor(random() * source.length);
        source = source.slice(0, at) + insert + source.slice(at);
        version++;

        let reason;
        snapshot = createFastDocumentSnapshot(
            TextDocument.create(uri, "rsl", version, source),
            snapshot,
            decision => {
                reason = decision.reason;
            }
        );

        if (reason === "incremental") {
            incremental++;
        }

        const update = tryUpdateRslModelState(state, source, snapshot.lex) ||
            createRslModelState(
                source,
                parseRslSyntax(
                    source,
                    snapshot.lex,
                    { buildExpressionTree: false }
                )
            );

        if (update.incremental) {
            incrementalModel++;
        }

        state = update.state;
        module = index.updateOpenModuleModel(uri, update.model, version);
        applied++;

        const scratch = buildFromScratch(uri, source);
        const syntaxDifference = compareSyntaxNodes(
            scratch.module.syntax.root,
            module.syntax.root
        );
        assert.strictEqual(
            syntaxDifference,
            undefined,
            `правка ${round} (${JSON.stringify(insert)} на ${at}): ` +
                `AST разошёлся — ${syntaxDifference}`
        );

        const symbolDifference = compareSymbols(
            scratch.module.symbolTree,
            module.symbolTree
        );
        assert.strictEqual(
            symbolDifference,
            undefined,
            `правка ${round}: symbol tree разошёлся — ${symbolDifference}`
        );

        const diagnosticDifference = compareDiagnostics(
            scratch.diagnostics,
            buildRslDiagnostics(module, index)
        );
        assert.strictEqual(
            diagnosticDifference,
            undefined,
            `правка ${round}: диагностика разошлась — ${diagnosticDifference}`
        );
    }

    console.log(
        `[METRIC] проверено правок: ${applied}, ` +
        `из них точечным lex: ${incremental}, ` +
        `точечной моделью: ${incrementalModel}`
    );
    assert.ok(
        incremental > 0,
        "проверка обязана задевать точечный путь, иначе она сравнивает " +
            "полный расчёт с полным"
    );
    assert.ok(
        incrementalModel > 0,
        "проверка обязана задевать точечную модель, а не только точечный lex"
    );
});

/*
 * ─── Сводка по журналу ──────────────────────────────────────────────────────
 *
 * Персентили, блокировка и повторная работа считаются отчётом над журналом, а
 * не в горячем пути. Отчёт — тоже код, и он тоже обязан быть проверен: иначе
 * замеры, на которые опирается следующий шаг, окажутся сочинёнными.
 */

test("отчёт по журналу считает то, что обещает", () => {
    const { summarize, percentile } = require("../build/perf-report");

    assert.strictEqual(percentile([1, 2, 3, 4], 0.5), 2.5);
    assert.strictEqual(percentile([10], 0.95), 10);
    assert.strictEqual(percentile([], 0.5), 0);

    const records = [];

    for (let version = 1; version <= 10; version++) {
        records.push({
            event: "analysis.fastSnapshot",
            durationMs: version,
            lexReason: version % 2 === 0 ? "incremental" : "editTooEarly",
            rssAfterBytes: version * 1024 * 1024
        });
        records.push({
            event: "analysis.syntax",
            durationMs: version * 3,
            blockingMs: version * 3
        });
        records.push({
            event: "analysis.full",
            durationMs: version,
            uri: "file:///m.mac",
            version,
            cancelled: false
        });
    }

    /* Одна версия разобрана дважды, одна отменена — считаться должна первая. */
    records.push({
        event: "analysis.full",
        durationMs: 5,
        uri: "file:///m.mac",
        version: 4,
        cancelled: false
    });
    records.push({
        event: "analysis.full",
        durationMs: 5,
        uri: "file:///m.mac",
        version: 5,
        cancelled: true
    });

    const summary = summarize(records);

    /*
     * В длительности попадают все 12 записей, включая отменённую: время она
     * всё равно заняла. Повторной работой ниже считается только успешная.
     */
    assert.strictEqual(summary.byEvent.get("analysis.full").length, 12);
    assert.strictEqual(summary.blocking.length, 10);
    assert.strictEqual(
        summary.blocking.reduce(
            (best, item) => Math.max(best, item.value),
            0
        ),
        30,
        "худшая блокировка обязана быть максимумом, а не суммой"
    );

    const repeated = Array.from(summary.parsesByVersion.entries())
        .filter(([, count]) => count > 1);
    assert.deepStrictEqual(
        repeated,
        [["file:///m.mac@4", 2]],
        "повторным считается только успешный разбор той же версии"
    );

    assert.strictEqual(summary.lexReasons.get("incremental"), 5);
    assert.strictEqual(summary.lexReasons.get("editTooEarly"), 5);
    assert.strictEqual(summary.peakRss, 10 * 1024 * 1024);
});

if (failed > 0) {
    console.error(`\nПройдено: ${passed}\nОшибок: ${failed}`);
    process.exitCode = 1;
} else {
    console.log(`\nПройдено: ${passed}\nОшибок: ${failed}`);
}

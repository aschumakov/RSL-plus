"use strict";

/**
 * Длительное редактирование: память выходит на плато.
 *
 * Точечная модель переиспользует между версиями и поддеревья, и объявления, и
 * символы. Такое переиспользование легко превратить в удержание: достаточно
 * одной ссылки из новой версии на прежнюю, и в памяти окажется вся история
 * правок. Здесь проверяется, что этого не происходит.
 *
 * Замер идёт после возврата из функции, делавшей правки: пока её кадр жив, V8
 * держит её локальные переменные, и обнуление их внутри ничего не доказывает.
 * Без --expose-gc проверка объёма пропускается — но сама сессия правок и
 * сверка ответа выполняются всё равно.
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
    TextDocument
} = require("../server/node_modules/vscode-languageserver-textdocument");
const {
    DocumentAnalysisService
} = require("../server/out/services/documentAnalysisService");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { createRslVirtualClock } = require("../server/out/core/clock");
const { lexRsl } = require("../server/out/lexer");
const { parseRslSyntax } = require("../server/out/syntaxParser");
const {
    createRslModelState
} = require("../server/out/services/incrementalModel");
const { isFullTestRun } = require("./test-mode");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const URI = "file:///editing-session.mac";
const NEEDLE = "  total = total + 1;";

/** Файл заведомо больше порога точечного пути. */
function sample(count) {
    const lines = ["Import common;", ""];

    for (let index = 0; index < count; index++) {
        lines.push(
            "Macro Process" + index + "(document, options)",
            "  Var result = 0;",
            "  Var total = 0;",
            "  if (options == 1)",
            "    result = document.Value;",
            "  end;",
            NEEDLE,
            "  return result;",
            "End;",
            ""
        );
    }

    return lines.join("\n");
}

function heap() {
    for (let round = 0; round < 5; round++) {
        global.gc();
    }

    return process.memoryUsage().heapUsed / (1024 * 1024);
}

/** Подпись дерева символов: по ней сверяется ответ. */
function symbolSignature(module) {
    const parts = [];

    const walk = symbol => {
        parts.push([
            symbol.id,
            symbol.name,
            symbol.kind,
            symbol.range.start,
            symbol.range.end
        ].join(":"));

        for (const child of symbol.children) {
            walk(child);
        }
    };

    walk(module.symbolTree);

    return module.imports.join(",") + "#" + parts.join("|");
}

/**
 * Сессия правок через службу разбора.
 *
 * Наружу отдаётся только подпись последней модели: ни модель, ни служба, ни
 * индекс не переживают возврата, поэтому после него в памяти не должно
 * остаться ничего.
 */
async function editingSession(text, edits) {
    let document = TextDocument.create(URI, "rsl", 1, text);
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
            changeDebounceMs: 5,
            performance: {
                enabled: false,
                mark: (name, fields) => marks.push({ name, fields })
            }
        }
    );

    analysis.setActiveDocument(URI);
    analysis.open(document);
    await clock.advance(40);

    let current = text;

    for (let round = 0; round < edits; round++) {
        const at = current.indexOf(NEEDLE, Math.floor(current.length / 2));

        current = current.slice(0, at) +
            "  total = total + " + (round + 2) + ";" +
            current.slice(at + NEEDLE.length);
        document = TextDocument.create(URI, "rsl", round + 2, current);
        analysis.changed(document);
        await clock.advance(40);
    }

    const model = index.getCurrentModule(URI, edits + 1);
    const incremental = marks.filter(item =>
        item.name === "analysis.incrementalParse" &&
        item.fields.reason === "incremental").length;

    const result = {
        text: current,
        incremental,
        signature: model ? symbolSignature(model) : undefined
    };

    analysis.close(URI);
    index.clear();

    return result;
}

test("двести правок подряд: ответ верен, память на плато", async () => {
    const base = sample(400);

    assert.ok(base.length > 50_000, "файл обязан быть больше порога");

    const edits = isFullTestRun() ? 200 : 30;

    /* Прогрев: первая сессия наполняет кэши кода и модулей. */
    await editingSession(base, 3);

    const before = global.gc ? heap() : 0;
    const session = await editingSession(base, edits);
    const after = global.gc ? heap() : 0;

    assert.strictEqual(
        session.incremental,
        edits,
        "все правки прошли точечным путём: " + session.incremental
    );

    /* Ответ последней версии обязан совпасть с полным расчётом. */
    const full = createRslModelState(
        session.text,
        parseRslSyntax(
            session.text,
            lexRsl(session.text, { includeTrivia: true }),
            { buildExpressionTree: false }
        )
    ).model;

    assert.strictEqual(
        session.signature,
        symbolSignature(full),
        "после серии правок модель совпадает с полным расчётом"
    );

    if (!global.gc) {
        console.log(
            "[METRIC] сессия из " + edits +
            " правок: объём не мерился (нужен --expose-gc)"
        );

        return;
    }

    const retained = after - before;

    console.log(
        "[METRIC] сессия из " + edits + " правок на файле " +
        Math.round(base.length / 1024) + " КБ: остаток " +
        retained.toFixed(2) + " МиБ"
    );
    assert.ok(
        retained < 8,
        "после закрытия документа память вернулась к плато: остаток " +
            retained.toFixed(2) + " МиБ"
    );
});

test("сборка модели не занимает поток одним куском", async () => {
    /*
     * Пользователь чувствует не сумму времени, а самый длинный кусок, в
     * который поток занят непрерывно. Раньше разбор и модель считались одним
     * вызовом, и на большом файле это были десятки миллисекунд подряд.
     *
     * Замер идёт настоящими часами и настоящим event loop: виртуальные часы
     * показали бы расписание, а не занятость потока.
     */
    const base = sample(2000);

    assert.ok(
        base.length > 100_000,
        "файл обязан быть больше порога фазового разбора: " + base.length
    );

    let document = TextDocument.create(URI, "rsl", 1, base);

    const documents = { get: uri => (uri === URI ? document : undefined) };
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([URI]);

    const analysis = new DocumentAnalysisService(
        documents,
        index,
        { getAvailable: () => ({ imports: { enabled: false } }) },
        {
            log: () => undefined,
            invalidateProviderCaches: () => undefined,
            onParsed: () => undefined,
            onImports: () => undefined,
            initialParseDelayMs: 0,
            changeDebounceMs: 1
        }
    );

    analysis.setActiveDocument(URI);
    analysis.open(document);
    await analysis.ensureParsed(document, "force");

    /* Правка внутри тела: точечный путь, который и надо мерить. */
    const at = base.indexOf(NEEDLE, Math.floor(base.length / 2));
    const edited = base.slice(0, at) + "  total = total + 7;" +
        base.slice(at + NEEDLE.length);

    document = TextDocument.create(URI, "rsl", 2, edited);

    const gaps = [];
    let previous = process.hrtime.bigint();
    const interval = setInterval(() => {
        const now = process.hrtime.bigint();

        gaps.push(Number(now - previous) / 1e6);
        previous = now;
    }, 1);

    analysis.changed(document);
    await analysis.ensureParsed(document, "force");
    clearInterval(interval);
    analysis.close(URI);

    const longest = Math.max(...gaps);

    console.log(
        "[METRIC] правка файла " + Math.round(base.length / 1024) +
        " КБ: самая долгая непрерывная занятость потока " +
        longest.toFixed(0) + " мс, возвратов управления " + gaps.length
    );
    /*
     * Число возвратов зависит от машины: важно, что их больше одного, — то
     * есть работа не идёт одним неделимым куском. Ограничение на длительность
     * ниже и есть настоящая проверка.
     */
    assert.ok(
        gaps.length >= 2,
        "поток возвращался управлению: " + gaps.length
    );
    /*
     * Порог с запасом к порции (8 мс): в один кусок всё равно попадают
     * неделимые фазы — точечный lex и разбор изменённой единицы. Он отделяет
     * порционную сборку от прежней, когда весь путь шёл одним вызовом.
     */
    assert.ok(
        longest < 120,
        "непрерывная занятость потока: " + longest.toFixed(0) + " мс"
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

    console.log(
        failed === 0
            ? `\nПройдено: ${passed}`
            : `\nПройдено: ${passed}, провалено: ${failed}`
    );

    if (failed > 0) {
        process.exitCode = 1;
    }
})();

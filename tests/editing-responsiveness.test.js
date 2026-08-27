"use strict";

/**
 * Отзывчивость при правке: поток не занят одним куском.
 *
 * Пользователь чувствует не сумму времени, а самый длинный отрезок, в который
 * поток занят непрерывно: пока он занят, редактор не отвечает ни на одну
 * просьбу. Раньше разбор и сборка модели шли одним вызовом, и на большом файле
 * это были десятки миллисекунд подряд.
 *
 * Отдельным файлом, а не рядом с проверкой памяти. Замер памяти сам по себе
 * шумит: он гоняет сборщик мусора и держит сотни версий документа, и делать
 * замер занятости потока в том же процессе — значит мерить последствия чужой
 * проверки. Разные процессы стоят пары секунд и снимают целый класс случайных
 * падений.
 *
 * Попыток три, и каждая на свежем стенде. Одна попытка ничего не доказывает:
 * остановка процесса операционной системой выглядит ровно как возврат к
 * монолитной сборке. Зато настоящий возврат к ней провалит все три сразу —
 * порог поэтому и не поднимается.
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

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const URI = "file:///editing-responsiveness.mac";
const NEEDLE = "  total = total + 1;";
/*
 * Порог занятости.
 *
 * Отделяет порционную работу от прежней, когда весь путь — разбор, перенос
 * хвоста дерева и сборка модели — шёл одним вызовом. В один кусок всё равно
 * попадают неделимые фазы: точечный lex порциями пока не режется.
 */
const BUDGET_MS = 80;
const ATTEMPTS = 3;

/** Файл заведомо больше порога фазового разбора. */
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

/**
 * Одна попытка: свежий индекс, свежая служба, одна правка внутри тела.
 *
 * Возвращает самый длинный отрезок занятости и число возвратов управления.
 */
async function attempt(base) {
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

    try {
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
        /*
         * Между порциями поток свободен, и таймер успевает сработать.
         * Непрерывная занятость — это и есть промежутки между срабатываниями.
         */
        const interval = setInterval(() => {
            const now = process.hrtime.bigint();

            gaps.push(Number(now - previous) / 1e6);
            previous = now;
        }, 1);

        analysis.changed(document);

        await analysis.ensureParsed(document, "force");
        clearInterval(interval);

        return { longest: Math.max(...gaps), returns: gaps.length };
    } finally {
        analysis.close(URI);
    }
}

test("сборка модели не занимает поток одним куском", async () => {
    const base = sample(2000);

    assert.ok(
        base.length > 100_000,
        "файл обязан быть больше порога фазового разбора: " + base.length
    );

    const results = [];

    for (let round = 0; round < ATTEMPTS; round++) {
        results.push(await attempt(base));
    }

    const longest = results.map(item => item.longest);
    const worst = Math.max(...longest);
    const median = [...longest].sort((left, right) => left - right)[
        Math.floor(ATTEMPTS / 2)
    ];

    console.log(
        "[METRIC] правка файла " + Math.round(base.length / 1024) +
        " КБ: занятость потока по попыткам " +
        longest.map(value => value.toFixed(0)).join(", ") +
        " мс (медиана " + median.toFixed(0) + ", худшая " + worst.toFixed(0) +
        "), возвратов управления " +
        results.map(item => item.returns).join(", ")
    );

    /*
     * Возвраты управления обязательны в каждой попытке: работа не имеет права
     * идти одним неделимым куском ни разу.
     */
    for (const [round, item] of results.entries()) {
        assert.ok(
            item.returns >= 2,
            "попытка " + (round + 1) + ": поток обязан возвращать управление, " +
                "а вернул " + item.returns + " раз"
        );
    }

    /*
     * Бюджет проверяется по медиане, то есть «не меньше двух попыток из трёх
     * уложились». Единичная остановка процесса выпуск не ломает, а возврат к
     * монолитной сборке проваливает все три — и медиану вместе с ними.
     */
    assert.ok(
        median < BUDGET_MS,
        "непрерывная занятость потока по медиане: " + median.toFixed(0) +
            " мс при бюджете " + BUDGET_MS + " мс; по попыткам " +
            longest.map(value => value.toFixed(0)).join(", ")
    );
});

(async () => {
    for (const item of tests) {
        try {
            await item.action();
            passed++;
            console.log("[OK] " + item.name);
        } catch (error) {
            failed++;
            console.error("[FAIL] " + item.name);
            console.error(error);
        }
    }

    console.log(
        failed === 0
            ? "\nПройдено: " + passed
            : "\nПройдено: " + passed + ", провалено: " + failed
    );

    if (failed > 0) {
        process.exitCode = 1;
    }
})();

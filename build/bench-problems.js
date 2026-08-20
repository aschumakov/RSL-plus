"use strict";

/*
 * Сколько проходит от правки до исчезновения ошибки из Problems.
 *
 * Замер сквозной: правка документа → готовность модели → публикация локальных
 * диагностик → публикация межфайловых. Именно эту величину видит пользователь,
 * а не время отдельных фаз: пока публикации нет, подчёркивание остаётся на
 * экране, даже если расчёт давно закончился.
 *
 * Запуск:
 *   node build/bench-problems.js [размер-наполнения]
 */

const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "server", "out");

const { WorkspaceIndex } = require(path.join(OUT, "workspaceIndex"));
const { RslScopeResolver } = require(path.join(OUT, "scopeResolver"));
const { getDefaults } = require(path.join(OUT, "defaults"));
const {
    RslDiagnosticEngine
} = require(path.join(OUT, "diagnostics", "diagnosticEngine"));
const {
    DiagnosticsCoordinator
} = require(path.join(OUT, "diagnostics", "diagnosticsCoordinator"));
const {
    DocumentAnalysisService
} = require(path.join(OUT, "services", "documentAnalysisService"));
const {
    RslSettingsService
} = require(path.join(OUT, "services", "settingsService"));
const {
    TextDocument
} = require(path.join(ROOT, "server", "node_modules",
    "vscode-languageserver-textdocument"));

const MAIN = "file:///d:/problems/main.mac";
const LIB = "file:///d:/problems/lib.mac";
const LIB_SOURCE = "Macro Helper(value)\n  return value;\nEnd;\n";

const SETTINGS = {
    language: { dialect: "rsBank" },
    imports: { enabled: true },
    autoImport: { enabled: true },
    analysis: { workspaceIndexing: "activeImports" },
    semanticHighlighting: { maxFileSizeKb: 512 },
    inlayHints: { variableTypes: true },
    diagnostics: {}
};

/**
 * Случаи исправления: текст с ошибкой, исправленный текст и код ошибки.
 *
 * Последний случай — межфайловый: имя из подключённого модуля, которое
 * перестаёт быть неизвестным после правки Import.
 */
const CASES = [
    {
        name: "двойная точка",
        broken: "  result = obj..field;",
        fixed: "  result = obj.field;",
        code: "missing-member-name",
        phase: "local"
    },
    {
        name: "пропущенная ;",
        broken: "  result = 1\n  result = 2;",
        fixed: "  result = 1;\n  result = 2;",
        code: "missing-semicolon",
        phase: "local"
    },
    {
        name: "присваивание константе",
        broken: "  Const LIMIT = 10;\n  LIMIT = 11;",
        fixed: "  Const LIMIT = 10;\n  result = 11;",
        code: "assignment-to-constant",
        phase: "local"
    },
    {
        name: "использование до объявления",
        broken: "  result = later;\n  Var later = 1;",
        fixed: "  Var later = 1;\n  result = later;",
        code: "use-before-declaration",
        phase: "local"
    },
    {
        name: "неиспользуемый Import",
        broken: "",
        fixed: "  result = Helper(1);",
        code: "unused-import",
        phase: "workspace",
        /* Обращение к модулю появляется только правкой: иначе Import занят. */
        withoutHelper: true
    }
];

function documentSource(body, padding, withoutHelper) {
    const lines = [
        "Import lib;",
        "Macro Test()",
        "  Var result;",
        withoutHelper ? "  Var obj;" : "  Var obj = Helper(1);",
        body
    ];

    for (let index = 0; index < padding; index++) {
        /* Наполнение без объявлений: иначе лимит Problems съедает случай. */
        lines.push(`  result = ${index} + 1;`);
    }

    lines.push("End;", "");

    return lines.join("\n");
}

/**
 * Стенд из настоящих служб сервера: анализ, движок, координатор.
 *
 * Сроки — производственные, без ускорений: склейка правок 90 мс и все
 * прочие задержки такие же, как у сервера. Иначе замер говорил бы о стенде,
 * а не о том, что видит пользователь.
 */
function createStand() {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([MAIN, LIB]);
    index.updateExternalModule(LIB, LIB_SOURCE, 1);

    let document = TextDocument.create(MAIN, "rsl", 1, "");
    const documents = {
        get: uri => uri === MAIN ? document : undefined,
        all: () => [document],
        onDidOpen: () => ({ dispose: () => undefined }),
        onDidClose: () => ({ dispose: () => undefined }),
        onDidChangeContent: () => ({ dispose: () => undefined })
    };
    const settings = new RslSettingsService(SETTINGS);
    const resolver = new RslScopeResolver(index, getDefaults());
    const engine = new RslDiagnosticEngine();
    const publications = [];
    const connection = {
        sendDiagnostics: value => {
            publications.push({ ...value, at: process.hrtime.bigint() });
        }
    };

    let coordinator;
    /* Отметки времени: правка, готовность модели, публикации после неё. */
    let changedAt;
    let parsedAt;
    const analysis = new DocumentAnalysisService(
        documents,
        index,
        settings,
        {
            log: () => undefined,
            invalidateProviderCaches: () => undefined,
            onParsed: module => {
                if (changedAt !== undefined && parsedAt === undefined) {
                    parsedAt = process.hrtime.bigint();
                }
                coordinator.scheduleLocal(module.uri, 0);
                coordinator.scheduleWorkspace(module.uri);
            },
            onImports: () => undefined
        }
    );

    coordinator = new DiagnosticsCoordinator(
        connection,
        documents,
        index,
        settings,
        engine,
        {
            isParseBusy: uri => analysis.isBusyFor(uri),
            waitForIdle: uri => analysis.whenIdle(uri),
            log: () => undefined,
            onImports: () => undefined,
            resolver
        }
    );
    coordinator.setActiveDocument(MAIN);

    return {
        index,
        analysis,
        coordinator,
        publications,
        get document() {
            return document;
        },
        /** Что и когда произошло после правки, в миллисекундах от неё. */
        phases() {
            const since = value => value === undefined
                ? undefined
                : Number(value - changedAt) / 1e6;
            const after = publications.filter(item =>
                changedAt !== undefined && item.at > changedAt
            );

            return {
                parsed: since(parsedAt),
                firstPublication: since(after[0]?.at),
                lastPublication: since(after[after.length - 1]?.at),
                publications: after.length
            };
        },
        /** Правка документа: ровно то, что приходит от редактора. */
        change(source) {
            changedAt = process.hrtime.bigint();
            parsedAt = undefined;
            document = TextDocument.create(
                MAIN,
                "rsl",
                document.version + 1,
                source
            );
            analysis.changed(document);
            coordinator.cancel(MAIN);
        },
        open(source) {
            document = TextDocument.create(MAIN, "rsl", 1, source);
            analysis.setActiveDocument(MAIN);
            analysis.open(document);
        }
    };
}

function hasCode(diagnostics, code) {
    return (diagnostics || []).some(item => item.code === code);
}

/** Ждёт публикацию, в которой ошибки уже нет. */
async function waitForClean(stand, code, budgetMs) {
    const started = process.hrtime.bigint();
    const deadline = Date.now() + budgetMs;

    for (;;) {
        const last = stand.publications[stand.publications.length - 1];

        if (last && !hasCode(last.diagnostics, code)) {
            return Number(process.hrtime.bigint() - started) / 1e6;
        }

        if (Date.now() > deadline) {
            return Number.POSITIVE_INFINITY;
        }

        await new Promise(resolve => setTimeout(resolve, 2));
    }
}

/** Ждёт публикацию, в которой ошибка есть. */
async function waitForCode(stand, code, budgetMs) {
    const deadline = Date.now() + budgetMs;

    for (;;) {
        if (stand.publications.some(item => hasCode(item.diagnostics, code))) {
            return true;
        }

        if (Date.now() > deadline) {
            return false;
        }

        await new Promise(resolve => setTimeout(resolve, 2));
    }
}

function percentile(values, share) {
    const usable = values.filter(value => Number.isFinite(value));

    if (usable.length === 0) {
        return Number.POSITIVE_INFINITY;
    }

    const sorted = [...usable].sort((first, second) => first - second);

    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
}

function show(name, values, appeared, target) {
    const p50 = percentile(values, 0.5);
    const p95 = percentile(values, 0.95);
    const verdict = Number.isFinite(p95) && p95 <= target
        ? "  (цель ≤ " + target + " мс — да)"
        : "  (цель ≤ " + target + " мс — НЕТ)";

    console.log("  " + name.padEnd(28) +
        (appeared ? "" : "ошибка не появилась, ") +
        "p50 " + p50.toFixed(0) + ", p95 " + p95.toFixed(0) +
        ", максимум " + percentile(values, 1).toFixed(0) + " мс" + verdict);
}

const RUNS = 5;

async function measureCase(item, padding, label) {
    const times = [];
    const phases = [];
    let appeared = false;
    let flicker = false;

    for (let run = 0; run < RUNS; run++) {
        const stand = createStand();
        stand.open(documentSource(item.broken, padding, item.withoutHelper));
        appeared = await waitForCode(stand, item.code, 4000) || appeared;

        const before = stand.publications.length;
        stand.change(documentSource(item.fixed, padding, item.withoutHelper));
        const took = await waitForClean(stand, item.code, 4000);
        times.push(took);
        phases.push(stand.phases());

        /*
         * Мерцание: после исправления в какой-то публикации ошибка снова
         * появилась. Именно это пользователь читает как «то есть, то нет».
         */
        let cleaned = false;

        for (const publication of stand.publications.slice(before)) {
            const present = hasCode(publication.diagnostics, item.code);

            if (!present) {
                cleaned = true;
            } else if (cleaned) {
                flicker = true;
            }
        }

        await new Promise(resolve => setTimeout(resolve, 30));
    }

    show(
        item.name + " (" + label + ")",
        times,
        appeared,
        item.phase === "local" ? 150 : 300
    );

    const median = key => {
        const values = phases
            .map(value => value[key])
            .filter(value => typeof value === "number")
            .sort((first, second) => first - second);

        return values.length === 0
            ? "—"
            : values[Math.floor(values.length / 2)].toFixed(0);
    };

    console.log("    фазы: модель " + median("parsed") +
        " мс, первая публикация " + median("firstPublication") +
        " мс, последняя " + median("lastPublication") +
        " мс, публикаций " + median("publications"));

    if (flicker) {
        console.log("    ВНИМАНИЕ: ошибка исчезала и появлялась снова");
    }
}

(async () => {
    const padding = Number(process.argv[2] || 0);

    console.log("обычный файл:");

    for (const item of CASES) {
        await measureCase(item, 0, "обычный");
    }

    console.log("большой файл (" +
        Math.round(documentSource("", padding || 8000).length / 1024) + " КБ):");

    for (const item of CASES) {
        await measureCase(item, padding || 8000, "большой");
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

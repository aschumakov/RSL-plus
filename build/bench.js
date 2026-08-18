"use strict";

/*
 * Воспроизводимый замер отзывчивости и памяти.
 *
 * Отвечает на три вопроса, на которые не отвечает набор тестов:
 *
 * 1. Сколько поток занят НЕПРЕРЫВНО. Именно это пользователь видит как
 *    подвисание: между порциями управление возвращается редактору, внутри
 *    порции — нет, поэтому суммарное время фазы здесь бесполезно.
 * 2. Сколько ждёт запрос, пришедший во время фонового расчёта.
 * 3. Сколько памяти остаётся занятой после расчёта — с учётом кэшей, которые
 *    живут вместе с потоком токенов версии.
 *
 * Запуск:
 *   node --expose-gc build/bench.js [каталог-или-файл ...]
 *
 * Без аргументов берётся сгенерированный образец, поэтому замер работает и там,
 * где репозитория макросов нет. С --expose-gc дополнительно печатается память,
 * удержанная после сборки мусора; без него — только прирост.
 */

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "server", "out");

const { WorkspaceIndex } = require(path.join(OUT, "workspaceIndex"));
const { RslScopeResolver } = require(path.join(OUT, "scopeResolver"));
const {
    buildLocalRslDiagnosticsChunked
} = require(path.join(OUT, "diagnostics"));
const {
    buildRslSemanticTokensChunked
} = require(path.join(OUT, "semanticTokens"));
const {
    decodeRslSourceText
} = require(path.join(OUT, "core", "textDecoding"));

/** Бюджет одной порции: тот же, что у сервера. */
const BUDGET_MS = 8;
const RUNS = 5;

function percentile(values, fraction) {
    if (values.length === 0) {
        return 0;
    }

    const sorted = values.slice().sort((left, right) => left - right);
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);

    return lower === upper
        ? sorted[lower]
        : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

const median = values => percentile(values, 0.5);

/**
 * Порция с настоящим бюджетом времени, попутно засекающая свою длительность.
 *
 * Подделывать здесь нельзя: порционность в сервере опирается именно на
 * shouldYield, и стенд с заглушкой мерил бы не то, что работает.
 */
function measuringSlice(record) {
    let startedAt = process.hrtime.bigint();

    return {
        shouldYield() {
            return Number(process.hrtime.bigint() - startedAt) / 1e6 >=
                BUDGET_MS;
        },
        async yieldNow() {
            record.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
            await new Promise(resolve => setImmediate(resolve));
            startedAt = process.hrtime.bigint();
        },
        async yieldIfNeeded() {
            if (this.shouldYield()) {
                await this.yieldNow();
            }
        },
        get yieldCount() {
            return record.length;
        }
    };
}

function collectFiles(targets) {
    const result = [];
    const visit = entry => {
        let stat;

        try {
            stat = fs.statSync(entry);
        } catch (error) {
            return;
        }

        if (stat.isDirectory()) {
            if (path.basename(entry) === ".git") {
                return;
            }
            fs.readdirSync(entry).forEach(name =>
                visit(path.join(entry, name))
            );
            return;
        }

        if (/\.(?:mac|rsm)$/iu.test(entry) && stat.size > 2 * 1024) {
            result.push({ path: entry, size: stat.size });
        }
    };

    targets.forEach(visit);
    /* Крупные файлы информативнее: на них видны все узкие места. */
    return result.sort((left, right) => right.size - left.size).slice(0, 3);
}

/** Образец на случай, когда реальных файлов под рукой нет. */
function syntheticSource() {
    const blocks = [];

    for (let index = 0; index < 3000; index++) {
        blocks.push([
            `Macro Handler${index}(obj, cmd, id, key)`,
            `  Var value${index}: Integer;`,
            `  value${index} = ${index};`,
            `  If (value${index} > 0) Then`,
            `    Println(value${index}:5.2);`,
            "  End;",
            "End;"
        ].join("\n"));
    }

    return blocks.join("\n");
}

async function measureFile(name, source) {
    const uri = pathToFileURL(
        path.join(ROOT, "bench-sample.mac")
    ).toString();
    const worstChunks = [];
    const worstStages = new Map();
    const responses = [];
    const totals = [];
    let heapDelta = 0;

    for (let run = 0; run < RUNS; run++) {
        const heapBefore = process.memoryUsage().heapUsed;
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([uri]);
        const module = index.updateOpenModule(uri, source, run + 1);
        const resolver = new RslScopeResolver(index);
        const chunks = [];
        const startedAt = process.hrtime.bigint();

        await buildLocalRslDiagnosticsChunked(
            module,
            index,
            undefined,
            () => false,
            measuringSlice(chunks),
            (stage, ms) => worstStages.set(
                stage,
                Math.max(worstStages.get(stage) || 0, ms)
            )
        );
        await buildRslSemanticTokensChunked(
            module,
            index,
            resolver,
            undefined,
            () => false,
            measuringSlice(chunks)
        );

        totals.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
        worstChunks.push(Math.max(...chunks, 0));
        heapDelta = Math.max(
            heapDelta,
            process.memoryUsage().heapUsed - heapBefore
        );

        /*
         * Запросы пользователя во время фонового расчёта. Считается именно
         * ожидание: запрос встаёт в очередь за очередной порцией.
         */
        const targets = module.lex.tokens
            .filter(token => token.kind === "identifier")
            .filter((_token, position) => position % 97 === 0)
            .slice(0, 40);
        let done = false;
        const background = (async () => {
            for (let round = 0; round < 2; round++) {
                await buildLocalRslDiagnosticsChunked(
                    module,
                    index,
                    undefined,
                    () => false
                );
            }
            done = true;
        })();

        for (const target of targets) {
            if (done) {
                break;
            }

            const requested = process.hrtime.bigint();
            await new Promise(resolve => setImmediate(resolve));
            resolver.resolveAt(uri, module.symbolTree, target.start);
            responses.push(
                Number(process.hrtime.bigint() - requested) / 1e6
            );
        }

        await background;
    }

    const retained = typeof global.gc === "function"
        ? (global.gc(), process.memoryUsage().heapUsed)
        : undefined;
    const top = Array.from(worstStages.entries())
        .sort((left, right) => right[1] - left[1])
        .slice(0, 3)
        .map(([stage, ms]) => `${stage} ${ms}`)
        .join(", ");

    console.log(
        `${name}  ${Math.round(source.length / 1024)} КБ\n` +
        `  полный расчёт           медиана ${median(totals).toFixed(1)} мс\n` +
        `  худшая непрерывная      медиана ${
            median(worstChunks).toFixed(1)} мс, максимум ${
            Math.max(...worstChunks).toFixed(1)} мс\n` +
        `  ответ под нагрузкой     p50 ${
            median(responses).toFixed(1)} мс, p95 ${
            percentile(responses, 0.95).toFixed(1)} мс, максимум ${
            percentile(responses, 1).toFixed(1)} мс\n` +
        `  память                  прирост ${
            (heapDelta / 1048576).toFixed(1)} МиБ${
            retained === undefined
                ? " (для удержанной нужен --expose-gc)"
                : `, удержано после GC ${(retained / 1048576).toFixed(1)} МиБ`
        }\n` +
        `  самые долгие этапы      ${top}`
    );
}

(async () => {
    const targets = process.argv.slice(2);
    const files = targets.length > 0 ? collectFiles(targets) : [];

    if (files.length === 0) {
        if (targets.length > 0) {
            console.log("Подходящих файлов не найдено; беру образец.");
        }
        await measureFile("образец", syntheticSource());
        return;
    }

    for (const file of files) {
        await measureFile(
            path.basename(file.path),
            decodeRslSourceText(fs.readFileSync(file.path))
        );
    }
})();

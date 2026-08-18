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
const {
    createFastDocumentSnapshot
} = require(path.join(OUT, "services", "fastDocumentSnapshot"));
const {
    dropFastCompletionIndex,
    getFastCompletionIndex
} = require(path.join(OUT, "features", "fastCompletionIndex"));
const {
    buildRslFastCompletions,
    buildRslFastMemberCompletions
} = require(path.join(OUT, "features", "fastCompletionProvider"));
const {
    CompletionTransport
} = require(path.join(OUT, "features", "completionTransport"));

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

/**
 * Образец на случай, когда реальных файлов под рукой нет.
 *
 * Синтаксис обязан быть корректным. В первом варианте условие писалось
 * как If (...) Then, а слова Then в RSL нет: образец давал три тысячи
 * ошибок missing-semicolon, и замер показывал в основном обработку
 * выдуманных ошибок.
 */
function syntheticSource() {
    const blocks = [];

    for (let index = 0; index < 3000; index++) {
        blocks.push([
            `Macro Handler${index}(obj, cmd, id, key)`,
            `  Var value${index}: Integer;`,
            `  value${index} = ${index};`,
            `  If (value${index} > 0)`,
            `    Println(value${index});`,
            "  End;",
            "End;"
        ].join("\n"));
    }

    return blocks.join("\n");
}

/** Память считается разницей после сборки мусора с обеих сторон. */
function settledHeap() {
    if (typeof global.gc === "function") {
        global.gc();
    }

    return process.memoryUsage().heapUsed;
}

/** Документ поверх строки: позиции нужны только Completion. */
function createDocument(uri, source) {
    const lineStarts = [0];

    for (let index = 0; index < source.length; index++) {
        if (source.charCodeAt(index) === 10) {
            lineStarts.push(index + 1);
        }
    }

    return {
        uri,
        languageId: "rsl",
        version: 1,
        getText: () => source,
        positionAt(offset) {
            let line = 0;

            while (
                line + 1 < lineStarts.length &&
                lineStarts[line + 1] <= offset
            ) {
                line++;
            }

            return { line, character: offset - lineStarts[line] };
        },
        offsetAt(position) {
            return lineStarts[position.line] + position.character;
        }
    };
}

/**
 * Полный быстрый путь Completion: индекс версии, список и подготовка ответа.
 *
 * Именно он работает, пока модель не готова, то есть на каждое нажатие
 * клавиши. Замерять вместо него разрешение имени значило бы мерить не то,
 * чего ждёт пользователь.
 */
function completionOnce(snapshot, offset, transport) {
    const index = getFastCompletionIndex(snapshot);
    const members = buildRslFastMemberCompletions(
        snapshot,
        offset,
        () => undefined,
        index
    );
    const items = members || buildRslFastCompletions(snapshot, offset, index);
    return transport.prepare(items).items.length;
}

async function measureFile(name, source) {
    const uri = pathToFileURL(
        path.join(ROOT, "bench-sample.mac")
    ).toString();
    const document = createDocument(uri, source);
    /*
     * Снимок строится один раз: в сервере он переживает правку и
     * перелексируется точечно, поэтому включать сюда полный lex значило бы
     * приписать Completion чужую работу.
     */
    const snapshot = createFastDocumentSnapshot(document);
    const transport = new CompletionTransport();
    const chunkTimes = [];
    const worstStages = new Map();
    const responses = [];
    const totals = [];
    const heapBefore = settledHeap();

    for (let run = 0; run < RUNS; run++) {
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
        chunkTimes.push(...chunks);

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
            /* Каждая правка даёт новую версию: индекс строится заново. */
            dropFastCompletionIndex(uri);
            completionOnce(snapshot, target.end, transport);
            responses.push(
                Number(process.hrtime.bigint() - requested) / 1e6
            );
        }

        await background;
    }

    const heapAfter = settledHeap();
    const top = Array.from(worstStages.entries())
        .sort((left, right) => right[1] - left[1])
        .slice(0, 3)
        .map(([stage, ms]) => `${stage} ${ms}`)
        .join(", ");

    console.log(name + "  " + Math.round(source.length / 1024) + " КБ");
    console.log(
        "  полный расчёт            медиана " +
        median(totals).toFixed(1) + " мс"
    );
    console.log(
        "  непрерывная занятость    p50 " +
        median(chunkTimes).toFixed(1) + ", p95 " +
        percentile(chunkTimes, 0.95).toFixed(1) + ", максимум " +
        percentile(chunkTimes, 1).toFixed(1) + " мс"
    );
    console.log(
        "  Completion под нагрузкой p50 " +
        median(responses).toFixed(1) + ", p95 " +
        percentile(responses, 0.95).toFixed(1) + ", максимум " +
        percentile(responses, 1).toFixed(1) + " мс"
    );
    console.log(
        "  память после расчёта     " +
        ((heapAfter - heapBefore) / 1048576).toFixed(1) + " МиБ" +
        (typeof global.gc === "function"
            ? " (обе стороны после сборки мусора)"
            : " (для точного числа нужен --expose-gc)")
    );
    console.log("  самые долгие этапы       " + top);
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

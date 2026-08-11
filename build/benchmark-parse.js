"use strict";

/*
 * Воспроизводимый замер основного пути разбора.
 *
 *   npm run bench                — таблицы в консоль
 *   npm run bench -- --json      — machine-readable JSON на stdout
 *   npm run bench -- --scenario=parse|queue|external   — один сценарий
 *
 * Существует, чтобы решения о разборе опирались на числа, а не на память о
 * прошлых замерах. Меряет то, что ощущает пользователь:
 *
 *   parse    — стоимость одного полного разбора по размерам и формам файла;
 *   queue    — максимальную блокировку event loop очередью валидаций: именно
 *              столько ждут таймеры, LSP IPC и все интерактивные ответы;
 *   external — цену индексации внешнего файла на месте против выноса в worker
 *              с компактным ответом (declarations + imports, без AST).
 *
 * Каждый сценарий выполняется в ОТДЕЛЬНОМ процессе: разборы больших файлов
 * оставляют после себя десятки мегабайт мусора, и GC от предыдущего сценария
 * иначе попадает в замер следующего (наблюдался разброс до 2 раз на одном и
 * том же сценарии). Отдельный процесс также даёт каждому сценарию свежий JIT.
 *
 * Замер намеренно не входит в npm test: десятки секунд и машинозависимые числа.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { fork } = require("child_process");
const { performance } = require("perf_hooks");
const { Worker } = require("worker_threads");

const OUT = path.join(__dirname, "..", "server", "out");
const SIZES_KB = [150, 300, 550, 1100];
const QUEUE_SIZES_KB = [150, 300, 550, 1100];
const QUEUE_FILE_COUNTS = [1, 2];
const EXTERNAL_SIZES_KB = [150, 300, 550];

/* Формы исходника: разная плотность токенов на байт при том же размере. */
const SHAPES = {
    "плотный код": approxChars => {
        const line = 'Var x1 = Something.Method(a, "text", 42) + b;\n';
        return line.repeat(Math.ceil(approxChars / line.length));
    },
    "макросы и блоки": approxChars => {
        const chunks = [];
        let size = 0;
        let index = 0;
        while (size < approxChars) {
            const chunk = [
                `// обработчик ${index}`,
                `Macro Handler${index}(obj, cmd, id, key)`,
                `  Var value${index} = ${index}, total${index} = 0;`,
                `  if (value${index} >= 0 and cmd == "run")`,
                `    for (Var i = 0; i < 10; i++)`,
                `      total${index} = total${index} + obj.Field(i, "name");`,
                "    End;",
                "  else",
                `    Println("skip " + string(value${index}));`,
                "  End;",
                `  return total${index};`,
                "End;",
                ""
            ].join("\n");
            chunks.push(chunk);
            size += chunk.length;
            index++;
        }
        return chunks.join("\n");
    },
    "длинные строки": approxChars => {
        const filler = "y".repeat(300);
        const line = `Var s = "${filler}";\n`;
        return line.repeat(Math.ceil(approxChars / line.length));
    },
    "одно выражение": approxChars => {
        const parts = ["Var total = a"];
        let size = parts[0].length;
        while (size < approxChars) {
            parts.push("+a");
            size += 2;
        }
        parts.push(";");
        return parts.join("");
    }
};

function median(values) {
    const sorted = values.slice().sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
}

function createDocument(uri, source) {
    const lineStarts = [0];
    for (let index = 0; index < source.length; index++) {
        if (source[index] === "\n") {
            lineStarts.push(index + 1);
        }
    }
    return {
        uri,
        languageId: "rsl",
        version: 1,
        lineCount: lineStarts.length,
        getText: () => source,
        positionAt(offset) {
            const bounded = Math.max(0, Math.min(offset, source.length));
            let line = 0;
            while (
                line + 1 < lineStarts.length &&
                lineStarts[line + 1] <= bounded
            ) {
                line++;
            }
            return { line, character: bounded - lineStarts[line] };
        },
        offsetAt(position) {
            const line = Math.max(
                0,
                Math.min(position.line, lineStarts.length - 1)
            );
            return Math.min(
                source.length,
                lineStarts[line] + Math.max(0, position.character)
            );
        }
    };
}

/** Максимальный и p95 разрыв между срабатываниями таймера в 1 мс. */
class EventLoopLag {
    constructor() {
        this.gaps = [];
        this.last = performance.now();
        this.timer = setInterval(() => {
            const now = performance.now();
            this.gaps.push(now - this.last);
            this.last = now;
        }, 1);
    }
    reset() {
        this.gaps = [];
        this.last = performance.now();
    }
    stop() {
        clearInterval(this.timer);
    }
    report() {
        const sorted = this.gaps.slice().sort((left, right) => left - right);
        return {
            maxMs: sorted[sorted.length - 1] || 0,
            p95Ms: sorted[Math.floor(sorted.length * 0.95)] || 0
        };
    }
}

/* --- сценарий parse: стоимость одного разбора ------------------------- */

function runParseScenario() {
    const { lexRsl } = require(OUT + "/lexer");
    const { parseRslSyntax } = require(OUT + "/syntaxParser");
    const { createOpenModuleModel } = require(OUT + "/moduleModel");
    const rows = [];

    for (const [shape, build] of Object.entries(SHAPES)) {
        for (const kb of SIZES_KB) {
            const source = build(kb * 1024);
            const lex = lexRsl(source);
            createOpenModuleModel(
                source,
                parseRslSyntax(source, lex, { buildExpressionTree: false })
            );

            const lexTimes = [];
            const parseTimes = [];
            const modelTimes = [];
            for (let run = 0; run < 5; run++) {
                let started = performance.now();
                lexRsl(source);
                lexTimes.push(performance.now() - started);

                started = performance.now();
                const syntax = parseRslSyntax(source, lex, {
                    buildExpressionTree: false
                });
                parseTimes.push(performance.now() - started);

                started = performance.now();
                createOpenModuleModel(source, syntax);
                modelTimes.push(performance.now() - started);
            }

            rows.push({
                shape,
                sizeKb: kb,
                tokens: lex.tokens.length,
                lexMs: +median(lexTimes).toFixed(1),
                parseMs: +median(parseTimes).toFixed(1),
                modelMs: +median(modelTimes).toFixed(1)
            });
        }
    }

    return rows;
}

/* --- сценарий queue: блокировка event loop очередью ------------------- */

/*
 * Один вариант (размер × число файлов) за запуск процесса.
 *
 * Разбор больших файлов оставляет десятки мегабайт мусора, и сборка после
 * предыдущего варианта попадала в замер следующего: на одном и том же
 * варианте наблюдался разброс до двух раз. Родительский процесс запускает
 * каждый вариант несколько раз в свежем процессе и агрегирует прогоны.
 */
const QUEUE_REPEATS = 3;

async function runQueueVariant(kb, files) {
    const { WorkspaceIndex } = require(OUT + "/workspaceIndex");
    const {
        DocumentAnalysisService
    } = require(OUT + "/services/documentAnalysisService");
    const build = SHAPES["макросы и блоки"];
    const lag = new EventLoopLag();
    const rows = [];

    {
        {
            const source = build(kb * 1024);
            const documentsByUri = new Map();
            for (let index = 0; index < files; index++) {
                const uri = `file:///bench-${kb}-${files}-${index}.mac`;
                documentsByUri.set(uri, createDocument(uri, source));
            }

            const service = new DocumentAnalysisService(
                { get: uri => documentsByUri.get(uri) },
                new WorkspaceIndex(),
                {
                    getAvailable: () => ({
                        imports: { enabled: false },
                        autoImport: { enabled: false },
                        analysis: { workspaceIndexing: "activeImports" },
                        semanticHighlighting: { maxFileSizeKb: 512 },
                        diagnostics: {}
                    })
                },
                {
                    log: () => undefined,
                    invalidateProviderCaches: () => undefined,
                    onParsed: () => undefined,
                    onImports: () => undefined,
                    initialParseDelayMs: 0,
                    inactiveParseDelayMs: 0
                }
            );

            /*
             * Прогрев в СВОЁМ процессе: изоляция вариантов убрала не только
             * чужой мусор, но и чужой прогретый JIT. Одного разбора для
             * прогрева не хватает — на 550КБ замер без него завышал паузу
             * почти втрое (84 мс против 32 мс). Language server в реальной
             * сессии давно прогрет, поэтому мерить холодный код значило бы
             * мерить не то, что видит пользователь. Прогрев идёт файлами
             * меньшего размера: те же участки кода, но три больших AST не
             * остаются в индексе и не поднимают давление на GC во время
             * самого замера.
             */
            const warmSource = build(150 * 1024);
            const warmUris = [0, 1, 2].map(index => {
                const uri = `file:///bench-warm-${kb}-${files}-${index}.mac`;
                documentsByUri.set(uri, createDocument(uri, warmSource));
                return uri;
            });
            for (const uri of warmUris) {
                await service.ensureParsed(documentsByUri.get(uri));
            }

            await new Promise(resolve => setTimeout(resolve, 50));
            lag.reset();
            const started = performance.now();
            await Promise.all(
                Array.from(documentsByUri.keys())
                    .filter(uri => !warmUris.includes(uri))
                    .map(uri => service.ensureParsed(documentsByUri.get(uri)))
            );
            const totalMs = performance.now() - started;
            await new Promise(resolve => setTimeout(resolve, 50));
            const report = lag.report();

            rows.push({
                sizeKb: kb,
                files,
                lagMaxMs: +report.maxMs.toFixed(1),
                lagP95Ms: +report.p95Ms.toFixed(1),
                totalMs: +totalMs.toFixed(0)
            });
        }
    }

    lag.stop();
    return rows;
}

/** Агрегирует прогоны одного варианта: median, p90 и max. */
function summarizeQueueRuns(kb, files, runs) {
    const pick = key => runs.map(run => run[key]);
    const percentile = (values, fraction) => {
        const sorted = values.slice().sort((left, right) => left - right);
        return sorted[Math.min(
            sorted.length - 1,
            Math.floor(sorted.length * fraction)
        )];
    };
    const lags = pick("lagMaxMs");
    const totals = pick("totalMs");

    return {
        sizeKb: kb,
        files,
        runs: runs.length,
        lagMedianMs: +median(lags).toFixed(1),
        lagP90Ms: +percentile(lags, 0.9).toFixed(1),
        lagMaxMs: +Math.max(...lags).toFixed(1),
        totalMedianMs: +median(totals).toFixed(0)
    };
}

/* --- сценарий external: индексация внешнего файла --------------------- */

const EXTERNAL_WORKER_SOURCE = `
const { parentPort } = require("worker_threads");
const fs = require("fs");
const {
    extractCompactDeclarations
} = require(${JSON.stringify(path.join(OUT, "analysis", "declarationExtractor"))});

parentPort.on("message", request => {
    const source = fs.readFileSync(request.filePath, "utf8");
    const stat = fs.statSync(request.filePath);
    /* Состав ровно как у внешнего модуля: без параметров Macro. */
    const snapshot = extractCompactDeclarations(source, {
        includeCallableParameters: false
    });
    parentPort.postMessage({
        id: request.id,
        postedAt: Date.now(),
        mtimeMs: stat.mtimeMs,
        sourceLength: source.length,
        declarations: snapshot.declarations,
        imports: snapshot.imports
    });
});
`;

function countDescriptors(list) {
    let total = 0;
    for (const item of list) {
        total += 1 + countDescriptors(item.children || []);
    }
    return total;
}

async function runExternalScenario() {
    const {
        extractCompactDeclarations
    } = require(OUT + "/analysis/declarationExtractor");
    const build = SHAPES["макросы и блоки"];
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rsl-bench-"));
    const workerPath = path.join(directory, "external-worker.js");
    fs.writeFileSync(workerPath, EXTERNAL_WORKER_SOURCE);

    const worker = new Worker(workerPath);
    const pending = new Map();
    worker.on("message", response => {
        const receivedAt = Date.now();
        const resolve = pending.get(response.id);
        pending.delete(response.id);
        resolve({ response, receivedAt });
    });
    const ask = (id, filePath) => new Promise(resolve => {
        pending.set(id, resolve);
        worker.postMessage({ id, filePath });
    });

    const warmPath = path.join(directory, "warm.mac");
    fs.writeFileSync(warmPath, build(20 * 1024));
    await ask(0, warmPath);

    const rows = [];
    let id = 1;
    for (const kb of EXTERNAL_SIZES_KB) {
        const filePath = path.join(directory, `external-${kb}.mac`);
        fs.writeFileSync(filePath, build(kb * 1024));

        const externalOptions = { includeCallableParameters: false };
        extractCompactDeclarations(
            fs.readFileSync(filePath, "utf8"),
            externalOptions
        );
        const localTimes = [];
        for (let run = 0; run < 5; run++) {
            const started = performance.now();
            extractCompactDeclarations(
                fs.readFileSync(filePath, "utf8"),
                externalOptions
            );
            localTimes.push(performance.now() - started);
        }

        const { response, receivedAt } = await ask(id++, filePath);
        const payloadKb = Math.round(Buffer.byteLength(JSON.stringify({
            declarations: response.declarations,
            imports: response.imports
        })) / 1024);

        rows.push({
            sizeKb: kb,
            descriptors: countDescriptors(response.declarations),
            localMs: +median(localTimes).toFixed(1),
            transferMs: receivedAt - response.postedAt,
            payloadKb
        });
    }

    await worker.terminate();
    fs.rmSync(directory, { recursive: true, force: true });
    return rows;
}

/* --- сценарий relex: точечный пересчёт токенов ------------------------ */

/*
 * Цена точечного relex зависит не от размера правки, а от числа токенов
 * ПОСЛЕ неё: им всем пересчитываются позиции. Этот замер и задаёт отсечку
 * MAX_SHIFTED_TOKEN_FRACTION в incrementalLex.ts — без неё правка в начале
 * большого файла обходится дороже полного лексирования.
 */
function runRelexScenario() {
    const { lexRsl } = require(OUT + "/lexer");
    const {
        tryIncrementalRelex
    } = require(OUT + "/services/incrementalLex");
    const build = SHAPES["макросы и блоки"];
    const rows = [];

    for (const kb of [300, 550, 1100]) {
        const source = build(kb * 1024);
        const lex = lexRsl(source);

        lexRsl(source);
        const fullTimes = [];
        for (let run = 0; run < 5; run++) {
            const started = performance.now();
            lexRsl(source);
            fullTimes.push(performance.now() - started);
        }
        const fullMs = median(fullTimes);

        for (const fraction of [0, 0.25, 0.5, 0.75, 0.95]) {
            const anchor = Math.floor(source.length * fraction);
            const found = source.indexOf("value", anchor);
            if (found < 0) continue;
            const editAt = found + 3;
            const next = source.slice(0, editAt) + "X" + source.slice(editAt);
            const shiftedTokens = lex.tokens.filter(
                token => token.start >= editAt
            ).length;

            tryIncrementalRelex(source, lex, next);
            const times = [];
            let accepted = false;
            for (let run = 0; run < 5; run++) {
                const started = performance.now();
                const result = tryIncrementalRelex(source, lex, next);
                times.push(performance.now() - started);
                accepted = !!result;
            }

            rows.push({
                sizeKb: kb,
                editAtPercent: Math.round(fraction * 100),
                shiftedTokens,
                totalTokens: lex.tokens.length,
                fullLexMs: +fullMs.toFixed(1),
                relexMs: +median(times).toFixed(1),
                accepted
            });
        }
    }

    return rows;
}

/* --- запуск ---------------------------------------------------------- */

const SCENARIOS = {
    parse: runParseScenario,
    external: runExternalScenario,
    relex: runRelexScenario
};

/*
 * queue устроен иначе: каждый вариант (размер × число файлов) выполняется в
 * отдельном процессе и несколько раз, а родитель агрегирует прогоны.
 */
const QUEUE_SCENARIO = "queue";

function printParse(rows) {
    console.log("=== стоимость одного разбора (медиана из 5) ===");
    console.log(
        "форма".padEnd(18) + "размер".padStart(8) + "токенов".padStart(10) +
        "lex".padStart(9) + "parse".padStart(9) + "модель".padStart(9)
    );
    for (const row of rows) {
        console.log(
            row.shape.padEnd(18) +
            `${row.sizeKb}КБ`.padStart(8) +
            String(row.tokens).padStart(10) +
            `${row.lexMs}мс`.padStart(9) +
            `${row.parseMs}мс`.padStart(9) +
            `${row.modelMs}мс`.padStart(9)
        );
    }
}

function printQueue(rows) {
    console.log("\n=== блокировка event loop очередью валидаций ===");
    console.log(
        "файлов".padStart(7) + "размер".padStart(9) +
        "лаг median".padStart(12) + "лаг p90".padStart(10) +
        "лаг max".padStart(10) + "всего".padStart(9) +
        "прогонов".padStart(10)
    );
    for (const row of rows) {
        console.log(
            String(row.files).padStart(7) +
            `${row.sizeKb}КБ`.padStart(9) +
            `${row.lagMedianMs}мс`.padStart(12) +
            `${row.lagP90Ms}мс`.padStart(10) +
            `${row.lagMaxMs}мс`.padStart(10) +
            `${row.totalMedianMs}мс`.padStart(9) +
            String(row.runs).padStart(10)
        );
    }
    console.log(
        "Лаг — сколько подряд основной поток не отдавал управление. Каждый\n" +
        "вариант замерен в отдельном процессе несколько раз."
    );
}

function printExternal(rows) {
    console.log("\n=== индексация внешнего файла: на месте против worker ===");
    console.log(
        "размер".padStart(8) + "дескрипторов".padStart(14) +
        "на месте".padStart(11) + "передача".padStart(11) +
        "ответ JSON".padStart(12)
    );
    for (const row of rows) {
        console.log(
            `${row.sizeKb}КБ`.padStart(8) +
            String(row.descriptors).padStart(14) +
            `${row.localMs}мс`.padStart(11) +
            `${row.transferMs}мс`.padStart(11) +
            `${row.payloadKb}КБ`.padStart(12)
        );
    }
    console.log(
        "Передача — сериализация в worker плюс распаковка в основном потоке;\n" +
        "выигрыш от выноса есть только если она заметно меньше «на месте»."
    );
}

function printRelex(rows) {
    console.log("\n=== точечный relex против полного лексирования ===");
    console.log(
        "размер".padStart(8) + "правка".padStart(9) +
        "сдвигается".padStart(12) + "полный lex".padStart(12) +
        "relex".padStart(9) + "принят".padStart(8)
    );
    for (const row of rows) {
        console.log(
            `${row.sizeKb}КБ`.padStart(8) +
            `${row.editAtPercent}%`.padStart(9) +
            `${Math.round(row.shiftedTokens / row.totalTokens * 100)}%`
                .padStart(12) +
            `${row.fullLexMs}мс`.padStart(12) +
            `${row.relexMs}мс`.padStart(9) +
            (row.accepted ? "да" : "нет").padStart(8)
        );
    }
    console.log(
        "Отсечка (incrementalLex.ts) отклоняет правки, сдвигающие больше\n" +
        "половины потока: там точечный путь дороже полного лексирования."
    );
}

const PRINTERS = {
    parse: printParse,
    queue: printQueue,
    external: printExternal,
    relex: printRelex
};

async function runChild(name) {
    const variant = name.startsWith(QUEUE_SCENARIO + ":")
        ? name.slice(QUEUE_SCENARIO.length + 1).split("x").map(Number)
        : undefined;
    const rows = variant
        ? await runQueueVariant(variant[0], variant[1])
        : await SCENARIOS[name]();
    process.send({ scenario: name, rows });
}

function runScenarioInChildProcess(name) {
    return new Promise((resolve, reject) => {
        const child = fork(__filename, [`--child=${name}`], { stdio: "inherit" });
        let result;
        child.on("message", message => { result = message.rows; });
        child.on("error", reject);
        child.on("exit", code => {
            if (code !== 0) {
                reject(new Error(`Сценарий ${name} завершился с кодом ${code}`));
                return;
            }
            resolve(result || []);
        });
    });
}

async function main() {
    const childArgument = process.argv.find(item => item.startsWith("--child="));
    if (childArgument) {
        await runChild(childArgument.slice("--child=".length));
        return;
    }

    const asJson = process.argv.includes("--json");
    const requested = process.argv
        .find(item => item.startsWith("--scenario="));
    const names = requested
        ? requested.slice("--scenario=".length).split(",")
        : ["parse", QUEUE_SCENARIO, "external", "relex"];

    for (const name of names) {
        if (!SCENARIOS[name] && name !== QUEUE_SCENARIO) {
            throw new Error(`Неизвестный сценарий: ${name}`);
        }
    }

    const results = {};
    for (const name of names) {
        if (name !== QUEUE_SCENARIO) {
            results[name] = await runScenarioInChildProcess(name);
            continue;
        }

        const aggregated = [];
        for (const kb of QUEUE_SIZES_KB) {
            for (const files of QUEUE_FILE_COUNTS) {
                const runs = [];
                for (let repeat = 0; repeat < QUEUE_REPEATS; repeat++) {
                    const rows = await runScenarioInChildProcess(
                        `${QUEUE_SCENARIO}:${kb}x${files}`
                    );
                    runs.push(...rows);
                }
                aggregated.push(summarizeQueueRuns(kb, files, runs));
            }
        }
        results[name] = aggregated;
    }

    if (asJson) {
        console.log(JSON.stringify({
            node: process.version,
            platform: `${process.platform} ${process.arch}`,
            cpu: os.cpus()[0]?.model,
            scenarios: results
        }, null, 2));
        return;
    }

    for (const name of names) {
        PRINTERS[name](results[name]);
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

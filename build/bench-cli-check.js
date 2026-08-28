"use strict";

/*
 * Сколько стоит `rsl-plus check`.
 *
 *   node build/bench-cli-check.js --project <каталог> [--repeats N]
 *
 * Меряется не «сколько всего», а из чего складывается: поиск файлов проекта,
 * загрузка прямых и транзитивных зависимостей, сам анализ. Отдельно —
 * повторный запуск в том же процессе: по нему видно, что даёт уже прогретый
 * контекст.
 *
 * Стенды идут от простого к сложному: файл без импортов, файл с прямым
 * импортом, файл с цепочкой, несколько файлов с общей зависимостью, несколько
 * файлов настоящего проекта, файл с отсутствующей зависимостью.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const outDir = path.join(__dirname, "..", "server", "out");
const serverModulePath = require.resolve(path.join(outDir, "server"));

require.cache[serverModulePath] = {
    id: serverModulePath,
    filename: serverModulePath,
    loaded: true,
    exports: { getTree: () => [], GetFileByNameRequest: () => undefined }
};

const {
    RslProjectAnalysis
} = require(path.join(outDir, "analysis", "projectAnalysis"));

function argumentValue(name, fallback) {
    const at = process.argv.indexOf(name);

    return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const PROJECT = argumentValue("--project", "");
const REPEATS = Number(argumentValue("--repeats", "3"));

function heap() {
    if (global.gc) {
        global.gc();
        global.gc();
    }

    return process.memoryUsage().heapUsed;
}

function milliseconds(from) {
    return Number(process.hrtime.bigint() - from) / 1e6;
}

/**
 * Один прогон стенда.
 *
 * Поиск файлов и анализ меряются раздельно: на большом проекте первое зависит
 * от диска, второе — от самих файлов, и складывать их в одно число значит
 * потерять то, ради чего замер делается.
 */
function measure(contextRoot, files) {
    const before = heap();
    const preparedAt = process.hrtime.bigint();
    const analysis = new RslProjectAnalysis({ contextRoot });

    analysis.prepare();

    const prepareMs = milliseconds(preparedAt);
    const analyzedAt = process.hrtime.bigint();
    const result = analysis.analyze(files);
    const analyzeMs = milliseconds(analyzedAt);

    /* Повторный анализ тем же ядром: контекст уже прогрет. */
    const repeatedAt = process.hrtime.bigint();

    analysis.analyze(files);

    const repeatMs = milliseconds(repeatedAt);

    return {
        prepareMs,
        analyzeMs,
        repeatMs,
        projectFiles: analysis.projectFileCount,
        dependencies: analysis.loadedDependencies - files.length,
        diagnostics: result.reduce(
            (sum, file) => sum + file.diagnostics.length,
            0
        ),
        incomplete: result.filter(file => file.status === "incomplete").length,
        heapBytes: heap() - before
    };
}

function best(contextRoot, files) {
    let result;

    for (let round = 0; round < REPEATS; round++) {
        const run = measure(contextRoot, files);

        if (!result || run.analyzeMs < result.analyzeMs) {
            result = run;
        }
    }

    return result;
}

function report(name, run) {
    console.log(
        "  " + name.padEnd(38) +
        "поиск " + run.prepareMs.toFixed(0).padStart(5) +
        " мс, анализ " + run.analyzeMs.toFixed(1).padStart(7) +
        " мс, повтор " + run.repeatMs.toFixed(1).padStart(7) +
        " мс | файлов проекта " + String(run.projectFiles).padStart(5) +
        ", зависимостей " + String(run.dependencies).padStart(3) +
        ", сообщений " + String(run.diagnostics).padStart(4) +
        ", неполных " + run.incomplete +
        ", куча " + (run.heapBytes / (1024 * 1024)).toFixed(1) + " МБ"
    );
}

/** Синтетический проект: цепочка зависимостей и общий модуль. */
function createSyntheticProject() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rsl-cli-bench-"));
    const write = (name, content) => {
        const target = path.join(directory, name);

        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, "utf8");
    };

    write("deep.mac", "Macro Deep()\n  return 1;\nEnd;\n");
    write("middle.mac", "Import deep;\nMacro Middle()\n  return Deep();\nEnd;\n");
    write("shared.mac", "Macro Shared(value)\n  return value;\nEnd;\n");
    write("alone.mac", "Macro Alone()\n  Var v = 1;\n  v = v;\n  return v;\nEnd;\n");
    write(
        "direct.mac",
        "Import shared;\nMacro Direct()\n  return Shared(1);\nEnd;\n"
    );
    write(
        "chained.mac",
        "Import middle;\nMacro Chained()\n  return Middle();\nEnd;\n"
    );
    write(
        "first.mac",
        "Import shared;\nMacro First()\n  return Shared(1);\nEnd;\n"
    );
    write(
        "second.mac",
        "Import shared;\nMacro Second()\n  return Shared(2);\nEnd;\n"
    );
    write(
        "broken.mac",
        "Import нетакогомодуля;\nMacro Broken()\n  return 1;\nEnd;\n"
    );

    return directory;
}

function main() {
    console.log("Стенд `rsl-plus check`, повторов на стенд: " + REPEATS);
    console.log("\n  Синтетические стенды");

    const synthetic = createSyntheticProject();

    try {
        report("файл без импортов", best(synthetic, ["alone.mac"]));
        report("файл с прямым импортом", best(synthetic, ["direct.mac"]));
        report("файл с цепочкой импортов", best(synthetic, ["chained.mac"]));
        report(
            "два файла с общей зависимостью",
            best(synthetic, ["first.mac", "second.mac"])
        );
        report(
            "файл с отсутствующей зависимостью",
            best(synthetic, ["broken.mac"])
        );
    } finally {
        fs.rmSync(synthetic, { recursive: true, force: true });
    }

    if (!PROJECT) {
        console.log(
            "\n  Настоящий проект не задан: добавьте --project <каталог>"
        );

        return;
    }

    console.log("\n  Настоящий проект");

    const files = [];
    const stack = [path.resolve(PROJECT)];

    while (stack.length > 0 && files.length < 5000) {
        const current = stack.pop();

        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);

            if (entry.isDirectory()) {
                if (entry.name !== ".git") {
                    stack.push(full);
                }

                continue;
            }

            if (/\.mac$/iu.test(entry.name)) {
                files.push(full);
            }
        }
    }

    files.sort();

    for (const count of [1, 5, 20]) {
        report(
            "файлов проекта: " + count,
            best(PROJECT, files.slice(0, count))
        );
    }
}

main();

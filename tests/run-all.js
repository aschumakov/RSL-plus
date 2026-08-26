"use strict";

/**
 * Прогон тестов: быстрый набор и полный.
 *
 * Файлов полсотни, и раньше они запускались строго по одному: сто секунд, из
 * которых половина уходила на ожидание таймеров и на два дифференциальных
 * прогона. Теперь работа разложена:
 *
 *   parallel — функциональные файлы, четыре процесса разом;
 *   serial   — то, что меряет время или конкуренцию задач: по одному и в
 *              тишине, иначе соседний процесс искажает замер;
 *   fullOnly — длинные дифференциальные и фаззинг-проверки, а также
 *              абсолютные бюджеты времени: в быстром наборе их нет.
 *
 * Быстрый набор — ежедневная проверка. Полный обязателен перед выпуском:
 * уникальные проверки из него никуда не делись, они просто идут отдельно.
 *
 *   node tests/run-all.js          — полный набор
 *   node tests/run-all.js --fast   — быстрый набор
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const TESTS_DIRECTORY = __dirname;
/*
 * Сколько процессов идёт разом.
 *
 * Больше половины ядер брать незачем: тесты и сами внутри уходят в worker
 * потоки, а последовательная группа после них требует тишины.
 */
const PARALLEL_WORKERS = Math.max(
    2,
    Math.min(6, Math.floor(require("os").cpus().length / 2))
);

/*
 * Проверки времени и конкуренции: только последовательно.
 *
 * Они смотрят на отзывчивость основного потока и на порядок задач. Соседний
 * тестовый процесс на том же ядре превращает такую проверку в лотерею.
 */
const SERIAL = new Set([
    "parse-scheduling.test.js",
    "parse-resume.test.js",
    "problems-lifecycle.test.js",
    "request-races.test.js",
    "interruptible-work.test.js",
    "workspace-resolution.test.js",
    "workspace-worker.test.js",
    "stability-regressions.test.js",
    "performance-regressions.test.js",
    /*
     * Файлы с проверками роста времени. В быстром наборе такие проверки
     * пропускаются, поэтому там эти файлы идут параллельно; в полном они
     * меряют время и требуют тишины.
     */
    "diagnostics.test.js",
    "class-member-diagnostics.test.js",
    "unknown-variables.test.js",
    /* Меряет память: рядом работающие процессы искажают замер. */
    "editing-session.test.js",
    /* Меряет непрерывную занятость потока — ей тоже нужна тишина. */
    "catalog-warmup.test.js"
]);

/*
 * Только в полном наборе: длинные дифференциальные прогоны, фаззинг и
 * абсолютные бюджеты времени.
 *
 * Уникальные сценарии сохранены целиком — быстрый набор просто не ждёт их
 * каждый раз.
 */
const FULL_ONLY = new Set([
    "lexer-incremental-differential.test.js",
    "lexer-incremental-fuzz.test.js",
    "model-equivalence.test.js",
    "parse-resume.test.js",
    "workspace-worker.test.js",
    "stability-regressions.test.js",
    "performance-regressions.test.js"
]);

/*
 * Файл, который последователен только в полном наборе.
 *
 * Проверки конкуренции внутри него в быстром наборе пропускаются (см.
 * tests/test-mode.js), а функциональные проверки прекрасно идут параллельно.
 */
const SERIAL_ONLY_IN_FULL = new Set([
    "workspace-resolution.test.js",
    "diagnostics.test.js",
    "class-member-diagnostics.test.js",
    "unknown-variables.test.js"
]);

const fast = process.argv.includes("--fast");
const files = fs.readdirSync(TESTS_DIRECTORY)
    .filter(name => name.endsWith(".test.js"))
    .filter(name => !fast || !FULL_ONLY.has(name))
    .sort();

/*
 * Самые долгие файлы запускаются первыми.
 *
 * Иначе пятнадцатисекундный дифференциальный прогон стартует в середине и
 * держит всю группу: остальные процессы уже закончили, а он ещё идёт.
 */
const LONGEST_FIRST = [
    "lexer-incremental-fuzz.test.js",
    "lexer-incremental-differential.test.js",
    "model-equivalence.test.js",
    "diagnostics.test.js",
    "class-member-diagnostics.test.js"
];

const isSerial = name => SERIAL.has(name) &&
    !(fast && SERIAL_ONLY_IN_FULL.has(name));

const parallelFiles = files
    .filter(name => !isSerial(name))
    .sort((left, right) => {
        const leftRank = LONGEST_FIRST.indexOf(left);
        const rightRank = LONGEST_FIRST.indexOf(right);

        if (leftRank !== rightRank) {
            return (leftRank < 0 ? LONGEST_FIRST.length : leftRank) -
                (rightRank < 0 ? LONGEST_FIRST.length : rightRank);
        }

        return left.localeCompare(right);
    });
const serialFiles = files.filter(isSerial);

/*
 * Файлы, которым нужен доступ к уборщику мусора.
 *
 * Проверка объёма памяти без принудительной уборки меряет момент, когда
 * уборщик решил не работать, а не удержание. Флаг ставится здесь, а не внутри
 * файла: node не умеет включать его на ходу.
 */
const NEEDS_GC = new Set(["editing-session.test.js"]);

function runFile(file) {
    const started = Date.now();

    return new Promise(resolve => {
        const nodeArguments = NEEDS_GC.has(file)
            ? ["--expose-gc", path.join(TESTS_DIRECTORY, file)]
            : [path.join(TESTS_DIRECTORY, file)];
        const child = spawn(process.execPath, nodeArguments, {
            cwd: path.join(TESTS_DIRECTORY, ".."),
            env: {
                ...process.env,
                /* Тесты роста и бюджетов смотрят на это значение. */
                RSL_TESTS: fast ? "fast" : "full"
            }
        });
        const chunks = [];

        child.stdout.on("data", data => chunks.push(data));
        child.stderr.on("data", data => chunks.push(data));
        child.on("close", code => resolve({
            file,
            code,
            ms: Date.now() - started,
            output: Buffer.concat(chunks).toString()
        }));
    });
}

function report(result) {
    const status = result.code === 0 ? "OK  " : "FAIL";

    console.log(
        `=== ${status} ${result.file} (${result.ms} мс) ===`
    );

    if (result.code !== 0) {
        console.log(result.output.trimEnd());
    }
}

async function runParallel(list) {
    const queue = [...list];
    const results = [];

    const worker = async () => {
        for (;;) {
            const file = queue.shift();

            if (!file) {
                return;
            }

            const result = await runFile(file);
            results.push(result);
            report(result);
        }
    };

    await Promise.all(
        Array.from({ length: Math.min(PARALLEL_WORKERS, list.length) }, worker)
    );

    return results;
}

async function runSerial(list) {
    const results = [];

    for (const file of list) {
        const result = await runFile(file);
        results.push(result);
        report(result);
    }

    return results;
}

async function main() {
    const startedAt = Date.now();

    console.log(
        (fast ? "Быстрый" : "Полный") + " набор: " + files.length +
        " файлов (" + parallelFiles.length + " параллельно, " +
        serialFiles.length + " последовательно)\n"
    );

    const results = [
        ...await runParallel(parallelFiles),
        ...await runSerial(serialFiles)
    ];
    const failures = results.filter(result => result.code !== 0);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

    if (failures.length > 0) {
        console.error(
            "\nПровалено файлов: " + failures.length + " из " +
            results.length + " за " + seconds + " с"
        );
        failures.forEach(result => console.error("  " + result.file));
        process.exit(1);
    }

    console.log(
        "\nВсе тесты RSL-plus успешно пройдены: " + results.length +
        " файлов за " + seconds + " с"
    );
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});

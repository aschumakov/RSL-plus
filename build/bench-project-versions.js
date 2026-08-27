"use strict";

/*
 * Стенд производительности на настоящем проекте макросов.
 *
 * Синтетические образцы отвечают на вопрос «сколько стоит эта операция», но не
 * отвечают на вопрос «сколько стоит работа с этим проектом»: настоящие файлы
 * устроены иначе — в них десятки процедур на сотни килобайт, и одна процедура
 * запросто занимает половину файла. Поэтому стенд берёт файлы проекта как они
 * есть.
 *
 * Проект указывает тот, кто запускает: ни путей, ни имён репозиториев здесь
 * нет и быть не должно.
 *
 *   node build/bench-project-versions.js --project <каталог> [ключи]
 *
 * Ключи:
 *   --project <путь>     каталог с .mac (можно повторять — несколько корней);
 *   --versions <пути>    каталоги других сборок через запятую: их результаты
 *                        меряются тем же кодом стенда и печатаются рядом;
 *   --min-size <КБ>      не брать файлы мельче (по умолчанию 4);
 *   --largest [N]        брать N самых крупных файлов вместо среза по алфавиту;
 *   --files <N>          сколько файлов взять (по умолчанию 200);
 *   --repeats <N>        повторов на файл, берётся лучший (по умолчанию 3);
 *   --edit <где>         место правки: start | middle | end (по умолчанию middle);
 *   --output <файл>      куда сложить подробный JSON;
 *   --detail             строка на каждый файл.
 *
 * Меряются два пути, потому что они разные:
 *
 *   изолированный холодный файл — модель с нуля и buildRslDiagnostics без
 *               движка и без кэша. Так считается файл, который никто не
 *               открывал;
 *   изолированный путь редактора — DocumentAnalysisService и
 *               RslDiagnosticEngine: то, что происходит при открытии вкладки
 *               и при наборе текста.
 *
 * Слово «изолированный» здесь существенно. Каждый файл меряется в собственном
 * индексе, где зарегистрирован он один: зависимостей проекта в индексе нет и
 * загрузка импортов выключена. Lex, разбор, модель, локальные Problems и вся
 * механика кэша по единицам от этого не страдают — они смотрят только на сам
 * файл. А вот межфайловые Problems и цена работы с Import-контекстом в таком
 * замере ниже, чем в настоящем открытом проекте, и сравнивать их с рабочими
 * ощущениями нельзя. Режим с заранее собранным каталогом и подгруженными
 * зависимостями — задача следующей версии.
 *
 * На каждый файл записывается: lex, разбор и модель по отдельности (из
 * span-ов самой службы разбора, а не замером снаружи); Problems локальные и
 * межфайловые; сколько текста пришлось пересчитать и какую долю файла это
 * составило; место правки; почему lex и модель пошли полным путём, а не
 * точечным; попадания и промахи по лентам кэша; чем кончилась запись в кэш и
 * почему; число опубликованных Problems.
 *
 * Итог — медиана, p95 и максимум по файлам. Минимум печатается справочно:
 * он показывает, как быстро может быть, а отзывчивость определяется тем, как
 * медленно бывает.
 */

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

/* ──────────────────────────── разбор аргументов ────────────────────────── */

function parseArguments(argv) {
    const options = {
        projects: [],
        versions: [],
        minKb: 4,
        files: 200,
        largest: 0,
        repeats: 3,
        edit: "middle",
        output: undefined,
        detail: false
    };

    for (let at = 0; at < argv.length; at++) {
        const key = argv[at];
        const value = () => argv[++at];

        switch (key) {
            case "--project":
                options.projects.push(value());
                break;
            case "--versions":
                options.versions = (value() || "")
                    .split(",")
                    .map(item => item.trim())
                    .filter(Boolean);
                break;
            case "--min-size":
                options.minKb = Number(value());
                break;
            case "--files":
                options.files = Number(value());
                break;
            case "--largest":
                /* Число необязательно: --largest без него берёт --files. */
                if (argv[at + 1] && !argv[at + 1].startsWith("--")) {
                    options.largest = Number(value());
                } else {
                    options.largest = -1;
                }

                break;
            case "--repeats":
                options.repeats = Number(value());
                break;
            case "--edit":
                options.edit = value();
                break;
            case "--output":
                options.output = value();
                break;
            case "--detail":
                options.detail = true;
                break;
            default:
                console.error("неизвестный ключ: " + key);
                process.exit(1);
        }
    }

    if (options.largest === -1) {
        options.largest = options.files;
    }

    return options;
}

const OPTIONS = parseArguments(process.argv.slice(2));

if (OPTIONS.projects.length === 0) {
    console.error(
        "нужен каталог проекта:\n" +
        "  node build/bench-project-versions.js --project <каталог> [ключи]\n" +
        "  ключи: --versions, --min-size, --largest, --files, --repeats,\n" +
        "         --edit, --output, --detail"
    );
    process.exit(1);
}

/* Тот же предел Problems, что у сервера по умолчанию. */
const MAX_PROBLEMS = 200;
const SETTINGS = { maxProblems: MAX_PROBLEMS };
const MIN_BYTES = OPTIONS.minKb * 1024;

/* ─────────────────────────── загрузка одной сборки ─────────────────────── */

/**
 * Модули сборки, лежащей по этому пути.
 *
 * Стенд умеет мерить не только себя: путь к чужой сборке даёт возможность
 * сравнить версии одним и тем же кодом замера. Модуль server подменяется
 * заглушкой — он тянет за собой соединение с клиентом, которого здесь нет.
 */
function loadBuild(root) {
    const buildRoot = path.resolve(root);
    const out = path.join(buildRoot, "server", "out");
    const serverModulePath = require.resolve(path.join(out, "server"));

    require.cache[serverModulePath] = {
        id: serverModulePath,
        filename: serverModulePath,
        loaded: true,
        exports: { getTree: () => [], GetFileByNameRequest: () => undefined }
    };

    const tryRequire = relative => {
        try {
            return require(path.join(out, relative));
        } catch {
            return undefined;
        }
    };
    const analysisModule = tryRequire("services/documentAnalysisService");
    const engineModule = tryRequire("diagnostics/diagnosticEngine");

    return {
        version: JSON.parse(
            fs.readFileSync(path.join(buildRoot, "package.json"), "utf8")
        ).version,
        WorkspaceIndex: require(path.join(out, "workspaceIndex")).WorkspaceIndex,
        buildCold: require(path.join(out, "diagnostics")).buildRslDiagnostics,
        decode: require(path.join(out, "core/textDecoding"))
            .decodeRslSourceText,
        TextDocument: require(path.join(
            buildRoot,
            "server",
            "node_modules",
            "vscode-languageserver-textdocument"
        )).TextDocument,
        analysisModule,
        engineModule,
        abilities: {
            analysis: !!(analysisModule &&
                analysisModule.DocumentAnalysisService),
            engine: !!(engineModule && engineModule.RslDiagnosticEngine)
        }
    };
}

/* ────────────────────────── сбор файлов проекта ────────────────────────── */

function collect(directory) {
    const result = [];
    const stack = [path.resolve(directory)];

    while (stack.length > 0) {
        const current = stack.pop();

        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);

            if (entry.isDirectory()) {
                if (entry.name !== ".git" && entry.name !== "node_modules") {
                    stack.push(full);
                }

                continue;
            }

            if (/\.mac$/iu.test(entry.name)) {
                result.push(full);
            }
        }
    }

    return result.sort();
}

/**
 * Какие файлы мерить.
 *
 * Размер отсекается ДО ограничения количества. Иначе `--files 200`
 * отбирает две сотни первых по алфавиту, мелкие из них потом отсеиваются, и
 * вместо двух сотен меряется сколько получится — при том что подходящие файлы
 * в проекте есть, просто они дальше по алфавиту.
 */
function chooseFiles() {
    const sized = OPTIONS.projects
        .flatMap(collect)
        .map(file => ({ file, size: fs.statSync(file).size }))
        .filter(item => item.size >= MIN_BYTES);

    if (OPTIONS.largest > 0) {
        return sized
            .sort((left, right) => right.size - left.size)
            .slice(0, OPTIONS.largest)
            .map(item => item.file);
    }

    return sized.slice(0, OPTIONS.files).map(item => item.file);
}

/* ─────────────────────────────── статистика ────────────────────────────── */

function quantile(sorted, share) {
    if (sorted.length === 0) {
        return 0;
    }

    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
}

function describe(values) {
    if (values.length === 0) {
        return undefined;
    }

    const sorted = [...values].sort((left, right) => left - right);

    return {
        count: sorted.length,
        p50: quantile(sorted, 0.5),
        p95: quantile(sorted, 0.95),
        max: sorted[sorted.length - 1],
        min: sorted[0]
    };
}

function isNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function push(target, value) {
    if (isNumber(value)) {
        target.push(value);
    }
}

function fixed(value) {
    return isNumber(value) ? value.toFixed(1) : "—";
}

function tally(map, key) {
    map.set(key, (map.get(key) || 0) + 1);
}

function tallyText(map) {
    return [...map.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([key, count]) => key + " " + count)
        .join(", ");
}

/* ───────────────────────────── правка в файле ──────────────────────────── */

/**
 * Куда вставить пробел.
 *
 * Место правки — не мелочь: точечный lex отказывается работать у самого начала
 * файла, а точечная модель тем полезнее, чем меньше задетая процедура. Поэтому
 * место и записывается в отчёт, а не выбирается молча.
 */
function editOffset(source) {
    const share = OPTIONS.edit === "start"
        ? 0.05
        : (OPTIONS.edit === "end" ? 0.95 : 0.5);
    const at = Math.floor(source.length * share);
    const line = source.indexOf("\n", at);

    return line < 0 ? source.length : line;
}

/* ──────────────────────── наблюдатель за службой ───────────────────────── */

/**
 * Подставной журнал производительности.
 *
 * Служба разбора сама размечает свои шаги и сообщает, почему lex и модель
 * пошли полным путём. Мерить те же шаги снаружи значило бы мерить не то, что
 * делает редактор, а то, что придумал стенд.
 */
function createProbe() {
    const spans = new Map();
    const marks = [];

    return {
        reset() {
            spans.clear();
            marks.length = 0;
        },
        durationOf(event) {
            return spans.get(event)?.ms;
        },
        fieldsOf(event) {
            return spans.get(event)?.fields;
        },
        markOf(event) {
            const found = marks.filter(item => item.event === event);

            return found.length > 0 ? found[found.length - 1].fields : undefined;
        },
        logger: {
            enabled: true,
            start: (event, fields) => ({
                event,
                fields,
                at: process.hrtime.bigint()
            }),
            end: (span, extra) => {
                if (!span) {
                    return;
                }

                const ms = Number(process.hrtime.bigint() - span.at) / 1e6;
                const previous = spans.get(span.event);

                spans.set(span.event, {
                    /* Шаг может повториться: берётся сумма за прогон. */
                    ms: (previous ? previous.ms : 0) + ms,
                    fields: { ...span.fields, ...(extra || {}) }
                });
            },
            mark: (event, fields) => marks.push({ event, fields: fields || {} })
        }
    };
}

/* ────────────────────────── наблюдатель за кэшем ───────────────────────── */

/** Сколько текста в единице: сумма её участков, а не протяжённость. */
function charsOf(unit) {
    const ranges = unit.ranges || [{ start: unit.start, end: unit.end }];

    return ranges.reduce((sum, range) => sum + (range.end - range.start), 0);
}

/**
 * Перехват кэша по единицам: что переиспользовано и запомнен ли результат.
 *
 * Кэш рассказывает о себе только числом попаданий. Стенду нужно больше:
 * сколько единиц пересчитано, сколько в них текста и чем кончился расчёт.
 * Перехват живёт в стенде — сам плагин ради замера не трогается.
 */
function watchUnitCache(engine) {
    const cache = engine && engine.unitCache;

    if (!cache || typeof cache.begin !== "function") {
        return undefined;
    }

    const original = cache.begin.bind(cache);
    let collected = [];

    cache.begin = (module, lane, fingerprint) => {
        const run = original(module, lane, fingerprint);
        const record = {
            lane,
            full: run.full,
            units: run.units.length,
            stale: run.stale.length,
            keep: run.keep.length,
            staleChars: run.stale.reduce((sum, unit) => sum + charsOf(unit), 0),
            outcome: "не завершён"
        };

        collected.push(record);

        return {
            ...run,
            commit: value => {
                record.outcome = "запомнен";
                run.commit(value);
            },
            abort: () => {
                record.outcome = "отброшен";
                run.abort();
            }
        };
    };

    return {
        take() {
            const value = collected;

            collected = [];

            return value;
        },
        laneStats(lane) {
            return cache.laneStats
                ? cache.laneStats(lane)
                : { hits: 0, misses: 0 };
        }
    };
}

function laneSnapshot(cache) {
    return {
        text: cache?.laneStats("text") || { hits: 0, misses: 0 },
        imports: cache?.laneStats("imports") || { hits: 0, misses: 0 }
    };
}

function laneDelta(before, after) {
    const of = lane => ({
        hits: after[lane].hits - before[lane].hits,
        misses: after[lane].misses - before[lane].misses
    });

    return { text: of("text"), imports: of("imports") };
}

/* ─────────────────────────── стенд одного файла ────────────────────────── */

function createStand(build, uri, source) {
    const index = new build.WorkspaceIndex();

    index.registerWorkspaceFiles([uri]);

    let document = build.TextDocument.create(uri, "rsl", 1, source);
    const probe = createProbe();
    let parsedVersion = 0;
    let waiter;
    const analysis = new build.analysisModule.DocumentAnalysisService(
        { get: requested => (requested === uri ? document : undefined) },
        index,
        { getAvailable: () => ({ imports: { enabled: false } }) },
        {
            log: () => undefined,
            invalidateProviderCaches: () => undefined,
            onParsed: module => {
                parsedVersion = module.version;

                if (waiter && waiter.version <= parsedVersion) {
                    const settle = waiter.settle;

                    waiter = undefined;
                    settle();
                }
            },
            onImports: () => undefined,
            initialParseDelayMs: 0,
            changeDebounceMs: 0,
            inactiveParseDelayMs: 0,
            backgroundQuietMs: 0,
            performance: probe.logger
        }
    );
    const engine = build.abilities.engine
        ? new build.engineModule.RslDiagnosticEngine()
        : undefined;

    const parsed = version => {
        if (parsedVersion >= version) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                waiter = undefined;
                reject(new Error(
                    "разбор версии " + version + " не дошёл до конца; " +
                    "последняя готовая версия " + parsedVersion
                ));
            }, 60_000);

            waiter = {
                version,
                settle: () => {
                    clearTimeout(timer);
                    resolve();
                }
            };
        });
    };

    return {
        index,
        engine,
        probe,
        cache: watchUnitCache(engine),
        get module() {
            return index.getModule(uri);
        },
        open() {
            analysis.setActiveDocument(uri);
            analysis.open(document);

            return parsed(1);
        },
        change(nextText, nextVersion) {
            document = build.TextDocument.create(uri, "rsl", nextVersion, nextText);
            analysis.noteInteractiveActivity();
            analysis.changed(document);

            return parsed(nextVersion);
        },
        dispose() {
            analysis.close(uri);
            engine?.forget(uri);
            index.clear?.();
        }
    };
}

async function measure(action) {
    const at = process.hrtime.bigint();
    const value = await action();

    return { ms: Number(process.hrtime.bigint() - at) / 1e6, value };
}

/** Диагностика в сравнимом виде: для подсчёта опубликованных. */
function signatureOf(diagnostic) {
    return diagnostic.code + "@" +
        diagnostic.range.start.line + ":" +
        diagnostic.range.start.character + ":" +
        diagnostic.message;
}

function publishedCount(...lists) {
    const seen = new Set();

    for (const list of lists) {
        for (const item of list) {
            seen.add(signatureOf(item));
        }
    }

    return Math.min(MAX_PROBLEMS, seen.size);
}

/**
 * Почему запись кэша не сохранилась.
 *
 * Отказы означают разное. Упёрлись в лимит Problems — расчёт неполон по
 * существу, и следующая правка снова пойдёт вхолодную. Отменили — файл
 * покинули, и это нормально. Различать обязательно: первое значит, что у самых
 * «шумных» файлов кэша нет вовсе.
 */
function refusalReason(runs, problems) {
    if (runs.length === 0 || runs.every(run => run.outcome === "запомнен")) {
        return undefined;
    }

    return problems >= MAX_PROBLEMS ? "лимит Problems" : "неполный проход";
}

/** Один прогон одного файла: холодный путь и путь редактора. */
async function runFile(build, uri, source) {
    const result = {};
    const coldIndex = new build.WorkspaceIndex();

    coldIndex.registerWorkspaceFiles([uri]);

    const coldModel = await measure(
        () => coldIndex.updateOpenModule(uri, source, 1)
    );

    result.coldModelMs = coldModel.ms;

    const cold = await measure(
        () => build.buildCold(coldModel.value, coldIndex, SETTINGS)
    );

    result.coldProblemsMs = cold.ms;
    result.coldProblems = cold.value.length;

    if (!build.abilities.analysis || !build.abilities.engine) {
        return result;
    }

    const stand = createStand(build, uri, source);

    try {
        await stand.open();

        result.openLexMs = stand.probe.durationOf("analysis.fastSnapshot");
        result.openParseMs = stand.probe.durationOf("analysis.syntax");
        result.openModelMs = stand.probe.durationOf("analysis.symbolTree");
        result.openTotalMs = stand.probe.durationOf("analysis.full");

        const module = stand.module;

        if (!module) {
            throw new Error("модель после открытия не появилась");
        }

        stand.cache?.take();

        const local = await measure(() => stand.engine.buildLocalAsync(
            module,
            stand.index,
            SETTINGS
        ));

        result.openLocalMs = local.ms;
        result.openCacheRuns = stand.cache?.take() || [];

        const workspace = await measure(() => stand.engine.buildWorkspaceAsync(
            module,
            stand.index,
            SETTINGS
        ));

        result.openWorkspaceMs = workspace.ms;
        result.publishedProblems = publishedCount(local.value, workspace.value);

        /* ── Первая правка ──────────────────────────────────────────────── */
        const at = editOffset(source);
        const next = source.slice(0, at) + " " + source.slice(at);

        result.editShare = at / source.length;

        stand.probe.reset();

        const beforeFirst = laneSnapshot(stand.cache);

        await stand.change(next, 2);

        result.editLexMs = stand.probe.durationOf("analysis.fastSnapshot");
        result.editParseMs = stand.probe.durationOf("analysis.syntax");
        result.editModelMs = stand.probe.durationOf("analysis.symbolTree");
        result.editTotalMs = stand.probe.durationOf("analysis.full");
        result.lexReason =
            (stand.probe.fieldsOf("analysis.fastSnapshot") || {}).lexReason ||
            "неизвестно";
        result.parseReason =
            (stand.probe.markOf("analysis.incrementalParse") || {}).reason ||
            "полный";

        stand.cache?.take();

        const editLocal = await measure(() => stand.engine.buildLocalAsync(
            stand.module,
            stand.index,
            SETTINGS
        ));

        result.editLocalMs = editLocal.ms;
        result.editCacheRuns = stand.cache?.take() || [];

        const editWorkspace = await measure(
            () => stand.engine.buildWorkspaceAsync(
                stand.module,
                stand.index,
                SETTINGS
            )
        );

        result.editWorkspaceMs = editWorkspace.ms;
        result.editPublishedProblems = publishedCount(
            editLocal.value,
            editWorkspace.value
        );
        result.laneDelta = laneDelta(beforeFirst, laneSnapshot(stand.cache));

        /*
         * ── Вторая правка ───────────────────────────────────────────────
         *
         * По первой правке о кэше судить нельзя: она сравнивается с записью,
         * сделанной при открытии, а та могла и не сохраниться. Вторая правка
         * показывает установившийся режим — так и набирают текст.
         */
        const at2 = editOffset(next);
        const next2 = next.slice(0, at2) + " " + next.slice(at2);

        stand.probe.reset();

        const beforeSecond = laneSnapshot(stand.cache);

        await stand.change(next2, 3);

        stand.cache?.take();

        const secondLocal = await measure(() => stand.engine.buildLocalAsync(
            stand.module,
            stand.index,
            SETTINGS
        ));

        result.edit2LocalMs = secondLocal.ms;
        result.edit2CacheRuns = stand.cache?.take() || [];
        result.edit2Problems = secondLocal.value.length;
        result.lane2Delta = laneDelta(beforeSecond, laneSnapshot(stand.cache));
    } finally {
        stand.dispose();
    }

    return result;
}

/** Совокупная длительность прогона: по ней выбирается лучший повтор. */
function totalOf(run) {
    return [
        run.coldModelMs,
        run.coldProblemsMs,
        run.openTotalMs,
        run.openLocalMs,
        run.openWorkspaceMs,
        run.editTotalMs,
        run.editLocalMs,
        run.editWorkspaceMs,
        run.edit2LocalMs
    ].reduce((sum, value) => sum + (isNumber(value) ? value : 0), 0);
}

/* ──────────────────────────── прогон одной сборки ──────────────────────── */

async function benchBuild(root, files) {
    const build = loadBuild(root);
    const stats = {
        coldModel: [],
        coldProblems: [],
        openLex: [],
        openParse: [],
        openModel: [],
        openLocal: [],
        openWorkspace: [],
        editLex: [],
        editParse: [],
        editModel: [],
        editLocal: [],
        editWorkspace: [],
        edit2Local: [],
        staleChars: [],
        staleShare: [],
        published: []
    };
    const lexReasons = new Map();
    const parseReasons = new Map();
    const cacheOutcomes = new Map();
    const cache2Outcomes = new Map();
    const refusals = new Map();
    const lanes = {
        first: { text: { hits: 0, misses: 0 }, imports: { hits: 0, misses: 0 } },
        second: { text: { hits: 0, misses: 0 }, imports: { hits: 0, misses: 0 } }
    };
    const crowded = [];
    let bytes = 0;
    let skipped = 0;
    let measured = 0;

    for (const file of files) {
        let source;

        try {
            source = build.decode(fs.readFileSync(file));
        } catch {
            skipped++;
            continue;
        }

        const uri = pathToFileURL(file).toString();
        let best;

        try {
            for (let round = 0; round < OPTIONS.repeats; round++) {
                const run = await runFile(build, uri, source);

                if (!best || totalOf(run) < totalOf(best)) {
                    best = run;
                }
            }
        } catch (error) {
            skipped++;

            if (OPTIONS.detail) {
                console.log(
                    "    " + path.basename(file) + ": пропущен — " +
                    (error && error.message)
                );
            }

            continue;
        }

        measured++;
        bytes += source.length;
        push(stats.coldModel, best.coldModelMs);
        push(stats.coldProblems, best.coldProblemsMs);
        push(stats.openLex, best.openLexMs);
        push(stats.openParse, best.openParseMs);
        push(stats.openModel, best.openModelMs);
        push(stats.openLocal, best.openLocalMs);
        push(stats.openWorkspace, best.openWorkspaceMs);
        push(stats.editLex, best.editLexMs);
        push(stats.editParse, best.editParseMs);
        push(stats.editModel, best.editModelMs);
        push(stats.editLocal, best.editLocalMs);
        push(stats.editWorkspace, best.editWorkspaceMs);
        push(stats.edit2Local, best.edit2LocalMs);
        push(stats.published, best.publishedProblems);

        if (best.lexReason) {
            tally(lexReasons, best.lexReason);
        }

        if (best.parseReason) {
            tally(parseReasons, best.parseReason);
        }

        const textRun = (best.editCacheRuns || [])
            .find(run => run.lane === "text");
        const textRun2 = (best.edit2CacheRuns || [])
            .find(run => run.lane === "text");

        if (textRun) {
            push(stats.staleChars, textRun.staleChars);
            push(stats.staleShare, 100 * textRun.staleChars / source.length);
            tally(
                cacheOutcomes,
                (textRun.full ? "весь файл" : "точечно") + "/" + textRun.outcome
            );
        }

        if (textRun2) {
            tally(
                cache2Outcomes,
                (textRun2.full ? "весь файл" : "точечно") + "/" +
                    textRun2.outcome
            );
        }

        const refusal = refusalReason(
            best.editCacheRuns || [],
            best.editPublishedProblems || 0
        );

        if (refusal) {
            tally(refusals, refusal);
        }

        for (const [when, delta] of [
            ["first", best.laneDelta],
            ["second", best.lane2Delta]
        ]) {
            if (!delta) {
                continue;
            }

            for (const lane of ["text", "imports"]) {
                lanes[when][lane].hits += delta[lane].hits;
                lanes[when][lane].misses += delta[lane].misses;
            }
        }

        if ((best.publishedProblems || 0) >= MAX_PROBLEMS) {
            crowded.push({
                file: path.basename(file),
                kb: Math.round(source.length / 1024),
                openLocalMs: best.openLocalMs,
                editLocalMs: best.editLocalMs,
                edit2LocalMs: best.edit2LocalMs,
                reused: !!(textRun2 && !textRun2.full),
                kept: !!(textRun2 && textRun2.outcome === "запомнен"),
                refusal
            });
        }

        if (OPTIONS.detail) {
            console.log(
                "    " + path.basename(file).padEnd(22) +
                String(Math.round(source.length / 1024)).padStart(4) + " КБ" +
                " | холодно " + fixed(best.coldModelMs) + "+" +
                fixed(best.coldProblemsMs) +
                " | открытие " + fixed(best.openLexMs) + "/" +
                fixed(best.openParseMs) + "/" + fixed(best.openModelMs) +
                " + " + fixed(best.openLocalMs) + "/" +
                fixed(best.openWorkspaceMs) +
                " | правка " + fixed(best.editLocalMs) + ", вторая " +
                fixed(best.edit2LocalMs) +
                " | " + best.lexReason + "," + best.parseReason +
                (textRun2
                    ? " | единиц " + textRun2.stale + "/" + textRun2.units +
                        ", " + textRun2.outcome
                    : "") +
                " | Problems " + (best.publishedProblems || 0)
            );
        }
    }

    return {
        build: root,
        version: build.version,
        abilities: build.abilities,
        measured,
        skipped,
        bytes,
        repeats: OPTIONS.repeats,
        edit: OPTIONS.edit,
        maxProblems: MAX_PROBLEMS,
        stats: Object.fromEntries(
            Object.entries(stats).map(([key, values]) => [key, describe(values)])
        ),
        lexReasons: Object.fromEntries(lexReasons),
        parseReasons: Object.fromEntries(parseReasons),
        cacheOutcomes: Object.fromEntries(cacheOutcomes),
        cache2Outcomes: Object.fromEntries(cache2Outcomes),
        refusals: Object.fromEntries(refusals),
        lanes,
        crowded
    };
}

/* ─────────────────────────────── печать ────────────────────────────────── */

function line(label, stats, unit = " мс") {
    if (!stats) {
        console.log("  " + label.padEnd(26) + "нет данных");

        return;
    }

    console.log(
        "  " + label.padEnd(26) +
        "p50 " + stats.p50.toFixed(1).padStart(7) +
        ", p95 " + stats.p95.toFixed(1).padStart(7) +
        ", максимум " + stats.max.toFixed(1).padStart(8) + unit +
        "   (минимум " + stats.min.toFixed(1) + ", файлов " + stats.count + ")"
    );
}

function laneLine(label, lane) {
    console.log(
        "  " + label.padEnd(26) +
        "text " + lane.text.hits + "/" + (lane.text.hits + lane.text.misses) +
        ", imports " + lane.imports.hits + "/" +
        (lane.imports.hits + lane.imports.misses)
    );
}

function printReport(report) {
    const stats = report.stats;

    console.log(
        "\nRSL-plus " + report.version + " (" + report.build + ")" +
        ": измерено файлов " + report.measured +
        " (" + (report.bytes / (1024 * 1024)).toFixed(1) + " МБ), пропущено " +
        report.skipped + ", повторов на файл " + report.repeats
    );
    console.log(
        "  правка: " + report.edit + ", предел Problems " + report.maxProblems
    );

    console.log("\n  Изолированный холодный файл");
    line("модель с нуля", stats.coldModel);
    line("buildRslDiagnostics", stats.coldProblems);

    if (!report.abilities.analysis || !report.abilities.engine) {
        console.log(
            "\n  Путь редактора этой версией не измеряется: " +
            "нет службы разбора или движка."
        );

        return;
    }

    console.log("\n  Изолированный путь редактора: открытие вкладки");
    line("lex", stats.openLex);
    line("разбор", stats.openParse);
    line("модель", stats.openModel);
    line("Problems локальные", stats.openLocal);
    line("Problems межфайловые", stats.openWorkspace);
    line("опубликовано Problems", stats.published, " шт");
    console.log(
        "  (межфайловые Problems занижены: зависимостей проекта в индексе нет)"
    );

    console.log("\n  Первая правка");
    line("lex", stats.editLex);
    line("разбор", stats.editParse);
    line("модель", stats.editModel);
    line("Problems локальные", stats.editLocal);
    line("Problems межфайловые", stats.editWorkspace);
    line("пересчитано текста", stats.staleChars, " симв");
    line("доля файла в пересчёте", stats.staleShare, " %");

    console.log("\n  Вторая правка подряд (установившийся режим)");
    line("Problems локальные", stats.edit2Local);

    console.log("\n  Пути, кэш и отказы");
    console.log("  " + "lex".padEnd(26) + tallyText(new Map(
        Object.entries(report.lexReasons)
    )));
    console.log("  " + "модель".padEnd(26) + tallyText(new Map(
        Object.entries(report.parseReasons)
    )));
    console.log("  " + "кэш, первая правка".padEnd(26) + tallyText(new Map(
        Object.entries(report.cacheOutcomes)
    )));
    console.log("  " + "кэш, вторая правка".padEnd(26) + tallyText(new Map(
        Object.entries(report.cache2Outcomes)
    )));

    if (Object.keys(report.refusals).length > 0) {
        console.log("  " + "отказ запомнить".padEnd(26) + tallyText(new Map(
            Object.entries(report.refusals)
        )));
    }

    laneLine("попаданий, первая правка", report.lanes.first);
    laneLine("попаданий, вторая правка", report.lanes.second);

    console.log(
        "\n  Файлы, упирающиеся в предел Problems (" +
        report.crowded.length + ")"
    );

    if (report.crowded.length === 0) {
        console.log("  таких нет");

        return;
    }

    const kept = report.crowded.filter(item => item.kept).length;
    const reused = report.crowded.filter(item => item.reused).length;

    console.log(
        "  " + "после второй правки".padEnd(26) +
        "кэш сохранён у " + kept + " из " + report.crowded.length +
        ", переиспользован у " + reused
    );

    for (const item of report.crowded.slice(0, 12)) {
        console.log(
            "    " + item.file.padEnd(22) +
            String(item.kb).padStart(4) + " КБ: открытие " +
            fixed(item.openLocalMs) + " мс, правка " +
            fixed(item.editLocalMs) + " мс, вторая " +
            fixed(item.edit2LocalMs) + " мс" +
            (item.refusal ? " (" + item.refusal + ")" : "")
        );
    }
}

/* ──────────────────────────────── запуск ───────────────────────────────── */

async function main() {
    const files = chooseFiles();

    if (files.length === 0) {
        console.error("в указанных каталогах нет файлов .mac");
        process.exit(1);
    }

    console.log(
        "файлов отобрано: " + files.length +
        (OPTIONS.largest > 0 ? " (самые крупные)" : " (срез по алфавиту)") +
        ", мельче " + OPTIONS.minKb + " КБ не берутся"
    );

    const reports = [];

    /* Своя сборка меряется всегда; чужие — если о них попросили. */
    for (const root of [path.join(__dirname, ".."), ...OPTIONS.versions]) {
        const report = await benchBuild(root, files);

        reports.push(report);
        printReport(report);
    }

    if (!OPTIONS.output) {
        return;
    }

    /*
     * Подробности — в JSON: сравнивать версии глазами по консоли неудобно, а
     * пути к файлам проекта в репозиторий попасть не должны.
     */
    fs.writeFileSync(
        path.resolve(OPTIONS.output),
        JSON.stringify({ options: OPTIONS, reports }, undefined, 2),
        "utf8"
    );
    console.log("\nподробности: " + path.resolve(OPTIONS.output));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

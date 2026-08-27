"use strict";

/**
 * Прерванный разбор продолжается, а не начинается заново.
 *
 * Большой файл разбирается фазами: lex, разбор, сборка модели порциями. Уход
 * на другую вкладку и правка обрывают работу между фазами, и раньше вся она
 * выбрасывалась.
 *
 * Здесь ничего не угадывается. Момент прерывания задаётся: служба сообщает о
 * каждой границе фазы, и тест прерывает работу ровно там, где проверяет.
 * Ожидание — тоже событие, а не число тактов: тест ждёт нужную границу или
 * готовность нужной версии. Ограничение по времени оставлено только как защита
 * от зависания, и при срабатывании оно печатает, чего ждали и что случилось.
 *
 * Файл собран из девятисот отдельных процедур: сборка модели обязана пройти
 * через множество единиц, иначе проверка продолжения ничего не проверяет.
 */

const assert = require("assert");

const {
    TextDocument
} = require("../server/node_modules/vscode-languageserver-textdocument");
const {
    DocumentAnalysisService
} = require("../server/out/services/documentAnalysisService");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { isFullTestRun } = require("./test-mode");

let passed = 0;
let failed = 0;

async function test(name, action) {
    try {
        await action();
        passed++;
        console.log(`[OK] ${name}`);
    } catch (error) {
        failed++;
        console.error(`[FAIL] ${name}`);
        console.error(error && error.stack ? error.stack : error);
    }
}

const URI = "file:///big.mac";
const OTHER = "file:///other.mac";
/** Защита от зависания: столько ждём событие, прежде чем признать провал. */
const WAIT_LIMIT_MS = 20_000;

/**
 * Файл из девятисот процедур.
 *
 * Больше порога фазового разбора (100 КБ) и с множеством единиц верхнего
 * уровня: сборка модели идёт по ним порциями, и прерывание попадает в
 * середину работы, а не между двумя единицами.
 */
function bigSource(salt) {
    const lines = [];

    for (let index = 0; index < 900; index++) {
        lines.push(
            "Macro Process" + index + "(document, options)",
            "  Var result = " + (index + salt) + ";",
            "  if (options == 1)",
            "    result = document.Value;",
            "  end;",
            "  return result;",
            "End;",
            ""
        );
    }

    return lines.join("\n");
}

/**
 * Стенд: служба разбора с наблюдателем за границами фаз и журналом событий.
 *
 * Наблюдатель — единственный способ прервать работу детерминированно: он
 * вызывается до возврата управления, и то, что он сделает, служба увидит на
 * ближайшей проверке актуальности. Он же ведёт журнал, по которому тест ждёт.
 */
function createStand() {
    const source = bigSource(0);

    assert.ok(
        source.length > 100_000,
        "нужен файл сверх порога фазового разбора, получено " + source.length
    );

    let document = TextDocument.create(URI, "rsl", 1, source);
    const others = new Map([
        [OTHER, TextDocument.create(OTHER, "rsl", 1, "Macro O()\nEnd;\n")]
    ]);
    const documents = {
        get: requested => requested === URI
            ? document
            : others.get(requested)
    };
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([URI, OTHER]);

    const marks = [];
    const events = [];
    const waiters = new Set();
    let pending;

    const record = event => {
        events.push(event);

        for (const waiter of [...waiters]) {
            if (waiter.match(event)) {
                waiters.delete(waiter);
                waiter.settle(event);
            }
        }
    };
    const summary = () => events
        .map(event => event.kind === "boundary"
            ? event.phase + "@" + event.version +
                (event.resumed ? " (продолжение)" : "")
            : "готово@" + event.version)
        .join(", ") || "ничего";

    const analysis = new DocumentAnalysisService(
        documents,
        index,
        { getAvailable: () => ({ imports: { enabled: false } }) },
        {
            log: () => undefined,
            invalidateProviderCaches: () => undefined,
            onParsed: module => record({
                kind: "parsed",
                version: module.version,
                uri: module.uri
            }),
            onImports: () => undefined,
            initialParseDelayMs: 0,
            changeDebounceMs: 0,
            inactiveParseDelayMs: 0,
            backgroundQuietMs: 0,
            /* Каждая единица заканчивает порцию: границы предсказуемы. */
            modelSliceMs: 0,
            onPhaseBoundary: async (phase, context) => {
                record({
                    kind: "boundary",
                    phase,
                    version: context.version,
                    resumed: context.resumed
                });

                /* Прерывание ждёт свою границу и срабатывает один раз. */
                if (pending && pending.phase === phase) {
                    const action = pending.action;

                    pending = undefined;
                    await action(context);
                }
            },
            performance: {
                enabled: false,
                start: () => undefined,
                end: () => undefined,
                mark: (event, fields) => marks.push({ event, fields })
            }
        }
    );

    const stand = {
        analysis,
        index,
        marks,
        get document() {
            return document;
        },
        /**
         * Ждать событие службы.
         *
         * Сначала смотрит в журнал: событие могло случиться до начала
         * ожидания. Ограничение по времени — не расписание, а защита от
         * зависания: при срабатывании видно, чего ждали и что было.
         */
        waitFor(description, match) {
            const seen = events.find(match);

            if (seen) {
                return Promise.resolve(seen);
            }

            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    waiters.delete(waiter);
                    reject(new Error(
                        "не дождались: " + description + "; за " +
                        WAIT_LIMIT_MS + " мс случилось: " + summary()
                    ));
                }, WAIT_LIMIT_MS);
                const waiter = {
                    match,
                    settle: event => {
                        clearTimeout(timer);
                        resolve(event);
                    }
                };

                waiters.add(waiter);
            });
        },
        /** Граница фазы указанной версии. */
        waitForBoundary(phase, version) {
            return stand.waitFor(
                "граница " + phase + " версии " + version,
                event => event.kind === "boundary" &&
                    event.phase === phase &&
                    event.version === version
            );
        },
        /** Готовая модель указанной версии. */
        waitForVersion(version) {
            return stand.waitFor(
                "готовая модель версии " + version,
                event => event.kind === "parsed" &&
                    event.uri === URI &&
                    event.version === version
            );
        },
        /** Прервать работу на первой границе фазы с этим именем. */
        interruptAt(phase, action) {
            pending = { phase, action };
        },
        /** Уйти на другую вкладку: разбор этого файла становится не нужен. */
        leave() {
            analysis.setActiveDocument(OTHER);
        },
        /** Вернуться: разбор продолжится с контрольной точки. */
        comeBack() {
            analysis.setActiveDocument(URI);
        },
        /** Правка во время паузы: версия сменилась. */
        edit(salt) {
            document = TextDocument.create(
                URI,
                "rsl",
                document.version + 1,
                bigSource(salt)
            );
            analysis.changed(document);

            return document;
        },
        summary,
        boundariesOf(phase, version) {
            return events.filter(event =>
                event.kind === "boundary" &&
                event.phase === phase &&
                (version === undefined || event.version === version)).length;
        },
        /** Сколько раз фаза выполнялась заново, а не продолжалась. */
        freshRunsOf(phase, version) {
            return events.filter(event =>
                event.kind === "boundary" &&
                event.phase === phase &&
                !event.resumed &&
                (version === undefined || event.version === version)).length;
        },
        /** Освободить память стенда: их в одном процессе десятки. */
        dispose() {
            for (const waiter of [...waiters]) {
                waiters.delete(waiter);
                waiter.settle({ kind: "disposed" });
            }

            analysis.close(URI);
            index.clear();
        }
    };

    return stand;
}

async function run() {
    await test("прерывание после разбора не теряет его результат", async () => {
        const stand = createStand();

        try {
            stand.analysis.setActiveDocument(URI);
            stand.interruptAt("syntax", () => stand.leave());
            stand.analysis.open(stand.document);

            await stand.waitForBoundary("syntax", 1);

            assert.strictEqual(
                stand.freshRunsOf("syntax", 1),
                1,
                "разбор дошёл до контрольной точки: " + stand.summary()
            );

            /*
             * Уход на другую вкладку не отменяет разбор навсегда: он
             * становится фоновым и доводится до конца. Проверяется не
             * остановка, а то, что продолжение не считает заново самую дорогую
             * фазу.
             */
            stand.comeBack();
            await stand.waitForVersion(1);

            assert.ok(
                stand.marks.some(item => item.event === "analysis.resumed"),
                "продолжение отмечено как продолжение: " + stand.summary()
            );
            assert.strictEqual(
                stand.freshRunsOf("syntax", 1),
                1,
                "фаза разбора этой версии второй раз не выполнялась: " +
                    stand.summary()
            );
        } finally {
            stand.dispose();
        }
    });

    await test("сборка модели продолжается, а не начинается заново", async () => {
        const stand = createStand();

        try {
            stand.analysis.setActiveDocument(URI);
            /* Прерываем в середине сборки модели, а не до неё. */
            stand.interruptAt("modelSlice", () => stand.leave());
            stand.analysis.open(stand.document);

            await stand.waitForBoundary("modelSlice", 1);

            const slicesBefore = stand.boundariesOf("modelSlice", 1);

            stand.comeBack();
            await stand.waitForVersion(1);

            assert.strictEqual(
                stand.freshRunsOf("syntax", 1),
                1,
                "разбор второй раз не выполнялся: " + stand.summary()
            );
            assert.ok(
                stand.boundariesOf("modelSlice", 1) >= slicesBefore,
                "сборка продолжилась, а не потерялась: " + stand.summary()
            );
            assert.ok(
                stand.index.getCurrentModule(URI, 1),
                "модель этой версии готова"
            );
        } finally {
            stand.dispose();
        }
    });

    await test("правка во время паузы отменяет устаревшую сборку", async () => {
        const stand = createStand();

        try {
            stand.analysis.setActiveDocument(URI);
            stand.interruptAt("syntax", () => {
                /* Пользователь правит файл ровно в паузу между фазами. */
                stand.edit(1);
            });
            stand.analysis.open(stand.document);

            await stand.waitForVersion(2);

            assert.strictEqual(
                stand.index.getCurrentModule(URI, 1),
                undefined,
                "модель устаревшей версии не публиковалась: " + stand.summary()
            );

            const model = stand.index.getCurrentModule(URI, 2);

            assert.ok(model, "в индексе лежит модель актуальной версии");
            assert.strictEqual(
                model.source,
                stand.document.getText(),
                "модель собрана по актуальному тексту"
            );
        } finally {
            stand.dispose();
        }
    });

    await test("устаревшая сборка не публикуется и после порции", async () => {
        const stand = createStand();

        try {
            stand.analysis.setActiveDocument(URI);
            stand.interruptAt("modelSlice", () => stand.edit(2));
            stand.analysis.open(stand.document);

            await stand.waitForVersion(2);

            assert.strictEqual(
                stand.index.getCurrentModule(URI, 1),
                undefined,
                "половина модели прежней версии наружу не вышла: " +
                    stand.summary()
            );
            assert.ok(
                stand.index.getCurrentModule(URI, 2),
                "актуальная версия доведена до конца"
            );
        } finally {
            stand.dispose();
        }
    });

    await test("серия прерываний не расшатывает разбор", async () => {
        /*
         * Проверка не на «однажды сработало», а на повторяемость: прежний
         * перебор тактов давал разный ответ от запуска к запуску, и именно это
         * здесь и ловится.
         */
        const rounds = isFullTestRun() ? 50 : 10;

        for (let round = 0; round < rounds; round++) {
            const stand = createStand();
            const phase = round % 2 === 0 ? "syntax" : "modelSlice";

            try {
                stand.analysis.setActiveDocument(URI);
                stand.interruptAt(phase, () => stand.leave());
                stand.analysis.open(stand.document);

                await stand.waitForBoundary(phase, 1);

                stand.comeBack();
                await stand.waitForVersion(1);

                assert.strictEqual(
                    stand.freshRunsOf("syntax", 1),
                    1,
                    `заход ${round} (${phase}): разбор считался ровно один ` +
                        `раз; ${stand.summary()}`
                );
            } finally {
                stand.dispose();
            }
        }

        console.log(
            "[METRIC] прерываний проверено: " + rounds +
            ", разбор каждый раз считался один раз"
        );
    });

    if (failed > 0) {
        console.error(`\nПройдено: ${passed}\nОшибок: ${failed}`);
        process.exitCode = 1;
    } else {
        console.log(`\nПройдено: ${passed}\nОшибок: ${failed}`);
    }
}

void run();

"use strict";

/**
 * Прерванный разбор продолжается, а не начинается заново.
 *
 * Большой файл разбирается фазами: lex, разбор, сборка модели порциями. Уход
 * на другую вкладку и правка обрывают работу между фазами, и раньше вся она
 * выбрасывалась.
 *
 * Момент прерывания здесь задаётся, а не подбирается. Прежняя проверка
 * перебирала число тактов до переключения вкладки в надежде попасть в паузу
 * между фазами: под нагрузкой разбор успевал закончиться раньше, и тест падал
 * на коде, который не менялся. Служба сообщает о каждой границе фазы, и тест
 * прерывает работу ровно там, где проверяет.
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

/** Файл больше порога фазового разбора: иначе фаз просто нет. */
function bigSource(salt) {
    const lines = ["Macro Big()"];

    for (let index = 0; index < 4000; index++) {
        lines.push(
            "  Var someRatherLongVariableName" + index + " = " +
            (index + salt) + ";"
        );
    }

    lines.push("End;");

    return lines.join("\n");
}

/**
 * Стенд: служба разбора с наблюдателем за границами фаз.
 *
 * Наблюдатель — единственный способ прервать работу детерминированно: он
 * вызывается до возврата управления, и то, что он сделает, служба увидит на
 * ближайшей проверке актуальности.
 */
function createStand() {
    const source = bigSource(0);

    assert.ok(
        source.length > 100_000,
        "нужен файл сверх порога фазового разбора"
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
    const boundaries = [];
    let pending;
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
            changeDebounceMs: 0,
            inactiveParseDelayMs: 0,
            backgroundQuietMs: 0,
            /* Каждая единица заканчивает порцию: границы предсказуемы. */
            modelSliceMs: 0,
            onPhaseBoundary: async (phase, context) => {
                boundaries.push({
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

    return {
        analysis,
        index,
        marks,
        boundaries,
        get document() {
            return document;
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
        /* Освободить память стенда: их в одном процессе десятки. */
        dispose() {
            analysis.close(URI);
            index.clear();
        },
        boundariesOf(phase, version) {
            return boundaries.filter(item =>
                item.phase === phase &&
                (version === undefined || item.version === version)).length;
        },
        /** Сколько раз фаза выполнялась заново, а не продолжалась. */
        freshRunsOf(phase, version) {
            return boundaries.filter(item =>
                item.phase === phase &&
                !item.resumed &&
                (version === undefined || item.version === version)).length;
        }
    };
}

/** Прокручивает цикл событий, не сдвигая время. */
async function pumpTicks(count, until) {
    for (let index = 0; index < count; index++) {
        if (until && until()) {
            return;
        }

        await new Promise(resolve => setImmediate(resolve));
    }
}

async function run() {
    await test("прерывание после разбора не теряет его результат", async () => {
        const stand = createStand();

        stand.analysis.setActiveDocument(URI);
        stand.interruptAt("syntax", () => stand.leave());
        stand.analysis.open(stand.document);

        await pumpTicks(200, () => stand.boundariesOf("syntax") > 0);

        assert.strictEqual(
            stand.freshRunsOf("syntax", 1),
            1,
            "разбор дошёл до контрольной точки"
        );

        /*
         * Уход на другую вкладку не отменяет разбор навсегда: он становится
         * фоновым и доводится до конца. Проверяется не остановка, а то, что
         * продолжение не считает заново самую дорогую фазу.
         */
        stand.comeBack();
        await pumpTicks(400, () => stand.analysis.isLocalReady(stand.document));

        assert.ok(
            stand.analysis.isLocalReady(stand.document),
            "после возвращения разбор доводится до конца"
        );
        assert.ok(
            stand.marks.some(item => item.event === "analysis.resumed"),
            "продолжение отмечено как продолжение"
        );
        assert.strictEqual(
            stand.freshRunsOf("syntax", 1),
            1,
            "фаза разбора этой версии второй раз не выполнялась"
        );
        stand.dispose();
    });

    await test("сборка модели продолжается, а не начинается заново", async () => {
        const stand = createStand();

        stand.analysis.setActiveDocument(URI);
        /* Прерываем в середине сборки модели, а не до неё. */
        stand.interruptAt("modelSlice", () => stand.leave());
        stand.analysis.open(stand.document);

        await pumpTicks(400, () => stand.boundariesOf("modelSlice") > 0);

        assert.ok(
            stand.boundariesOf("modelSlice") > 0,
            "сборка модели успела начаться"
        );

        const slicesBefore = stand.boundariesOf("modelSlice", 1);

        stand.comeBack();
        await pumpTicks(400, () => stand.analysis.isLocalReady(stand.document));

        assert.ok(
            stand.analysis.isLocalReady(stand.document),
            "модель этой версии готова"
        );
        assert.strictEqual(
            stand.freshRunsOf("syntax", 1),
            1,
            "разбор второй раз не выполнялся"
        );
        assert.ok(
            stand.boundariesOf("modelSlice", 1) >= slicesBefore,
            "сборка продолжилась, а не потерялась"
        );
        stand.dispose();
    });

    await test("правка во время паузы отменяет устаревшую сборку", async () => {
        const stand = createStand();

        stand.analysis.setActiveDocument(URI);
        stand.interruptAt("syntax", () => {
            /* Пользователь правит файл ровно в паузу между фазами. */
            stand.edit(1);
        });
        stand.analysis.open(stand.document);

        await pumpTicks(600, () =>
            stand.analysis.isLocalReady(stand.document));

        assert.ok(
            stand.analysis.isLocalReady(stand.document),
            "новая версия разобрана"
        );
        assert.strictEqual(
            stand.index.getCurrentModule(URI, 1),
            undefined,
            "модель устаревшей версии не публиковалась"
        );

        const model = stand.index.getCurrentModule(
            URI,
            stand.document.version
        );

        assert.ok(model, "в индексе лежит модель актуальной версии");
        assert.strictEqual(
            model.source,
            stand.document.getText(),
            "модель собрана по актуальному тексту"
        );
        stand.dispose();
    });

    await test("устаревшая сборка не публикуется и после порции", async () => {
        const stand = createStand();

        stand.analysis.setActiveDocument(URI);
        stand.interruptAt("modelSlice", () => stand.edit(2));
        stand.analysis.open(stand.document);

        await pumpTicks(600, () =>
            stand.analysis.isLocalReady(stand.document));

        assert.strictEqual(
            stand.index.getCurrentModule(URI, 1),
            undefined,
            "половина модели прежней версии наружу не вышла"
        );
        assert.ok(
            stand.analysis.isLocalReady(stand.document),
            "актуальная версия доведена до конца"
        );
        stand.dispose();
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

            stand.analysis.setActiveDocument(URI);
            stand.interruptAt(phase, () => stand.leave());
            stand.analysis.open(stand.document);

            await pumpTicks(400, () => stand.boundariesOf(phase) > 0);

            stand.comeBack();
            await pumpTicks(
                600,
                () => stand.analysis.isLocalReady(stand.document)
            );

            assert.ok(
                stand.analysis.isLocalReady(stand.document),
                `заход ${round} (${phase}): разбор обязан довестись до конца`
            );
            assert.strictEqual(
                stand.freshRunsOf("syntax", 1),
                1,
                `заход ${round} (${phase}): разбор считался ровно один раз`
            );
            stand.dispose();
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

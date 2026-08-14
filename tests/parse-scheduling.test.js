"use strict";

/**
 * Кто вправе торопить разбор.
 *
 * Правки текста склеиваются debounce-ом, но всякий запрос, дожидавшийся модели,
 * снимал таймер и запускал разбор немедленно. Semantic Tokens, Inlay Hints и
 * Completion редактор шлёт сам на каждое нажатие клавиши — то есть склейка
 * не работала ровно тогда, когда она нужна: при быстром наборе.
 *
 * Здесь проверяется граница: запрос по ходу набора ждёт уже назначенный разбор,
 * запрос по действию пользователя назначает свой.
 */

const assert = require("assert");

const {
    TextDocument
} = require("../server/node_modules/vscode-languageserver-textdocument");
const {
    buildRslFastCompletions
} = require("../server/out/features/fastCompletionProvider");
const {
    createFastDocumentSnapshot
} = require("../server/out/services/fastDocumentSnapshot");
const {
    DocumentAnalysisService
} = require("../server/out/services/documentAnalysisService");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

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
        console.error(error);
    }
}

const URI = "file:///scheduling.mac";
const DEBOUNCE_MS = 60;

/** Служба разбора с одним открытым и активным документом. */
function createHarness(options = {}) {
    const uri = options.uri || URI;
    let document = TextDocument.create(uri, "rsl", 1, "Macro T()\nEnd;\n");
    const others = new Map(options.others || []);
    const documents = {
        get: requested => requested === uri
            ? document
            : others.get(requested)
    };
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([uri, ...others.keys()]);

    const parsedAt = [];
    const parsedVersions = [];
    let mark = 0;
    const analysis = new DocumentAnalysisService(
        documents,
        index,
        { getAvailable: () => ({ imports: { enabled: false } }) },
        {
            log: () => undefined,
            invalidateProviderCaches: () => undefined,
            onParsed: module => {
                parsedAt.push(Date.now() - mark);
                parsedVersions.push(`${module.uri}@${module.version}`);
            },
            onImports: () => undefined,
            initialParseDelayMs: 0,
            changeDebounceMs: DEBOUNCE_MS,
            inactiveParseDelayMs:
                options.inactiveParseDelayMs ?? DEBOUNCE_MS * 2,
            backgroundQuietMs:
                options.backgroundQuietMs ?? DEBOUNCE_MS
        }
    );

    analysis.setActiveDocument(uri);
    analysis.open(document);

    return {
        analysis,
        index,
        parsedVersions,
        uri,
        get document() {
            return document;
        },
        /** Пользователь набрал символ; отсчёт до разбора начинается заново. */
        type() {
            document = TextDocument.create(
                uri,
                "rsl",
                document.version + 1,
                `Macro T()\nEnd;\nMacro M${document.version}()\nEnd;\n`
            );
            parsedAt.length = 0;
            parsedVersions.length = 0;
            mark = Date.now();
            analysis.changed(document);
            return document;
        },
        async settle(multiplier = 4) {
            await new Promise(resolve =>
                setTimeout(resolve, DEBOUNCE_MS * multiplier));
            return parsedAt.length > 0 ? parsedAt[0] : undefined;
        }
    };
}

/* Разбор до половины debounce означает, что таймер сняли. */
const IMMEDIATE_MS = DEBOUNCE_MS / 2;

async function run() {
    await test("правка ждёт debounce, если её никто не торопит", async () => {
        const harness = createHarness();
        harness.type();
        const elapsed = await harness.settle();

        assert.ok(
            elapsed !== undefined && elapsed >= IMMEDIATE_MS,
            `разбор обязан ждать склейку правок, а прошёл через ${elapsed} мс`
        );
    });

    await test("запрос по ходу набора не приближает разбор", async () => {
        const harness = createHarness();
        const document = harness.type();

        /* Так ведут себя Semantic Tokens и Inlay Hints. */
        harness.analysis.requestParse(document);
        /* Так — Completion и Signature Help. */
        void harness.analysis.ensureParsed(document, "scheduled");

        const elapsed = await harness.settle();

        assert.ok(
            elapsed !== undefined && elapsed >= IMMEDIATE_MS,
            "запрос, который редактор шлёт сам, обязан ждать уже назначенный " +
                `разбор; он прошёл через ${elapsed} мс`
        );
    });

    await test("действие пользователя разбирает немедленно", async () => {
        const harness = createHarness();
        const document = harness.type();

        /* Переход к объявлению, Rename, Hover: ждать здесь незачем. */
        await harness.analysis.ensureParsed(document, "force");
        const elapsed = await harness.settle();

        assert.ok(
            elapsed !== undefined && elapsed < IMMEDIATE_MS,
            `переход к объявлению не должен ждать склейку правок (${elapsed} мс)`
        );
    });

    await test("scheduled дожидается модели, а не возвращает пустоту", async () => {
        const harness = createHarness();
        const document = harness.type();
        const tree = await harness.analysis.ensureParsed(document, "scheduled");

        assert.ok(
            tree,
            "Completion обязан получить модель — просто не приближая её"
        );
        assert.ok(harness.analysis.isLocalReady(document));
    });

    await test("без назначенного разбора scheduled его назначает", async () => {
        const harness = createHarness();
        /* Вкладка ушла из активных: таймера у неё нет. */
        harness.analysis.setActiveDocument(undefined);
        const document = harness.type();

        harness.analysis.requestParse(document);
        const elapsed = await harness.settle();

        assert.ok(
            elapsed !== undefined,
            "иначе подсветка неактивной вкладки осталась бы базовой навсегда"
        );
    });

    /*
     * ─── Переключение вкладок ───────────────────────────────────────────────
     *
     * Уход на другую вкладку снимал назначенный разбор покинутого файла
     * совсем. Правка, не дождавшаяся своего debounce, пропадала, и при
     * возвращении файл разбирался заново — та самая «повторная работа».
     */

    await test("правка не пропадает от ухода на другую вкладку", async () => {
        const other = "file:///other.mac";
        const harness = createHarness({
            others: [[other, TextDocument.create(other, "rsl", 1, "Macro O()\nEnd;\n")]]
        });
        const document = harness.type();

        /* Ctrl+Click в другой файл раньше, чем истёк debounce. */
        harness.analysis.setActiveDocument(other);
        await harness.settle(8);

        assert.deepStrictEqual(
            harness.parsedVersions,
            [`${harness.uri}@${document.version}`],
            "разбор обязан состояться, просто с отсрочкой"
        );
        assert.ok(
            harness.analysis.isLocalReady(document),
            "модель покинутого файла обязана быть готова к возвращению"
        );
    });

    await test("возврат во вкладку не разбирает её второй раз", async () => {
        const other = "file:///other.mac";
        const harness = createHarness({
            others: [[other, TextDocument.create(other, "rsl", 1, "Macro O()\nEnd;\n")]]
        });
        const document = harness.type();

        harness.analysis.setActiveDocument(other);
        await harness.settle(8);
        const afterLeaving = harness.parsedVersions.length;

        /* Возвращаемся: модель этой версии уже есть. */
        harness.analysis.setActiveDocument(harness.uri);
        await harness.settle(4);

        assert.strictEqual(afterLeaving, 1, "версия A разбирается один раз");
        assert.deepStrictEqual(
            harness.parsedVersions,
            [`${harness.uri}@${document.version}`],
            "возвращение не имеет права разбирать готовую версию заново"
        );
    });

    await test("готовая модель переживает переключение вкладки", async () => {
        const other = "file:///other.mac";
        const harness = createHarness({
            others: [[other, TextDocument.create(other, "rsl", 1, "Macro O()\nEnd;\n")]]
        });
        const document = harness.type();
        await harness.settle();
        assert.ok(harness.analysis.isLocalReady(document));

        harness.analysis.setActiveDocument(other);
        harness.analysis.setActiveDocument(harness.uri);

        assert.ok(
            harness.analysis.isLocalReady(document),
            "переключение вкладок не инвалидирует уже построенную модель"
        );
    });

    await test("серия Enter даёт один разбор, а не по одному на каждый", async () => {
        const harness = createHarness();
        let document;

        /* Пять переводов строки подряд быстрее, чем истекает debounce. */
        for (let index = 0; index < 5; index++) {
            document = harness.type();
        }

        await harness.settle();

        assert.deepStrictEqual(
            harness.parsedVersions,
            [`${harness.uri}@${document.version}`],
            "промежуточные версии разбирать незачем — их уже нет на экране"
        );
    });

    await test("фоновый разбор ждёт паузы, а не срока", async () => {
        /*
         * Фиксированная отсрочка означала, что разбор покинутого файла
         * стартует посреди работы в новом и отбирает у него процессор. Теперь
         * фон ждёт тишины: пока идёт ввод, он переносится.
         */
        const other = "file:///other.mac";
        const harness = createHarness({
            others: [[other, TextDocument.create(other, "rsl", 1, "Macro O()\nEnd;\n")]],
            inactiveParseDelayMs: 1,
            backgroundQuietMs: DEBOUNCE_MS * 3
        });
        const document = harness.type();
        harness.analysis.setActiveDocument(other);

        /* Пользователь продолжает работать в другом файле. */
        for (let stroke = 0; stroke < 4; stroke++) {
            await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS));
            harness.analysis.noteInteractiveActivity();
        }

        assert.deepStrictEqual(
            harness.parsedVersions,
            [],
            "пока идёт ввод, фоновый разбор не имеет права занимать процессор"
        );

        /* Тишина — работа продолжается сама. */
        await new Promise(resolve =>
            setTimeout(resolve, DEBOUNCE_MS * 8));

        assert.deepStrictEqual(
            harness.parsedVersions,
            [`${harness.uri}@${document.version}`],
            "на первой же паузе отложенный разбор обязан состояться"
        );
    });

    await test("прерванный разбор продолжается, а не начинается заново", async () => {
        /*
         * Большой файл разбирается фазами lex -> parse -> модель. Уход на
         * другую вкладку обрывает разбор между фазами, и раньше вся работа
         * выбрасывалась. Здесь проверяется, что после возвращения самая
         * дорогая фаза не считается второй раз.
         */
        const other = "file:///other.mac";
        const big = ["Macro Big()"];
        for (let index = 0; index < 4000; index++) {
            big.push(`  Var someRatherLongVariableName${index} = ${index};`);
        }
        big.push("End;");

        const uri = "file:///big.mac";
        const source = big.join("\n");
        assert.ok(source.length > 100_000, "нужен файл сверх порога фазового разбора");

        let document = TextDocument.create(uri, "rsl", 1, source);
        const others = new Map([
            [other, TextDocument.create(other, "rsl", 1, "Macro O()\nEnd;\n")]
        ]);
        const documents = {
            get: requested => requested === uri ? document : others.get(requested)
        };
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([uri, other]);

        const marks = [];
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
                /*
                 * Без склейки правок: перебор ниже считает возвраты управления
                 * от начала разбора, и debounce сдвигал бы отсчёт на время,
                 * за которое разбор успевает закончиться целиком.
                 */
                changeDebounceMs: 0,
                inactiveParseDelayMs: 0,
                /* Ожидание тишины здесь только мешало бы перебору. */
                backgroundQuietMs: 0,
                performance: {
                    enabled: false,
                    start: () => undefined,
                    end: () => undefined,
                    mark: (event, fields) => marks.push({ event, fields })
                }
            }
        );

        analysis.setActiveDocument(uri);
        analysis.open(document);

        /*
         * Момент паузы между фазами зависит от машины и от нагрузки, поэтому
         * он не угадывается, а перебирается: каждый заход правит текст заново
         * и уходит на другую вкладку через своё число тиков. Один из заходов
         * обязан попасть в паузу после parse — там и проверяется, что
         * продолжение берёт готовый результат.
         */
        for (let offset = 1; offset <= 12; offset++) {
            for (let tick = 0; tick < offset; tick++) {
                await new Promise(resolve => setImmediate(resolve));
            }

            analysis.setActiveDocument(other);
            await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS * 20));

            if (marks.some(item => item.event === "analysis.resumed")) {
                break;
            }

            assert.ok(
                analysis.isLocalReady(document),
                "разбор обязан довестись до конца, пусть и в фоне"
            );

            /* Следующий заход — новая версия и другое число тиков. */
            document = TextDocument.create(
                uri,
                "rsl",
                document.version + 1,
                `${source}\nMacro Extra${offset}()\nEnd;\n`
            );
            analysis.setActiveDocument(uri);
            analysis.changed(document);
        }

        analysis.setActiveDocument(uri);
        await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS * 20));

        assert.ok(
            analysis.isLocalReady(document),
            "разбор обязан довестись до конца, пусть и в фоне"
        );
        assert.ok(
            marks.some(item => item.event === "analysis.resumed"),
            "продолжение обязано брать готовый syntax, а не считать его заново"
        );
    });

    /*
     * ─── Completion без готовой модели ──────────────────────────────────────
     *
     * Пока модель строится, ответом был пустой список — то есть подсказка
     * выглядела так, будто в файле ничего не объявлено. Быстрый снимок даёт
     * приблизительный состав сразу.
     */

    await test("без модели Completion отдаёт состав из быстрого снимка", async () => {
        const source = [
            "Class Doc",
            "  Macro Save()",
            "  End;",
            "End;",
            "Macro Helper(param)",
            "  Var hidden = 1;",
            "End;",
            "Macro Test()",
            "  ",
            "End;"
        ].join("\n");
        const document = TextDocument.create("file:///fast.mac", "rsl", 1, source);
        const snapshot = createFastDocumentSnapshot(document);
        const inTest = source.lastIndexOf("  ") + 2;
        const labels = buildRslFastCompletions(snapshot, inTest)
            .map(item => item.label);

        assert.deepStrictEqual(
            labels,
            ["Doc", "Save", "Helper", "Test"],
            "классы, макропроцедуры и методы обязаны быть доступны сразу"
        );

        /* Параметр чужого Macro не предлагается: компилятор его здесь не видит. */
        const inHelper = source.indexOf("Var hidden");
        assert.ok(
            buildRslFastCompletions(snapshot, inHelper).some(
                item => item.label === "param"
            ),
            "внутри Helper его собственный параметр обязан предлагаться"
        );
        assert.ok(
            !buildRslFastCompletions(snapshot, inTest).some(
                item => item.label === "param"
            ),
            "внутри Test параметр Helper предлагаться не должен"
        );
    });

    await test("открытый файл не разбирается заново из-за watcher", async () => {
        /*
         * Собственное сохранение документа тоже даёт событие файловой системы.
         * Реакция на него означала полный повторный анализ файла, содержимое
         * которого не менялось: каждое Ctrl+S оплачивалось лексированием,
         * разбором, моделью и Problems.
         */
        const {
            shouldHandleWatchedFileChange
        } = require("../server/out/indexing/watchedFileRouting");
        const CREATED = 1;
        const CHANGED = 2;
        const DELETED = 3;

        assert.strictEqual(
            shouldHandleWatchedFileChange(CHANGED, true),
            false,
            "у открытого файла истина — буфер редактора, а не диск"
        );
        assert.strictEqual(
            shouldHandleWatchedFileChange(CREATED, true),
            false
        );
        assert.strictEqual(
            shouldHandleWatchedFileChange(CHANGED, false),
            true,
            "закрытый файл перечитать нужно"
        );
        assert.strictEqual(
            shouldHandleWatchedFileChange(DELETED, true),
            true,
            "удаление меняет разрешение имён у зависимых файлов"
        );
    });

    if (failed > 0) {
        console.error(`\nПройдено: ${passed}\nОшибок: ${failed}`);
        process.exitCode = 1;
    } else {
        console.log(`\nПройдено: ${passed}\nОшибок: ${failed}`);
    }
}

run();

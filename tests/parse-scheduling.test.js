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
function createHarness() {
    let document = TextDocument.create(URI, "rsl", 1, "Macro T()\nEnd;\n");
    const documents = { get: uri => (uri === URI ? document : undefined) };
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([URI]);

    const parsedAt = [];
    let mark = 0;
    const analysis = new DocumentAnalysisService(
        documents,
        index,
        { getAvailable: () => ({ imports: { enabled: false } }) },
        {
            log: () => undefined,
            invalidateProviderCaches: () => undefined,
            onParsed: () => parsedAt.push(Date.now() - mark),
            onImports: () => undefined,
            initialParseDelayMs: 0,
            changeDebounceMs: DEBOUNCE_MS
        }
    );

    analysis.setActiveDocument(URI);
    analysis.open(document);

    return {
        analysis,
        get document() {
            return document;
        },
        /** Пользователь набрал символ; отсчёт до разбора начинается заново. */
        type() {
            document = TextDocument.create(
                URI,
                "rsl",
                document.version + 1,
                `Macro T()\nEnd;\nMacro M${document.version}()\nEnd;\n`
            );
            parsedAt.length = 0;
            mark = Date.now();
            analysis.changed(document);
            return document;
        },
        async settle() {
            await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS * 4));
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

    if (failed > 0) {
        console.error(`\nПройдено: ${passed}\nОшибок: ${failed}`);
        process.exitCode = 1;
    } else {
        console.log(`\nПройдено: ${passed}\nОшибок: ${failed}`);
    }
}

run();

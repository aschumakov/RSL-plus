"use strict";

/**
 * Прерванный разбор продолжается, а не начинается заново.
 *
 * Большой файл разбирается фазами lex -> parse -> модель, и уход на другую
 * вкладку обрывает разбор между фазами. Проверка держится на настоящем
 * чередовании фаз и на файле больше 100 КБ, поэтому живёт отдельно от
 * быстрых проверок расписания: виртуальное время здесь не помогает, а
 * работа занимает секунды. Место такому тесту — в полном наборе.
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

/**
 * Прокручивает цикл событий, не сдвигая время.
 *
 * Нужен там, где проверяются ФАЗЫ разбора, а не задержки: фазы уступают
 * управление через setImmediate, и виртуальные часы им не помогут. Настоящее
 * ожидание тоже не нужно — достаточно дать циклу событий поработать.
 */
async function pumpTicks(count, until) {
    for (let index = 0; index < count; index++) {
        if (until && until()) {
            return;
        }

        await new Promise(resolve => setImmediate(resolve));
    }
}

async function run() {
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
        /*
         * Заходов больше, чем кажется нужным: под нагрузкой разбор успевает
         * закончиться до переключения вкладки, и пауза между фазами ловится
         * не с первой попытки. Лишние заходы стоят миллисекунды, ложное
         * падение — доверия к набору.
         */
        for (let offset = 1; offset <= 24; offset++) {
            for (let tick = 0; tick < offset; tick++) {
                await new Promise(resolve => setImmediate(resolve));
            }

            analysis.setActiveDocument(other);
            await pumpTicks(
                400,
                () => marks.some(item => item.event === "analysis.resumed") ||
                    analysis.isLocalReady(document)
            );

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
        await pumpTicks(400, () => analysis.isLocalReady(document));

        assert.ok(
            analysis.isLocalReady(document),
            "разбор обязан довестись до конца, пусть и в фоне"
        );
        assert.ok(
            marks.some(item => item.event === "analysis.resumed"),
            "продолжение обязано брать готовый syntax, а не считать его заново"
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

"use strict";

/**
 * Прерываемость тяжёлых расчётов.
 *
 * Прерываемость — это не проверка отмены сама по себе, а пауза перед ней. Пока
 * расчёт держит поток, ни отмена запроса, ни уведомление о смене активной
 * вкладки до сервера не доходят: проверять в этот момент нечего. Поэтому здесь
 * отмена наступает через setImmediate — ровно так, как её приносит транспорт.
 */

const assert = require("assert");

const { createWorkSlice } = require("../server/out/core/timeSlice");
const {
    buildLocalRslDiagnostics,
    buildLocalRslDiagnosticsChunked
} = require("../server/out/diagnostics");
const {
    buildRslSemanticTokens,
    buildRslSemanticTokensChunked
} = require("../server/out/semanticTokens");
const { RslScopeResolver } = require("../server/out/scopeResolver");
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

const MAIN = "file:///big.mac";

/** Файл, которого заведомо хватает больше чем на одну порцию. */
function largeSource(macroCount) {
    const parts = [];

    for (let index = 0; index < macroCount; index++) {
        parts.push(
            `Macro Handler${index}(argument${index})`,
            `  Var local${index} = argument${index} + ${index};`,
            `  Var second${index} = local${index} * 2;`,
            /* Неиспользуемое объявление: расчёту нужно что-то находить. */
            `  Var unused${index};`,
            `  local${index} = second${index} - local${index};`,
            "End;"
        );
    }

    return parts.join("\n");
}

function openLarge(macroCount = 900) {
    const source = largeSource(macroCount);
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([MAIN]);
    const module = index.updateOpenModule(MAIN, source, 1);
    return { index, module, resolver: new RslScopeResolver(index), source };
}

/** Отмена, которая наступает не сейчас, а на следующем витке event loop. */
function cancelOnNextTick() {
    let cancelled = false;
    setImmediate(() => {
        cancelled = true;
    });
    return () => cancelled;
}

async function main() {
    await test("порция возвращает управление и начинает отсчёт заново", async () => {
        const slice = createWorkSlice(5);

        assert.strictEqual(slice.shouldYield(), false);
        assert.strictEqual(slice.yieldCount, 0);

        /* Пауза без израсходованного бюджета не нужна и не происходит. */
        await slice.yieldIfNeeded();
        assert.strictEqual(slice.yieldCount, 0);

        const until = Date.now() + 12;
        while (Date.now() < until) {
            /* Занятое ожидание: так выглядит тяжёлый этап. */
        }

        assert.strictEqual(slice.shouldYield(), true);
        await slice.yieldIfNeeded();
        assert.strictEqual(slice.yieldCount, 1);
        /* После паузы бюджет отсчитывается с нуля. */
        assert.strictEqual(slice.shouldYield(), false);
    });

    await test("пауза пропускает уже назначенный setImmediate", async () => {
        const order = [];
        setImmediate(() => order.push("transport"));
        await createWorkSlice(1).yieldNow();
        order.push("resumed");

        assert.deepStrictEqual(
            order,
            ["transport", "resumed"],
            "Сообщение, стоящее в очереди, обязано пройти раньше продолжения " +
                "расчёта — иначе проверять отмену бессмысленно"
        );
    });

    await test("Semantic Tokens прерываются отменой во время расчёта", async () => {
        const context = openLarge();

        /* Полный расчёт нужен для сравнения: он заведомо непустой. */
        const complete = buildRslSemanticTokens(
            context.module,
            context.index,
            context.resolver
        );
        assert.ok(
            complete.data.length > 100,
            `Расчёт обязан быть заметным: ${complete.data.length}`
        );

        const interrupted = await buildRslSemanticTokensChunked(
            context.module,
            context.index,
            context.resolver,
            undefined,
            cancelOnNextTick()
        );
        assert.deepStrictEqual(
            interrupted.data,
            [],
            "Отменённый расчёт обязан вернуть пустой результат, а не доводиться " +
                "до конца"
        );

        /*
         * Синхронный расчёт наблюдать такую отмену не может: он не отдаёт
         * управление, а значит setImmediate до его конца не выполняется. Это
         * ровно та разница, ради которой появился порционный вариант.
         */
        const synchronous = buildRslSemanticTokens(
            context.module,
            context.index,
            context.resolver,
            undefined,
            cancelOnNextTick()
        );
        assert.deepStrictEqual(
            synchronous.data,
            complete.data,
            "Непрерываемый расчёт отмену через setImmediate не замечает"
        );
    });

    await test("Semantic Tokens без отмены считают то же самое порциями", async () => {
        const context = openLarge(300);
        const synchronous = buildRslSemanticTokens(
            context.module,
            context.index,
            context.resolver
        );
        const chunked = await buildRslSemanticTokensChunked(
            context.module,
            context.index,
            context.resolver
        );

        assert.deepStrictEqual(
            chunked.data,
            synchronous.data,
            "Прерываемый и непрерываемый расчёт обязаны совпадать: иначе " +
                "подсветка зависела бы от того, каким путём её посчитали"
        );
    });

    await test("Diagnostics прерываются отменой во время расчёта", async () => {
        const context = openLarge();
        const complete = buildLocalRslDiagnostics(
            context.module,
            context.index
        );
        assert.ok(
            complete.length > 0,
            "Расчёт обязан находить проблемы, иначе сравнивать нечего"
        );

        const interrupted = await buildLocalRslDiagnosticsChunked(
            context.module,
            context.index,
            undefined,
            cancelOnNextTick()
        );
        assert.ok(
            interrupted.length < complete.length,
            "Прерванный расчёт обязан остановиться на ближайшей границе: " +
                `получено ${interrupted.length} из ${complete.length}`
        );
    });

    await test("Diagnostics без отмены считают то же самое порциями", async () => {
        const context = openLarge(200);
        const synchronous = buildLocalRslDiagnostics(
            context.module,
            context.index
        );
        const chunked = await buildLocalRslDiagnosticsChunked(
            context.module,
            context.index
        );

        assert.deepStrictEqual(
            chunked.map(item => `${item.code}:${item.range.start.line}`),
            synchronous.map(item => `${item.code}:${item.range.start.line}`)
        );
    });

    await test(
        "порция не теряет проверки внутри одного объявления",
        async () => {
            /*
             * Проверки, которые обходят все вхождения имени, режутся на порции
             * по числу вхождений: на большом модуле весь этап уходил на ОДНО
             * объявление, имя которого встречается тысячи раз. Здесь вхождений
             * заведомо больше бюджета одной порции, поэтому продолжение с
             * середины объявления обязано дать тот же ответ, что и обход целиком.
             */
            const uses = Array.from(
                { length: 900 },
                () => "  counter = counter + 1;"
            ).join("\n");
            const source = [
                "Macro Long()",
                uses,
                "  Var counter = 0;",
                "  Var later = missing;",
                "  Var missing = 1;",
                "End;"
            ].join("\n");
            const uri = "file:///d:/resumable.mac";
            const index = new WorkspaceIndex();
            index.registerWorkspaceFiles([uri]);
            const module = index.updateOpenModule(uri, source, 1);

            const synchronous = buildLocalRslDiagnostics(module, index);
            const chunked = await buildLocalRslDiagnosticsChunked(
                module,
                index
            );
            const key = list => list
                .map(item => `${item.code}:${item.range.start.line}`)
                .sort();

            assert.deepStrictEqual(key(chunked), key(synchronous));
            assert.ok(
                synchronous.some(
                    item => item.code === "use-before-declaration"
                ),
                "Образец обязан содержать использование до объявления, иначе " +
                    "проверка сравнивала бы два пустых списка"
            );
        }
    );

    if (failed > 0) {
        console.error(`\nПройдено: ${passed}\nОшибок: ${failed}`);
        process.exitCode = 1;
    } else {
        console.log(`\nПройдено: ${passed}\nОшибок: ${failed}`);
    }
}

main();

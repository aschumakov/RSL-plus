"use strict";

/**
 * Один снимок документа — один список, независимо от источника.
 *
 * Подсказки собираются двумя путями: из быстрого индекса версии, пока полная
 * модель считается, и из модели, когда она готова. Пользователь этой разницы
 * знать не должен: для одного состояния документа состав и порядок обязаны
 * совпадать. Здесь это и сверяется — на прогретом и на холодном каталоге, до и
 * после появления модели, на завершённом и на набираемом обращении.
 */

const assert = require("assert");

const {
    PlatformModuleCatalog
} = require("../server/out/builtins/platformModuleCatalog");
const {
    createCompletionRegistry,
    completeAfter,
    orderedLabels
} = require("./completion-harness");

const MAIN = "file:///d:/differential/main.mac";

const SOURCE = [
    "Import RsbFormsInter;",
    "Macro Test()",
    "  Var Field7: TRsbEditField = TRsbEditField(7);",
    "  Field7.",
    "  Field7.set",
    "  /* Field7. в комментарии */",
    "  Var text = \"Field7.\";",
    "End;"
].join("\n");

let passed = 0;
let failed = 0;

async function test(name, action) {
    try {
        await action();
        passed++;
        console.log("[OK] " + name);
    } catch (error) {
        failed++;
        console.error("[FAIL] " + name);
        console.error(error);
    }
}

function stand(platform, modelReady) {
    return createCompletionRegistry({
        uri: MAIN,
        source: SOURCE,
        platform,
        modelReady
    });
}

const MEMBER_TRIGGER = { triggerKind: 2, triggerCharacter: "." };

async function main() {
    const platform = new PlatformModuleCatalog({ log: () => undefined });
    await platform.ensureModules(["RsbFormsInter"]);
    assert.ok(platform.ready, "каталог прикладных модулей не прочитан");

    await test("быстрый путь и полная модель дают один список", async () => {
        const fast = await completeAfter(
            stand(platform, false),
            "  Field7.",
            MEMBER_TRIGGER
        );
        const full = await completeAfter(
            stand(platform, true),
            "  Field7.",
            MEMBER_TRIGGER
        );

        assert.ok(fast.items.length > 0, "быстрый путь вернул пустой список");
        assert.deepStrictEqual(
            orderedLabels(fast),
            orderedLabels(full),
            "состав и порядок обязаны совпадать: пользователь не должен видеть " +
                "разницы между ответом до и после готовности модели"
        );
    });

    await test("оба ответа помечены полными", async () => {
        for (const modelReady of [false, true]) {
            const list = await completeAfter(
                stand(platform, modelReady),
                "  Field7.",
                MEMBER_TRIGGER
            );
            assert.strictEqual(
                list.isIncomplete,
                false,
                "список обязан быть полным при modelReady=" + modelReady
            );
        }
    });

    await test("прогретый каталог добавляет члены класса", async () => {
        const cold = new PlatformModuleCatalog({ log: () => undefined });
        const warm = await completeAfter(
            stand(platform, false),
            "  Field7.",
            MEMBER_TRIGGER
        );
        const coldList = await completeAfter(
            stand(cold, false),
            "  Field7.",
            MEMBER_TRIGGER
        );

        /*
         * На холодном каталоге членов ещё нет, и ответ пуст.
         *
         * Прежде здесь ожидался обычный список имён — и это было
         * неверно: после точки общих имён не бывает. Пустой ответ
         * приблизителен и спрашивается заново, как только каталог
         * прогреется; наполовину собранным он не бывает никогда.
         */
        assert.deepStrictEqual(
            coldList.items.map(item => item.label),
            [],
            "на холодном каталоге после точки показывать нечего"
        );
        assert.ok(
            warm.items.length > 0,
            "а прогретый обязан дать члены класса"
        );
        assert.notDeepStrictEqual(
            orderedLabels(coldList),
            orderedLabels(warm),
            "прогретый каталог обязан добавлять члены класса"
        );
    });

    await test("холодный каталог отвечает одинаково на повторный запрос", async () => {
        const cold = new PlatformModuleCatalog({ log: () => undefined });
        const first = await completeAfter(
            stand(cold, false),
            "  Field7.",
            MEMBER_TRIGGER
        );
        const again = await completeAfter(
            stand(cold, false),
            "  Field7.",
            MEMBER_TRIGGER
        );

        assert.deepStrictEqual(orderedLabels(again), orderedLabels(first));
    });

    await test("набранная часть имени меняет порядок, а не состав", async () => {
        /*
         * Две РАЗНЫЕ позиции одного документа: после точки и после точки с
         * набранным «set». Прежде тест дважды спрашивал одну и ту же позицию и
         * потому не проверял ничего.
         */
        const registry = stand(platform, true);
        const empty = await completeAfter(
            registry,
            "  Field7.",
            MEMBER_TRIGGER
        );
        const typed = await completeAfter(registry, "  Field7.set");

        assert.ok(typed.items.length > 0, "по набранному «set» список пуст");
        assert.deepStrictEqual(
            orderedLabels(empty).slice().sort(),
            orderedLabels(typed).slice().sort(),
            "состав не зависит от набранного"
        );
        assert.notDeepStrictEqual(
            orderedLabels(typed),
            orderedLabels(empty),
            "набранное обязано менять порядок"
        );
        assert.ok(
            /^set/i.test(orderedLabels(typed)[0]),
            "первым обязан идти член, начинающийся с набранного: " +
                orderedLabels(typed)[0]
        );
    });

    await test("в комментарии и в строке подсказок нет ни на одном пути", async () => {
        for (const modelReady of [false, true]) {
            const registry = stand(platform, modelReady);
            const comment = await completeAfter(
                registry,
                "  /* Field7.",
                MEMBER_TRIGGER
            );
            const string = await completeAfter(
                registry,
                "  Var text = \"Field7.",
                MEMBER_TRIGGER
            );

            assert.strictEqual(
                comment.items.length,
                0,
                "в комментарии подсказок нет, modelReady=" + modelReady
            );
            assert.strictEqual(
                string.items.length,
                0,
                "в строке подсказок нет, modelReady=" + modelReady
            );
        }
    });

    console.log("\nПройдено: " + passed + ", провалено: " + failed);

    if (failed > 0) {
        process.exitCode = 1;
    }
}

main();

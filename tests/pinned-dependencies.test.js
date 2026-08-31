"use strict";

/**
 * Зависимости открытых документов не вытесняются.
 *
 * Подсказки, Problems и переходы открытого файла считаются по его
 * зависимостям. Пока фоновая индексация читает проект, LRU внешних модулей
 * доходит до предела и выбрасывает самые старые записи — а самыми старыми
 * оказываются как раз зависимости того файла, который открыли первым. Ответ
 * становился неполным ровно тогда, когда пользователь в файле работает.
 *
 * Проверяется не «работает ли закрепление», а то, ради чего оно заведено:
 * состав ответа открытому файлу не должен зависеть от того, сколько всего
 * успела прочитать фоновая индексация.
 */

const assert = require("assert");

const serverModulePath = require.resolve("../server/out/server");

require.cache[serverModulePath] = {
    id: serverModulePath,
    filename: serverModulePath,
    loaded: true,
    exports: {
        getTree: () => [],
        GetFileByNameRequest: () => undefined
    }
};

const { WorkspaceIndex } = require("../server/out/workspaceIndex");

let passed = 0;
let failed = 0;

function test(name, action) {
    try {
        action();
        passed++;
        console.log("[OK] " + name);
    } catch (error) {
        failed++;
        console.error("[FAIL] " + name);
        console.error(error);
    }
}

const MAIN = "file:///d:/project/main.mac";
const A = "file:///d:/project/a.mac";
const B = "file:///d:/project/b.mac";
const DEEP = "file:///d:/project/deep.mac";

/** Проект с маленьким пределом внешних модулей. */
function project(options = {}) {
    const index = new WorkspaceIndex({
        maxExternalModules: options.limit ?? 3
    });
    const background = [];

    for (let number = 0; number < 40; number++) {
        background.push("file:///d:/project/back" + number + ".mac");
    }

    index.registerWorkspaceFiles([MAIN, A, B, DEEP, ...background]);

    return {
        index,
        background,
        /** Фоновое чтение проекта: столько файлов, сколько попросят. */
        loadBackground(count) {
            for (let number = 0; number < count; number++) {
                index.updateExternalModule(
                    background[number],
                    "Macro Back" + number + "()\nEnd;\n",
                    1
                );
            }
        },
        /** Виден ли модуль открытому документу. */
        sees(uri) {
            return !!index.getModule(uri);
        },
        /** Разрешается ли имя из зависимости открытого файла. */
        resolves(name) {
            return index.findImportedSymbols(MAIN, name).length > 0;
        }
    };
}

test("зависимости открытого файла переживают обход проекта", () => {
    const board = project();

    board.index.updateExternalModule(A, "Macro FromA()\nEnd;\n", 1);
    board.index.updateExternalModule(B, "Macro FromB()\nEnd;\n", 1);
    board.index.updateOpenModule(
        MAIN,
        "Import a, b;\n\nMacro Run()\n  FromA();\n  FromB();\nEnd;\n",
        1
    );

    assert.ok(board.resolves("FromA"), "до обхода зависимость видна");
    assert.ok(board.resolves("FromB"), "и вторая тоже");

    /* Фон читает вчетверо больше файлов, чем помещается в предел. */
    board.loadBackground(12);

    assert.ok(
        board.sees(A),
        "зависимость a не имеет права быть вытесненной"
    );
    assert.ok(
        board.sees(B),
        "зависимость b тоже"
    );
    assert.ok(
        board.resolves("FromA") && board.resolves("FromB"),
        "ответ открытому файлу остался полным"
    );
});

test("транзитивная зависимость закреплена наравне с прямой", () => {
    const board = project();

    board.index.updateExternalModule(DEEP, "Macro FromDeep()\nEnd;\n", 1);
    board.index.updateExternalModule(A, "Import deep;\nMacro FromA()\nEnd;\n", 1);
    board.index.updateOpenModule(
        MAIN,
        "Import a;\n\nMacro Run()\n  FromA();\nEnd;\n",
        1
    );

    board.loadBackground(12);

    assert.ok(board.sees(A), "прямая зависимость на месте");
    assert.ok(
        board.sees(DEEP),
        "зависимость зависимости тоже: её видит тот же Import-контекст"
    );
});

test("зависимость, загруженная после открытия, закрепляется", () => {
    const board = project();

    /* Файл открыт раньше, чем прочитана его зависимость. */
    board.index.updateOpenModule(
        MAIN,
        "Import a;\n\nMacro Run()\n  FromA();\nEnd;\n",
        1
    );
    board.loadBackground(6);
    board.index.updateExternalModule(A, "Macro FromA()\nEnd;\n", 1);
    board.loadBackground(12);

    assert.ok(
        board.sees(A),
        "дочитанная зависимость обязана попасть под закрепление"
    );
});

test("закрытие документа снимает закрепление", () => {
    const board = project();

    board.index.updateExternalModule(A, "Macro FromA()\nEnd;\n", 1);
    board.index.updateOpenModule(MAIN, "Import a;\nMacro Run()\nEnd;\n", 1);
    board.loadBackground(12);

    assert.ok(board.sees(A), "пока файл открыт, зависимость держится");

    board.index.markClosed(MAIN);
    board.index.compactModule(MAIN);
    board.loadBackground(24);

    assert.ok(
        !board.sees(A),
        "после закрытия зависимость снова обычная и вытесняется"
    );
});

test("закрытие в порядке сервера сразу возвращает проект в предел", () => {
    /*
     * Порядок вызовов ровно как на сервере: сначала compactModule из
     * DocumentAnalysisService.close, потом markClosed.
     *
     * Проверяется итог, а не механизм: после закрытия ничего не закреплено и
     * проект в пределе. Пересчёт пределов вынесен в отдельный метод и зовётся
     * при любой смене закрепления — прежде он жил только внутри загрузки
     * модуля, и снятие закрепления пределов не пересчитывало.
     *
     * Состояния «осталось больше предела» на этом стенде воспроизвести не
     * удалось: compactModule успевает снять закрепление сам. Проверка стоит
     * как страховка на итог, а не как воспроизведение ошибки.
     */
    const board = project({ limit: 2 });

    /* От конца цепочки к началу: так сводка каждого модуля видит свой Import. */
    board.index.updateExternalModule(DEEP, "Macro FromDeep()\nEnd;\n", 1);
    board.index.updateExternalModule(
        B,
        "Import deep;\nMacro FromB()\nEnd;\n",
        1
    );
    board.index.updateExternalModule(A, "Import b;\nMacro FromA()\nEnd;\n", 1);
    board.index.updateOpenModule(MAIN, "Import a;\nMacro Run()\nEnd;\n", 1);

    assert.strictEqual(
        board.index.pinnedModuleCount,
        3,
        "вся цепочка закреплена, и её больше предела"
    );

    board.index.compactModule(MAIN);
    board.index.markClosed(MAIN);

    const alive = [MAIN, A, B, DEEP].filter(uri => board.sees(uri)).length;

    assert.strictEqual(
        board.index.pinnedModuleCount,
        0,
        "закрытый документ никого не удерживает"
    );
    assert.ok(
        alive <= board.index.externalModuleLimit,
        "предел " + board.index.externalModuleLimit +
            ", а осталось сводок " + alive
    );
});

test("выключение и включение Import пересчитывают закрепление", () => {
    const board = project({ limit: 2 });

    board.index.updateExternalModule(A, "Macro FromA()\nEnd;\n", 1);
    board.index.updateOpenModule(MAIN, "Import a;\nMacro Run()\nEnd;\n", 1);

    const pinned = board.index.pinnedModuleCount;

    assert.ok(pinned > 0, "зависимость открытого файла закреплена");

    /*
     * Выключение обязано отпустить прежнее замыкание сразу. Прежде оно
     * оставалось закреплённым и держало проект над пределом, а включение не
     * строило новое до следующей правки документа.
     */
    board.index.setImportsEnabled(false);

    assert.strictEqual(
        board.index.pinnedModuleCount,
        0,
        "при выключенных Import закреплять нечего"
    );

    board.index.setImportsEnabled(true);

    assert.strictEqual(
        board.index.pinnedModuleCount,
        pinned,
        "включение строит замыкание заново, не дожидаясь правки"
    );
});

test("смена Import отпускает прежнюю зависимость", () => {
    const board = project();

    /* Порядок как в жизни: сначала открыли файл, потом дочитали зависимость. */
    board.index.updateOpenModule(MAIN, "Import a;\nMacro Run()\nEnd;\n", 1);
    board.index.updateExternalModule(A, "Macro FromA()\nEnd;\n", 1);
    board.loadBackground(12);

    assert.ok(board.sees(A), "пока импортирована — держится");

    /* Import переписан на другой модуль, и он дочитан следом. */
    board.index.updateOpenModule(MAIN, "Import b;\nMacro Run()\nEnd;\n", 2);
    board.index.updateExternalModule(B, "Macro FromB()\nEnd;\n", 1);
    board.loadBackground(24);

    assert.ok(board.sees(B), "новая зависимость закреплена");
    assert.ok(
        !board.sees(A),
        "прежняя больше не удерживается и вытесняется как обычная"
    );
});

test("закрепление не отменяет вытеснение вовсе", () => {
    /*
     * Закреплённых модулей может оказаться больше предела. Тогда вытеснение
     * прекращается — но именно прекращается, а не начинает выбрасывать
     * нужное: выбросить и тут же прочитать заново означало бы бесконечный
     * круг.
     */
    const board = project({ limit: 2 });

    board.index.updateOpenModule(
        MAIN,
        "Import a, b, deep;\nMacro Run()\nEnd;\n",
        1
    );
    board.index.updateExternalModule(A, "Macro FromA()\nEnd;\n", 1);
    board.index.updateExternalModule(B, "Macro FromB()\nEnd;\n", 1);
    board.index.updateExternalModule(DEEP, "Macro FromDeep()\nEnd;\n", 1);
    board.loadBackground(20);

    assert.ok(
        board.sees(A) && board.sees(B) && board.sees(DEEP),
        "все три зависимости обязаны остаться"
    );
    assert.strictEqual(
        board.index.pinnedModuleCount,
        4,
        "закреплены сам документ и три его зависимости"
    );

    /* А незакреплённые всё-таки вытесняются: предел работает. */
    const loaded = board.background
        .slice(0, 20)
        .filter(uri => board.sees(uri)).length;

    assert.ok(
        loaded < 20,
        "фоновые модули обязаны вытесняться: осталось " + loaded + " из 20"
    );
});

if (failed > 0) {
    console.error("\nПройдено: " + passed + "\nОшибок: " + failed);
    process.exitCode = 1;
} else {
    console.log("\nПройдено: " + passed + "\nОшибок: " + failed);
}

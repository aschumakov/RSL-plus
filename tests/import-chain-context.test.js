"use strict";

/**
 * Длинная цепочка Import и выводы по неполному контексту.
 *
 * Проверка «модуль не используется» делает вывод из ОТСУТСТВИЯ имени, и
 * потому обязана знать, всё ли она видела. Полнота документа целиком для
 * этого не годится:
 *
 *     main -> A -> B -> C -> D -> E
 *
 * Пока E дочитывается, объявить `Import A` неиспользуемым нельзя: имя,
 * которым A оправдан, лежит как раз в непрочитанном. При этом непрозрачный
 * СОСЕДНИЙ Import не должен выключать проверку целиком — у каждого прямого
 * Import полнота своя.
 *
 * Допустимо временное отсутствие положительного ответа. Недопустим ложный
 * отрицательный вывод: «Import не используется», «члена нет», «символа нет»,
 * пока контекст не полон.
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
const {
    resolveRslImportContext,
    isRslDirectImportComplete
} = require("../server/out/analysis/resolvedImportContext");
const {
    createUnusedImportStage
} = require("../server/out/diagnostics/importChecks");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { getDefaults } = require("../server/out/defaults");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const ROOT = "file:///d:/chain/";
const MAIN = ROOT + "main.mac";

/** Цепочка A -> B -> C -> D -> E; каждый объявляет своё имя. */
const CHAIN = ["a", "b", "c", "d", "e"];

function uriOf(name) {
    return ROOT + name + ".mac";
}

function sourceOf(name, next) {
    return (next ? "Import " + next + ";\n" : "") +
        "Macro " + name.toUpperCase() + "Name()\n  return 1;\nEnd;\n";
}

/**
 * Стенд: main подключает A, загружено `loaded` первых звеньев цепочки.
 *
 * `usesDeep` — main вызывает имя из последнего звена: тогда Import оправдан,
 * но узнать об этом можно только дочитав цепочку.
 */
function stand(loaded, usesDeep) {
    const index = new WorkspaceIndex();
    const uris = [MAIN, ...CHAIN.map(uriOf)];

    index.registerWorkspaceFiles(uris);

    for (let at = 0; at < loaded; at++) {
        index.updateExternalModule(
            uriOf(CHAIN[at]),
            sourceOf(CHAIN[at], CHAIN[at + 1]),
            1
        );
    }

    const body = usesDeep
        ? "  return ENAME();\n"
        : "  return 1;\n";
    const module = index.updateOpenModule(
        MAIN,
        "Import a;\nMacro Run()\n" + body + "End;\n",
        1
    );

    return { index, module };
}

/**
 * Имена модулей, про которые сказано «не используется».
 *
 * Прогоняется настоящий этап целиком: он не только собирает контекст, но и
 * помечает использованные имена, обходя все идентификаторы файла. Без
 * пометки любой Import выглядит неиспользуемым.
 */
function unusedNames(index, module) {
    const result = [];
    const resolver = new RslScopeResolver(index, getDefaults());
    const stage = createUnusedImportStage(module, index, resolver, result);

    /* Этап возвращает true, пока не закончил: крутим до false. */
    while (stage(() => false, () => false) === true) {
        /* порция за порцией */
    }

    return result
        .map(item => String(item.data.moduleName))
        .map(name => name.toLowerCase().endsWith(".mac")
            ? name.slice(0, -4)
            : name);
}

test("недочитанная цепочка не даёт вывода «не используется»", () => {
    /*
     * Загружено только A: что лежит за ним, сервер ещё не видел. Сказать «A не
     * используется» в этот момент значит соврать — и именно так и было.
     */
    const { index, module } = stand(1, true);
    const context = resolveRslImportContext(index, MAIN, {});
    const direct = context.directImports[0];

    assert.strictEqual(direct.name, "a");
    assert.ok(
        !isRslDirectImportComplete(direct),
        "контекст Import a обязан быть неполным, а он " + direct.completeness
    );
    assert.deepStrictEqual(
        unusedNames(index, module),
        [],
        "по неполной цепочке вывод делать нельзя"
    );
});

test("дочитанная цепочка даёт вывод", () => {
    /*
     * Вся цепочка прочитана, и ни одно её имя не использовано: теперь вывод
     * доказуем.
     */
    const { index, module } = stand(CHAIN.length, false);
    const context = resolveRslImportContext(index, MAIN, {});

    assert.ok(
        isRslDirectImportComplete(context.directImports[0]),
        "полная цепочка обязана давать complete: " +
            context.directImports[0].completeness
    );
    assert.deepStrictEqual(
        unusedNames(index, module),
        ["a"],
        "неиспользуемый Import обязан находиться"
    );
});

test("использованное имя из глубины цепочки оправдывает Import", () => {
    const { index, module } = stand(CHAIN.length, true);

    assert.deepStrictEqual(
        unusedNames(index, module),
        [],
        "имя из последнего звена оправдывает Import первого"
    );
});

test("замыкание прямого Import включает всю цепочку", () => {
    const { index } = stand(CHAIN.length, false);
    const context = resolveRslImportContext(index, MAIN, {});

    assert.strictEqual(
        context.directImports[0].closureUris.size,
        CHAIN.length,
        "в замыкании обязаны быть все пять звеньев: " +
            [...context.directImports[0].closureUris].join(", ")
    );
});

test("непрозрачный сосед не выключает проверку целиком", () => {
    /*
     * Существенное: полнота считается для КАЖДОГО прямого Import отдельно.
     * Прежде хватало одного непонятного имени, чтобы замолчало всё.
     */
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN, uriOf("a")]);
    index.updateExternalModule(uriOf("a"), sourceOf("a", undefined), 1);

    const module = index.updateOpenModule(
        MAIN,
        "Import a;\nImport НетТакогоМодуля;\nMacro Run()\n  return 1;\nEnd;\n",
        1
    );
    const context = resolveRslImportContext(index, MAIN, {});
    const byName = new Map(context.directImports.map(item =>
        [item.name.toLowerCase(), item]));
    const stranger = context.directImports.find(item =>
        item.kind === "missing");

    assert.ok(stranger, "ненайденный модуль обязан быть в списке");
    assert.strictEqual(
        stranger.completeness,
        "opaque",
        "источник имени непрозрачен, и это отдельное состояние"
    );
    assert.ok(
        isRslDirectImportComplete(byName.get("a")),
        "а у соседа рядом полнота своя: " + byName.get("a").completeness
    );
    assert.deepStrictEqual(
        unusedNames(index, module),
        ["a"],
        "проверка обязана сработать по полному Import, несмотря на соседа"
    );
});

test("прямые Import перечислены в порядке написания", () => {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN, uriOf("a"), uriOf("b")]);
    index.updateExternalModule(uriOf("a"), sourceOf("a", undefined), 1);
    index.updateExternalModule(uriOf("b"), sourceOf("b", undefined), 1);
    index.updateOpenModule(
        MAIN,
        "Import b;\nImport a;\nMacro Run()\n  return 1;\nEnd;\n",
        1
    );

    const context = resolveRslImportContext(index, MAIN, {});

    assert.deepStrictEqual(
        context.directImports.map(item => item.name),
        ["b", "a"]
    );
    assert.strictEqual(
        context.visibleWorkspaceModules.length,
        2,
        "оба модуля видимы"
    );
});

(async () => {
    for (const item of tests) {
        try {
            await item.action();
            passed++;
            console.log("[OK] " + item.name);
        } catch (error) {
            failed++;
            console.error("[FAIL] " + item.name);
            console.error(error);
        }
    }

    console.log(
        failed === 0
            ? "\nПройдено: " + passed
            : "\nПройдено: " + passed + ", провалено: " + failed
    );

    if (failed > 0) {
        process.exitCode = 1;
    }
})();

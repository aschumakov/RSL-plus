"use strict";

/**
 * Импортированные символы Completion собираются один раз.
 *
 * На пути полной модели их добавлял resolver — и следом второй раз собирал
 * ambient-слой: обходил цепочку Import заново, проходил публичные символы
 * каждого модуля и создавал элементы, которые тут же выбрасывались общей
 * дедупликацией. Ответ был верный, работа делалась дважды.
 *
 * Здесь проверяется, что состав и порядок списка от этого не изменились:
 * местное имя побеждает импортированное, встроенное — импортированное, а два
 * модуля с одинаковым именем не превращаются в одну строку молча.
 *
 * Быстрому пути второй сбор по-прежнему нужен: полной модели текущей версии
 * там ещё нет.
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
const { RslScopeResolver } = require("../server/out/scopeResolver");
const {
    collectRslCompletionCandidates
} = require("../server/out/features/completionCandidates");
const {
    buildRslContextCompletions
} = require("../server/out/features/contextCompletionProvider");

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

const MAIN = "file:///d:/completion/main.mac";

/**
 * Список пути полной модели.
 *
 * Собирается ровно теми же частями, что и в провайдере: видимые имена от
 * resolver, ambient-слой и общая дедупликация. Ambient здесь — только
 * встроенные значения, как и в модели.
 */
function modelCandidates(source, library = {}, builtins = [], offset) {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN, ...Object.keys(library)]);

    for (const [uri, text] of Object.entries(library)) {
        index.updateExternalModule(uri, text, 1);
    }

    const module = index.updateOpenModule(MAIN, source, 1);
    const resolver = new RslScopeResolver(index);
    const at = offset === undefined ? source.indexOf("/*тут*/") : offset;
    const names = () => resolver.getCompletions(MAIN, module.symbolTree, at);

    return collectRslCompletionCandidates({
        name: "model",
        blockedPosition: () => false,
        contextCandidates: () => buildRslContextCompletions(
            module,
            index,
            at,
            resolver
        ),
        memberCandidates: () => undefined,
        visibleCandidates: names,
        ambientCandidates: () => builtins,
        searchCandidates: () => ({ items: [], truncated: false })
    });
}

/** Строки списка с указанием источника: по detail видно, откуда символ. */
function labelled(result, name) {
    return result.candidates
        .filter(item => String(item.label).toLowerCase() === name.toLowerCase())
        .map(item => ({ label: item.label, detail: item.detail }));
}

const LIBRARY = {
    "file:///d:/completion/alpha.mac":
        "Macro SharedName()\n  return 1;\nEnd;\n\n" +
        "Macro AlphaOnly()\n  return 1;\nEnd;\n",
    "file:///d:/completion/beta.mac":
        "Macro SharedName()\n  return 2;\nEnd;\n\n" +
        "Macro BetaOnly()\n  return 2;\nEnd;\n"
};

test("импортированный символ попадает в список один раз", () => {
    const result = modelCandidates(
        "Import alpha;\n\nMacro Run()\n  /*тут*/\nEnd;\n",
        { "file:///d:/completion/alpha.mac": LIBRARY[
            "file:///d:/completion/alpha.mac"
        ] }
    );

    assert.strictEqual(
        labelled(result, "AlphaOnly").length,
        1,
        "импортированный символ обязан быть ровно одной строкой"
    );
});

test("местное имя побеждает одноимённое импортированное", () => {
    const result = modelCandidates(
        "Import alpha;\n\nMacro SharedName()\n  return 0;\nEnd;\n\n" +
        "Macro Run()\n  /*тут*/\nEnd;\n",
        { "file:///d:/completion/alpha.mac": LIBRARY[
            "file:///d:/completion/alpha.mac"
        ] }
    );
    const found = labelled(result, "SharedName");

    assert.strictEqual(found.length, 1, "строка обязана быть одна");
    /*
     * У местного объявления в detail описание подписи, у импортированного —
     * имя файла, откуда оно пришло. По этому и видно, кто победил.
     */
    assert.ok(
        !String(found[0].detail || "").includes(".mac"),
        "победить обязано местное объявление, а не импортированное: " +
        JSON.stringify(found[0])
    );
});

test("встроенное имя не вытесняет импортированное и наоборот", () => {
    const builtin = { label: "AlphaOnly", kind: 3, detail: "встроенное" };
    const result = modelCandidates(
        "Import alpha;\n\nMacro Run()\n  /*тут*/\nEnd;\n",
        { "file:///d:/completion/alpha.mac": LIBRARY[
            "file:///d:/completion/alpha.mac"
        ] },
        [builtin]
    );
    const found = labelled(result, "AlphaOnly");

    assert.strictEqual(found.length, 1, "одноимённые дают одну строку");
    assert.notStrictEqual(
        found[0].detail,
        "встроенное",
        "импортированное имя видно из области видимости и потому важнее"
    );
});

test("два Import с одинаковым именем дают одну строку", () => {
    const result = modelCandidates(
        "Import alpha;\nImport beta;\n\nMacro Run()\n  /*тут*/\nEnd;\n",
        LIBRARY
    );
    const found = labelled(result, "SharedName");

    assert.strictEqual(
        found.length,
        1,
        "одинаковое имя из двух модулей — одна строка: " +
        JSON.stringify(found)
    );
    /* И оба модуля при этом видны своими собственными именами. */
    assert.strictEqual(labelled(result, "AlphaOnly").length, 1);
    assert.strictEqual(labelled(result, "BetaOnly").length, 1);
});

test("транзитивный Import тоже виден", () => {
    const result = modelCandidates(
        "Import alpha;\n\nMacro Run()\n  /*тут*/\nEnd;\n",
        {
            "file:///d:/completion/alpha.mac":
                "Import deep;\nMacro AlphaOnly()\nEnd;\n",
            "file:///d:/completion/deep.mac": "Macro DeepOnly()\nEnd;\n"
        }
    );

    assert.strictEqual(
        labelled(result, "DeepOnly").length,
        1,
        "символ из цепочки обязан остаться в списке"
    );
});

test("после точки предлагаются только члены", () => {
    const source = "Import alpha;\n\nMacro Run()\n  Var thing;\n" +
        "  thing.\nEnd;\n";
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN, "file:///d:/completion/alpha.mac"]);
    index.updateExternalModule(
        "file:///d:/completion/alpha.mac",
        LIBRARY["file:///d:/completion/alpha.mac"],
        1
    );

    const module = index.updateOpenModule(MAIN, source, 1);
    const resolver = new RslScopeResolver(index);
    const at = source.indexOf("thing.") + "thing.".length;
    const names = () => resolver.getCompletions(MAIN, module.symbolTree, at);
    const result = collectRslCompletionCandidates({
        name: "model",
        blockedPosition: () => false,
        contextCandidates: () => [],
        /* Признак обращения: после точки предлагаются члены. */
        memberCandidates: () => names(),
        visibleCandidates: names,
        ambientCandidates: () => [{ label: "ВстроенноеЗначение", kind: 21 }],
        searchCandidates: () => ({ items: [], truncated: false })
    });

    assert.strictEqual(
        labelled(result, "AlphaOnly").length,
        0,
        "импортированные имена после точки не предлагаются"
    );
    assert.strictEqual(
        labelled(result, "ВстроенноеЗначение").length,
        0,
        "и встроенные тоже"
    );
});

console.log(
    failed === 0
        ? "\nПройдено: " + passed
        : "\nПройдено: " + passed + ", провалено: " + failed
);

if (failed > 0) {
    process.exitCode = 1;
}

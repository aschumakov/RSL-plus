"use strict";

/**
 * Четыре действия над секцией Import и договор реестра рефакторингов.
 *
 * Что проверяется помимо самих правок: действие не считает правку, пока его не
 * выбрали; правка не применяется к документу, который успели изменить;
 * повторное применение ничего не меняет; удаление молчит, пока хоть один
 * Import файла не разрешился.
 *
 * Форма объявления и написание пути сохраняются, и это не косметика. На
 * проекте макросов 2463 объявления из 5867 перечисляют несколько модулей (до
 * 27 в одном), 1810 элементов из 14014 записаны строкой в кавычках, 1761 — с
 * расширением .mac. Действие, приводящее всё это к одному виду, переписало бы
 * половину проекта.
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
    createRslRefactorRegistry
} = require("../server/out/features/refactorRegistry");
const {
    RSL_IMPORT_ACTION_KINDS,
    RSL_IMPORT_REFACTORS,
    findMissingRslImports,
    findUnusedRslImports,
    rslImportContextIsComplete
} = require("../server/out/features/importSourceActions");
const {
    planRslImports
} = require("../server/out/features/organizeImports");

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

const MAIN = "file:///d:/org/main.mac";

/** Индекс с главным файлом и, при надобности, зависимостями. */
function open(source, library = {}) {
    const index = new WorkspaceIndex();
    const uris = [MAIN, ...Object.keys(library)];

    index.registerWorkspaceFiles(uris);

    for (const [uri, text] of Object.entries(library)) {
        index.updateExternalModule(uri, text, 1);
    }

    return { index, module: index.updateOpenModule(MAIN, source, 1) };
}

/** Применить правки к тексту: с конца, чтобы смещения не разъезжались. */
function applyEdits(module, source, edits) {
    const offsetAt = position =>
        module.lex.lineStarts[position.line] + position.character;
    const ordered = [...edits].sort((left, right) =>
        offsetAt(right.range.start) - offsetAt(left.range.start));
    let result = source;

    for (const edit of ordered) {
        result = result.slice(0, offsetAt(edit.range.start)) +
            edit.newText +
            result.slice(offsetAt(edit.range.end));
    }

    return result;
}

/** Текст после действия реестра. */
function run(source, kind, library) {
    const { index, module } = open(source, library);
    const registry = createRslRefactorRegistry(RSL_IMPORT_REFACTORS);
    const context = {
        module,
        index,
        start: 0,
        end: 0,
        options: {},
        isCancelled: () => false
    };
    const actions = registry.build(context, [kind]);

    if (actions.length === 0) {
        return { text: source, offered: false };
    }

    const resolved = registry.resolve(actions[0], () => module, index, {});
    const edits = resolved.edit?.changes?.[MAIN] || [];

    return {
        text: applyEdits(module, source, edits),
        offered: true,
        title: actions[0].title
    };
}

/** Текст после прямого плана: так проверяются правила перестройки. */
function plan(source, options) {
    const { module } = open(source);

    return applyEdits(module, source, planRslImports(module, options));
}

/* ── Перестройка секции ─────────────────────────────────────────────────── */

test("сортировка убирает повторы и упорядочивает", () => {
    assert.strictEqual(
        plan(
            "Import utils, alpha;\nImport beta;\nImport alpha;\n\nMacro Run()\nEnd;\n",
            { sort: true }
        ),
        "Import alpha, utils;\nImport beta;\n\nMacro Run()\nEnd;\n"
    );
});

test("написание пути сохраняется", () => {
    assert.strictEqual(
        plan(
            "Import \"zeta.mac\";\nImport alpha;\n\nMacro Run()\nEnd;\n",
            { sort: true }
        ),
        "Import alpha;\nImport \"zeta.mac\";\n\nMacro Run()\nEnd;\n",
        "кавычки и расширение остаются такими, как их написали"
    );
});

test("комментарий между объявлениями разрывает группу", () => {
    const source =
        "Import zeta;\n// расчёты\nImport gamma;\nImport alpha;\n\nMacro Run()\nEnd;\n";

    assert.strictEqual(
        plan(source, { sort: true }),
        "Import zeta;\n// расчёты\nImport alpha;\nImport gamma;\n\nMacro Run()\nEnd;\n",
        "переставляется только то, что лежит по одну сторону комментария"
    );
});

test("пустая строка разрывает группу", () => {
    const source = "Import zeta;\n\nImport alpha;\n\nMacro Run()\nEnd;\n";

    assert.strictEqual(
        plan(source, { sort: true }),
        source,
        "автор разделил группы сам"
    );
});

test("объявление с чужим текстом на строке не переставляется", () => {
    const source =
        "Import zeta; // отчёт\nImport alpha;\n\nMacro Run()\nEnd;\n";

    assert.strictEqual(plan(source, { sort: true }), source);
});

test("комментарий внутри списка элементов оставляет порядок", () => {
    const source = "Import zeta, /* потом */ alpha;\n\nMacro Run()\nEnd;\n";

    assert.strictEqual(plan(source, { sort: true }), source);
});

test("многострочное объявление не склеивается в строку", () => {
    const source = [
        "import ",
        "       zeta,",
        "       alpha;",
        "",
        "Macro Run()",
        "End;",
        ""
    ].join("\n");

    assert.strictEqual(
        plan(source, { sort: true }),
        source,
        "автор разложил список по строкам сам"
    );
});

test("из многострочного объявления элемент вырезается с запятой", () => {
    assert.strictEqual(
        plan(
            "import \n       zeta,\n       alpha;\n\nMacro Run()\nEnd;\n",
            { remove: new Set(["zeta"]) }
        ),
        "import \n       alpha;\n\nMacro Run()\nEnd;\n"
    );
});

test("комментарий перед точкой с запятой сохраняется", () => {
    const source = [
        "import ExchangeInter /*, \"rstrfunc.mac\"*/;",
        "import alpha;",
        "",
        "Macro Run()",
        "End;",
        ""
    ].join("\n");

    assert.strictEqual(
        plan(source, { sort: true }),
        source,
        "закомментированный хвост списка — тоже комментарий"
    );
});

test("удаление элемента и опустевшей строки", () => {
    assert.strictEqual(
        plan(
            "Import alpha, beta, gamma;\nImport delta;\n\nMacro Run()\nEnd;\n",
            { remove: new Set(["beta", "delta"]) }
        ),
        "Import alpha, gamma;\n\nMacro Run()\nEnd;\n"
    );
});

test("добавление в файл без Import", () => {
    assert.strictEqual(
        plan("Macro Run()\nEnd;\n", { add: ["alpha"] }),
        "Import alpha;\nMacro Run()\nEnd;\n"
    );
});

test("добавление встаёт на своё место при сортировке", () => {
    assert.strictEqual(
        plan(
            "Import beta;\nImport delta;\n\nMacro Run()\nEnd;\n",
            { sort: true, add: ["alpha", "gamma"] }
        ),
        "Import alpha;\nImport beta;\nImport delta;\nImport gamma;\n\nMacro Run()\nEnd;\n"
    );
});

test("CRLF сохраняется", () => {
    assert.strictEqual(
        plan(
            "Import beta;\r\nImport alpha;\r\n\r\nMacro Run()\r\nEnd;\r\n",
            { sort: true }
        ),
        "Import alpha;\r\nImport beta;\r\n\r\nMacro Run()\r\nEnd;\r\n"
    );
});

test("отступ объявления сохраняется", () => {
    assert.strictEqual(
        plan("  Import beta;\n  Import alpha;\n\nMacro Run()\nEnd;\n", {
            sort: true
        }),
        "  Import alpha;\n  Import beta;\n\nMacro Run()\nEnd;\n"
    );
});

test("уже упорядоченная секция правок не даёт", () => {
    const { module } = open("Import alpha;\nImport beta;\n\nMacro Run()\nEnd;\n");

    assert.deepStrictEqual(planRslImports(module, { sort: true }), []);
});

test("повторное применение ничего не меняет", () => {
    const source =
        "Import utils, alpha;\nImport beta;\nImport alpha;\n\nMacro Run()\nEnd;\n";
    const once = plan(source, { sort: true });

    assert.strictEqual(plan(once, { sort: true }), once);
});

/* ── Что считают действия ───────────────────────────────────────────────── */

const LIBRARY = {
    "file:///d:/org/alpha.mac": "Macro AlphaOne()\n  return 1;\nEnd;\n",
    "file:///d:/org/beta.mac": "Macro BetaOne()\n  return 1;\nEnd;\n"
};

test("неиспользуемый Import находится", () => {
    const { index, module } = open(
        "Import alpha;\nImport beta;\n\nMacro Run()\n  return AlphaOne();\nEnd;\n",
        LIBRARY
    );

    assert.ok(
        rslImportContextIsComplete(module, index),
        "оба модуля проекта разобраны"
    );
    assert.deepStrictEqual(
        [...findUnusedRslImports(module, index)],
        ["beta"]
    );
});

test("удаление не предлагается при неполном контексте", () => {
    const { index, module } = open(
        "Import alpha;\nImport нетакогомодуля;\n\nMacro Run()\n  return AlphaOne();\nEnd;\n",
        LIBRARY
    );

    assert.strictEqual(rslImportContextIsComplete(module, index), false);
    assert.strictEqual(
        run(
            "Import alpha;\nImport нетакогомодуля;\n\nMacro Run()\n  return AlphaOne();\nEnd;\n",
            RSL_IMPORT_ACTION_KINDS.removeUnused,
            LIBRARY
        ).offered,
        false,
        "неизвестный модуль мог объявлять то самое имя"
    );
});

test("недостающий Import находится по однозначному имени", () => {
    const { index, module } = open(
        "Macro Run()\n  return BetaOne();\nEnd;\n",
        LIBRARY
    );

    assert.deepStrictEqual(
        findMissingRslImports(module, index, () => false),
        ["beta"]
    );
});

test("неоднозначное имя не подключается", () => {
    const library = {
        "file:///d:/org/alpha.mac": "Macro Shared()\n  return 1;\nEnd;\n",
        "file:///d:/org/beta.mac": "Macro Shared()\n  return 2;\nEnd;\n"
    };
    const { index, module } = open(
        "Macro Run()\n  return Shared();\nEnd;\n",
        library
    );

    assert.deepStrictEqual(
        findMissingRslImports(module, index, () => false),
        [],
        "выбор между двумя модулями — решение автора"
    );
});

test("отмена прекращает поиск недостающих", () => {
    const { index, module } = open(
        "Macro Run()\n  return BetaOne();\nEnd;\n",
        LIBRARY
    );

    assert.deepStrictEqual(
        findMissingRslImports(module, index, () => true),
        []
    );
});

test("полное действие добавляет, удаляет и сортирует за раз", () => {
    const source = [
        "Import beta;",
        "Import beta;",
        "",
        "Macro Run()",
        "  return AlphaOne();",
        "End;",
        ""
    ].join("\n");

    assert.strictEqual(
        run(source, RSL_IMPORT_ACTION_KINDS.all, LIBRARY).text,
        [
            "Import alpha;",
            "",
            "Macro Run()",
            "  return AlphaOne();",
            "End;",
            ""
        ].join("\n"),
        "повтор снят, beta не нужна, alpha подключена"
    );
});

/* ── Договор реестра ────────────────────────────────────────────────────── */

test("действие показывается без правки", () => {
    const { index, module } = open(
        "Import beta;\nImport alpha;\n\nMacro Run()\nEnd;\n"
    );
    const registry = createRslRefactorRegistry(RSL_IMPORT_REFACTORS);
    const actions = registry.build({
        module,
        index,
        start: 0,
        end: 0,
        options: {},
        isCancelled: () => false
    });

    assert.ok(actions.length >= 2, "видов действий несколько");
    assert.ok(
        actions.every(action => action.edit === undefined),
        "ни одно действие не считает правку при показе"
    );
});

test("устаревшая версия документа правки не получает", () => {
    const { index, module } = open(
        "Import beta;\nImport alpha;\n\nMacro Run()\nEnd;\n"
    );
    const registry = createRslRefactorRegistry(RSL_IMPORT_REFACTORS);
    const action = registry.build(
        {
            module,
            index,
            start: 0,
            end: 0,
            options: {},
            isCancelled: () => false
        },
        [RSL_IMPORT_ACTION_KINDS.sort]
    )[0];
    const newer = index.updateOpenModule(
        MAIN,
        "Import beta;\nImport alpha;\nImport gamma;\n\nMacro Run()\nEnd;\n",
        2
    );

    assert.strictEqual(
        registry.resolve(action, () => newer, index, {}).edit,
        undefined,
        "правка по диапазонам прежнего текста легла бы не туда"
    );
});

test("вид действия отбирается запросом редактора", () => {
    const { index, module } = open("Import beta;\n\nMacro Run()\nEnd;\n");
    const registry = createRslRefactorRegistry(RSL_IMPORT_REFACTORS);
    const context = {
        module,
        index,
        start: 0,
        end: 0,
        options: {},
        isCancelled: () => false
    };
    const organize = registry.build(context, ["source.organizeImports"]);

    assert.deepStrictEqual(
        organize.map(action => action.kind),
        ["source.organizeImports"],
        "команда редактора обязана давать одно действие, а не выбор из четырёх"
    );
    assert.strictEqual(
        registry.build(context, ["quickfix"]).length,
        0
    );
});

test("чужое действие resolve не трогает", () => {
    const { index, module } = open("Import beta;\n\nMacro Run()\nEnd;\n");
    const registry = createRslRefactorRegistry(RSL_IMPORT_REFACTORS);
    const foreign = { title: "чужое", kind: "quickfix" };

    assert.strictEqual(
        registry.resolve(foreign, () => module, index, {}),
        foreign
    );
});

if (failed > 0) {
    console.error("\nПройдено: " + passed + "\nОшибок: " + failed);
    process.exitCode = 1;
} else {
    console.log("\nПройдено: " + passed + "\nОшибок: " + failed);
}

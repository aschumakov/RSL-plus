"use strict";

/**
 * Модуль-владелец в Hover и строки в апострофах.
 *
 * По смыслу RSL и файл проекта, и прикладной модуль платформы — это модуль:
 * первый подключают по имени файла, второй по имени модуля. Показывать
 * пользователю внутреннее различие незачем, а слово «Файл» для прикладного
 * символа было бы просто неверным — файла у него нет.
 *
 * Строки в апострофах RSL не принимает вовсе: `var z = 'sss';` компилятор
 * отвергает, а плагин считал корректным. Лексер апострофы разбирает — иначе он
 * спотыкался бы и портил разбор всего файла, — поэтому проверка нужна
 * отдельная.
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
const { getDefaults } = require("../server/out/defaults");
const {
    PlatformModuleCatalog
} = require("../server/out/builtins/platformModuleCatalog");
const {
    buildRslHoverContent
} = require("../server/out/features/hoverFormatter");
const {
    buildWorkspaceRslDiagnostics,
    buildRslDiagnostics
} = require("../server/out/diagnostics");
const { buildRslCodeActions } = require("../server/out/codeActions");
const {
    doubleQuoted
} = require("../server/out/diagnostics/stringQuoteDiagnostics");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const MAIN = "file:///d:/hover/payment.mac";

/** Каталог платформы читается один раз на весь файл проверок. */
let catalog;

async function platform() {
    if (!catalog) {
        catalog = new PlatformModuleCatalog({ log: () => undefined });
        await catalog.ensureModules(["PTInter"]);
    }

    return catalog;
}

function stand(source, modules) {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN]);

    const module = index.updateOpenModule(MAIN, source, 1);

    return {
        index,
        module,
        resolver: new RslScopeResolver(index, getDefaults(), modules)
    };
}

/** Строки Hover для имени под курсором. */
function hoverLines(board, offset) {
    const resolved = board.resolver.resolveAt(
        MAIN,
        board.module.symbolTree,
        offset
    );

    assert.ok(resolved, "имя обязано разрешиться");

    return buildRslHoverContent(
        board.index,
        resolved.uri,
        resolved.symbol,
        undefined,
        resolved.platformModuleName
    ).value.split("  \n");
}

/* ─── Hover ──────────────────────────────────────────────────────────────── */

test("проектный символ: Модуль и строка", () => {
    const source = [
        "Macro Filler()",
        "End;",
        "",
        "Macro Target()",
        "End;",
        "",
        "Macro Run()",
        "  Target();",
        "End;",
        ""
    ].join("\n");
    const board = stand(source);
    const lines = hoverLines(board, source.lastIndexOf("Target") + 2);

    /* Точка в имени файла экранируется разметкой: см. escapeMarkdown. */
    assert.ok(
        lines.some(line => line.replace(/\\/gu, "") ===
            "**Модуль:** payment.mac"),
        "ожидалось «Модуль: payment.mac», получено:\n" + lines.join("\n")
    );
    assert.ok(
        lines.some(line => line.startsWith("**Строка:**")),
        "у проектного символа строка объявления известна"
    );
    assert.ok(
        !lines.some(line => line.includes("**Файл:**")),
        "слово «Файл» больше не используется"
    );
});

test("символ платформы: Модуль по имени модуля", async () => {
    const modules = await platform();
    const source = [
        "Import PTInter;",
        "",
        "Macro Run()",
        "  Var p: RSBParty;",
        "  Return p;",
        "End;",
        ""
    ].join("\n");
    const board = stand(source, modules);
    const lines = hoverLines(board, source.indexOf("RSBParty") + 2);

    assert.ok(
        lines.some(line => line === "**Модуль:** PTInter"),
        "ожидалось «Модуль: PTInter», получено:\n" + lines.join("\n")
    );
    assert.ok(
        !lines.some(line => line.includes(".mac")),
        "файла у прикладного символа нет, и упоминать его нельзя"
    );
    assert.ok(
        !lines.some(line => line.startsWith("**Строка:**")),
        "строки объявления в справке платформы нет"
    );
});

test("слово «Файл» из Hover убрано целиком", () => {
    const fs = require("fs");
    const text = fs.readFileSync(
        "server/src/features/hoverFormatter.ts",
        "utf8"
    );

    assert.ok(
        !text.includes("**Файл:**"),
        "в подсказке объявления используется только «Модуль»"
    );
});

/* ─── Модуль не подключён ────────────────────────────────────────────────── */

test("имя из неподключённого модуля названо вместе с модулем", async () => {
    const modules = await platform();
    const source = "Macro Run()\n  Var p: RSBParty;\nEnd;\n";
    const board = stand(source, modules);
    const found = buildWorkspaceRslDiagnostics(
        board.module,
        board.index,
        {},
        undefined,
        board.resolver
    ).filter(item => item.code === "platform-module-not-imported");

    assert.strictEqual(found.length, 1, "ожидалось одно сообщение");
    assert.strictEqual(
        found[0].message,
        "RSBParty описан в модуле PTInter, который не подключён"
    );

    const actions = buildRslCodeActions(board.module, {
        textDocument: { uri: MAIN },
        range: found[0].range,
        context: { diagnostics: found }
    });

    assert.strictEqual(actions.length, 1, "исправление обязано быть");
    assert.strictEqual(actions[0].title, "Подключить модуль PTInter");
    assert.strictEqual(
        actions[0].edit.changes[MAIN][0].newText,
        "Import PTInter;\n"
    );
});

test("подключённый модуль сообщения не даёт", async () => {
    const modules = await platform();
    const board = stand(
        "Import PTInter;\n\nMacro Run()\n  Var p: RSBParty;\nEnd;\n",
        modules
    );

    assert.deepStrictEqual(
        buildWorkspaceRslDiagnostics(
            board.module,
            board.index,
            {},
            undefined,
            board.resolver
        ).filter(item => item.code === "platform-module-not-imported"),
        []
    );
});

test("своё объявление того же имени сообщения не даёт", async () => {
    /* Имя доступно и без этого Import: причина не в модуле. */
    const modules = await platform();
    const board = stand(
        "Class RSBParty\nEnd;\n\nMacro Run()\n  Var p: RSBParty;\nEnd;\n",
        modules
    );

    assert.deepStrictEqual(
        buildWorkspaceRslDiagnostics(
            board.module,
            board.index,
            {},
            undefined,
            board.resolver
        ).filter(item => item.code === "platform-module-not-imported"),
        []
    );
});

test("имя из нескольких модулей сообщения не даёт", async () => {
    /*
     * Выбрать за пользователя один из равноправных модулей значит соврать, а
     * предложить пять исправлений — переложить на него ту же догадку.
     */
    const modules = await platform();
    const owners = modules.modulesDeclaring("AccTrn_Status_Document");

    assert.ok(
        owners.length > 1,
        "имя для проверки обязано быть в нескольких модулях"
    );

    const board = stand(
        "Macro Run()\n  Var p = AccTrn_Status_Document;\nEnd;\n",
        modules
    );

    assert.deepStrictEqual(
        buildWorkspaceRslDiagnostics(
            board.module,
            board.index,
            {},
            undefined,
            board.resolver
        ).filter(item => item.code === "platform-module-not-imported"),
        []
    );
});

test("обращение к члену сообщения не даёт", async () => {
    const modules = await platform();
    const board = stand(
        "Macro Run()\n  Var q = 1;\n  Return q.RSBParty;\nEnd;\n",
        modules
    );

    assert.deepStrictEqual(
        buildWorkspaceRslDiagnostics(
            board.module,
            board.index,
            {},
            undefined,
            board.resolver
        ).filter(item => item.code === "platform-module-not-imported"),
        []
    );
});

test("без обратного указателя проверка молчит", () => {
    /* Указатель производный: его отсутствие не повод ломать остальное. */
    const board = stand("Macro Run()\n  Var p: RSBParty;\nEnd;\n");

    assert.deepStrictEqual(
        buildWorkspaceRslDiagnostics(
            board.module,
            board.index,
            {},
            undefined,
            board.resolver
        ).filter(item => item.code === "platform-module-not-imported"),
        []
    );
});

/* ─── Строки в апострофах ────────────────────────────────────────────────── */

test("строка в апострофах названа ошибкой", () => {
    const source = "Macro Run()\n  z = 'sss';\nEnd;\n";
    const board = stand(source);
    const found = buildRslDiagnostics(board.module, board.index)
        .filter(item => item.code === "single-quoted-string");

    assert.strictEqual(found.length, 1);
    assert.strictEqual(
        found[0].message,
        "Строковый литерал RSL должен быть заключён в двойные кавычки"
    );
    assert.strictEqual(found[0].range.start.line, 1);

    const actions = buildRslCodeActions(board.module, {
        textDocument: { uri: MAIN },
        range: found[0].range,
        context: { diagnostics: found }
    });

    assert.strictEqual(actions.length, 1);
    assert.strictEqual(actions[0].title, "Заключить в двойные кавычки");
    assert.strictEqual(
        actions[0].edit.changes[MAIN][0].newText,
        "\"sss\""
    );
});

test("строка в двойных кавычках ошибкой не считается", () => {
    const board = stand("Macro Run()\n  z = \"ok\";\nEnd;\n");

    assert.deepStrictEqual(
        buildRslDiagnostics(board.module, board.index)
            .filter(item => item.code === "single-quoted-string"),
        []
    );
});

test("несколько литералов названы по отдельности", () => {
    const board = stand(
        "Macro Run()\n  a = 'one';\n  b = 'two';\nEnd;\n"
    );
    const found = buildRslDiagnostics(board.module, board.index)
        .filter(item => item.code === "single-quoted-string");

    assert.strictEqual(found.length, 2);
    assert.deepStrictEqual(
        found.map(item => item.range.start.line),
        [1, 2]
    );
});

test("неоднозначное преобразование не предлагается", () => {
    /*
     * Двойная кавычка внутри: в двойных кавычках её надо удваивать, и
     * доверять такому переносу без проверки компилятором нельзя. Обратная
     * косая меняет смысл escape-последовательности от смены обрамления.
     *
     * Сообщение при этом остаётся: ошибка настоящая, просто исправлять её
     * пользователю придётся руками.
     */
    for (const body of ["он сказал \"да\"", "путь\\файл"]) {
        const board = stand(
            "Macro Run()\n  z = '" + body + "';\nEnd;\n"
        );
        const found = buildRslDiagnostics(board.module, board.index)
            .filter(item => item.code === "single-quoted-string");

        assert.strictEqual(found.length, 1, body);

        const actions = buildRslCodeActions(board.module, {
            textDocument: { uri: MAIN },
            range: found[0].range,
            context: { diagnostics: found }
        });

        assert.deepStrictEqual(actions, [], body);
    }
});

test("правило преобразования проверяется отдельно", () => {
    assert.strictEqual(doubleQuoted("'sss'"), "\"sss\"");
    assert.strictEqual(doubleQuoted("''"), "\"\"");
    assert.strictEqual(doubleQuoted("'с пробелом'"), "\"с пробелом\"");
    assert.strictEqual(doubleQuoted("'с \"кавычкой\"'"), "");
    assert.strictEqual(doubleQuoted("'с \\\\косой'"), "");
});

test("апостроф внутри двойных кавычек ошибкой не считается", () => {
    const board = stand("Macro Run()\n  z = \"don't\";\nEnd;\n");

    assert.deepStrictEqual(
        buildRslDiagnostics(board.module, board.index)
            .filter(item => item.code === "single-quoted-string"),
        []
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

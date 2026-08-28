"use strict";

/**
 * Переход к файлу из строкового `Import`.
 *
 * `Import "checkaml.mac";` — это ссылка на файл, а не на символ: её знает
 * каталог проекта, и разбор для неё не нужен. Проверяется весь путь целиком —
 * от позиции курсора до открытого файла, — потому что по отдельности и разбор
 * строки, и разрешение имени файла работали, а переход не работал.
 *
 * Отдельно проверяется обратное: обычная строка ссылкой не становится.
 * `MsgBox("checkaml.mac")` — это текст сообщения, и уводить из него в файл
 * нельзя.
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
    findRslImportModuleDefinition
} = require("../server/out/features/interactiveAnswers");
const {
    createRslInteractiveContext
} = require("../server/out/features/interactiveContext");
const {
    TextDocument
} = require("../server/node_modules/vscode-languageserver-textdocument");
const {
    createFastDocumentSnapshot
} = require("../server/out/services/fastDocumentSnapshot");
const { buildLocalRslDiagnostics } = require("../server/out/diagnostics");

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
const TARGET = "file:///d:/project/checkaml.mac";
const NESTED = "file:///d:/project/sub/checkaml.mac";

const TARGET_SOURCE = [
    "Macro CheckAml(document)",
    "  return 1;",
    "End;",
    ""
].join("\n");

/**
 * Стенд перехода: проект, открытый документ и позиция курсора.
 *
 * Состояние каталога задаётся снаружи: файл может быть открыт, известен только
 * компактному каталогу, зарегистрирован без содержимого или отсутствовать
 * вовсе — от этого переход зависеть не должен.
 */
function stand(source, options = {}) {
    const index = new WorkspaceIndex();
    const registered = options.registered || [MAIN, TARGET];

    index.registerWorkspaceFiles(registered);

    if (options.loadTarget) {
        index.updateExternalModule(TARGET, TARGET_SOURCE, 1);
    }

    if (options.openTarget) {
        index.updateOpenModule(TARGET, TARGET_SOURCE, 1);
    }

    const document = TextDocument.create(MAIN, "rsl", 1, source);
    const module = index.updateOpenModule(MAIN, source, 1);
    const resolver = new RslScopeResolver(index);

    return {
        index,
        /** Переход из позиции offset. */
        at(offset) {
            const context = createRslInteractiveContext(
                {
                    index,
                    resolver,
                    getFastDocumentSnapshot: value =>
                        createFastDocumentSnapshot(value),
                    getCurrentModule: () => module
                },
                document,
                offset,
                () => false
            );

            return findRslImportModuleDefinition(context, index);
        }
    };
}

/** Позиция внутри подстроки: середина, начало и конец. */
function placesOf(source, value) {
    const at = source.indexOf(value);

    assert.notStrictEqual(at, -1, "образец обязан содержать " + value);

    return [
        ["начало", at],
        ["середина", at + Math.floor(value.length / 2)],
        ["конец", at + value.length - 1]
    ];
}

const FORMS = [
    ['Import "checkaml.mac";', "checkaml.mac"],
    ['Import "checkaml";', "checkaml"],
    ['Import "CHECKAML.MAC";', "CHECKAML.MAC"],
    ["Import \"sub\\checkaml.mac\";", "sub\\checkaml.mac"],
    ['Import "sub/checkaml.mac";', "sub/checkaml.mac"]
];

for (const [directive, name] of FORMS) {
    test("переход из " + JSON.stringify(directive), () => {
        const source = directive + "\n\nMacro Run()\nEnd;\n";
        const board = stand(source);

        for (const [where, offset] of placesOf(source, name)) {
            const target = board.at(offset);

            assert.ok(
                target,
                where + " имени: переход обязан находить файл"
            );
            assert.strictEqual(
                target.uri,
                TARGET,
                where + " имени: переход обязан вести в checkaml.mac"
            );
        }
    });
}

test("кавычки в ссылку не входят", () => {
    const source = 'Import "checkaml.mac";\n\nMacro Run()\nEnd;\n';
    const board = stand(source);
    const quote = source.indexOf("\"");

    assert.strictEqual(
        board.at(quote),
        undefined,
        "открывающая кавычка частью ссылки не является"
    );
    assert.strictEqual(
        board.at(source.indexOf("\"", quote + 1)),
        undefined,
        "закрывающая кавычка тоже"
    );
    assert.ok(
        board.at(quote + 1),
        "первый символ имени уже ссылка"
    );
});

test("состояние каталога на переход не влияет", () => {
    const source = 'Import "checkaml.mac";\n\nMacro Run()\nEnd;\n';
    const at = source.indexOf("checkaml") + 4;

    for (const [what, options] of [
        ["файл только зарегистрирован", {}],
        ["файл известен каталогу", { loadTarget: true }],
        ["файл открыт", { openTarget: true }]
    ]) {
        const target = stand(source, options).at(at);

        assert.ok(target, what + ": переход обязан работать");
        assert.strictEqual(target.uri, TARGET, what);
    }
});

test("отсутствующий файл не даёт ложного назначения", () => {
    const source = 'Import "nosuchfile.mac";\n\nMacro Run()\nEnd;\n';
    const board = stand(source);

    assert.strictEqual(
        board.at(source.indexOf("nosuchfile") + 4),
        undefined,
        "файла нет — и перехода быть не должно"
    );
});

test("два одноимённых файла: показываются оба", () => {
    /*
     * В проверенном проекте макросов семьдесят три имени файла встречаются не
     * по одному разу. Увести в один из них наугад нельзя, но и молчать не
     * лучше: показываются все подходящие, выбирает человек.
     */
    const source = 'Import "checkaml.mac";\n\nMacro Run()\nEnd;\n';
    const board = stand(source, { registered: [MAIN, TARGET, NESTED] });
    const found = board.at(source.indexOf("checkaml") + 4);

    assert.ok(Array.isArray(found), "неоднозначность даёт список назначений");
    assert.deepStrictEqual(
        found.map(item => item.uri).sort(),
        [NESTED, TARGET].sort(),
        "в списке обязаны быть оба одноимённых файла"
    );

    /* Порядок ответа не зависит от порядка регистрации файлов. */
    const reversed = stand(source, {
        registered: [MAIN, NESTED, TARGET]
    }).at(source.indexOf("checkaml") + 4);

    assert.deepStrictEqual(
        reversed.map(item => item.uri),
        found.map(item => item.uri),
        "порядок ответа обязан быть устойчивым"
    );
});

test("предупреждение о повторном импорте сохраняется", () => {
    /*
     * `Import "checkaml.mac", checkaml;` — это один и тот же модуль дважды.
     * Точный диапазон имени завёлся ради перехода и не имеет права отменить
     * существующую диагностику: она подчёркивает всю директиву целиком.
     */
    const source = 'Import "checkaml.mac", checkaml;\n\nMacro Run()\nEnd;\n';
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([MAIN, TARGET]);
    index.updateExternalModule(TARGET, TARGET_SOURCE, 1);

    const module = index.updateOpenModule(MAIN, source, 1);
    const found = buildLocalRslDiagnostics(module, index, { maxProblems: 50 })
        .filter(item => item.code === "duplicate-import");

    assert.strictEqual(
        found.length,
        1,
        "повторный импорт обязан остаться одним предупреждением"
    );

    /* И переход из строковой части при этом работает. */
    assert.ok(
        stand(source).at(source.indexOf("checkaml") + 4),
        "из строковой части перехода никто не лишал"
    );
});

test("несколько имён в одном Import", () => {
    const source = 'Import "checkaml.mac", other;\n\nMacro Run()\nEnd;\n';
    const board = stand(source, { registered: [MAIN, TARGET] });

    assert.ok(
        board.at(source.indexOf("checkaml") + 4),
        "первое имя обязано вести в свой файл"
    );
    assert.strictEqual(
        board.at(source.indexOf("other") + 2),
        undefined,
        "второе имя без файла в проекте перехода не даёт"
    );
});

test("обычные строки ссылками не становятся", () => {
    for (const line of [
        'MsgBox("checkaml.mac");',
        'Var fileName = "checkaml.mac";'
    ]) {
        const source = "Macro Run()\n  " + line + "\nEnd;\n";
        const board = stand(source);

        assert.strictEqual(
            board.at(source.indexOf("checkaml") + 4),
            undefined,
            JSON.stringify(line) + ": обычная строка ссылкой не является"
        );
    }
});

test("ExecMacroFile остаётся своей ссылкой, а не Import", () => {
    const source = 'Macro Run()\n  ExecMacroFile("checkaml.mac");\nEnd;\n';
    const board = stand(source);

    assert.strictEqual(
        board.at(source.indexOf("checkaml") + 4),
        undefined,
        "у ExecMacroFile своя семантика: Import её обрабатывать не должен"
    );
});

if (failed > 0) {
    console.error("\nПройдено: " + passed + "\nОшибок: " + failed);
    process.exitCode = 1;
} else {
    console.log("\nПройдено: " + passed + "\nОшибок: " + failed);
}

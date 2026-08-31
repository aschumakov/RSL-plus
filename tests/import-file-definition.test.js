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
const {
    buildLocalRslDiagnostics,
    buildRslDiagnostics
} = require("../server/out/diagnostics");
const {
    GetImportDefinitionTargetsFromTokens
} = require("../server/out/execMacroDefinition");

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
        module,
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

/*
 * Настоящий файл, а не одна директива: комментарий с кириллицей, пустые строки,
 * обычные Import и только потом строковые.
 *
 * Так выглядел файл, на котором переход не работал в редакторе, хотя работал во
 * всех проверках: диагностика к тому времени успевала пройти. Список ссылок
 * Import запоминается на версию потока токенов, и этап диагностики подавал
 * сканеру полный поток вместо потока значимых токенов. Индексы разъезжались,
 * имена файлов склеивались из чужих токенов, и этот мусор оставался в кэше:
 * `Import "checkaml.mac";` превращался в `Import"checkaml.mac".mac`, а из
 * объявления `private file ci_doc_file ("ci_doc.dbt")` получался несуществующий
 * модуль. Переход по строковому Import умирал до следующего lex — то есть до
 * первой правки файла.
 */
const REAL_FILE = [
    "/* RSBD-3101 Автоматическое подтверждение операций */",
    "",
    "import DeprIntr, globals;",
    "import fm_defs;",
    "",
    "//проверка на ИПДЛ",
    'import "ipdlrtllib.mac";',
    'Import "checkaml.mac";',
    "",
    'private file ci_doc_file ( "ci_doc.dbt" );',
    "",
    "Macro Run()",
    "End;",
    ""
].join("\n");

/*
 * Проверки, которые ищут директивы Import, включены: именно они и трогают кэш
 * ссылок. С настройками по умолчанию оба этапа «importReferences» не запускались
 * бы, и проверка прошла бы даже на сломанном коде.
 */
const REAL_SETTINGS = {
    enabled: true,
    structure: true,
    unusedImports: true,
    redundantImports: true,
    maxProblems: 50
};

const REAL_FILES = [
    MAIN,
    TARGET,
    "file:///d:/project/deprintr.mac",
    "file:///d:/project/globals.mac",
    "file:///d:/project/fm_defs.mac",
    "file:///d:/project/ipdlrtllib.mac"
];

test("переход работает и после диагностики того же модуля", () => {
    const board = stand(REAL_FILE, { registered: REAL_FILES });

    /* Порядок как в редакторе: сначала диагностика, потом Ctrl+Click. */
    buildRslDiagnostics(board.module, board.index, REAL_SETTINGS);

    /*
     * Проверяются все директивы образца, а не одна.
     *
     * От сдвига индексов страдают не все имена сразу: какое уцелеет, зависит от
     * того, сколько пробелов и комментариев стоит перед ним. На этом образце
     * `checkaml.mac` уцелевал, а `ipdlrtllib.mac` пропадал — и переход по нему
     * молчал ровно так, как в редакторе.
     */
    for (const [name, uri] of [
        ["DeprIntr", "file:///d:/project/deprintr.mac"],
        ["globals", "file:///d:/project/globals.mac"],
        ["fm_defs", "file:///d:/project/fm_defs.mac"],
        ["ipdlrtllib.mac", "file:///d:/project/ipdlrtllib.mac"],
        ["checkaml.mac", TARGET]
    ]) {
        const target = board.at(REAL_FILE.indexOf(name) + 2);

        assert.ok(
            target,
            "после диагностики переход по " + name + " обязан работать"
        );
        assert.strictEqual(
            target.uri,
            uri,
            name + ": переход обязан вести в свой файл"
        );
    }
});

test("диагностика не портит список ссылок Import", () => {
    const board = stand(REAL_FILE, { registered: REAL_FILES });

    buildRslDiagnostics(board.module, board.index, REAL_SETTINGS);

    assert.deepStrictEqual(
        GetImportDefinitionTargetsFromTokens(board.module.lex.tokens)
            .map(item => item.moduleName),
        [
            "DeprIntr.mac",
            "globals.mac",
            "fm_defs.mac",
            "ipdlrtllib.mac",
            "checkaml.mac"
        ],
        "в списке обязаны остаться все директивы Import и только они"
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

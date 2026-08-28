"use strict";

const assert = require("assert");
const path = require("path");

const modulePath = path.join(
    __dirname,
    "..",
    "server",
    "out",
    "execMacroDefinition.js"
);

const {
    GetDynamicDefinitionTarget,
    GetImportDefinitionTarget,
    GetImportedMacroFiles,
    GetProcedureReferenceTargetFromTokens,
    GetPositionalHandlerNamesFromTokens
} = require(modulePath);
const { lexRsl } = require("../server/out/lexer");

let passed = 0;
let failed = 0;

function test(name, action) {
    try {
        action();
        passed++;
        console.log(`[OK] ${name}`);
    } catch (error) {
        failed++;
        console.error(`[FAIL] ${name}`);
        console.error(error);
    }
}

function inside(source, value, occurrence = 0) {
    let offset = -1;
    let from = 0;

    for (let index = 0; index <= occurrence; index++) {
        offset = source.indexOf(value, from);
        from = offset + value.length;
    }

    assert.notStrictEqual(offset, -1);
    return offset + Math.floor(value.length / 2);
}

test("ExecMacro переходит по строковому имени", () => {
    const source = 'ExecMacro ("ProcessReserveAccount", acc, sum);';

    assert.deepStrictEqual(
        GetDynamicDefinitionTarget(
            source,
            inside(source, "ProcessReserveAccount")
        ),
        {
            kind: "macro",
            macroName: "ProcessReserveAccount"
        }
    );
});

test("Строковые callback-процедуры документированных API поддерживают переход", () => {
    const cases = [
        ['RunDialog(dlg, "DialogEvent");', "DialogEvent"],
        ['RunMenu(menu, "MenuEvent");', "MenuEvent"],
        ['SetOutHandler("OutputEvent");', "OutputEvent"],
        ['ProcessTrn(data, "TransactionEvent");', "TransactionEvent"],
        ['array.Sort("CompareRows");', "CompareRows"]
    ];
    for (const [source, name] of cases) {
        assert.deepStrictEqual(
            GetProcedureReferenceTargetFromTokens(
                lexRsl(source).tokens,
                inside(source, name)
            ),
            { kind: "macro", name }
        );
    }
});

test("R2M связывает строку метода с объектом-получателем", () => {
    const source = 'RunScroll(dlg, data, 4, cols, R2M(this, "OnScroll"));';
    assert.deepStrictEqual(
        GetProcedureReferenceTargetFromTokens(
            lexRsl(source).tokens,
            inside(source, "OnScroll")
        ),
        {
            kind: "method",
            name: "OnScroll",
            receiverOffset: source.indexOf("this")
        }
    );
});

test("Обработчики из строки, @ и R2M распознаются позиционными", () => {
    const source = [
        'RunDialog(dlg, "DialogEvent");',
        "RunMenu(menu, @MenuEvent);",
        'RunScroll(dlg, data, 4, cols, R2M(this, "ScrollEvent"));'
    ].join("\n");
    assert.deepStrictEqual(
        Array.from(GetPositionalHandlerNamesFromTokens(
            lexRsl(source).tokens
        )).sort(),
        ["dialogevent", "menuevent", "scrollevent"]
    );
});

test("ExecMacro2 поддерживает вложенные выражения в параметрах", () => {
    const source =
        'result = ExecMacro2 ("getCodeByISO", makeValue (398, 1));';

    assert.deepStrictEqual(
        GetDynamicDefinitionTarget(
            source,
            inside(source, "getCodeByISO")
        ),
        {
            kind: "macro",
            macroName: "getCodeByISO"
        }
    );
});


test("Вложенный ExecMacro2 определяется отдельно", () => {
    const source =
        'ExecMacro2 ("Outer", ExecMacro2 ("Inner", value));';

    assert.deepStrictEqual(
        GetDynamicDefinitionTarget(
            source,
            inside(source, "Inner")
        ),
        {
            kind: "macro",
            macroName: "Inner"
        }
    );
});

test("Переменная в первом параметре не перехватывается", () => {
    const source = "ExecMacro (macroName, acc);";

    assert.strictEqual(
        GetDynamicDefinitionTarget(
            source,
            inside(source, "macroName")
        ),
        undefined
    );
});

test("ExecMacroFile возвращает файл и макропроцедуру", () => {
    const source =
        'res = ExecMacroFile ("bezdei.mac", "getBezdeiStatus", client);';

    assert.deepStrictEqual(
        GetDynamicDefinitionTarget(
            source,
            inside(source, "getBezdeiStatus")
        ),
        {
            kind: "fileMacro",
            moduleName: "bezdei.mac",
            macroName: "getBezdeiStatus"
        }
    );

    assert.deepStrictEqual(
        GetDynamicDefinitionTarget(
            source,
            inside(source, "bezdei.mac")
        ),
        {
            kind: "fileMacro",
            moduleName: "bezdei.mac",
            macroName: "getBezdeiStatus"
        }
    );
});

test("ExecMacroFile без ProcName открывает файл", () => {
    const source = 'ExecMacroFile ("bezdei.mac");';

    assert.deepStrictEqual(
        GetDynamicDefinitionTarget(
            source,
            inside(source, "bezdei.mac")
        ),
        {
            kind: "file",
            moduleName: "bezdei.mac"
        }
    );
});

test("Ложные вызовы внутри комментариев и SQL игнорируются", () => {
    const source = [
        '// ExecMacro ("Fake1");',
        '[select ExecMacro ("Fake2") from dual]',
        '/* ExecMacro2 ("Fake3") */'
    ].join("\n");

    assert.strictEqual(
        GetDynamicDefinitionTarget(
            source,
            inside(source, "Fake1")
        ),
        undefined
    );
});


test("Import переходит по каждому имени в списке", () => {
    const source =
        "import globals, utils, Oratools, strcupt;";

    for (const name of [
        "globals",
        "utils",
        "Oratools",
        "strcupt"
    ]) {
        const target = GetImportDefinitionTarget(
            source,
            inside(source, name)
        );

        assert.ok(target);
        assert.strictEqual(
            target.moduleName,
            name + ".mac"
        );
    }
});

test("Import поддерживает кавычки и относительный путь", () => {
    const source = [
        'Import "cards.mac";',
        "Import folder\\payments;"
    ].join("\n");

    const quoted = source.indexOf('"cards.mac"');

    assert.deepStrictEqual(
        GetImportDefinitionTarget(
            source,
            inside(source, "cards.mac")
        ),
        {
            kind: "import-file",
            rawText: "cards.mac",
            moduleName: "cards.mac",
            /* Весь фрагмент директивы: его подчёркивает диагностика. */
            start: quoted,
            end: quoted + '"cards.mac"'.length,
            /* Само имя: кавычки в него не входят. */
            nameStart: quoted + 1,
            nameEnd: quoted + '"cards.mac"'.length - 1
        }
    );

    /* Клик по кавычке ссылкой не считается: она не часть имени файла. */
    assert.strictEqual(
        GetImportDefinitionTarget(source, quoted),
        undefined,
        "открывающая кавычка частью ссылки не является"
    );
    assert.strictEqual(
        GetImportDefinitionTarget(
            source,
            quoted + '"cards.mac"'.length - 1
        ),
        undefined,
        "закрывающая кавычка тоже"
    );

    const relative = GetImportDefinitionTarget(
        source,
        inside(source, "payments")
    );

    assert.ok(relative);
    assert.strictEqual(
        relative.moduleName,
        "folder\\payments.mac"
    );
});

test("Клик по ключевому слову Import и разделителям не перехватывается", () => {
    const source = "Import globals, utils;";

    assert.strictEqual(
        GetImportDefinitionTarget(
            source,
            inside(source, "Import")
        ),
        undefined
    );

    assert.strictEqual(
        GetImportDefinitionTarget(
            source,
            source.indexOf(",")
        ),
        undefined
    );
});

test("Import внутри комментария и SQL не создаёт переход", () => {
    const source = [
        "// Import ignored;",
        "[Import sql_fake;]",
        "/* Import hidden; */"
    ].join("\n");

    assert.strictEqual(
        GetImportDefinitionTarget(
            source,
            inside(source, "ignored")
        ),
        undefined
    );
    assert.strictEqual(
        GetImportDefinitionTarget(
            source,
            inside(source, "sql_fake")
        ),
        undefined
    );
    assert.strictEqual(
        GetImportDefinitionTarget(
            source,
            inside(source, "hidden")
        ),
        undefined
    );
});

test("Import извлекается без комментариев и SQL", () => {
    const source = [
        'Import common, "cards.mac";',
        '// Import ignored;',
        '[Import sql_fake;]',
        'Import folder\\payments;'
    ].join("\n");

    assert.deepStrictEqual(
        GetImportedMacroFiles(source),
        [
            "common.mac",
            "cards.mac",
            "folder\\payments.mac"
        ]
    );
});

console.log("");
console.log(`Пройдено: ${passed}`);
console.log(`Ошибок: ${failed}`);

if (failed > 0) {
    process.exitCode = 1;
}

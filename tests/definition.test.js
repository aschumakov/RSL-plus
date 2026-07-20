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
    GetImportedMacroFiles
} = require(modulePath);

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

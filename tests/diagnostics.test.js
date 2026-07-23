"use strict";

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

const { CBase } = require("../server/out/common");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { buildRslDiagnostics } = require("../server/out/diagnostics");

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

function createModule(index, uri, source, open = true) {
    return index.updateModule(
        uri,
        source,
        new CBase(source, 0),
        1,
        open
    );
}

function diagnosticsFor(source, setup, settings) {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles(["file:///main.mac"]);

    if (setup) {
        setup(index);
    }

    const module = createModule(index, "file:///main.mac", source);
    return buildRslDiagnostics(module, index, settings);
}

function codes(items) {
    return items.map(item => item.code);
}

test("DEBUGBREAK выдаёт предупреждение", () => {
    const items = diagnosticsFor("Macro Test()\n DebugBreak;\nEnd;");
    const item = items.find(value => value.code === "debugbreak");
    assert.ok(item);
    assert.strictEqual(item.severity, 2);
});

test("Неиспользуемая локальная переменная выдаёт предупреждение", () => {
    const items = diagnosticsFor("Macro Test()\n Var unused;\nEnd;");
    const item = items.find(value => value.code === "unused-declaration");
    assert.ok(item);
    assert.strictEqual(item.severity, 2);
});

test("Использованная переменная не помечается", () => {
    const items = diagnosticsFor([
        "Macro Test()",
        " Var value;",
        " value = 1;",
        "End;"
    ].join("\n"));
    assert.ok(!codes(items).includes("unused-declaration"));
});

test("Использование переменной до объявления является ошибкой", () => {
    const items = diagnosticsFor([
        "Macro Test()",
        " value = 1;",
        " Var value;",
        "End;"
    ].join("\n"));
    const item = items.find(value => value.code === "use-before-declaration");
    assert.ok(item);
    assert.strictEqual(item.severity, 1);
});

test("Повторный ELSE является ошибкой", () => {
    const items = diagnosticsFor([
        "Macro Test()",
        " If ready",
        " Else",
        " Else",
        " End;",
        "End;"
    ].join("\n"));
    assert.ok(codes(items).includes("duplicate-else"));
});

test("Известный неиспользуемый модуль выдаёт предупреждение", () => {
    const items = diagnosticsFor(
        "Import common;\nMacro Test()\nEnd;",
        index => createModule(
            index,
            "file:///common.mac",
            "Macro Shared()\nEnd;",
            false
        )
    );
    const item = items.find(value => value.code === "unused-import");
    assert.ok(item);
    assert.strictEqual(item.severity, 2);
});

test("Неизвестный модуль базовой поставки не считается ошибкой", () => {
    const items = diagnosticsFor(
        "Import InsCarryDoc;\nMacro Test()\nEnd;"
    );
    assert.ok(!codes(items).includes("missing-import"));
    assert.ok(!items.some(item => /не найден в проекте/i.test(item.message)));
});

test("Использованный импорт не помечается", () => {
    const items = diagnosticsFor(
        [
            "Import common;",
            "Macro Test()",
            " Shared();",
            "End;"
        ].join("\n"),
        index => createModule(
            index,
            "file:///common.mac",
            "Macro Shared()\nEnd;",
            false
        )
    );
    assert.ok(!codes(items).includes("unused-import"));
});

test("Неоднозначная ссылка из двух Import является ошибкой", () => {
    const items = diagnosticsFor(
        [
            "Import first, second;",
            "Macro Test()",
            " Shared();",
            "End;"
        ].join("\n"),
        index => {
            createModule(index, "file:///first.mac", "Macro Shared()\nEnd;", false);
            createModule(index, "file:///second.mac", "Macro Shared()\nEnd;", false);
        }
    );
    const item = items.find(value => value.code === "ambiguous-reference");
    assert.ok(item);
    assert.strictEqual(item.severity, 1);
    assert.ok(item.message.includes("first.mac"));
    assert.ok(item.message.includes("second.mac"));
});

test("Стандартные типы RSL не считаются неоднозначными ссылками", () => {
    const standardTypes = [
        "Integer",
        "Double",
        "DoubleL",
        "String",
        "Bool",
        "Date",
        "Time",
        "DateTime",
        "MemAddr",
        "ProcRef",
        "MethodRef",
        "Decimal",
        "Numeric",
        "Money",
        "MoneyL",
        "SpecVal"
    ];
    const importedDeclarations = standardTypes
        .map(typeName => `Macro ${typeName}()\nEnd;`)
        .join("\n");
    const typedVariables = standardTypes
        .map((typeName, index) =>
            `private var value${index}:${typeName};`
        );
    const source = [
        "Import first, second;",
        ...typedVariables,
        "Macro Test(value:String):String",
        ' return "";',
        "End;"
    ].join("\n");
    const items = diagnosticsFor(source, index => {
        createModule(
            index,
            "file:///first.mac",
            importedDeclarations,
            false
        );
        createModule(
            index,
            "file:///second.mac",
            importedDeclarations,
            false
        );
    });

    assert.ok(!items.some(item =>
        item.code === "ambiguous-reference" &&
        standardTypes.some(typeName =>
            item.message.toLowerCase().includes(typeName.toLowerCase())
        )
    ));
});

test("ValType и его стандартные коды не считаются неоднозначными", () => {
    const builtinNames = [
        "ValType",
        "V_UNDEF",
        "V_INTEGER",
        "V_MONEY",
        "V_DECIMAL",
        "V_DOUBLE",
        "V_STRING",
        "V_BOOL",
        "V_DATE",
        "V_TIME",
        "V_DTTM",
        "V_FILE",
        "V_STRUC",
        "V_ARRAY",
        "V_TXTFILE",
        "V_DBFFILE",
        "V_PROC",
        "V_R2M",
        "V_MEMADDR"
    ];
    const importedDeclarations = builtinNames
        .map(name => `Macro ${name}()\nEnd;`)
        .join("\n");
    const source = [
        "Import first, second;",
        "Macro Test(value)",
        " result = ValType(value);",
        " If result==V_STRING",
        " End;",
        "End;"
    ].join("\n");
    const items = diagnosticsFor(source, index => {
        createModule(
            index,
            "file:///first.mac",
            importedDeclarations,
            false
        );
        createModule(
            index,
            "file:///second.mac",
            importedDeclarations,
            false
        );
    });

    assert.ok(!items.some(item =>
        item.code === "ambiguous-reference" &&
        builtinNames.some(name =>
            item.message.toLowerCase().includes(name.toLowerCase())
        )
    ));
});

test("Локальное объявление снимает неоднозначность Import", () => {
    const items = diagnosticsFor(
        [
            "Import first, second;",
            "Macro Shared()",
            "End;",
            "Macro Test()",
            " Shared();",
            "End;"
        ].join("\n"),
        index => {
            createModule(index, "file:///first.mac", "Macro Shared()\nEnd;", false);
            createModule(index, "file:///second.mac", "Macro Shared()\nEnd;", false);
        }
    );
    assert.ok(!codes(items).includes("ambiguous-reference"));
});

test("Отдельную диагностику можно отключить", () => {
    const items = diagnosticsFor(
        "Macro Test()\n DebugBreak;\n Var unused;\nEnd;",
        undefined,
        {
            debugBreak: false,
            unusedVariables: false
        }
    );
    assert.ok(!codes(items).includes("debugbreak"));
    assert.ok(!codes(items).includes("unused-declaration"));
});

test("Общий выключатель очищает диагностику", () => {
    const items = diagnosticsFor(
        "Macro Test()\n DebugBreak;\nEnd;",
        undefined,
        { enabled: false }
    );
    assert.deepStrictEqual(items, []);
});

test("maxProblems ограничивает список", () => {
    const items = diagnosticsFor(
        "Macro Test()\n DebugBreak;\n Var a, b, c;\nEnd;",
        undefined,
        { maxProblems: 1 }
    );
    assert.strictEqual(items.length, 1);
});

test("Ключевые слова IF и VAR не считаются переменными", () => {
    const source = [
        "Macro Test()",
        "    If ready",
        "        Var value;",
        "        value = 1;",
        "    End;",
        "End;"
    ].join("\n");
    const diagnostics = diagnosticsFor(source);
    const messages = diagnostics.map(item => item.message.toLowerCase());

    assert.ok(!messages.includes("переменная if используется до объявления"));
    assert.ok(!messages.includes("переменная var используется до объявления"));
});

test("FOR объявляет только первый аргумент после VAR", () => {
    const source = [
        "Macro Test(tag)",
        "    for (Var x, 0, tag.getElementsByTagName(\"Info/Balances\").Item(0).childNodes.Length - 1, 1)",
        "        x = x + 1;",
        "    end;",
        "End;"
    ].join("\n");
    const items = diagnosticsFor(source);

    assert.ok(!items.some(item =>
        item.code === "duplicate-declaration" && /tag/i.test(item.message)
    ));
    assert.ok(!items.some(item =>
        item.code === "unused-declaration" && /переменная x/i.test(item.message)
    ));
});

test("Индекс массива считается использованием переменной цикла", () => {
    const source = [
        "Macro Contains(accounts, num, w4accCnt)",
        "    for (Var i, 0, w4accCnt - 1, 1)",
        "        if (accounts[i].number == num)",
        "            return true;",
        "        end;",
        "    end;",
        "End;"
    ].join("\n");
    const items = diagnosticsFor(source);

    assert.ok(!items.some(item =>
        item.code === "unused-declaration" && /переменная i/i.test(item.message)
    ));
});

test("FOR по массиву объявляет элемент цикла", () => {
    const source = [
        "Macro Process(Accounts)",
        "    for (Var account, Accounts)",
        "        account.Process();",
        "    end;",
        "End;"
    ].join("\n");
    const items = diagnosticsFor(source);

    assert.ok(!items.some(item =>
        item.code === "unused-declaration" && /переменная account/i.test(item.message)
    ));
});

test("Поле класса в индексированном присваивании не становится локальной переменной", () => {
    const source = [
        "Private class CBlockInfo(tag)",
        "    Var BlockSum = TArray();",
        "    Macro Parse(xml)",
        "        for (Var x, 0, 1, 1)",
        "            BlockSum[BlockSum.Size] = xml.Item(x);",
        "        end;",
        "    End;",
        "End;"
    ].join("\n");
    const items = diagnosticsFor(source);

    assert.ok(!items.some(item =>
        item.code === "unused-declaration" && /BlockSum/i.test(item.message)
    ));
    assert.ok(!items.some(item =>
        item.code === "duplicate-declaration" && /BlockSum/i.test(item.message)
    ));
});

console.log("");
console.log(`Пройдено: ${passed}`);
console.log(`Ошибок: ${failed}`);

if (failed > 0) {
    process.exitCode = 1;
}

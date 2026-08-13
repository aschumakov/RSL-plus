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

const { createSymbolTree } = require("./test-helpers");
const { getDefaults } = require("../server/out/defaults");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const {
    buildLocalRslDiagnostics,
    buildRslDiagnostics,
    buildWorkspaceRslDiagnostics
} = require("../server/out/diagnostics");
const {
    RslDiagnosticEngine
} = require("../server/out/diagnostics/diagnosticEngine");

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
    return open
        ? index.updateOpenModule(uri, source, 1)
        : index.updateExternalModule(uri, source, 1);
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

test("ARRAY считается устаревшим, RECORD — нет", () => {
    const items = diagnosticsFor(
        "Array Values: Integer;\nRecord Buffer(\"buffer.dat\") normal mem;"
    );
    const deprecated = items.filter(value => value.code === "deprecated-declaration");
    assert.strictEqual(deprecated.length, 1);
    assert.ok(/ARRAY/.test(deprecated[0].message));
});

test("FILE считается устаревшим и рекомендует Tbfile", () => {
    const items = diagnosticsFor("File Texts(\"texts.dat\") normal txt 120;");
    const item = items.find(value => value.code === "deprecated-declaration");
    assert.ok(item);
    assert.ok(/Tbfile/.test(item.message));
});

test("LOCAL переменная модуля недоступна обычной процедуре", () => {
    const source = [
        "Local Var str;",
        "Macro MyProc1()",
        "  str = \"Hello!\";",
        "End;",
        "Local Macro MyMacro1()",
        "  str = \"Hello!\";",
        "End;"
    ].join("\n");
    const items = diagnosticsFor(source);
    const violations = items.filter(value =>
        value.code === "local-visibility-violation"
    );
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].range.start.line, 2);
});

test("LOCAL свойство класса недоступно обычному методу", () => {
    const source = [
        "Class MyClass",
        "  Var prop1 = 200;",
        "  Local Var lvar = 300;",
        "  Macro Method1()",
        "    println(lvar);",
        "  End;",
        "  Local Macro LocProc()",
        "    println(lvar);",
        "  End;",
        "End;"
    ].join("\n");
    const items = diagnosticsFor(source);
    const violations = items.filter(value =>
        value.code === "local-visibility-violation"
    );
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].range.start.line, 4);
});

/*
 * Параметр Macro — не модификатор LOCAL.
 *
 * Внутренне у них одна и та же visibility "local", и правило про LOCAL модуля
 * объявляло параметр внешнего Macro недоступным во вложенном в него Macro —
 * причём сообщением про процедуру инициализации модуля, к которой параметр
 * отношения не имеет. Проверка включается только при наличии в файле хотя бы
 * одного настоящего LOCAL-объявления, поэтому оно здесь обязательно.
 */
test("параметр внешней Macro доступен во вложенной Macro", () => {
    const source = [
        "Local Var кэшМодуля;",
        "Private Macro checkException(субъект_)",
        "  Private Macro checkServkind(ptk)",
        "    if (СрокОбслуживанияКлиента(Субъект_.partyid, ptk) == 0)",
        "      return true;",
        "    End;",
        "    return false;",
        "  End;",
        "  return checkServkind(1);",
        "End;"
    ].join("\n");
    const violations = diagnosticsFor(source).filter(value =>
        value.code === "local-visibility-violation"
    );
    assert.deepStrictEqual(
        violations.map(value => value.message),
        [],
        "Параметр внешней Macro виден вложенной и не является LOCAL модуля"
    );
});

/* Параметр не должен и глушить правило: настоящее нарушение рядом с ним ловится. */
test("параметр Macro не отменяет проверку LOCAL модуля", () => {
    const source = [
        "Local Var str;",
        "Private Macro Outer(параметр_)",
        "  Private Macro Inner(p)",
        "    return параметр_ + p;",
        "  End;",
        "  str = \"Hello!\";",
        "  return Inner(1);",
        "End;"
    ].join("\n");
    const violations = diagnosticsFor(source).filter(value =>
        value.code === "local-visibility-violation"
    );
    assert.strictEqual(
        violations.length,
        1,
        "LOCAL модуля из обычной Private Macro по-прежнему недоступен"
    );
    assert.strictEqual(violations[0].range.start.line, 5);
});

test("Денежная константа без цифр — ошибка", () => {
    const items = diagnosticsFor("Macro Test()\n Var a = $146;\n Var b = $;\nEnd;");
    assert.strictEqual(
        items.filter(value => value.code === "invalid-money-constant").length,
        1
    );
});

test("Слишком длинное имя macro-файла — ошибка, а не рекомендация", () => {
    const index = new WorkspaceIndex();
    const longName = "a".repeat(25);
    const uri = `file:///${longName}.mac`;
    index.registerWorkspaceFiles([uri]);
    const module = createModule(index, uri, "Macro Test()\nEnd;");
    const items = buildRslDiagnostics(module, index);
    const item = items.find(value => value.code === "macro-file-name-too-long");
    assert.ok(item);
    assert.strictEqual(item.severity, 1);
});

test("Специализированные ссылочные типы считаются устаревшими", () => {
    const source = [
        "Macro Test()",
        "  Var a: BtFileRef;",
        "  Var b: StrucRef;",
        "  Var c: ArrayRef;",
        "  Var d: TxtFileRef;",
        "  Var e: DbfFileRef;",
        "End;"
    ].join("\n");
    const items = diagnosticsFor(source);
    const deprecated = items.filter(value => value.code === "deprecated-declaration");
    assert.strictEqual(deprecated.length, 5);
    assert.ok(deprecated.every(item => /обобщённый объект/.test(item.message)));
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

test("Передача локальной переменной через @ считается использованием", () => {
    const items = diagnosticsFor([
        "Macro Test(getrecive)",
        " Var opendate, proldate;",
        " GetDepositorInfo(getrecive, @opendate, @proldate);",
        "End;"
    ].join("\n"));
    const unusedMessages = items
        .filter(item => item.code === "unused-declaration")
        .map(item => item.message.toLowerCase());

    assert.ok(!unusedMessages.some(message => message.includes("opendate")));
    assert.ok(!unusedMessages.some(message => message.includes("proldate")));
});

test("SPNAME допустим в объявлении VAR", () => {
    const items = diagnosticsFor([
        "Private Var {oper};",
        "Private Var {OurBank};",
        "Macro Test()",
        " result = {oper} + {OurBank};",
        "End;"
    ].join("\n"));

    assert.ok(!items.some(item =>
        item.code === "expected-variable-name"
    ));
    assert.ok(!items.some(item =>
        item.code === "unused-declaration" &&
        /\\{oper\\}|\\{ourbank\\}/i.test(item.message)
    ));
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

test("Общесистемная спецпеременная {oper} не считается неоднозначной", () => {
    const source = [
        "Import first, second;",
        "Macro Test(order)",
        " If(not ЗаведующийКассы(order.fncash, {oper}))",
        " End;",
        "End;"
    ].join("\n");
    const items = diagnosticsFor(source, index => {
        createModule(index, "file:///first.mac", "Macro oper()\nEnd;", false);
        createModule(index, "file:///second.mac", "Macro oper()\nEnd;", false);
    });

    assert.ok(!items.some(item =>
        item.code === "ambiguous-reference" &&
        /oper/i.test(item.message)
    ));
});

test("Общесистемные спецпеременные имеют документированные типы", () => {
    const expectedTypes = new Map([
        ["oper", "integer"],
        ["curdate", "date"],
        ["BPromUse", "bool"],
        ["MFO_Bank", "string"],
        ["BranchCurDate", "string"]
    ]);

    for (const [name, expectedType] of expectedTypes) {
        const variable = getDefaults().find(`{${name}}`);
        assert.ok(variable, `Не найдена спецпеременная ${name}`);
        assert.strictEqual(variable.typeName, expectedType);
        assert.strictEqual(variable.completionItem.insertText, `{${name}}`);
    }
});

test("Обычное имя oper без фигурных скобок всё ещё проверяется", () => {
    const source = [
        "Import first, second;",
        "Macro Test()",
        " oper();",
        "End;"
    ].join("\n");
    const items = diagnosticsFor(source, index => {
        createModule(index, "file:///first.mac", "Macro oper()\nEnd;", false);
        createModule(index, "file:///second.mac", "Macro oper()\nEnd;", false);
    });

    assert.ok(items.some(item =>
        item.code === "ambiguous-reference" &&
        /oper/i.test(item.message)
    ));
});

test("Верхнеуровневый END завершает unit без ошибки extra-end", () => {
    const items = diagnosticsFor([
        "Private Var {oper};",
        "{oper} = 1;",
        "End;",
        "Println(\"этот код не выполняется\");"
    ].join("\n"));

    assert.ok(!items.some(item => item.code === "extra-end"));
    assert.ok(items.some(item =>
        item.code === "unreachable-after-unit-end" &&
        /не выполняется/i.test(item.message)
    ));
});

test("Текст после конструкции END, тут конец помечается недостижимым", () => {
    const items = diagnosticsFor([
        "Println(\"start\");",
        "End, тут конец"
    ].join("\n"));

    assert.ok(!items.some(item => item.code === "extra-end"));
    assert.ok(items.some(item =>
        item.code === "unreachable-after-unit-end"
    ));
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

test("Верхнеуровневый ONERROR не скрывает структурные ошибки", () => {
    const onErrorItems = diagnosticsFor([
        "Macro Test()",
        "End;",
        "OnError(err)",
        "  Return err.Message;"
    ].join("\n"));
    assert.ok(!onErrorItems.some(item =>
        String(item.code || "").toLowerCase() === "onerror-outside-macro"
    ));

    const missingEndItems = diagnosticsFor(
        "If (true)\n  Var value;"
    );
    assert.ok(missingEndItems.some(item =>
        String(item.code || "").toLowerCase().includes("end")
    ));
});

test("ONERROR проверяется по допустимой области и количеству", () => {
    const nested = diagnosticsFor([
        "Macro Test()",
        "  If (true)",
        "    OnError()",
        "  End;",
        "End;"
    ].join("\n"));
    assert.ok(nested.some(item =>
        item.code === "invalid-onerror-context"
    ));

    const duplicate = diagnosticsFor([
        "Macro Test()",
        "OnError(first)",
        "  OnError(second)",
        "End;"
    ].join("\n"));
    assert.ok(duplicate.some(item =>
        item.code === "duplicate-onerror"
    ));
});

test("Diagnostic engine подключает правила через реестр и применяет лимит", () => {
    const source = "Macro Test()\nEnd;";
    const index = new WorkspaceIndex();
    const indexedModule = createModule(
        index,
        "file:///registry.mac",
        source
    );
    const engine = new RslDiagnosticEngine();
    engine.register({
        id: "custom-test",
        run: () => [{
            code: "custom-test",
            message: "custom",
            severity: 2,
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 }
            }
        }]
    });

    const diagnostics = engine.build(
        indexedModule,
        index,
        { maxProblems: 1 }
    );
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, "custom-test");
    assert.throws(() =>
        engine.register({ id: "custom-test", run: () => [] })
    );
});

test("Workspace-фаза не повторяет parser и локальные диагностики", () => {
    const index = new WorkspaceIndex();
    const module = index.updateOpenModule(
        "file:///split.mac",
        "Macro Broken()\n  Var unused;",
        1
    );
    const local = buildLocalRslDiagnostics(module, index);
    const workspaceOnly = buildWorkspaceRslDiagnostics(module, index);
    assert.ok(local.some(item => item.code === "missing-end"));
    assert.ok(!workspaceOnly.some(item => item.code === "missing-end"));
    assert.ok(!workspaceOnly.some(item => item.code === "unused-declaration"));
});

/*
 * Обращение к члену переменной, объявленной скалярным типом.
 *
 * Объявление типа в RSL — это приведение: у `Var sql: String` результат любого
 * присваивания приводится к строке, а у строки нет ни свойств, ни методов.
 */
const RECORDSET_SOURCE = [
    "Class Recordset",
    "  Macro MoveNext()",
    "  End;",
    "End;"
].join("\n");

test("обращение к члену строки — ошибка", () => {
    const source = [
        RECORDSET_SOURCE,
        "Macro Test(DocKind, id)",
        "    Var sql: String;",
        "    sql = \"select t_id_operation from doproper_dbt\";",
        "    sql = ExecSqlSelect (sql, MakeArray (SqlParam (\"kind\", DocKind)));",
        "    If (sql.MoveNext())",
        "        msgbox(\"1111\");",
        "    End;",
        "End;"
    ].join("\n");
    const index = new WorkspaceIndex();
    const module = index.updateOpenModule("file:///scalar.mac", source, 1);
    const found = buildRslDiagnostics(module, index)
        .filter(item => item.code === "member-on-scalar-type");

    assert.strictEqual(found.length, 1, JSON.stringify(found));
    assert.strictEqual(found[0].severity, 1, "Это ошибка, а не подсказка");
    assert.ok(
        /sql.*String.*MoveNext/.test(found[0].message),
        found[0].message
    );

    /* Подчёркивается имя члена, а не вся строка. */
    const memberStart = source.indexOf("sql.MoveNext") + 4;
    const lineStart = source.lastIndexOf("\n", memberStart) + 1;
    assert.strictEqual(
        found[0].range.start.character,
        memberStart - lineStart
    );
});

test("объявления без приведения к скаляру ошибкой не считаются", () => {
    const legal = [
        "    Var sql;",
        "    Var sql: Variant;",
        "    Var sql = \"aaa\";",
        "    Var sql: Object;",
        "    Var sql: Recordset;"
    ];

    for (const declaration of legal) {
        const source = [
            RECORDSET_SOURCE,
            "Macro Test()",
            declaration,
            "    sql = Recordset ();",
            "    If (sql.MoveNext())",
            "    End;",
            "End;"
        ].join("\n");
        const index = new WorkspaceIndex();
        const module = index.updateOpenModule("file:///legal.mac", source, 1);

        assert.deepStrictEqual(
            buildRslDiagnostics(module, index)
                .filter(item => item.code === "member-on-scalar-type")
                .map(item => item.message),
            [],
            `Декларация ${declaration.trim()} обращение к члену допускает`
        );
    }
});

console.log("");
console.log(`Пройдено: ${passed}`);
console.log(`Ошибок: ${failed}`);

if (failed > 0) {
    process.exitCode = 1;
}

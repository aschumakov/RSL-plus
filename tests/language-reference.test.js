"use strict";

/**
 * Единый справочник языка и его потребители.
 *
 * Раньше списки ключевых слов, типов и модификаторов лежали в восьми местах и
 * расходились по составу. Здесь проверяется и сам справочник, и то, что
 * потребители берут состав из него: parser, formatter, folding, diagnostics,
 * Semantic Tokens, Completion и TextMate-грамматика.
 */

const assert = require("assert");

const reference = require("../server/out/language/rslLanguageReference");
const { parseRslSyntax } = require("../server/out/syntaxParser");
const {
    extractCompactDeclarations
} = require("../server/out/analysis/declarationExtractor");
const {
    createExternalModuleSummary,
    createOpenModuleModel
} = require("../server/out/moduleModel");
const { FormatCode } = require("../server/out/format");
const { GetFoldingRanges } = require("../server/out/folding");

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

function names(symbols) {
    return symbols.map(item => item.name);
}

test("справочник описывает язык одним списком", () => {
    /* Модификаторы видимости: ровно два, PUBLIC среди них нет. */
    assert.deepStrictEqual(
        Array.from(reference.DECLARATION_MODIFIERS).sort(),
        ["local", "private"]
    );

    assert.ok(!reference.isDeclarationModifier("public"));
    assert.ok(!reference.isRslKeyword("public"));
    assert.ok(!reference.isReservedWord("public"));

    /* Границы блоков собираются из END и ветвей, а не переписываются. */
    assert.deepStrictEqual(
        Array.from(reference.BLOCK_BOUNDARY_KEYWORDS),
        ["end", "else", "elif", "onerror"]
    );

    /* Слово-оператор ключевым словом является, зарезервированным именем тоже. */
    assert.ok(reference.isWordOperator("not"));
    assert.ok(reference.isReservedWord("not"));

    /* CPDOS и CPWIN — ключевые слова, но именами быть могут. */
    assert.ok(reference.isRslKeyword("cpwin"));
    assert.ok(!reference.isReservedWord("cpwin"));

    /*
     * Скалярные типы — по таблице «Скалярные типы» раздела «Типы данных».
     * Список закреплён целиком: он отвечает не только за подсказку типа, но и
     * за проверку обращения к членам, а руководство делит все типы на скалярные
     * и объектные и члены даёт только объектным.
     */
    assert.deepStrictEqual(
        reference.SCALAR_TYPES.map(item => item.keyword),
        [
            "Integer", "Double", "DoubleL", "String", "Bool", "Date", "Time",
            "DateTime", "MemAddr", "ProcRef", "MethodRef", "Decimal",
            "Numeric", "Money", "MoneyL", "SpecVal"
        ]
    );

    /*
     * Код типа из той же таблицы. У SpecVal символьной константы нет —
     * руководство называет только числовое значение 26.
     */
    assert.deepStrictEqual(
        reference.SCALAR_TYPES
            .filter(item => !item.typeCode)
            .map(item => item.keyword),
        ["SpecVal"]
    );
    for (const item of reference.SCALAR_TYPES) {
        assert.ok(item.title, `${item.keyword}: название обязано быть`);

        if (item.typeCode) {
            assert.ok(
                reference.VALUE_TYPE_CONSTANTS.includes(item.typeCode),
                `${item.keyword}: код ${item.typeCode} обязан быть среди ` +
                    "констант кода типа"
            );
        }
    }

    /* Скалярный — значит без членов. Variant и Object скалярными не являются. */
    assert.ok(reference.isScalarRslType("String"));
    assert.ok(reference.isScalarRslType("date"));
    assert.ok(reference.isScalarRslType("MethodRef"));
    assert.ok(!reference.isScalarRslType("Variant"));
    assert.ok(!reference.isScalarRslType("Object"));
    assert.ok(!reference.isScalarRslType("RsdCommand"));

    /*
     * R2M типом не является: руководство знает процедуру R2M, а тип называется
     * MethodRef с кодом V_R2M. В позиции типа R2M предлагать нельзя.
     */
    assert.ok(!reference.isRslType("R2M"));
    assert.ok(reference.isRslType("MethodRef"));

    /* Синонимы типов из подраздела «Особенности реализации типов». */
    assert.strictEqual(reference.TYPE_SYNONYMS.get("doublel"), "double");
    assert.strictEqual(reference.TYPE_SYNONYMS.get("moneyl"), "money");
    assert.strictEqual(reference.TYPE_SYNONYMS.get("decimal"), "numeric");

    /* Тип: примитив приводится к канонической форме, класс — нет. */
    assert.ok(reference.isRslType("INTEGER"));
    assert.ok(reference.isRslType("@Integer"));
    assert.strictEqual(reference.canonicalTypeName("INTEGER"), "integer");
    assert.strictEqual(reference.displayTypeName("integer"), "Integer");
    assert.strictEqual(reference.canonicalTypeName("RsdCommand"), "RsdCommand");

    /* Системные константы: литералы, VALTYPE и коды типа значения. */
    assert.ok(reference.isRslSystemConstant("V_MONEYL"));
    assert.ok(reference.isRslSystemConstant("valtype"));
    assert.ok(!reference.isRslSystemConstant("Amount"));

    /* Устаревшие конструкции: RECORD в списке быть не должен. */
    assert.ok(reference.deprecatedConstructMessage("ARRAY"));
    assert.ok(reference.deprecatedConstructMessage("BtFileRef"));
    assert.strictEqual(
        reference.deprecatedConstructMessage("record"),
        undefined
    );

    /*
     * Идентификаторы, которые не являются ссылкой на символ: ключевые слова и
     * спецификаторы FILE/RECORD. APPEND входил в спецификаторы parser-а и не
     * входил в этот список Semantic Tokens.
     */
    assert.ok(reference.isNonSymbolIdentifier("append"));
    assert.ok(reference.isNonSymbolIdentifier("onerror"));
    assert.ok(!reference.isNonSymbolIdentifier("Amount"));
});

/*
 * PUBLIC не модификатор и не ключевое слово.
 *
 * Компилятор RSL во всех проверенных случаях отвечает «неопределенный
 * идентификатор Public». Значит `Public Var x;` — это выражение `Public`, за
 * которым идёт объявление, а не объявление с модификатором.
 */
test("PUBLIC не модификатор ни в открытой, ни в компактной модели", () => {
    const source = [
        "Public Var moduleVariable;",
        "Public Macro Exported()",
        "End;",
        "Public Class Exposed",
        "End;"
    ].join("\n");

    /* Открытая модель: PUBLIC не даёт modifier ни одному объявлению. */
    const syntax = parseRslSyntax(source);
    const modifiers = [];
    const walk = node => {
        if (node.modifier) {
            modifiers.push(node.modifier);
        }
        node.children.forEach(walk);
    };
    walk(syntax.root);
    assert.deepStrictEqual(modifiers, []);

    /* Public — обычное имя, а не модификатор: своих диагностик он не даёт. */
    assert.deepStrictEqual(syntax.diagnostics, []);

    /*
     * Объявления при этом сохраняются: компилятор ругается ровно на одно слово
     * Public, и терять из-за него всю строку незачем.
     *
     * Компактная модель обязана дать то же самое. Раньше она принимала PUBLIC за
     * модификатор, а полная — нет: переход по такому имени работал из соседнего
     * файла и не работал в самом файле.
     */
    const expected = ["Exported", "Exposed", "moduleVariable"];
    const open = createOpenModuleModel(source, syntax);
    const compact = extractCompactDeclarations(source, {
        includePrivate: true
    });

    assert.deepStrictEqual(names(open.symbolTree.children).sort(), expected);
    assert.deepStrictEqual(
        compact.declarations.map(item => item.name).sort(),
        expected,
        "Открытая и компактная модель обязаны совпадать"
    );

    /* Видимость публичная — потому что LOCAL и PRIVATE нет, а не из-за PUBLIC. */
    assert.ok(
        open.symbolTree.children.every(item => item.visibility === "public")
    );
});

test("публичная видимость остаётся значением по умолчанию", () => {
    const source = [
        "Var openVariable;",
        "Private Var hidden;",
        "Local Var scoped;",
        "Macro Exported()",
        "End;",
        "Private Macro Internal()",
        "End;"
    ].join("\n");
    const open = createOpenModuleModel(source, parseRslSyntax(source));
    const visibility = new Map(
        open.symbolTree.children.map(item => [item.name, item.visibility])
    );

    assert.strictEqual(visibility.get("openVariable"), "public");
    assert.strictEqual(visibility.get("Exported"), "public");
    assert.strictEqual(visibility.get("hidden"), "private");
    assert.strictEqual(visibility.get("scoped"), "local");

    /* Во внешний summary попадает только то, что видно по умолчанию. */
    const external = createExternalModuleSummary(source);
    assert.deepStrictEqual(
        names(external.symbolTree.children).sort(),
        ["Exported", "openVariable"]
    );
});

test("formatter и folding берут границы блоков из справочника", () => {
    const source = [
        "Private Macro Demo()",
        "If (true)",
        "Var x;",
        "Else",
        "Var y;",
        "End;",
        "End;"
    ].join("\n");
    const formatted = FormatCode(source, 4);

    assert.ok(
        formatted.includes("\n    If (true)"),
        `Блок Macro обязан задавать отступ:\n${formatted}`
    );
    assert.ok(
        formatted.includes("\n    Else"),
        `Else обязан стоять на уровне владельца:\n${formatted}`
    );

    const folding = GetFoldingRanges(source);
    assert.ok(
        folding.some(range => range.startLine === 0),
        "Macro с модификатором обязан складываться"
    );
});

test("TextMate-грамматика генерируется из справочника", () => {
    const {
        generate,
        readGrammar,
        serialize
    } = require("../build/generate-grammar");

    assert.strictEqual(
        serialize(readGrammar()),
        serialize(generate(readGrammar(), reference)),
        "syntaxes/rsl.tmLanguage.json разошлась со справочником; " +
            "запустите node build/generate-grammar.js --write"
    );

    const grammar = readGrammar();
    const words = JSON.stringify(grammar);

    assert.ok(
        !/\bpublic\b/i.test(words),
        "PUBLIC не имеет права подсвечиваться как ключевое слово"
    );
    assert.ok(
        /append/i.test(words),
        "Спецификатор APPEND обязан попасть в подсветку из справочника"
    );
});

test("каталог прикладных модулей проходит проверки генератора", () => {
    const {
        readCatalog,
        buildClassOwners,
        collectProblems,
        standardLibraryClasses
    } = require("../build/platform-modules");

    const { modules } = readCatalog();
    const owners = buildClassOwners(modules);
    const { problems } = collectProblems(
        modules,
        owners,
        standardLibraryClasses()
    );

    assert.deepStrictEqual(
        problems.map(item => `${item.kind} ${item.module}: ${item.detail}`),
        [],
        "Данные прикладных модулей обязаны быть согласованы"
    );
});

if (failed > 0) {
    console.error(`\nПройдено: ${passed}\nОшибок: ${failed}`);
    process.exitCode = 1;
} else {
    console.log(`\nПройдено: ${passed}\nОшибок: ${failed}`);
}

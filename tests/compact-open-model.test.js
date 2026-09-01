"use strict";

/**
 * Закрытие разобранного файла не сканирует его заново.
 *
 * Полная модель открытого документа уже содержит дерево символов, импорты и
 * диапазоны объявлений. Но при закрытии внешняя сводка строилась вызовом
 * extractCompactDeclarations по исходному тексту — то есть только что
 * разобранный файл разбирался ещё раз.
 *
 * Проверяется два утверждения: сводка из модели совпадает со сводкой из текста
 * по всему, что видно снаружи, и повторного сканирования при этом нет.
 */

const assert = require("assert");
const Module = require("module");

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

const extractorPath = require.resolve(
    "../server/out/analysis/declarationExtractor"
);
const extractor = require(extractorPath);
const {
    compactOpenModuleModel,
    createExternalModuleSummary,
    createOpenModuleModel
} = require("../server/out/moduleModel");

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

const SOURCE = [
    "Import alpha, \"beta.mac\";",
    "",
    "Const MAX_SIZE = 10;",
    "Var moduleLevel: String;",
    "",
    "Macro Public(value, other)",
    "  Var local = value;",
    "  return local;",
    "End;",
    "",
    "private Macro Hidden(x)",
    "  return x;",
    "End;",
    "",
    "Class (BaseHolder) Holder",
    "  Var Code: String;",
    "  Const Kind = 1;",
    "  Macro Load(id)",
    "    Var inner = id;",
    "    return inner;",
    "  End;",
    "End;",
    "",
    "Class Пустой",
    "  Var Поле: Number;",
    "End;",
    ""
].join("\n");

/** Диапазон каждого объявления дерева: путь имён -> диапазон. */
function definitionRangesOf(model) {
    const found = [];
    const walk = (symbol, path) => {
        const here = path ? path + "." + symbol.name : symbol.name;
        const range = model.definitionRanges?.get(symbol);

        if (range) {
            found.push([here, JSON.stringify(range)]);
        }
        symbol.children.forEach(child => walk(child, here));
    };

    model.symbolTree.children.forEach(symbol => walk(symbol, ""));

    return found.sort((left, right) => left[0].localeCompare(right[0]));
}

/** Всё, что видно снаружи, в сравнимом виде. */
function describe(model) {
    const walk = (symbol, into) => ({
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        visibility: symbol.visibility,
        range: { ...symbol.range },
        selectionRange: { ...symbol.selectionRange },
        typeName: symbol.typeName,
        value: symbol.value,
        parameterText: symbol.parameterText,
        baseClassName: symbol.baseClassName,
        children: into ? symbol.children.map(item => walk(item, into)) : []
    });

    return {
        kind: model.kind,
        sourceLength: model.sourceLength,
        imports: model.imports,
        source: model.source,
        tokens: model.lex.tokens.length,
        /*
         * Диапазоны сравниваются настоящим поиском по символам дерева.
         *
         * Прежде здесь стоял Object.keys по Map — он всегда даёт пустой
         * массив, и проверка сравнивала ноль с нулём.
         */
        definitionRanges: definitionRangesOf(model),
        tree: model.symbolTree.children.map(item => walk(item, true))
    };
}

test("сводка из модели совпадает со сводкой из текста", () => {
    const fromSource = createExternalModuleSummary(SOURCE);
    const fromModel = compactOpenModuleModel(createOpenModuleModel(SOURCE));

    assert.deepStrictEqual(
        describe(fromModel),
        describe(fromSource),
        "два пути обязаны давать одно и то же"
    );
});

test("сводка из модели не удерживает тяжёлое состояние", () => {
    const compacted = compactOpenModuleModel(createOpenModuleModel(SOURCE));

    assert.strictEqual(compacted.kind, "external");
    assert.strictEqual(compacted.source, "", "исходник не удерживается");
    assert.strictEqual(
        compacted.lex.tokens.length,
        0,
        "поток токенов не удерживается"
    );
    assert.strictEqual(
        compacted.syntax.root.children.length,
        0,
        "дерево разбора не удерживается"
    );

    const callable = compacted.symbolTree.children
        .find(item => item.name === "Public");

    assert.ok(callable, "процедура обязана остаться");
    assert.deepStrictEqual(
        callable.children.map(item => item.name),
        [],
        "параметры и локальные имена внешней сводке не нужны"
    );
});

test("закрытие не запускает повторное сканирование", () => {
    const open = createOpenModuleModel(SOURCE);
    const original = extractor.extractCompactDeclarations;
    let calls = 0;

    extractor.extractCompactDeclarations = function (...args) {
        calls++;

        return original.apply(this, args);
    };

    try {
        compactOpenModuleModel(open);
    } finally {
        extractor.extractCompactDeclarations = original;
    }

    assert.strictEqual(
        calls,
        0,
        "разобранный файл не имеет права сканироваться заново"
    );
});

test("уже сжатая модель возвращается как есть", () => {
    const external = createExternalModuleSummary(SOURCE);

    assert.strictEqual(compactOpenModuleModel(external), external);
});

test("пустой файл", () => {
    assert.deepStrictEqual(
        describe(compactOpenModuleModel(createOpenModuleModel(""))),
        describe(createExternalModuleSummary("")),
        "пустой файл обязан сжиматься так же"
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

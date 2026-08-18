"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

/* Language server подменяется, чтобы unit-тест не запускал IPC transport. */
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
const { lexRsl, tokenAtOffset } = require("../server/out/lexer");
const { parseRslSyntax } = require("../server/out/syntaxParser");
const { GetFoldingRanges } = require("../server/out/folding");

function testSqlInjectionGrammar() {
    const grammarPath = path.join(
        __dirname,
        "..",
        "syntaxes",
        "rsl.SQL_SB_injection.json"
    );
    const grammar = JSON.parse(fs.readFileSync(grammarPath, "utf8"));
    const block = grammar.patterns[0];
    const begin = new RegExp(block.begin);
    const end = new RegExp(block.end);

    assert.strictEqual(grammar.injectionSelector, "L:source.mac");
    assert.ok(begin.test("   ["));
    assert.ok(end.test("   ];"));
    assert.ok(end.test("] (Account, Summa:l);"));
    assert.ok(block.patterns.some(item =>
        item.include === "#sqlSingleQuotedString"
    ));
    assert.ok(block.patterns.some(item =>
        item.include === "#sqlLineComment"
    ));
    assert.strictEqual(block.name, "meta.embedded.block.sql.rsl");
}

function testLargeSqlMacro() {
    const sqlBlock = [
        "[",
        "DECLARE",
        "  v_number VARCHAR2(1000);",
        "BEGIN",
        "  v_number := regexp_replace('123', '[^[[:digit:]]]*');",
        "  v_number := SUBSTR(v_number, INSTR(v_number, '\\', -1) + 1);",
        "  -- ] не закрывает capture-блок",
        "  /* ] также не закрывает capture-блок */",
        "END;",
        "];"
    ].join("\n");
    const oneMacro = [
        "macro LargeSqlMacro(value)",
        "var sql;",
        "lStartCapture();",
        sqlBlock,
        "sql = lEndCapture();",
        "if (value)",
        "    return 1;",
        "end;",
        "return 0;",
        "end;"
    ].join("\n");
    const source = Array.from(
        { length: 80 },
        (_value, index) => oneMacro.replace(
            "LargeSqlMacro",
            "LargeSqlMacro" + index
        )
    ).join("\n\n");

    const lexed = lexRsl(source);
    const squareTokens = lexed.tokens.filter(token => token.kind === "square");
    const macroTokens = lexed.tokens.filter(token =>
        token.kind === "identifier" &&
        token.value.toLowerCase() === "macro"
    );

    assert.strictEqual(squareTokens.length, 80);
    assert.strictEqual(macroTokens.length, 80);
    assert.ok(lexed.tokens.some(token => token.raw === "return"));
    assert.doesNotThrow(() => GetFoldingRanges(source));
}

function testOptimizedTokenLookup() {
    const source = [
        "Private class CTransactionW4Service",
        "",
        "    Macro init",
        `        sql = execSqlSelect ("select * from t@"+BCLinkWWay4+" where x in ('A', 'B')", null, false);`,
        "        while (sql.moveNext())",
        "            if (foo+bar > 0)",
        "                x = [",
        "                    begin",
        "                        if 1=1 then",
        "                            null;",
        "                        end if;",
        "                    end;",
        "                ];",
        "            end;",
        "        end;",
        "    End;",
        "",
        "    Macro makeTemplateRequest(funcName)",
        "        return funcName;",
        "    End;",
        "End;"
    ].join("\n");
    const tree = createSymbolTree(source);
    const tokens = lexRsl(source).tokens;
    const classNode = tree
        .children
        .find(node => node.name === "CTransactionW4Service");

    assert.ok(classNode, "Класс не найден");
    const methodNames = classNode
        .children
        .filter(node => node.isContainer)
        .map(node => node.name);
    assert.ok(methodNames.includes("init"));
    assert.ok(methodNames.includes("makeTemplateRequest"));

    function tokenAt(fragment) {
        const offset =
            source.indexOf(fragment) +
            Math.floor(fragment.length / 2);
        return tokenAtOffset(tokens, offset, true);
    }

    assert.strictEqual(tokenAt("select * from").kind, "string");
    assert.strictEqual(tokenAt("BCLinkWWay4").kind, "identifier");
    assert.strictEqual(tokenAt("begin").kind, "square");
    assert.strictEqual(
        tokenAtOffset(tokens, source.indexOf("foo+bar") + 3, false).raw,
        "+"
    );

    const startedAt = Date.now();
    for (let index = 0; index < 100000; index++) {
        tokenAtOffset(tokens, source.length - 10, true);
    }
    const elapsed = Date.now() - startedAt;
    assert.ok(
        elapsed < 2000,
        `100000 token lookups заняли ${elapsed} мс`
    );
}

/**
 * Извлечение объявлений линейно по размеру файла.
 *
 * Проверяется характер роста, а не абсолютное время. Прежний вариант требовал
 * «меньше 500 мс на 2000 объявлений»: на занятой машине этот предел иногда
 * превышался и тест падал без всякой регрессии, то есть сообщал не о том, о чём
 * заведён. Квадратичный поиск токенов виден иначе — по тому, что удвоение файла
 * даёт вчетверо больше работы.
 */
function testLinearDeclarationExtraction() {
    const build = count => Array.from(
        { length: count },
        (_value, index) => [
            `Macro Procedure${index}(value: Integer)`,
            "  Var result;",
            `  result = value + ${index};`,
            "End;"
        ].join("\n")
    ).join("\n");

    const measure = count => {
        const source = build(count);
        /* Медиана трёх прогонов: одиночный замер шумит сильнее самой разницы. */
        const times = [];

        for (let attempt = 0; attempt < 3; attempt++) {
            const startedAt = process.hrtime.bigint();
            const tree = createSymbolTree(source);
            times.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
            assert.strictEqual(tree.children.length, count);
        }

        times.sort((left, right) => left - right);
        return times[1];
    };

    /* Разогрев: первый прогон платит за JIT, и на него приходится основной шум. */
    measure(200);
    const single = measure(1000);
    const double = measure(2000);
    const ratio = double / Math.max(single, 0.001);

    assert.ok(
        ratio < 3,
        `Удвоение файла увеличило время в ${ratio.toFixed(1)} раза ` +
        `(${single.toFixed(1)} мс -> ${double.toFixed(1)} мс); ` +
        "линейный обход дал бы примерно вдвое, квадратичный — вчетверо"
    );
}

/*
 * Регрессия по ревью: накопление токенов через target.push(...source)
 * передавало каждый токен отдельным аргументом вызова, и на одном очень
 * длинном операторе (свыше ~100 тысяч токенов, то есть примерно от 150КБ)
 * разбор падал с RangeError: Maximum call stack size exceeded. Файл при этом
 * синтаксически корректный.
 */
function testSingleHugeExpressionDoesNotOverflowStack() {
    const parts = ["Var total = a"];
    let size = parts[0].length;
    while (size < 600 * 1024) {
        parts.push("+a");
        size += 2;
    }
    parts.push(";");
    const source = parts.join("");
    const tokenCount = lexRsl(source).tokens.length;

    assert.ok(
        tokenCount > 150000,
        `Тест должен превышать прежний порог падения: токенов ${tokenCount}`
    );

    for (const buildExpressionTree of [false, true]) {
        const result = parseRslSyntax(source, undefined, {
            buildExpressionTree
        });
        assert.strictEqual(
            result.root.children.length,
            1,
            "Один оператор должен дать один узел верхнего уровня " +
                `(buildExpressionTree=${buildExpressionTree})`
        );
    }
}

testSqlInjectionGrammar();
console.log("[OK] grammar корректно ограничивает SQL-блок");

testSingleHugeExpressionDoesNotOverflowStack();
console.log("[OK] одно очень длинное выражение не переполняет стек");

testLargeSqlMacro();
console.log("[OK] большой макрос с SQL разбирается");

testOptimizedTokenLookup();
console.log("[OK] поиск токена использует оптимизированный индекс");

testLinearDeclarationExtraction();
console.log("[OK] извлечение деклараций остаётся линейным");

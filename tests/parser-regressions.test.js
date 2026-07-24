"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

/*
 * common.js импортирует ./server для getTree(). В unit-тесте подменяем
 * настоящий language server минимальной заглушкой.
 */
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
const { GetFoldingRanges } = require("../server/out/folding");
const { lexRsl } = require("../server/out/lexer");

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
    assert.ok(!end.test("'[^[[:digit:]]]*'"));
    assert.ok(!end.test("value := arr[index];"));
    assert.ok(!end.test("-- ] внутри комментария"));
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
    const tree = new CBase(source, 0);
    const classNode = tree
        .getChilds()
        .find(node => node.Name === "CTransactionW4Service");

    assert.ok(classNode, "Класс не найден");
    const methodNames = classNode
        .getChilds()
        .filter(node => node.isObject())
        .map(node => node.Name);
    assert.ok(methodNames.includes("init"));
    assert.ok(methodNames.includes("makeTemplateRequest"));

    function tokenAt(fragment) {
        const offset =
            source.indexOf(fragment) +
            Math.floor(fragment.length / 2);
        return tree.getCurrentToken(offset);
    }

    assert.strictEqual(tokenAt("select * from").kind, "string");
    assert.strictEqual(tokenAt("BCLinkWWay4").kind, "code");
    assert.strictEqual(tokenAt("begin").kind, "square");
    assert.strictEqual(
        tree.getCurrentToken(source.indexOf("foo+bar") + 3).str,
        "+"
    );

    const startedAt = Date.now();
    for (let index = 0; index < 100000; index++) {
        tree.getCurrentToken(source.length - 10);
    }
    const elapsed = Date.now() - startedAt;
    assert.ok(
        elapsed < 2000,
        `100000 token lookups заняли ${elapsed} мс`
    );
}

testSqlInjectionGrammar();
console.log("[OK] grammar корректно ограничивает SQL-блок");

testLargeSqlMacro();
console.log("[OK] большой макрос с SQL разбирается");

testOptimizedTokenLookup();
console.log("[OK] поиск токена использует оптимизированный индекс");

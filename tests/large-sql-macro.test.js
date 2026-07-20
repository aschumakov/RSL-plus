"use strict";

const assert = require("assert");
const path = require("path");

const { lexRsl } = require(path.join(
    __dirname,
    "..",
    "server",
    "out",
    "lexer.js"
));
const { GetFoldingRanges } = require(path.join(
    __dirname,
    "..",
    "server",
    "out",
    "folding.js"
));

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

console.log("[OK] Большой макрос с SQL regexp и обратной косой чертой разбирается");

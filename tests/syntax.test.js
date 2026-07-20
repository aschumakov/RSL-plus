"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

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

console.log("[OK] SQL-блок завершается только отдельной строкой ] или ];");

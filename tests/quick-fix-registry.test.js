"use strict";

const assert = require("assert");
const { RslQuickFixRegistry } = require("../server/out/features/quickFixRegistry");

const diagnostic = {
  code: "unused-declaration",
  message: "unused",
  range: {
    start: { line: 1, character: 2 },
    end: { line: 1, character: 3 }
  }
};
const registry = new RslQuickFixRegistry();
registry.setFallback((_module, item) => ({
  title: "Legacy",
  diagnostics: [item]
}));
registry.register("unused-declaration", (_module, item) => ({
  title: "AST fix",
  diagnostics: [item]
}));
let actions = registry.build(
  { uri: "file:///main.mac" },
  { context: { diagnostics: [diagnostic] } }
);
assert.deepStrictEqual(actions.map(item => item.title), ["AST fix"]);

const other = { ...diagnostic, code: "debugbreak" };
actions = registry.build(
  { uri: "file:///main.mac" },
  { context: { diagnostics: [other] } }
);
assert.deepStrictEqual(actions.map(item => item.title), ["Legacy"]);
console.log("[OK] registry выбирает AST-провайдер и использует legacy только как fallback");

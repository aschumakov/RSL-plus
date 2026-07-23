"use strict";

const assert = require("assert");
const { scanExternalModule } = require(
  "../server/out/indexing/externalModuleScanner"
);

const source = [
  "Import common, helpers;",
  "Macro PublicMacro(value = MakePair(left, right), second)",
  "  Var localValue = 1;",
  "End;",
  "Var PublicValue = MakePair(left, right), SecondValue;",
  "Class Customer",
  "  Macro Load(id)",
  "    Var localInMethod;",
  "  End;",
  "End;"
].join("\n");

const result = scanExternalModule(source);
assert.deepStrictEqual(result.imports.map(x => x.toLowerCase()), ["common", "helpers"]);
assert.ok(result.symbolTree.RecursiveFind("PublicMacro"));
assert.ok(result.symbolTree.RecursiveFind("Customer"));
assert.ok(result.symbolTree.RecursiveFind("Load"));
assert.ok(result.symbolTree.RecursiveFind("PublicValue"));
assert.ok(result.symbolTree.RecursiveFind("SecondValue"));
assert.strictEqual(result.symbolTree.RecursiveFind("right"), undefined);
assert.strictEqual(result.symbolTree.RecursiveFind("localValue"), undefined);
assert.strictEqual(result.symbolTree.RecursiveFind("localInMethod"), undefined);
assert.ok(result.definitionRanges.size >= 3);

console.log("[OK] external summary scanner хранит только Import и внешние символы");

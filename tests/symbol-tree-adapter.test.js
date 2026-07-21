"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vscodeLanguageServerPath = require.resolve(
  "vscode-languageserver",
  { paths: [path.join(__dirname, "..", "server")] }
);
const { CompletionItemKind } = require(vscodeLanguageServerPath);
const { CBase, RSL_PARSER_VERSION } = require("../server/out/common");

const source = [
  "import common, bankinter;",
  "var globalValue: integer = 1;",
  "macro Test(p1, p2:@integer): string",
  "  if (p1 > 0)",
  "    var insideIf = 10;",
  "  end;",
  "  for (var i: numeric, 1, 10)",
  "    insideIf = insideIf + i;",
  "  end;",
  "onerror (er)",
  "  return er.Message",
  "end;",
  "class (BaseClass) DemoClass(cp)",
  "  var Prop: integer;",
  "  macro Method(mp)",
  "    var localValue = mp;",
  "  end;",
  "end;"
].join("\n");

const tree = new CBase(source, 0);
assert.ok(RSL_PARSER_VERSION.includes("syntax-tree-adapter"));
assert.ok(tree.getSyntaxResult(), "Syntax tree должен храниться в CBase");

const rootNames = tree.getChilds().map(item => item.Name);
assert.ok(rootNames.includes("globalValue"));
assert.ok(rootNames.includes("Test"));
assert.ok(rootNames.includes("DemoClass"));

const macro = tree.getChilds().find(item => item.Name === "Test");
assert.ok(macro);
assert.strictEqual(macro.ObjKind, CompletionItemKind.Function);
const macroNames = macro.getChilds().map(item => item.Name);
assert.ok(macroNames.includes("p1"));
assert.ok(macroNames.includes("p2"));
assert.ok(macroNames.includes("insideIf"));
assert.ok(macroNames.includes("i"));
assert.ok(macroNames.includes("er"));

const loopVariable = macro.getChilds().find(item => item.Name === "i");
assert.strictEqual(loopVariable.Type.toLowerCase(), "numeric");

const errorVariable = macro.getChilds().find(item => item.Name === "er");
assert.strictEqual(errorVariable.Type.toLowerCase(), "trslerror");

const cls = tree.getChilds().find(item => item.Name === "DemoClass");
assert.ok(cls);
assert.strictEqual(cls.ObjKind, CompletionItemKind.Class);
const classNames = cls.getChilds().map(item => item.Name);
assert.ok(classNames.includes("cp"));
assert.ok(classNames.includes("Prop"));
assert.ok(classNames.includes("Method"));

const method = cls.getChilds().find(item => item.Name === "Method");
assert.strictEqual(method.ObjKind, CompletionItemKind.Method);
assert.ok(method.getChilds().some(item => item.Name === "mp"));
assert.ok(method.getChilds().some(item => item.Name === "localValue"));


const commonSource = fs.readFileSync(
  path.join(__dirname, "..", "server", "src", "common.ts"),
  "utf8"
);
assert.ok(
  !/\bNextToken\s*\(/.test(commonSource),
  "common.ts больше не должен содержать второй tokenizer NextToken"
);

console.log("[OK] legacy symbol tree построен из нового syntax tree");

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

const documentedTree = new CBase([
  "array GlobalArray;",
  "file GlobalFile(account) write;",
  "record GlobalRecord(account) mem;",
  "class Demo",
  "  array Items;",
  "  file Accounts(account) write;",
  "  record Buffer(account) mem;",
  "  local var constructorOnly;",
  "  local macro Helper()",
  "    return constructorOnly;",
  "  end;",
  "  macro PublicMethod()",
  "    return Items(0);",
  "  end;",
  "end;"
].join("\n"), 0);

const documentedRoot = documentedTree.getChilds();
assert.strictEqual(
  documentedRoot.find(item => item.Name === "GlobalArray").Type.toLowerCase(),
  "array"
);
assert.strictEqual(
  documentedRoot.find(item => item.Name === "GlobalFile").Type.toLowerCase(),
  "file"
);
assert.strictEqual(
  documentedRoot.find(item => item.Name === "GlobalRecord").Type.toLowerCase(),
  "record"
);

const documentedClass = documentedRoot.find(item => item.Name === "Demo");
const documentedMembers = documentedClass.getChilds();
assert.strictEqual(
  documentedMembers.find(item => item.Name === "Items").ObjKind,
  CompletionItemKind.Property
);
assert.strictEqual(
  documentedMembers.find(item => item.Name === "Accounts").Type.toLowerCase(),
  "file"
);
assert.strictEqual(
  documentedMembers.find(item => item.Name === "Buffer").Type.toLowerCase(),
  "record"
);
assert.strictEqual(
  documentedMembers.find(item => item.Name === "constructorOnly").ObjKind,
  CompletionItemKind.Variable
);
assert.strictEqual(
  documentedMembers.find(item => item.Name === "Helper").ObjKind,
  CompletionItemKind.Function
);
assert.strictEqual(
  documentedMembers.find(item => item.Name === "PublicMethod").ObjKind,
  CompletionItemKind.Method
);

console.log("[OK] ARRAY/FILE/RECORD и local-члены перенесены в symbol tree");

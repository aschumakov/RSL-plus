const assert = require("assert");
const path = require("path");
const vscodeLanguageServerPath = require.resolve(
  "vscode-languageserver",
  { paths: [path.join(__dirname, "..", "server")] }
);
const { CompletionItemKind } = require(vscodeLanguageServerPath);
const {
  parseRslSyntax,
  getImportNamesFromSyntax
} = require("../server/out/syntaxParser");
const {
  RSL_PARSER_VERSION
} = require("../server/out/syntax/rslIdentifiers");
const { createSymbolTree } = require("./test-helpers");

function codes(source) {
  return parseRslSyntax(source).diagnostics.map(item => item.code);
}

assert.deepStrictEqual(codes([
  "import common, bankinter;",
  "var a = 1, b: integer;",
  "macro Test(p1, p2:@integer)",
  "  if (p1 > 0)",
  "    for (var i, 0, 10, 1)",
  "      a = a + i;",
  "    end;",
  "  elif (p1 == 0)",
  "    return;",
  "  else",
  "    while (true)",
  "      break",
  "    end",
  "  end",
  "onerror (er)",
  "  return er.Code",
  "end;"
].join("\n")), []);

assert.deepStrictEqual(codes([
  "Macro SafeCall()",
  "  Return true;",
  "OnError()",
  "  Return false;",
  "End;"
].join("\n")), []);
assert.ok(
  codes("OnError(")
    .includes("expected-identifier"),
  "Незакрытый ONERROR( без имени по-прежнему должен диагностироваться"
);

assert.ok(codes("import common bankinter;").includes("missing-comma"));
assert.ok(codes("macro Test(a b)\nend").includes("missing-comma"));
assert.ok(codes("var a = 1\nvar b = 2;").includes("missing-semicolon"));
const duplicateSemicolon = parseRslSyntax(
  "import InsCarryDoc, globals, inc_utils, inc_access, inc_icm_lib;;"
).diagnostics.find(item => item.code === "duplicate-semicolon");
assert.ok(duplicateSemicolon);
assert.strictEqual(duplicateSemicolon.severity, "warning");
assert.ok(!codes(";").includes("duplicate-semicolon"));
assert.ok(codes("if (true)\n a = 1\nelse\n a = 2\nend").length === 0);
assert.ok(codes("while (true)\n a = 1;").includes("missing-end"));

console.log("[OK] syntax parser tests");

const specialNames = parseRslSyntax(
  "Private Var {oper}, {34-23-O};"
);
assert.ok(!specialNames.diagnostics.some(item =>
  item.code === "expected-variable-name"
));
assert.deepStrictEqual(
  specialNames.root.children[0].children.map(item => item.name),
  ["{oper}", "{34-23-O}"]
);

console.log("[OK] SPNAME разбирается как имя объявления");

const unitEnd = parseRslSyntax([
  "value = 1;",
  "End;",
  "value = 2;"
].join("\n"));
assert.ok(unitEnd.root.tokens.some(token =>
  token.value.toLowerCase() === "end"
));
assert.ok(unitEnd.diagnostics.some(item =>
  item.code === "unreachable-after-unit-end" &&
  item.severity === "warning"
));

console.log("[OK] верхнеуровневый END завершает unit");

const multilineXml = [
  'result = "<bis:ViolationDate>" +',
  '  strsubst(string(substr(p_OffenseDate, 7, 4), "-",',
  '                   substr(p_OffenseDate, 4, 2), "-",',
  '                   substr(p_OffenseDate, 1, 2)), " ", "0")',
  '  + "</bis:ViolationDate>" +',
  '  "</bis:request>";'
].join("\n");

assert.ok(
  !codes(multilineXml).includes("missing-semicolon"),
  "Вызов после бинарного '+' не должен считаться новой инструкцией"
);

assert.ok(
  codes("value = Calculate()\nPrintln(value);").includes("missing-semicolon"),
  "Две завершённые инструкции без ';' должны диагностироваться"
);


const pathImport = parseRslSyntax("Import lib\\common;");
assert.deepStrictEqual(
  getImportNamesFromSyntax(pathImport.root),
  ["lib\\common"],
  "Относительный путь IMPORT должен оставаться одним узлом"
);
assert.deepStrictEqual(
  pathImport.diagnostics,
  [],
  "Обратная косая черта в IMPORT не является синтаксической ошибкой"
);

function findNodes(node, kind, result = []) {
  if (node.kind === kind) {
    result.push(node);
  }
  node.children.forEach(child => findNodes(child, kind, result));
  return result;
}

const implicitStringSource = [
  'Sql1 = " select v.T_PAYERBANKNAME,v.T_PAYERNAME, "',
  '       " v.T_RECEIVERINN from dpmrmprop_dbt v "',
  '       " where v.t_paymentid=:1 ";'
].join("\n");
const implicitStringResult = parseRslSyntax(implicitStringSource);
const implicitStringCodes = implicitStringResult.diagnostics
  .map(item => item.code);

assert.ok(
  !implicitStringCodes.includes("missing-semicolon"),
  "Соседний строковый литерал не должен считаться новой инструкцией"
);
const implicitStringWarning = implicitStringResult.diagnostics
  .find(item => item.code === "implicit-string-concatenation");
assert.ok(implicitStringWarning);
assert.strictEqual(implicitStringWarning.severity, "warning");
assert.strictEqual(
  implicitStringSource
    .slice(0, implicitStringWarning.start)
    .split("\n").length - 1,
  0,
  "Предупреждение должно подчёркивать строку, после которой нужен '+'"
);
assert.ok(
  findNodes(
    implicitStringResult.root,
    "ImplicitStringConcatenationExpression"
  ).length >= 1
);

const documentedSyntax = parseRslSyntax([
  "array MyVar, First, Second;",
  "file Accounts(account) sort 0 write;",
  "record Buffer(\"account.dbt\") mem;",
  "with (this)",
  "  First(0) = Buffer.Account;",
  "  MyVar(9)(1)(2) = First[0];",
  "  ob.(10) = ob.item(10);",
  "end;"
].join("\n"));

assert.deepStrictEqual(documentedSyntax.diagnostics, []);
assert.strictEqual(
  documentedSyntax.root.children[0].kind,
  "ArrayDeclaration"
);
assert.strictEqual(
  documentedSyntax.root.children[1].kind,
  "FileDeclaration"
);
assert.strictEqual(
  documentedSyntax.root.children[1].typeName,
  "file"
);
assert.deepStrictEqual(
  documentedSyntax.root.children[1].specifiers,
  ["sort", "write"]
);
assert.strictEqual(
  documentedSyntax.root.children[2].kind,
  "RecordDeclaration"
);
assert.strictEqual(
  documentedSyntax.root.children[2].typeName,
  "record"
);
assert.strictEqual(
  documentedSyntax.root.children[3].kind,
  "WithStatement"
);

assert.ok(findNodes(documentedSyntax.root, "PostfixAccessExpression").length >= 4);
assert.ok(findNodes(documentedSyntax.root, "IndexExpression").length >= 1);
assert.ok(findNodes(documentedSyntax.root, "MemberAccessExpression").length >= 2);
assert.ok(findNodes(documentedSyntax.root, "DefaultPropertyExpression").length >= 1);
assert.ok(findNodes(documentedSyntax.root, "AssignmentExpression").length >= 3);

assert.ok(codes("array First Second;").includes("missing-comma"));
assert.ok(codes("file Accounts(account) sort;").includes("expected-key-number"));
assert.ok(codes("with (this)\n Println(1);").includes("missing-end"));

console.log("[OK] ARRAY, FILE, RECORD, WITH и постфиксные выражения разобраны");

assert.deepStrictEqual(codes("file Primary(account) sort -1;"), []);
assert.ok(
  codes("class (Base, Other) Child\nend;")
    .includes("multiple-inheritance-not-supported")
);

console.log("[OK] одиночное наследование и знаковый номер ключа проверены");

assert.ok(codes("file Accounts(account main); ").includes("missing-comma"));
assert.ok(
  codes("record Buffer(account, main, extra);")
    .includes("too-many-object-arguments")
);

console.log("[OK] параметры FILE/RECORD проверены по формальной грамматике");

const topLevelOnError = parseRslSyntax([
  "Macro Test()",
  "End;",
  "OnError(err)",
  "  Return err.Message;"
].join("\n"), undefined, {
  buildExpressionTree: false
});
assert.ok(
  topLevelOnError.root.children.some(item =>
    item.kind === "OnErrorClause"
  )
);
assert.ok(
  !topLevelOnError.diagnostics.some(item =>
    String(item.code || "").toLowerCase().includes("onerror")
  )
);
assert.ok(codes("If (true)\n  Var value;").includes("missing-end"));

console.log("[OK] ONERROR верхнего уровня не скрывает missing END");

const adaptedTreeSource = [
  "var globalValue: integer = 1;",
  "macro Test(p1, p2:@integer): string",
  "  for (var i: numeric, 1, 10)",
  "    globalValue = globalValue + i;",
  "  end;",
  "onerror (er)",
  "  return er.Message",
  "end;",
  "class (BaseClass) DemoClass(cp)",
  "  var Prop: integer;",
  "  macro Method(mp)",
  "  end;",
  "end;"
].join("\n");
const adaptedTree = createSymbolTree(adaptedTreeSource);

assert.ok(RSL_PARSER_VERSION.includes("semantic-symbols"));
const adaptedMacro = adaptedTree.children.find(
  item => item.name === "Test"
);
const adaptedClass = adaptedTree.children.find(
  item => item.name === "DemoClass"
);
assert.strictEqual(adaptedMacro.kind, CompletionItemKind.Function);
assert.ok(
  ["p1", "p2", "i", "er"].every(name =>
    adaptedMacro.children.some(item => item.name === name)
  )
);
assert.strictEqual(adaptedClass.kind, CompletionItemKind.Class);
assert.ok(
  adaptedClass.children.some(item =>
    item.name === "Method" &&
    item.kind === CompletionItemKind.Method
  )
);

const documentedTree = createSymbolTree([
  "array GlobalArray;",
  "file GlobalFile(account) write;",
  "record GlobalRecord(account) mem;",
  "class Demo",
  "  array Items;",
  "  file Accounts(account) write;",
  "  record Buffer(account) mem;",
  "  local var constructorOnly;",
  "  local macro Helper()",
  "  end;",
  "  macro PublicMethod()",
  "  end;",
  "end;"
].join("\n"));
const documentedRoot = documentedTree.children;
assert.strictEqual(
  documentedRoot.find(item => item.name === "GlobalArray").typeName.toLowerCase(),
  "array"
);
assert.strictEqual(
  documentedRoot.find(item => item.name === "GlobalFile").typeName.toLowerCase(),
  "file"
);
assert.strictEqual(
  documentedRoot.find(item => item.name === "GlobalRecord").typeName.toLowerCase(),
  "record"
);
const documentedMembers = documentedRoot
  .find(item => item.name === "Demo")
  .children;
assert.strictEqual(
  documentedMembers.find(item => item.name === "Items").kind,
  CompletionItemKind.Property
);
assert.strictEqual(
  documentedMembers.find(item => item.name === "Helper").kind,
  CompletionItemKind.Function
);
assert.strictEqual(
  documentedMembers.find(item => item.name === "PublicMethod").kind,
  CompletionItemKind.Method
);

console.log("[OK] semantic symbol tree сохраняет объявления RSL");

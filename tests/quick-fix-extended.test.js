"use strict";

const assert = require("assert");

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
const {
  applyProjectDiagnosticRules
} = require("../server/out/diagnosticPostProcessor");
const {
  buildEnhancedRslCodeActions
} = require("../server/out/enhancedCodeActions");
const { buildRslDiagnostics } = require("../server/out/diagnostics");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

let passed = 0;
let failed = 0;

function test(name, action) {
  try {
    action();
    passed++;
    console.log(`[OK] ${name}`);
  } catch (error) {
    failed++;
    console.error(`[FAIL] ${name}`);
    console.error(error);
  }
}

function createModule(source) {
  const index = new WorkspaceIndex();
  const uri = "file:///main.mac";
  const module = index.updateModule(
    uri,
    source,
    new CBase(source, 0),
    1,
    true
  );
  return { index, module };
}

function diagnosticsFor(source) {
  const { index, module } = createModule(source);
  const diagnostics = applyProjectDiagnosticRules(
    module,
    buildRslDiagnostics(module, index)
  );
  return { index, module, diagnostics };
}

function actionParams(module, diagnostic) {
  return {
    textDocument: { uri: module.uri },
    range: diagnostic.range,
    context: { diagnostics: [diagnostic] }
  };
}

function offsetAt(source, position) {
  const lines = source.split(/\r?\n/);
  let offset = 0;

  for (let line = 0; line < position.line; line++) {
    offset += lines[line].length;
    offset += source.includes("\r\n") ? 2 : 1;
  }

  return offset + position.character;
}

function applyFirstAction(source, module, diagnostic) {
  const actions = buildEnhancedRslCodeActions(
    module,
    actionParams(module, diagnostic)
  );
  assert.strictEqual(actions.length, 1);
  const edit = actions[0].edit.changes[module.uri][0];
  const start = offsetAt(source, edit.range.start);
  const end = offsetAt(source, edit.range.end);
  return source.substring(0, start) + edit.newText + source.substring(end);
}

test("Quick Fix удаляет последний элемент составного Var", () => {
  const source = [
    "Macro Test()",
    "  var param:TArray = TArray(), sqlp:SQLParam = NULL;",
    "  param.Add(1);",
    "End;"
  ].join("\n");
  const { module, diagnostics } = diagnosticsFor(source);
  const diagnostic = diagnostics.find(item =>
    item.code === "unused-declaration" && /sqlp/i.test(item.message)
  );
  assert.ok(diagnostic);

  const updated = applyFirstAction(source, module, diagnostic);
  assert.ok(updated.includes("var param:TArray = TArray();"));
  assert.ok(!/sqlp/i.test(updated));
});

test("Quick Fix удаляет одиночное многострочное объявление", () => {
  const source = [
    "Private var ListCheck3 = \"2202-2208,2211,2213,2215,2217,2219,2223,2023,2123,2124,2125,2127,2130,\"+",
    "                         //2024_03 RSBD-4839 бсч. 2242",
    "                         \"2133,2222,2022,2024,2122,2135,2138,2224,2225,2226,2231,2232,2242\";",
    "Macro Test()",
    "End;"
  ].join("\n");
  const { module, diagnostics } = diagnosticsFor(source);
  const diagnostic = diagnostics.find(item =>
    item.code === "unused-declaration" && /ListCheck3/i.test(item.message)
  );
  assert.ok(diagnostic);

  const updated = applyFirstAction(source, module, diagnostic);
  assert.strictEqual(updated, ["Macro Test()", "End;"].join("\n"));
});

test("Повторный Import имеет уровень Warning", () => {
  const source = "Import utils, utils;\nMacro Test()\nEnd;";
  const { diagnostics } = diagnosticsFor(source);
  const diagnostic = diagnostics.find(item => item.code === "duplicate-import");
  assert.ok(diagnostic);
  assert.strictEqual(diagnostic.severity, 2);
});

test("Если последний параметр обработчика используется, остальные не проверяются", () => {
  const source = [
    "Macro ExecuteStep(doc, payorder, DocKind, IdOperation, NumberStep)",
    "  NumberStep = NumberStep + 1;",
    "End;"
  ].join("\n");
  const { diagnostics } = diagnosticsFor(source);
  const unusedParameters = diagnostics.filter(item =>
    item.code === "unused-declaration" && item.data?.parameter
  );

  assert.deepStrictEqual(unusedParameters, []);
});

test("У стандартного обработчика проверяется только неиспользуемый хвост", () => {
  const source = [
    "Macro ExecuteStep(doc, payorder, DocKind, IdOperation, NumberStep)",
    "  Println(DocKind);",
    "End;"
  ].join("\n");
  const { diagnostics } = diagnosticsFor(source);
  const messages = diagnostics
    .filter(item => item.code === "unused-declaration" && item.data?.parameter)
    .map(item => item.message.toLowerCase());

  assert.strictEqual(messages.length, 2);
  assert.ok(messages.some(message => message.includes("idoperation")));
  assert.ok(messages.some(message => message.includes("numberstep")));
  assert.ok(!messages.some(message => message.includes("doc объявлен")));
  assert.ok(!messages.some(message => message.includes("payorder")));
});

test("Если параметры стандартного обработчика вообще не используются, проверяются все", () => {
  const source = [
    "Macro CheckStepAction(mes, primdoc, DocKind, IdOperation, IdStep)",
    "End;"
  ].join("\n");
  const { diagnostics } = diagnosticsFor(source);
  const unusedParameters = diagnostics.filter(item =>
    item.code === "unused-declaration" && item.data?.parameter
  );

  assert.strictEqual(unusedParameters.length, 5);
});

test("Обычный Macro по-прежнему проверяет каждый неиспользуемый параметр", () => {
  const source = [
    "Macro CustomHandler(a, b, c)",
    "  Println(c);",
    "End;"
  ].join("\n");
  const { diagnostics } = diagnosticsFor(source);
  const messages = diagnostics
    .filter(item => item.code === "unused-declaration" && item.data?.parameter)
    .map(item => item.message.toLowerCase());

  assert.strictEqual(messages.length, 2);
  assert.ok(messages.some(message => message.includes("параметр a")));
  assert.ok(messages.some(message => message.includes("параметр b")));
});

console.log("");
console.log(`Пройдено: ${passed}`);
console.log(`Ошибок: ${failed}`);

if (failed > 0) {
  process.exitCode = 1;
}

"use strict";

const assert = require("assert");
const { CBase } = require("../server/out/common");
const {
  buildImportResolutionDiagnostics
} = require("../server/out/diagnostics/importResolutionDiagnostics");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

const index = new WorkspaceIndex();
index.registerWorkspaceFiles([
  "file:///workspace/retail/common.mac",
  "file:///workspace/corporate/common.mac"
]);
const source = "Import common;\nMacro Test()\nEnd;";
const indexedModule = index.updateModule(
  "file:///workspace/main.mac",
  source,
  new CBase(source, 0),
  1,
  true
);
const diagnostics = buildImportResolutionDiagnostics(
  indexedModule,
  index,
  { structure: true }
);

assert.strictEqual(diagnostics.length, 1);
assert.strictEqual(diagnostics[0].code, "ambiguous-import");
assert.ok(diagnostics[0].message.includes("retail/common.mac"));
assert.ok(diagnostics[0].message.includes("corporate/common.mac"));
assert.strictEqual(index.findWorkspaceFileUri("common"), undefined);

console.log("[OK] неоднозначный Import диагностируется и не выбирается молча");

"use strict";

const assert = require("assert");
const { CBase } = require("../server/out/common");
const { RslDiagnosticEngine } = require("../server/out/diagnosticEngine");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

const source = "Macro Test()\nEnd;";
const index = new WorkspaceIndex();
const indexedModule = index.updateModule(
  "file:///main.mac",
  source,
  new CBase(source, 0),
  1,
  true
);
const engine = new RslDiagnosticEngine();
engine.register({
  id: "custom-test",
  run: () => [{
    code: "custom-test",
    message: "custom",
    severity: 2,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 }
    }
  }]
});
const diagnostics = engine.build(indexedModule, index, { maxProblems: 1 });
assert.strictEqual(diagnostics.length, 1);
assert.strictEqual(diagnostics[0].code, "custom-test");
assert.throws(() => engine.register({ id: "custom-test", run: () => [] }));
console.log("[OK] diagnostic engine подключает правила через реестр и применяет общий лимит");

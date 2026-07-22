"use strict";

const assert = require("assert");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

const index = new WorkspaceIndex();
index.registerWorkspaceFiles([
  "file:///workspace/retail/common.mac",
  "file:///workspace/corporate/common.mac",
  "file:///workspace/lib/unique.mac"
]);

const ambiguous = index.resolveWorkspaceFile("common");
assert.strictEqual(ambiguous.kind, "ambiguous");
assert.strictEqual(ambiguous.candidates.length, 2);
assert.strictEqual(index.findWorkspaceFileUri("common"), undefined);

const exact = index.resolveWorkspaceFile("retail/common");
assert.strictEqual(exact.kind, "resolved");
assert.strictEqual(exact.value, "file:///workspace/retail/common.mac");

const unique = index.resolveWorkspaceFile("unique");
assert.strictEqual(unique.kind, "resolved");
assert.strictEqual(unique.value, "file:///workspace/lib/unique.mac");

const missing = index.resolveWorkspaceFile("missing");
assert.strictEqual(missing.kind, "missing");

console.log("[OK] Import различает resolved, ambiguous и missing");

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { CBase } = require("../server/out/common");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

const root = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

const index = new WorkspaceIndex({ importCacheEntries: 2 });
const source = [
  "Macro PublicMacro(value)",
  "  Var localValue = 1;",
  "End;"
].join("\n");
const uri = "file:///workspace/library.mac";

index.updateModule(uri, source, new CBase(source, 0), 1, true);
const compact = index.compactModule(uri);

assert.ok(compact);
assert.strictEqual(compact.kind, "external");
assert.strictEqual(compact.isOpen, false);
assert.strictEqual(compact.source, "");
assert.strictEqual(compact.lex.tokens.length, 0);
assert.strictEqual(compact.syntax.tokens.length, 0);
assert.ok(compact.object.RecursiveFind("PublicMacro"));
assert.strictEqual(
  compact.object.RecursiveFind("localValue"),
  undefined,
  "External summary не должен удерживать локальные переменные Macro"
);

const server = read("server", "src", "server.ts");
const loader = read("server", "src", "indexing", "workspaceModuleLoader.ts");
const definition = read("server", "src", "features", "definitionProvider.ts");
const workspaceIndex = read("server", "src", "workspaceIndex.ts");
const references = read("server", "src", "analysis", "references.ts");
const diagnostics = read(
  "server", "src", "diagnostics", "diagnosticsCoordinator.ts"
);
const engine = read("server", "src", "diagnostics", "diagnosticEngine.ts");

assert.ok(!server.includes("moduleLoader.startBackgroundIndexing()"));
assert.ok(loader.includes('indexingMode: WorkspaceIndexingMode = "activeImports"'));
assert.ok(!definition.includes("externalModuleCache"));
assert.ok(workspaceIndex.includes("LruCache"));
assert.ok(workspaceIndex.includes("importContextCache"));
assert.ok(!workspaceIndex.includes("importedCompletionCache"));
assert.ok(references.includes("containsIdentifier"));
assert.ok(references.includes("withTransientOpenModule"));
assert.ok(diagnostics.includes("scheduleLocal"));
assert.ok(diagnostics.includes("scheduleWorkspace"));
assert.ok(diagnostics.includes("workspaceMaxWaitMs"));
assert.ok(engine.includes("buildLocal"));
assert.ok(engine.includes("buildWorkspace"));
assert.ok(!engine.includes("Number.MAX_SAFE_INTEGER"));

console.log("[OK] resource-патч 1.1.4 ограничивает постоянный индекс и тяжёлые кэши");

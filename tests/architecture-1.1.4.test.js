"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const packageJson = JSON.parse(read("package.json"));
const server = read("server", "src", "server.ts");
const workspaceIndex = read("server", "src", "workspaceIndex.ts");
const moduleModel = read("server", "src", "moduleModel.ts");
const engine = read("server", "src", "diagnosticEngine.ts");
const fixes = read("server", "src", "quickFixRegistry.ts");
const readme = read("README.md");
const tsconfig = JSON.parse(read("server", "tsconfig.json"));

assert.strictEqual(packageJson.version, "1.1.4");
assert.ok(readme.includes("## Что изменилось в 1.1.4"));
assert.ok(readme.includes("standard-handlers.json"));

for (const service of [
  "DocumentAnalysisService",
  "DiagnosticsCoordinator",
  "WorkspaceModuleLoader",
  "RslSettingsService",
  "RslLanguageFeatureRegistry"
]) {
  assert.ok(server.includes(service), `${service} должен подключаться server.ts`);
}
assert.ok(server.split(/\r?\n/).length < 500, "server.ts должен оставаться компактной точкой сборки");
assert.ok(!server.includes("globalSettings"), "Resource-настройки нельзя хранить в общем globalSettings");
assert.ok(!server.includes("ensureWorkspaceModulesLoaded"), "References не должен читать workspace синхронно");

assert.ok(moduleModel.includes("IRslModuleModel"));
assert.ok(moduleModel.includes("symbolTree"));
assert.ok(workspaceIndex.includes("ModuleResolution"));
assert.ok(workspaceIndex.includes('kind: "ambiguous"'));
assert.ok(workspaceIndex.includes("resolveWorkspaceFile"));
assert.ok(engine.includes("IRslDiagnosticRule"));
assert.ok(engine.includes("register(rule"));
assert.ok(fixes.includes("RslQuickFixProvider"));
assert.ok(fixes.includes("register(code"));

assert.strictEqual(tsconfig.compilerOptions.strictFunctionTypes, true);
assert.strictEqual(tsconfig.compilerOptions.noFallthroughCasesInSwitch, true);

console.log("[OK] архитектурный каркас RSL-plus 1.1.4 подключён");

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

const analysis = read("server", "src", "services", "documentAnalysisService.ts");
const coordinator = read("server", "src", "diagnostics", "diagnosticsCoordinator.ts");
const engine = read("server", "src", "diagnostics", "diagnosticEngine.ts");
const registry = read("server", "src", "features", "languageFeatureRegistry.ts");
const model = read("server", "src", "moduleModel.ts");
const scanner = read("server", "src", "indexing", "externalModuleScanner.ts");
const index = read("server", "src", "workspaceIndex.ts");

assert.ok(analysis.includes("open(document: TextDocument)"));
assert.ok(analysis.includes("changed(document: TextDocument)"));
assert.ok(analysis.includes("parseRslSyntax(text"));
assert.ok(analysis.includes("CBase.fromSyntax"));
assert.ok(!analysis.includes("new CBase(text, 0)"));

assert.ok(coordinator.includes("scheduleLocal"));
assert.ok(coordinator.includes("scheduleWorkspace"));
assert.ok(coordinator.includes("workspaceMaxWaitMs ?? 1800"));
assert.ok(coordinator.includes("getImportClosureKey"));
assert.ok(engine.includes("buildLocal"));
assert.ok(engine.includes("buildWorkspace"));

assert.ok(registry.includes("semanticTokens.onDelta"));
assert.ok(registry.includes("semanticTokens.onRange"));
assert.ok(registry.includes("await ensureDocumentParsed(document)"));
assert.ok(model.includes("scanExternalModule"));
assert.ok(scanner.includes("Однопроходный scanner"));
assert.ok(index.includes("interface IImportContext"));
assert.ok(index.includes("importContextCache"));
assert.ok(!index.includes("importedCompletionCache"));

console.log("[OK] конвейер открытия приоритизирует подсветку, folding, навигацию и двухфазные Problems");

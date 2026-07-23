"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const serverSource = fs.readFileSync(path.join(root, "server", "src", "server.ts"), "utf8");
const analysisSource = fs.readFileSync(path.join(root, "server", "src", "services", "documentAnalysisService.ts"), "utf8");
const diagnosticsSource = fs.readFileSync(path.join(root, "server", "src", "diagnostics", "diagnosticsCoordinator.ts"), "utf8");
const loaderSource = fs.readFileSync(path.join(root, "server", "src", "indexing", "workspaceModuleLoader.ts"), "utf8");
const clientSource = fs.readFileSync(path.join(root, "client", "src", "extension.ts"), "utf8");

assert.ok(
  analysisSource.includes("changeDebounceMs ?? 90") && analysisSource.includes("open(document: TextDocument)"),
  "Открытие должно разбираться сразу, изменения — с коротким debounce"
);
assert.ok(
  diagnosticsSource.includes("localDebounceMs ?? 180") && diagnosticsSource.includes("workspaceMaxWaitMs ?? 1800"),
  "Локальные Problems должны приходить быстро, workspace-фаза иметь max wait"
);
assert.ok(
  loaderSource.includes("interactiveQueue") && loaderSource.includes("backgroundQueue"),
  "Интерактивные Import должны иметь приоритет над фоновым индексом"
);
assert.ok(
  loaderSource.includes("setImmediate") && !loaderSource.includes("Promise.all("),
  "Workspace должен разбираться последовательной фоновой очередью"
);
assert.ok(
  serverSource.includes("DocumentAnalysisService") &&
    serverSource.includes("DiagnosticsCoordinator") &&
    serverSource.includes("WorkspaceModuleLoader"),
  "server.ts должен делегировать тяжёлые этапы отдельным сервисам"
);
assert.ok(!serverSource.includes("buildRslDiagnostics("), "Полная диагностика не должна находиться на горячем parse-пути server.ts");
assert.ok(!serverSource.includes("ensureWorkspaceModulesLoaded"), "Find All References не должен синхронно читать весь workspace");

const startupStart = clientSource.indexOf("client.start().then(");
const startupEnd = clientSource.indexOf("window.onDidChangeActiveTextEditor", startupStart);
const startupSource = startupStart >= 0
  ? clientSource.slice(startupStart, startupEnd >= 0 ? startupEnd : clientSource.length)
  : "";
const activeIndex = startupSource.indexOf("await notifyActiveDocument()");
const readyIndex = startupSource.indexOf('await client.sendNotification("clientReady")');
const timeoutIndex = startupSource.indexOf("setTimeout(");
const inventoryIndex = startupSource.indexOf("workspace.findFiles(");

assert.ok(
  startupStart >= 0 && activeIndex >= 0 && readyIndex > activeIndex && timeoutIndex > readyIndex && inventoryIndex > timeoutIndex,
  "Клиент должен выполнить activeDocumentChanged → clientReady и только затем отложить обход workspace"
);
assert.ok(
  startupSource.includes("archive") && startupSource.includes("backup") && startupSource.includes(".history"),
  "Фоновый обход workspace должен исключать архивные и служебные каталоги"
);
assert.ok(
  diagnosticsSource.includes("planActiveDocumentDiagnostics") && diagnosticsSource.includes("publishedSignatures"),
  "Problems должны кэшироваться и не перерисовываться без изменения"
);

console.log("[OK] parse, diagnostics, workspace index и Problems разделены и планируются без блокировки");

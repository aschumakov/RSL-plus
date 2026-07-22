"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const serverSource = fs.readFileSync(
  path.join(root, "server", "src", "server.ts"),
  "utf8"
);
const analysisSource = fs.readFileSync(
  path.join(root, "server", "src", "documentAnalysisService.ts"),
  "utf8"
);
const diagnosticsSource = fs.readFileSync(
  path.join(root, "server", "src", "diagnosticsCoordinator.ts"),
  "utf8"
);
const loaderSource = fs.readFileSync(
  path.join(root, "server", "src", "workspaceModuleLoader.ts"),
  "utf8"
);
const clientSource = fs.readFileSync(
  path.join(root, "client", "src", "extension.ts"),
  "utf8"
);

assert.ok(
  analysisSource.includes("parseDebounceMs ?? 80"),
  "Быстрый parser debounce должен оставаться коротким"
);
assert.ok(
  diagnosticsSource.includes("diagnosticsDebounceMs ?? 300"),
  "Диагностики должны выполняться отдельным отложенным этапом"
);
assert.ok(
  loaderSource.includes("interactiveQueue") &&
    loaderSource.includes("backgroundQueue"),
  "Интерактивные Import должны иметь приоритет над фоновым индексом"
);
assert.ok(
  loaderSource.includes("setImmediate") &&
    !loaderSource.includes("Promise.all("),
  "Workspace должен разбираться последовательной фоновой очередью"
);
assert.ok(
  serverSource.includes("DocumentAnalysisService") &&
    serverSource.includes("DiagnosticsCoordinator") &&
    serverSource.includes("WorkspaceModuleLoader"),
  "server.ts должен делегировать тяжёлые этапы отдельным сервисам"
);
assert.ok(
  !serverSource.includes("buildRslDiagnostics("),
  "Полная диагностика не должна находиться на горячем parse-пути server.ts"
);
assert.ok(
  !serverSource.includes("ensureWorkspaceModulesLoaded"),
  "Find All References не должен синхронно читать весь workspace"
);
assert.ok(
  clientSource.includes('"activeDocumentChanged"'),
  "Клиент должен сообщать серверу активный RSL-файл"
);
assert.ok(
  diagnosticsSource.includes("planActiveDocumentDiagnostics") &&
    diagnosticsSource.includes("publishedSignatures"),
  "Problems должны кэшироваться и не перерисовываться без изменения"
);

console.log("[OK] parse, diagnostics, workspace index и Problems разделены и планируются без блокировки");

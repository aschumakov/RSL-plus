"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const serverSource = fs.readFileSync(
  path.join(root, "server", "src", "server.ts"),
  "utf8"
);
const clientSource = fs.readFileSync(
  path.join(root, "client", "src", "extension.ts"),
  "utf8"
);

function functionBody(source, name) {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  assert.notStrictEqual(start, -1, `${name} должен существовать`);

  const open = source.indexOf("{", start);
  assert.notStrictEqual(open, -1, `${name}: не найдено начало тела`);

  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const ch = source[index];
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return source.substring(open + 1, index);
      }
    }
  }

  throw new Error(`${name}: не найден конец тела`);
}

assert.ok(
  /const PARSE_DEBOUNCE_MS = 80;/.test(serverSource),
  "Быстрый parser debounce должен оставаться коротким"
);
assert.ok(
  /const DIAGNOSTICS_DEBOUNCE_MS = 300;/.test(serverSource),
  "Диагностики должны выполняться отдельным отложенным этапом"
);
assert.ok(
  /externalModuleQueue/.test(serverSource) &&
    /enqueueExternalModuleLoad/.test(serverSource),
  "IMPORT должны загружаться последовательной фоновой очередью"
);

const validateBody = functionBody(serverSource, "validateTextDocument");
assert.ok(
  validateBody.includes("scheduleDiagnostics(uri)"),
  "После parse должна планироваться отдельная диагностика"
);
assert.ok(
  !validateBody.includes("buildRslDiagnostics("),
  "Полная диагностика не должна блокировать parse активного документа"
);

const dependentsBody = functionBody(serverSource, "refreshOpenDependents");
assert.ok(
  dependentsBody.includes("scheduleDiagnostics("),
  "Изменение IMPORT должно обновлять диагностики зависимых файлов"
);
assert.ok(
  !dependentsBody.includes("scheduleValidation("),
  "Загрузка каждого IMPORT не должна повторно парсить зависимый файл"
);

assert.ok(
  clientSource.includes('"activeDocumentChanged"'),
  "Клиент должен сообщать серверу активный RSL-файл"
);
assert.ok(
  serverSource.includes("diagnosticsCache"),
  "Диагностики открытых файлов должны кэшироваться при переключении"
);

console.log("[OK] parse, diagnostics и IMPORT планируются без лишних повторных разборов");

assert.ok(
  serverSource.includes("notifyModuleCount") &&
    serverSource.includes("lastReportedModuleCount"),
  "Status bar не должен обновляться по IPC после каждого parse"
);
assert.ok(
  serverSource.includes("sendDiagnosticsIfChanged"),
  "Одинаковые diagnostics не должны повторно перерисовывать Problems"
);
assert.ok(
  serverSource.includes("getDiagnosticsDelay"),
  "Большие документы должны получать адаптивную задержку тяжёлых диагностик"
);

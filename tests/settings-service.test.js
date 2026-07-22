"use strict";

const assert = require("assert");
const { RslSettingsService } = require("../server/out/services/settingsService");

const calls = [];
const connection = {
  workspace: {
    getConfiguration({ scopeUri }) {
      calls.push(scopeUri);
      return Promise.resolve({
        import: "ДА",
        diagnostics: {
          maxProblems: scopeUri.endsWith("a.mac") ? 10 : 20
        }
      });
    }
  }
};

(async () => {
  const service = new RslSettingsService(connection, {
    import: "ДА",
    diagnostics: { enabled: true, maxProblems: 200 }
  });
  service.configure(true);

  const a = await service.get("file:///a.mac");
  const b = await service.get("file:///b.mac");
  assert.strictEqual(a.diagnostics.maxProblems, 10);
  assert.strictEqual(b.diagnostics.maxProblems, 20);
  assert.strictEqual(a.diagnostics.enabled, true);
  assert.strictEqual(calls.length, 2);

  await service.get("file:///a.mac");
  assert.strictEqual(calls.length, 2, "Настройки документа должны кэшироваться отдельно");

  service.clear("file:///a.mac");
  await service.get("file:///a.mac");
  assert.strictEqual(calls.length, 3);

  console.log("[OK] resource-настройки разных документов не смешиваются");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

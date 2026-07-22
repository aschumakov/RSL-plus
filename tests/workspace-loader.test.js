"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { WorkspaceModuleLoader } = require("../server/out/workspaceModuleLoader");

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rsl-loader-"));
  const files = ["a.mac", "b.mac", "c.mac"].map(name => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "Macro Test()\nEnd;", "utf8");
    return pathToFileURL(file).toString();
  });
  const loaded = [];
  const modules = new Map();
  const index = {
    registerWorkspaceFiles() {},
    unregisterWorkspaceFile() {},
    removeModule(uri) { modules.delete(uri); },
    getModule(uri) { return modules.get(uri); },
    resolveWorkspaceFile() { return { kind: "missing" }; },
    updateModule(uri, source, object, version, isOpen) {
      const module = { uri, source, object, version, isOpen, imports: [] };
      modules.set(uri, module);
      loaded.push(uri);
      return module;
    }
  };
  const loader = new WorkspaceModuleLoader(index, {
    log: message => { throw new Error(message); },
    onModuleLoaded() {},
    onModuleCountChanged() {}
  });

  loader.registerWorkspaceFiles(files.slice(0, 2));
  loader.enqueue(files[1], "interactive");

  while (loader.isIndexing) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }

  assert.strictEqual(loaded.length, 2);
  assert.strictEqual(loaded[1], files[1],
    "Уже поставленный background-файл должен повышаться до interactive");
  console.log("[OK] интерактивный Import повышает приоритет фоновой задачи");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

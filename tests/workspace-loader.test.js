"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const {
  WorkspaceModuleLoader
} = require("../server/out/indexing/workspaceModuleLoader");

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rsl-loader-"));
  const files = ["a.mac", "b.mac", "c.mac"].map(name => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "Macro Test()\nEnd;", "utf8");
    return pathToFileURL(file).toString();
  });
  const loaded = [];
  const modules = new Map();
  const workspaceFiles = new Set();
  const index = {
    registerWorkspaceFiles(uris) { uris.forEach(uri => workspaceFiles.add(uri)); },
    unregisterWorkspaceFile(uri) { workspaceFiles.delete(uri); },
    removeModule(uri) { modules.delete(uri); },
    getModule(uri) { return modules.get(uri); },
    findModuleByName() { return undefined; },
    resolveWorkspaceFile(name) {
      const uri = Array.from(workspaceFiles).find(value =>
        path.basename(new URL(value).pathname).toLowerCase() ===
          `${name}`.replace(/\.mac$/i, "").toLowerCase() + ".mac"
      );
      return uri ? { kind: "resolved", value: uri } : { kind: "missing" };
    },
    updateExternalModule(uri, source, version) {
      const module = {
        uri,
        source: "",
        sourceLength: source.length,
        object: {},
        version,
        isOpen: false,
        kind: "external",
        imports: []
      };
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

  loader.registerWorkspaceFiles(files);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.strictEqual(
    loaded.length,
    0,
    "Регистрация workspace не должна разбирать все .mac"
  );

  loader.enqueueImport("b");

  while (loader.isIndexing) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }

  assert.deepStrictEqual(loaded, [files[1]]);
  assert.strictEqual(loader.mode, "activeImports");
  console.log("[OK] по умолчанию загружается только активный Import-граф");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

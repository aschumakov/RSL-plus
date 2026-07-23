"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { CBase } = require("../server/out/common");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const {
    RslDiagnosticEngine
} = require("../server/out/diagnostics/diagnosticEngine");
const {
    referenceTesting
} = require("../server/out/analysis/references");

const diagnosticSettings = {
    enabled: true,
    deprecatedDeclarations: false,
    structure: true,
    unusedVariables: false,
    unusedImports: false,
    debugBreak: false,
    useBeforeDeclaration: false,
    ambiguousReferences: false,
    maxProblems: 200
};

const onErrorSource = [
    "var result: integer;",
    "result = 1;",
    "onerror",
    "  result = 0;"
].join("\n");
const onErrorUri = "file:///workspace/onerror-main.mac";
const onErrorIndex = new WorkspaceIndex();
onErrorIndex.updateOpenModule(
    onErrorUri,
    onErrorSource,
    new CBase(onErrorSource, 0),
    1
);
const onErrorModule = onErrorIndex.getModule(onErrorUri);
assert.ok(onErrorModule);

const engine = new RslDiagnosticEngine();
const onErrorDiagnostics = engine.buildLocal(
    onErrorModule,
    onErrorIndex,
    diagnosticSettings
);

assert.ok(
    !onErrorDiagnostics.some(item =>
        String(item.code || "").toLowerCase() === "onerror-outside-macro"
    ),
    "ONERROR верхнего уровня разрешён в исполняемом макрофайле"
);
assert.ok(
    !onErrorDiagnostics.some(item => {
        const code = String(item.code || "").toLowerCase();
        const message = String(item.message || "").toLowerCase();
        const onErrorLine = item.range.start.line === 2;
        return onErrorLine && (code.includes("end") || message.includes("end"));
    }),
    "ONERROR верхнего уровня не должен требовать собственного END"
);

const missingEndSource = [
    "if (true)",
    "  var value: integer;"
].join("\n");
const missingEndUri = "file:///workspace/missing-end.mac";
const missingEndIndex = new WorkspaceIndex();
missingEndIndex.updateOpenModule(
    missingEndUri,
    missingEndSource,
    new CBase(missingEndSource, 0),
    1
);
const missingEndModule = missingEndIndex.getModule(missingEndUri);
assert.ok(missingEndModule);
const missingEndDiagnostics = engine.buildLocal(
    missingEndModule,
    missingEndIndex,
    diagnosticSettings
);
assert.ok(
    missingEndDiagnostics.some(item => {
        const code = String(item.code || "").toLowerCase();
        const message = String(item.message || "").toLowerCase();
        return code.includes("end") || message.includes("end");
    }),
    "Обычная ошибка отсутствующего END для IF должна сохраниться"
);

const referenceSource = [
    "macro Test(p)",
    "  var localValue: integer;",
    "  localValue = p;",
    "end;",
    "private macro PrivateMacro()",
    "end;",
    "macro PublicMacro()",
    "end;"
].join("\n");
const referenceTree = new CBase(referenceSource, 0);
const localValue = referenceTree.RecursiveFind("localValue");
const privateMacro = referenceTree.RecursiveFind("PrivateMacro");
const publicMacro = referenceTree.RecursiveFind("PublicMacro");
assert.ok(localValue);
assert.ok(privateMacro);
assert.ok(publicMacro);
assert.strictEqual(
    referenceTesting.isLocalReferenceTarget(referenceTree, localValue),
    true,
    "Локальная переменная должна искать ссылки только в текущем модуле"
);
assert.strictEqual(
    referenceTesting.isLocalReferenceTarget(referenceTree, privateMacro),
    true,
    "PRIVATE Macro должен искать ссылки только в текущем модуле"
);
assert.strictEqual(
    referenceTesting.isLocalReferenceTarget(referenceTree, publicMacro),
    false,
    "Публичный Macro может иметь использования в других файлах"
);

const bloom = referenceTesting.buildIdentifierBloom([
    "Macro Alpha()",
    "  LocalValue = BuildValue;",
    "End;"
].join("\n"));
assert.strictEqual(
    referenceTesting.bloomMightContain(bloom, "localvalue"),
    true
);
assert.strictEqual(
    referenceTesting.bloomMightContain(bloom, "missingidentifier"),
    false
);
assert.strictEqual(
    referenceTesting.containsIdentifier("Alpha Alphabet", "alpha"),
    true
);
assert.strictEqual(
    referenceTesting.containsIdentifier("Alphabet", "alpha"),
    false,
    "Prefilter должен учитывать границы идентификатора"
);

const root = path.join(__dirname, "..");
const referencesSource = fs.readFileSync(
    path.join(root, "server", "src", "analysis", "references.ts"),
    "utf8"
);
const serverSource = fs.readFileSync(
    path.join(root, "server", "src", "server.ts"),
    "utf8"
);
const loaderSource = fs.readFileSync(
    path.join(root, "server", "src", "indexing", "workspaceModuleLoader.ts"),
    "utf8"
);
assert.ok(referencesSource.includes("REFERENCE_READ_BATCH_SIZE = 16"));
assert.ok(referencesSource.includes("Promise.all("));
assert.ok(referencesSource.includes("identifierBloomByUri"));
assert.ok(referencesSource.includes("candidateUrisByName"));
assert.ok(referencesSource.includes("isLocalReferenceTarget"));
assert.ok(referencesSource.includes("analyzeIdentifierSource"));
assert.ok(loaderSource.includes("indexReferenceFileSource(uri, text)"));
assert.ok(serverSource.includes("invalidateReferenceFileIndex(uri)"));
assert.ok(serverSource.includes("retainReferenceFileIndex(items)"));

console.log("[OK] ONERROR верхнего уровня разрешён, References использует локальный shortcut и компактный индекс кандидатов");

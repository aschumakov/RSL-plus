"use strict";

const assert = require("assert");
const {
    createFastDocumentSnapshot
} = require("../server/out/services/fastDocumentSnapshot");
const {
    parseRslSyntax
} = require("../server/out/syntaxParser");
const { CBase } = require("../server/out/common");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const {
    RslDiagnosticEngine
} = require("../server/out/diagnostics/diagnosticEngine");
const {
    DocumentAnalysisService
} = require("../server/out/services/documentAnalysisService");
const {
    scanExternalModule
} = require("../server/out/indexing/externalModuleScanner");
const {
    isLocalReferenceTarget
} = require("../server/out/analysis/references");

const source = [
    "Import lib\\common.mac;",
    "Var GlobalValue: Integer;",
    "Macro Calculate(pValue)",
    "  If (pValue)",
    "    GlobalValue = pValue;",
    "  End;",
    "End;",
    "OnError(err)",
    "  GlobalValue = 0;"
].join("\n");

const document = {
    uri: "file:///workspace/main.mac",
    version: 7,
    getText: () => source
};

const snapshot = createFastDocumentSnapshot(document);
assert.strictEqual(snapshot.version, 7);
assert.ok(snapshot.lex.tokens.length > 0);
assert.ok(snapshot.imports.includes("lib\\common.mac"));
assert.ok(snapshot.foldingRanges.length > 0);
assert.ok(snapshot.symbols.some(item => item.name === "Calculate"));
assert.ok(snapshot.symbols.some(item => item.name === "GlobalValue"));
assert.ok(snapshot.identifiersByName.get("globalvalue").length >= 2);

const analysisIndex = new WorkspaceIndex();
const analysisService = new DocumentAnalysisService(
    { get: uri => uri === document.uri ? document : undefined },
    analysisIndex,
    { get: async () => ({ import: "ДА" }) },
    {
        log: () => undefined,
        invalidateProviderCaches: () => undefined,
        onParsed: () => undefined,
        onImports: () => undefined,
        initialParseDelayMs: 1000
    }
);
analysisService.open(document);
assert.strictEqual(
    analysisService.getFastSnapshot(document).version,
    document.version,
    "FastDocumentSnapshot должен быть доступен синхронно после open"
);
analysisService.close(document.uri);

const syntax = parseRslSyntax(source, snapshot.lex, {
    buildExpressionTree: false
});
assert.strictEqual(
    syntax.lex,
    snapshot.lex,
    "Полный parser обязан переиспользовать lexer FastDocumentSnapshot"
);
assert.ok(
    syntax.root.children.some(item => item.kind === "OnErrorClause"),
    "ONERROR верхнего уровня должен быть частью исходной grammar"
);
assert.ok(
    !syntax.diagnostics.some(item =>
        String(item.code || "").toLowerCase().includes("onerror")
    ),
    "Верхнеуровневый ONERROR не должен создавать parser diagnostic"
);

const diagnosticIndex = new WorkspaceIndex();
const diagnosticTree = CBase.fromSyntax(source, 0, syntax, true, false);
diagnosticIndex.updateOpenModule(
    document.uri,
    source,
    diagnosticTree,
    document.version,
    syntax
);
const diagnostics = new RslDiagnosticEngine().buildLocal(
    diagnosticIndex.getModule(document.uri),
    diagnosticIndex,
    {
        enabled: true,
        structure: true,
        deprecatedDeclarations: false,
        unusedVariables: false,
        unusedImports: false,
        debugBreak: false,
        useBeforeDeclaration: false,
        ambiguousReferences: false,
        maxProblems: 100
    }
);
assert.ok(
    !diagnostics.some(item =>
        String(item.code || "").toLowerCase() === "onerror-outside-macro"
    ),
    "Structural diagnostics тоже должны принимать ONERROR верхнего уровня"
);

const missingEndSource = "If (true)\n  Var value;";
const missingSyntax = parseRslSyntax(missingEndSource, undefined, {
    buildExpressionTree: false
});
const missingTree = CBase.fromSyntax(
    missingEndSource,
    0,
    missingSyntax,
    true,
    false
);
const missingIndex = new WorkspaceIndex();
missingIndex.updateOpenModule(
    "file:///workspace/missing.mac",
    missingEndSource,
    missingTree,
    1,
    missingSyntax
);
const missingDiagnostics = new RslDiagnosticEngine().buildLocal(
    missingIndex.getModule("file:///workspace/missing.mac"),
    missingIndex,
    { enabled: true, structure: true, maxProblems: 100 }
);
assert.ok(
    missingDiagnostics.some(item =>
        String(item.code || "").toLowerCase().includes("end")
    ),
    "Исправление ONERROR не должно скрывать обычный missing END"
);

const externalSource = [
    "Import common, helpers;",
    "Macro PublicMacro(value)",
    "  Var localValue = 1;",
    "End;",
    "Var PublicValue, SecondValue;",
    "Class Customer",
    "  Macro Load(id)",
    "    Var localInMethod;",
    "  End;",
    "End;"
].join("\n");
const external = scanExternalModule(externalSource);
assert.deepStrictEqual(
    external.imports.map(value => value.toLowerCase()),
    ["common", "helpers"]
);
assert.ok(external.symbolTree.RecursiveFind("PublicMacro"));
assert.ok(external.symbolTree.RecursiveFind("Customer"));
assert.ok(external.symbolTree.RecursiveFind("Load"));
assert.ok(external.symbolTree.RecursiveFind("PublicValue"));
assert.strictEqual(external.symbolTree.RecursiveFind("localValue"), undefined);
assert.strictEqual(external.symbolTree.RecursiveFind("localInMethod"), undefined);

const inheritedClassSource = [
    "Class (TRecHandler) TDocument(TableName:string)",
    "  Private Var m_carries:TDocCarryList;",
    "  Var m_payment:TRecHandler = TRecHandler(\"pmpaym.dbt\", \"bank.def\");",
    "  InitTRecHandler(TableName, \"bank.def\");",
    "End;"
].join("\n");
const inheritedSyntax = parseRslSyntax(inheritedClassSource, undefined, {
    buildExpressionTree: false
});
const inheritedClass = inheritedSyntax.root.children.find(item =>
    item.kind === "ClassDeclaration"
);
assert.ok(inheritedClass, "Основная grammar должна распознать CLASS с наследованием");
assert.strictEqual(inheritedClass.name, "TDocument");
assert.strictEqual(inheritedClass.baseClassName, "TRecHandler");

const inheritedDocument = {
    uri: "file:///workspace/MC_lib.mac",
    version: 1,
    getText: () => inheritedClassSource
};
const inheritedFast = createFastDocumentSnapshot(inheritedDocument);
assert.ok(inheritedFast.symbols.some(item => item.name === "TDocument"));
assert.ok(
    !inheritedFast.symbols.some(item => item.name === "TRecHandler"),
    "Fast Snapshot не должен публиковать базовый класс как объявление"
);

const inheritedExternal = scanExternalModule(inheritedClassSource);
assert.ok(inheritedExternal.symbolTree.RecursiveFind("TDocument"));
assert.strictEqual(
    inheritedExternal.symbolTree.RecursiveFind("TRecHandler"),
    undefined,
    "External summary не должен объявлять базовый класс в MC_lib.mac"
);

const inheritanceIndex = new WorkspaceIndex();
inheritanceIndex.updateExternalModule(
    inheritedDocument.uri,
    inheritedClassSource,
    1
);
const consumerSource = [
    "Import MC_lib;",
    "Private Macro IsSetAccAndOpen(Rec_Account:TRecHandler)",
    "End;"
].join("\n");
const consumerSyntax = parseRslSyntax(consumerSource, undefined, {
    buildExpressionTree: false
});
const consumerTree = CBase.fromSyntax(
    consumerSource,
    0,
    consumerSyntax,
    true,
    false
);
const consumerUri = "file:///workspace/consumer.mac";
inheritanceIndex.updateOpenModule(
    consumerUri,
    consumerSource,
    consumerTree,
    1,
    consumerSyntax
);
assert.strictEqual(
    inheritanceIndex.findImportedSymbols(consumerUri, "TRecHandler").length,
    0,
    "Базовый системный класс не должен появляться среди символов MC_lib.mac"
);
assert.strictEqual(
    inheritanceIndex.findImportedSymbols(consumerUri, "TDocument").length,
    1
);

const referenceSource = [
    "Macro Test(p)",
    "  Var localValue: Integer;",
    "End;",
    "Private Macro Hidden()",
    "End;",
    "Macro PublicMacro()",
    "End;"
].join("\n");
const referenceTree = new CBase(referenceSource, 0);
const localValue = referenceTree.RecursiveFind("localValue");
const hidden = referenceTree.RecursiveFind("Hidden");
const publicMacro = referenceTree.RecursiveFind("PublicMacro");
assert.ok(localValue && hidden && publicMacro);
assert.strictEqual(
    isLocalReferenceTarget(
        referenceTree,
        localValue
    ),
    true
);
assert.strictEqual(
    isLocalReferenceTarget(
        referenceTree,
        hidden
    ),
    true
);
assert.strictEqual(
    isLocalReferenceTarget(
        referenceTree,
        publicMacro
    ),
    false
);

console.log("[OK] FastDocumentSnapshot обслуживает Folding/Outline до полного parser, ONERROR находится в grammar");

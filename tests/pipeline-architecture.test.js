"use strict";

const assert = require("assert");
const {
    createFastDocumentSnapshot,
    getFastDocumentSymbols,
    getFastFoldingRanges
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


function createTestDocument(uri, version, source) {
    const lineStarts = [0];

    for (let index = 0; index < source.length; index++) {
        const char = source.charCodeAt(index);

        if (char === 13) {
            if (source.charCodeAt(index + 1) === 10) {
                index++;
            }
            lineStarts.push(index + 1);
        } else if (char === 10) {
            lineStarts.push(index + 1);
        }
    }

    return {
        uri,
        languageId: "rsl",
        version,
        lineCount: lineStarts.length,
        getText: () => source,
        positionAt(offset) {
            const clamped = Math.max(0, Math.min(offset, source.length));
            let left = 0;
            let right = lineStarts.length;

            while (left < right) {
                const middle = Math.floor((left + right) / 2);
                if (lineStarts[middle] > clamped) {
                    right = middle;
                } else {
                    left = middle + 1;
                }
            }

            const line = Math.max(0, left - 1);
            return {
                line,
                character: clamped - lineStarts[line]
            };
        },
        offsetAt(position) {
            const line = Math.max(
                0,
                Math.min(position.line, lineStarts.length - 1)
            );
            const lineStart = lineStarts[line];
            const nextLineStart = line + 1 < lineStarts.length
                ? lineStarts[line + 1]
                : source.length;

            return Math.max(
                lineStart,
                Math.min(lineStart + position.character, nextLineStart)
            );
        }
    };
}

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

const document = createTestDocument(
    "file:///workspace/main.mac",
    7,
    source
);

const snapshot = createFastDocumentSnapshot(document);
assert.strictEqual(snapshot.version, 7);
assert.ok(snapshot.lex.tokens.length > 0);
assert.strictEqual(
    snapshot.foldingRanges,
    undefined,
    "Folding не должен строиться до первого запроса"
);
assert.strictEqual(
    snapshot.symbols,
    undefined,
    "Outline не должен строиться до первого запроса"
);
assert.ok(getFastFoldingRanges(document, snapshot).length > 0);
const sourceSymbols = getFastDocumentSymbols(document, snapshot);
assert.ok(sourceSymbols.some(item => item.name === "Calculate"));
assert.ok(sourceSymbols.some(item => item.name === "GlobalValue"));

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


const outlineSource = [
    "Class TExecFunPIParm()",
    "  Var pi:TRecHandler = TRecHandler(\"pmaddpi.dbt\");",
    "  Var stat:Integer = 0;",
    "  Var err_mes:String = \"\";",
    "End;"
].join("\n");
const outlineDocument = createTestDocument(
    "file:///workspace/outline.mac",
    1,
    outlineSource
);
const outlineSnapshot = createFastDocumentSnapshot(outlineDocument);
const outlineSymbols = getFastDocumentSymbols(
    outlineDocument,
    outlineSnapshot
);
assert.strictEqual(
    outlineSymbols.length,
    1,
    "Class и её свойства не должны возвращаться четырьмя корневыми строками"
);
assert.strictEqual(outlineSymbols[0].name, "TExecFunPIParm");
assert.deepStrictEqual(
    (outlineSymbols[0].children || []).map(item => item.name),
    ["pi", "stat", "err_mes"],
    "Outline должен сохранять Class → properties"
);
assert.ok(
    outlineSymbols[0].range.end.line >= 4,
    "Range класса должен включать тело до END"
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

const inheritedDocument = createTestDocument(
    "file:///workspace/MC_lib.mac",
    1,
    inheritedClassSource
);
const inheritedFast = createFastDocumentSnapshot(inheritedDocument);
const inheritedSymbols = getFastDocumentSymbols(
    inheritedDocument,
    inheritedFast
);
assert.ok(inheritedSymbols.some(item => item.name === "TDocument"));
assert.ok(
    !inheritedSymbols.some(item => item.name === "TRecHandler"),
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

console.log("[OK] FastDocumentSnapshot ленивый, Outline иерархический, ONERROR находится в grammar");

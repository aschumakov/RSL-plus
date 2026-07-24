"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vscodeLanguageServerPath = require.resolve(
    "vscode-languageserver",
    { paths: [path.join(__dirname, "..", "server")] }
);
const { CompletionItemKind } = require(vscodeLanguageServerPath);
const {
    createFastDocumentSnapshot,
    getFastDocumentSymbols,
    getFastFoldingRanges
} = require("../server/out/services/fastDocumentSnapshot");
const {
    parseRslSyntax
} = require("../server/out/syntaxParser");
const {
    CBase,
    RSL_PARSER_VERSION
} = require("../server/out/common");
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
assert.strictEqual(
    analysisService.open(document),
    true,
    "Первая версия документа должна запускать fast-анализ"
);
const openedSnapshot = analysisService.getFastSnapshot(document);
assert.strictEqual(
    openedSnapshot.version,
    document.version,
    "FastDocumentSnapshot должен быть доступен синхронно после open"
);
assert.ok(
    Array.isArray(openedSnapshot.symbols),
    "Outline должен быть подготовлен синхронно до полного parser"
);
assert.strictEqual(
    analysisService.open(document),
    false,
    "Повторный onDidOpen той же версии не должен дублировать анализ"
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

function testSyntaxTreeAdapterBuildsLegacySymbols() {
    const source = [
        "import common, bankinter;",
        "var globalValue: integer = 1;",
        "macro Test(p1, p2:@integer): string",
        "  if (p1 > 0)",
        "    var insideIf = 10;",
        "  end;",
        "  for (var i: numeric, 1, 10)",
        "    insideIf = insideIf + i;",
        "  end;",
        "onerror (er)",
        "  return er.Message",
        "end;",
        "class (BaseClass) DemoClass(cp)",
        "  var Prop: integer;",
        "  macro Method(mp)",
        "    var localValue = mp;",
        "  end;",
        "end;"
    ].join("\n");
    const tree = new CBase(source, 0);

    assert.ok(RSL_PARSER_VERSION.includes("syntax-tree-adapter"));
    assert.ok(tree.getSyntaxResult(), "Syntax tree должен храниться в CBase");

    const rootNames = tree.getChilds().map(item => item.Name);
    assert.ok(rootNames.includes("globalValue"));
    assert.ok(rootNames.includes("Test"));
    assert.ok(rootNames.includes("DemoClass"));

    const macro = tree.getChilds().find(item => item.Name === "Test");
    assert.ok(macro);
    assert.strictEqual(macro.ObjKind, CompletionItemKind.Function);
    const macroNames = macro.getChilds().map(item => item.Name);
    ["p1", "p2", "insideIf", "i", "er"].forEach(name =>
        assert.ok(macroNames.includes(name))
    );
    assert.strictEqual(
        macro.getChilds().find(item => item.Name === "i").Type.toLowerCase(),
        "numeric"
    );
    assert.strictEqual(
        macro.getChilds().find(item => item.Name === "er").Type.toLowerCase(),
        "trslerror"
    );

    const cls = tree.getChilds().find(item => item.Name === "DemoClass");
    assert.ok(cls);
    assert.strictEqual(cls.ObjKind, CompletionItemKind.Class);
    const classNames = cls.getChilds().map(item => item.Name);
    ["cp", "Prop", "Method"].forEach(name =>
        assert.ok(classNames.includes(name))
    );
    const method = cls.getChilds().find(item => item.Name === "Method");
    assert.strictEqual(method.ObjKind, CompletionItemKind.Method);
    assert.ok(method.getChilds().some(item => item.Name === "mp"));
    assert.ok(method.getChilds().some(item => item.Name === "localValue"));

    const commonSource = fs.readFileSync(
        path.join(__dirname, "..", "server", "src", "common.ts"),
        "utf8"
    );
    assert.ok(
        !/\bNextToken\s*\(/.test(commonSource),
        "common.ts больше не должен содержать второй tokenizer NextToken"
    );

    const documentedTree = new CBase([
        "array GlobalArray;",
        "file GlobalFile(account) write;",
        "record GlobalRecord(account) mem;",
        "class Demo",
        "  array Items;",
        "  file Accounts(account) write;",
        "  record Buffer(account) mem;",
        "  local var constructorOnly;",
        "  local macro Helper()",
        "    return constructorOnly;",
        "  end;",
        "  macro PublicMethod()",
        "    return Items(0);",
        "  end;",
        "end;"
    ].join("\n"), 0);
    const documentedRoot = documentedTree.getChilds();
    assert.strictEqual(
        documentedRoot.find(
            item => item.Name === "GlobalArray"
        ).Type.toLowerCase(),
        "array"
    );
    assert.strictEqual(
        documentedRoot.find(
            item => item.Name === "GlobalFile"
        ).Type.toLowerCase(),
        "file"
    );
    assert.strictEqual(
        documentedRoot.find(
            item => item.Name === "GlobalRecord"
        ).Type.toLowerCase(),
        "record"
    );

    const documentedClass = documentedRoot.find(
        item => item.Name === "Demo"
    );
    const members = documentedClass.getChilds();
    assert.strictEqual(
        members.find(item => item.Name === "Items").ObjKind,
        CompletionItemKind.Property
    );
    assert.strictEqual(
        members.find(item => item.Name === "Accounts").Type.toLowerCase(),
        "file"
    );
    assert.strictEqual(
        members.find(item => item.Name === "Buffer").Type.toLowerCase(),
        "record"
    );
    assert.strictEqual(
        members.find(item => item.Name === "constructorOnly").ObjKind,
        CompletionItemKind.Variable
    );
    assert.strictEqual(
        members.find(item => item.Name === "Helper").ObjKind,
        CompletionItemKind.Function
    );
    assert.strictEqual(
        members.find(item => item.Name === "PublicMethod").ObjKind,
        CompletionItemKind.Method
    );
}

testSyntaxTreeAdapterBuildsLegacySymbols();

console.log("[OK] FastDocumentSnapshot ленивый, open заранее готовит Outline, ONERROR находится в grammar");

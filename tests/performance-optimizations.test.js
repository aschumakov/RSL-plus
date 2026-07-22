"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { lexRsl } = require("../server/out/lexer");
const { parseRslSyntax } = require("../server/out/syntaxParser");
const { CBase } = require("../server/out/common");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { GetFoldingRanges } = require("../server/out/folding");

function findNodes(node, kind, result = []) {
  if (node.kind === kind) result.push(node);
  node.children.forEach(child => findNodes(child, kind, result));
  return result;
}

const source = [
  "import lib\\common;",
  "macro Test(p)",
  "  var localValue: integer = 1;",
  "  localValue = BuildValue(p) + 2;",
  "  if (localValue > 0)",
  "    localValue = localValue + 1;",
  "  end;",
  "end;"
].join("\n");

const full = parseRslSyntax(source);
const compact = parseRslSyntax(source, undefined, {
  buildExpressionTree: false
});
assert.deepStrictEqual(compact.diagnostics, full.diagnostics);
assert.ok(findNodes(full.root, "AssignmentExpression").length > 0);
assert.strictEqual(findNodes(compact.root, "AssignmentExpression").length, 0);
assert.ok(findNodes(compact.root, "VariableDeclaration").length > 0);
assert.ok(findNodes(compact.root, "IfStatement").length > 0);

const fullLex = lexRsl(source);
const compactLex = lexRsl(source, { includeTrivia: false });
assert.ok(fullLex.tokens.some(token => token.kind === "whitespace"));
assert.ok(!compactLex.tokens.some(token => token.kind === "whitespace"));
assert.deepStrictEqual(
  compactLex.tokens.filter(token => token.kind === "identifier").map(token => token.value),
  fullLex.tokens.filter(token => token.kind === "identifier").map(token => token.value)
);
assert.deepStrictEqual(
  GetFoldingRanges(source, fullLex),
  GetFoldingRanges(source)
);

const openTree = new CBase(source, 0);
const externalTree = CBase.forExternalModule(source);
assert.ok(openTree.getCurrentToken(source.indexOf("Test")));
assert.strictEqual(externalTree.getCurrentToken(source.indexOf("Test")), undefined);
assert.ok(externalTree.RecursiveFind("Test"));
assert.ok(externalTree.RecursiveFind("localValue"));

const index = new WorkspaceIndex();
const workspaceUris = [];
for (let item = 0; item < 2000; item++) {
  workspaceUris.push(`file:///workspace/lib${item}/module${item}.mac`);
}
workspaceUris.push("file:///workspace/lib/common.mac");
index.registerWorkspaceFiles(workspaceUris);
assert.strictEqual(
  index.findWorkspaceFileUri("lib\\common"),
  "file:///workspace/lib/common.mac"
);

const mainUri = "file:///workspace/main.mac";
const commonUri = "file:///workspace/lib/common.mac";
index.updateModule(mainUri, source, CBase.forExternalModule(source), 1, false);
index.updateModule(
  commonUri,
  "macro Shared\nend;",
  CBase.forExternalModule("macro Shared\nend;"),
  1,
  false
);
assert.deepStrictEqual(index.getImportedModules(mainUri).map(module => module.uri), [commonUri]);
assert.ok(index.getImportedCompletionItems(mainUri).some(item =>
  String(item.label).toLowerCase() === "shared"
));
index.removeModule(commonUri);
assert.deepStrictEqual(index.getImportedModules(mainUri), []);

const featureSource = fs.readFileSync(
  path.join(__dirname, "..", "server", "src", "languageFeatureRegistry.ts"),
  "utf8"
);
const analysisSource = fs.readFileSync(
  path.join(__dirname, "..", "server", "src", "documentAnalysisService.ts"),
  "utf8"
);
const semanticSource = fs.readFileSync(
  path.join(__dirname, "..", "server", "src", "semanticTokens.ts"),
  "utf8"
);
const scopeResolverSource = fs.readFileSync(
  path.join(__dirname, "..", "server", "src", "scopeResolver.ts"),
  "utf8"
);
const diagnosticsSource = fs.readFileSync(
  path.join(__dirname, "..", "server", "src", "diagnostics.ts"),
  "utf8"
);
const referencesSource = fs.readFileSync(
  path.join(__dirname, "..", "server", "src", "references.ts"),
  "utf8"
);
const foldingSource = fs.readFileSync(
  path.join(__dirname, "..", "server", "src", "folding.ts"),
  "utf8"
);
assert.ok(featureSource.includes("semanticTokensCache"));
assert.ok(featureSource.includes("foldingRangesCache"));
assert.ok(featureSource.includes("documentSymbolsCache"));
assert.ok(featureSource.includes("defaultCompletionItems"));
assert.ok(analysisSource.includes("slowParseLogMs"));
assert.ok(semanticSource.includes("lowerBoundByStart"));
assert.ok(semanticSource.includes("objectInfoByObject"));
assert.ok(!semanticSource.includes("objects.find(info =>"));
assert.ok(scopeResolverSource.includes("tokensByModule"));
assert.ok(scopeResolverSource.includes("childrenByNameCache"));
assert.ok(scopeResolverSource.includes("upperBoundByStart"));
assert.ok(scopeResolverSource.includes("findContainingObject"));
assert.ok(!scopeResolverSource.includes("significantTokens(module.lex.tokens)"));
assert.ok(diagnosticsSource.includes("nestedScopesByScope"));
assert.ok(featureSource.includes("GetFoldingRanges(document.getText(), lex)"));
assert.ok(foldingSource.includes("lexResult?: IRslLexResult"));
assert.ok(referencesSource.includes("candidateModule.syntax.tokens"));
assert.ok(referencesSource.includes("findDeclarationToken"));
assert.ok(!referencesSource.includes("isDeclarationToken("));

console.log("[OK] parser, lexer, индекс и LSP-provider-ы используют быстрый путь");

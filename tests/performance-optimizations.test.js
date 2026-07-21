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
  if (node.kind === kind) {
    result.push(node);
  }
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

assert.deepStrictEqual(
  compact.diagnostics,
  full.diagnostics,
  "Компактный режим не должен менять синтаксические диагностики"
);
assert.ok(
  findNodes(full.root, "AssignmentExpression").length > 0,
  "Полный parser должен сохранять выражения"
);
assert.strictEqual(
  findNodes(compact.root, "AssignmentExpression").length,
  0,
  "Горячий LSP-путь не должен строить неиспользуемое дерево выражений"
);
assert.ok(
  findNodes(compact.root, "VariableDeclaration").length > 0,
  "Компактный parser обязан сохранять объявления"
);
assert.ok(
  findNodes(compact.root, "IfStatement").length > 0,
  "Компактный parser обязан сохранять структуру блоков"
);

const fullLex = lexRsl(source);
const compactLex = lexRsl(source, { includeTrivia: false });
assert.ok(fullLex.tokens.some(token => token.kind === "whitespace"));
assert.ok(fullLex.tokens.some(token => token.kind === "newline"));
assert.ok(!compactLex.tokens.some(token => token.kind === "whitespace"));
assert.ok(!compactLex.tokens.some(token => token.kind === "newline"));
assert.deepStrictEqual(
  compactLex.tokens
    .filter(token => token.kind === "identifier")
    .map(token => token.value),
  fullLex.tokens
    .filter(token => token.kind === "identifier")
    .map(token => token.value),
  "Облегчённый lexer не должен терять кодовые токены"
);

const foldingFromSource = GetFoldingRanges(source);
const foldingFromSharedLex = GetFoldingRanges(source, fullLex);
assert.deepStrictEqual(
  foldingFromSharedLex,
  foldingFromSource,
  "Folding должен переиспользовать lexer-результат parser без изменения результата"
);

const openTree = new CBase(source, 0);
const externalTree = CBase.forExternalModule(source);
assert.ok(openTree.getCurrentToken(source.indexOf("Test")));
assert.strictEqual(
  externalTree.getCurrentToken(source.indexOf("Test")),
  undefined,
  "Закрытому импортированному модулю не нужен legacy token cache"
);
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
  "file:///workspace/lib/common.mac",
  "Поиск IMPORT должен использовать индекс по basename и сохранять путь"
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
assert.deepStrictEqual(
  index.getImportedModules(mainUri).map(module => module.uri),
  [commonUri]
);
assert.ok(
  index.getImportedCompletionItems(mainUri)
    .some(item => String(item.label).toLowerCase() === "shared")
);
index.removeModule(commonUri);
assert.deepStrictEqual(
  index.getImportedModules(mainUri),
  [],
  "Кэш импортов должен сбрасываться при изменении индекса"
);

const serverSource = fs.readFileSync(
  path.join(__dirname, "..", "server", "src", "server.ts"),
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
assert.ok(serverSource.includes("semanticTokensCache"));
assert.ok(serverSource.includes("foldingRangesCache"));
assert.ok(serverSource.includes("documentSymbolsCache"));
assert.ok(serverSource.includes("defaultCompletionItems"));
assert.ok(serverSource.includes("SLOW_PARSE_LOG_MS"));
assert.ok(semanticSource.includes("lowerBoundByStart"));
assert.ok(semanticSource.includes("objectInfoByObject"));
assert.ok(!semanticSource.includes("objects.find(info =>"));
assert.ok(scopeResolverSource.includes("tokensByModule"));
assert.ok(scopeResolverSource.includes("childrenByNameCache"));
assert.ok(scopeResolverSource.includes("upperBoundByStart"));
assert.ok(scopeResolverSource.includes("findContainingObject"));
assert.ok(!scopeResolverSource.includes("significantTokens(module.lex.tokens)"));
assert.ok(diagnosticsSource.includes("nestedScopesByScope"));
assert.ok(serverSource.includes("GetFoldingRanges(document.getText(), lex)"));
assert.ok(foldingSource.includes("lexResult?: IRslLexResult"));
assert.ok(referencesSource.includes("candidateModule.syntax.tokens"));
assert.ok(referencesSource.includes("findDeclarationToken"));
assert.ok(!referencesSource.includes("isDeclarationToken("));

console.log("[OK] parser, lexer, индекс и LSP-provider-ы используют быстрый путь");

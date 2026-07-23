"use strict";

const assert = require("assert");

const { CBase } = require("../server/out/common");
const { parseRslSyntax } = require("../server/out/syntaxParser");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const {
    buildRslSemanticTokens
} = require("../server/out/semanticTokens");

const source = [
    "Macro Test(pValue)",
    "  Var localValue: Integer;",
    "  localValue = pValue;",
    "  localValue = localValue + 1;",
    "End;"
].join("\n");
const uri = "file:///workspace/semantic.mac";
const syntax = parseRslSyntax(source, undefined, {
    buildExpressionTree: false
});
const tree = CBase.fromSyntax(source, 0, syntax, true, false);
const index = new WorkspaceIndex();
index.updateOpenModule(uri, source, tree, 1, syntax);
const resolver = new RslScopeResolver(index);
const offset = source.indexOf("localValue = pValue") + 2;

const first = resolver.resolveAt(uri, tree, offset);
const second = resolver.resolveAt(uri, tree, offset);
assert.ok(first);
assert.strictEqual(second && second.object, first.object);
const stats = resolver.getCacheStats();
assert.ok(stats.misses >= 1);
assert.ok(stats.hits >= 1, "Повторный resolveAt должен попадать в token-start cache");

const rangeTokens = buildRslSemanticTokens(
    index.getModule(uri),
    index,
    resolver,
    {
        startLine: 2,
        startCharacter: 0,
        endLine: 2,
        endCharacter: 1000
    }
);
const lines = decodeSemanticTokenLines(rangeTokens.data);
assert.ok(lines.length > 0);
assert.ok(
    lines.every(line => line === 2),
    `Range semantic tokens не должны разрешать другие строки: ${lines.join(",")}`
);

function decodeSemanticTokenLines(data) {
    const result = [];
    let line = 0;
    let character = 0;

    for (let index = 0; index < data.length; index += 5) {
        const deltaLine = data[index];
        const deltaCharacter = data[index + 1];
        line += deltaLine;
        character = deltaLine === 0
            ? character + deltaCharacter
            : deltaCharacter;
        result.push(line);
    }

    return result;
}

console.log("[OK] resolveAt кэшируется по token start, Semantic Tokens Range строится напрямую");

"use strict";

const assert = require("assert");
const { performance } = require("perf_hooks");

const {
    buildRslSmartEnterSnippet,
    isRslBlockHeader
} = require("../client/out/smartEnter");
const { getDefaults } = require("../server/out/defaults");
const {
    rankCompletionItemsForPrefix
} = require("../server/out/features/completionRanking");
const {
    buildRslContextCompletions
} = require("../server/out/features/contextCompletionProvider");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { buildRslDiagnostics } = require("../server/out/diagnostics");
const { buildRslSemanticTokens } = require("../server/out/semanticTokens");
const {
    createFastDocumentSnapshot,
    getFastDocumentSymbols
} = require("../server/out/services/fastDocumentSnapshot");

function measure(name, iterations, action, ceilingMs) {
    for (let index = 0; index < 1000; index++) action();
    const started = performance.now();
    for (let index = 0; index < iterations; index++) action();
    const duration = performance.now() - started;
    console.log(`[METRIC] ${name}: ${duration.toFixed(2)} ms / ${iterations}`);
    assert.ok(
        duration < ceilingMs,
        `${name}: ${duration.toFixed(2)} ms >= ${ceilingMs} ms`
    );
}

measure("Smart Enter header check", 200000, () => {
    isRslBlockHeader("  if (value == 1)");
}, 1500);

measure("Smart Enter snippet", 100000, () => {
    buildRslSmartEnterSnippet({
        beforeCursor: "  if (value == 1)",
        afterCursor: "",
        indentUnit: "  ",
        eol: "\n",
        nextNonEmptyLine: "value = 2;"
    });
}, 1500);

const completionItems = getDefaults().completionItems;
assert.ok(completionItems.length > 200);
measure("builtin completion ranking", 1000, () => {
    rankCompletionItemsForPrefix(completionItems, "Str");
}, 2500);

const serializedBytes = Buffer.byteLength(JSON.stringify(completionItems));
console.log(`[METRIC] builtin completion JSON: ${serializedBytes} bytes`);
assert.ok(serializedBytes < 300000);

const largeSource = Array.from({ length: 900 }, (_, index) => [
    `Macro Handler${index}(obj, cmd, id, key)`,
    `  Var value${index} = ${index};`,
    `  if (value${index} >= 0)`,
    `    Println(value${index});`,
    "  End;",
    "End;"
].join("\n")).join("\n");
const heapBefore = process.memoryUsage().heapUsed;
const lineStarts = [0];
for (let position = 0; position < largeSource.length; position++) {
    if (largeSource[position] === "\n") lineStarts.push(position + 1);
}
const document = {
    uri: "file:///performance-large.mac",
    version: 1,
    getText: () => largeSource,
    positionAt(offset) {
        let low = 0;
        let high = lineStarts.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (lineStarts[middle] <= offset) low = middle + 1;
            else high = middle;
        }
        const line = Math.max(0, low - 1);
        return { line, character: offset - lineStarts[line] };
    }
};
let started = performance.now();
const fastSnapshot = createFastDocumentSnapshot(document);
const outlineSymbols = getFastDocumentSymbols(document, fastSnapshot);
const outlineMs = performance.now() - started;
const index = new WorkspaceIndex();
started = performance.now();
const largeModule = index.updateOpenModule(
    "file:///performance-large.mac",
    largeSource,
    1
);
const parseMs = performance.now() - started;
started = performance.now();
const diagnostics = buildRslDiagnostics(largeModule, index);
const diagnosticsMs = performance.now() - started;
started = performance.now();
const semantic = buildRslSemanticTokens(
    largeModule,
    index,
    new RslScopeResolver(index)
);
const semanticMs = performance.now() - started;
const heapDelta = process.memoryUsage().heapUsed - heapBefore;

console.log(
    `[METRIC] large file ${largeSource.length} chars: ` +
    `outline=${outlineMs.toFixed(1)}ms, parse=${parseMs.toFixed(1)}ms, ` +
    `problems=${diagnosticsMs.toFixed(1)}ms, ` +
    `semantic=${semanticMs.toFixed(1)}ms, heap=${(heapDelta / 1048576).toFixed(1)}MiB`
);
assert.ok(outlineMs < 500, `large outline ${outlineMs.toFixed(1)}ms`);
assert.ok(outlineSymbols.length === 900);
assert.ok(parseMs < 1500, `large parse ${parseMs.toFixed(1)}ms`);
assert.ok(diagnosticsMs < 1500, `large diagnostics ${diagnosticsMs.toFixed(1)}ms`);
assert.ok(semanticMs < 2000, `large semantic ${semanticMs.toFixed(1)}ms`);
assert.ok(heapDelta < 160 * 1024 * 1024, `large heap delta ${heapDelta}`);
assert.ok(semantic.data.length > 0);

/*
 * Completion вызывается на каждый введённый символ, поэтому цена одного
 * запроса не должна зависеть от размера файла. До кэша фильтрованного
 * token stream каждый вызов заново отфильтровывал и аллоцировал весь файл
 * (порядка 2 мс на 300КБ) — линейная работа ровно перед бинарными поисками,
 * ради которых её и добавляли.
 */
const contextOffset = largeSource.lastIndexOf("Println(") + 8;
measure("context completions on large module", 500, () => {
    buildRslContextCompletions(largeModule, index, contextOffset);
}, 60);

console.log("[OK] performance regression guards");

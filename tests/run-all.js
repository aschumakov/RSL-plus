"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

const tests = [
    "lexer.test.js",
    "language-reference.test.js",
    "syntax-conformance.test.js",
    "syntax-parser.test.js",
    "parser-regressions.test.js",
    "smart-enter.test.js",
    "formatter.test.js",
    "folding.test.js",
    "definition.test.js",
    "diagnostic-visibility.test.js",
    "scope-index.test.js",
    "scope-resolution.test.js",
    "diagnostics.test.js",
    "unknown-variables.test.js",
    "language-features.test.js",
    "interactive-features.test.js",
    "language-features-extra.test.js",
    "extended-language-features.test.js",
    "performance-regressions.test.js",
    "quick-fix-extended.test.js",
    "workspace-resolution.test.js",
    "workspace-worker.test.js",
    "server-services.test.js",
    "request-races.test.js",
    "interruptible-work.test.js",
    "parse-scheduling.test.js",
    "model-equivalence.test.js",
    "document-units.test.js",
    "incremental-diagnostics.test.js",
    "text-decoding.test.js",
    "resolver-cache.test.js",
    "index-memory.test.js",
    "fast-completion.test.js",
    "fast-completion-index.test.js",
    "fast-completion-mutations.test.js",
    "import-chm.test.js",
    "special-variables.test.js",
    "expression-checks.test.js",
    "stability-regressions.test.js",
    "completion-protocol.test.js",
    "completion-differential.test.js",
    "completion-stability.test.js",
    "interactive-fast-path.test.js",
    "interactive-differential.test.js",
    "interactive-resolution.test.js",
    "class-member-diagnostics.test.js",
    "range-formatting.test.js",
    "problems-lifecycle.test.js",
    "quick-fixes-and-type-definition.test.js",
];

let failed = false;

for (const testFile of tests) {
    console.log(`\n=== ${testFile} ===`);

    const result = spawnSync(
        process.execPath,
        [path.join(__dirname, testFile)],
        { stdio: "inherit" }
    );

    if (result.status !== 0) {
        failed = true;
    }
}

if (failed) {
    process.exitCode = 1;
} else {
    console.log("\nВсе тесты RSL-plus успешно пройдены.");
}

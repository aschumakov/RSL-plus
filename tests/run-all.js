"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

const tests = [
    "lexer.test.js",
    "syntax-parser.test.js",
    "syntax.test.js",
    "large-sql-macro.test.js",
    "formatter.test.js",
    "folding.test.js",
    "definition.test.js",
    "parser-optimized.test.js",
    "symbol-tree-adapter.test.js",
    "performance-scheduling.test.js",
    "diagnostic-visibility.test.js",
    "performance-optimizations.test.js",
    "scope-index.test.js",
    "diagnostics.test.js",
    "language-features.test.js",
    "quick-fix-extended.test.js",
    "architecture-1.1.4.test.js",
    "resource-optimization-1.1.4.test.js",
    "open-pipeline-1.1.4.test.js",
    "external-summary-scanner.test.js",
    "module-resolution.test.js",
    "settings-service.test.js",
    "quick-fix-registry.test.js",
    "workspace-loader.test.js",
    "import-resolution-diagnostics.test.js",
    "diagnostic-engine.test.js",
    "onerror-references-performance.test.js"
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

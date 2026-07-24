"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

const tests = [
    "lexer.test.js",
    "syntax-parser.test.js",
    "parser-regressions.test.js",
    "formatter.test.js",
    "folding.test.js",
    "definition.test.js",
    "pipeline-architecture.test.js",
    "diagnostic-visibility.test.js",
    "scope-index.test.js",
    "diagnostics.test.js",
    "language-features.test.js",
    "quick-fix-extended.test.js",
    "workspace-resolution.test.js",
    "server-services.test.js",
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

"use strict";

const assert = require("assert");
const extensionManifest = require("../package.json");
const {
    buildRslSmartEnterSnippet,
    isRslBlockHeader
} = require("../client/out/smartEnter");

assert.ok(
    extensionManifest.activationEvents.includes("onCommand:rsl.smartEnter"),
    "rsl.smartEnter должна явно активировать расширение"
);
assert.ok(
    extensionManifest.contributes.commands.some(item =>
        item.command === "rsl.smartEnter"
    ),
    "rsl.smartEnter должна быть объявлена в contributes.commands"
);

for (const header of [
    "If (1 == 1)",
    "If ()",
    "while()",
    "For ( )",
    "while (not rs.Eof)",
    "For (Var i, 0, 10, 1)",
    "With (document)",
    "Private Macro GetOrigin(value): Integer",
    "Class (BaseClass) Service(value)"
]) {
    assert.ok(isRslBlockHeader(header), `${header} должен открывать блок`);
}

for (const text of [
    "If (",
    "value = If(true)",
    "Else",
    "OnError()",
    "Return true;"
]) {
    assert.ok(!isRslBlockHeader(text), `${text} не должен открывать блок`);
}

assert.strictEqual(
    buildRslSmartEnterSnippet({
        beforeCursor: "    If ()",
        afterCursor: "",
        indentUnit: "    ",
        eol: "\n"
    }),
    "\n    $0\nEnd;"
);

assert.strictEqual(
    buildRslSmartEnterSnippet({
        beforeCursor: "  If (1 == 1)",
        afterCursor: "",
        indentUnit: "    ",
        eol: "\n"
    }),
    "\n    $0\nEnd;"
);

assert.strictEqual(
    buildRslSmartEnterSnippet({
        beforeCursor: "\tWhile (true)",
        afterCursor: "   ",
        indentUnit: "\t",
        eol: "\r\n",
        nextNonEmptyLine: "\tEnd;"
    }),
    "\r\n\t$0"
);

/*
 * Вложенный IF вставляется относительно уже существующего отступа строки.
 * VS Code самостоятельно добавит baseIndent к каждой новой строке snippet.
 */
assert.strictEqual(
    buildRslSmartEnterSnippet({
        beforeCursor: "        If (ready)",
        afterCursor: "",
        indentUnit: "    ",
        eol: "\n"
    }),
    "\n    $0\nEnd;"
);

assert.strictEqual(
    buildRslSmartEnterSnippet({
        beforeCursor: "If (true)",
        afterCursor: " + other",
        indentUnit: "    ",
        eol: "\n"
    }),
    undefined
);

console.log("[OK] Smart Enter завершает только полные RSL-блоки");

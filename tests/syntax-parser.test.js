const assert = require("assert");
const { parseRslSyntax } = require("../server/out/syntaxParser");

function codes(source) {
  return parseRslSyntax(source).diagnostics.map(item => item.code);
}

assert.deepStrictEqual(codes([
  "import common, bankinter;",
  "var a = 1, b: integer;",
  "macro Test(p1, p2:@integer)",
  "  if (p1 > 0)",
  "    for (var i, 0, 10, 1)",
  "      a = a + i;",
  "    end;",
  "  elif (p1 == 0)",
  "    return;",
  "  else",
  "    while (true)",
  "      break",
  "    end",
  "  end",
  "onerror (er)",
  "  return er.Code",
  "end;"
].join("\n")), []);

assert.ok(codes("import common bankinter;").includes("missing-comma"));
assert.ok(codes("macro Test(a b)\nend").includes("missing-comma"));
assert.ok(codes("var a = 1\nvar b = 2;").includes("missing-semicolon"));
assert.ok(codes("if (true)\n a = 1\nelse\n a = 2\nend").length === 0);
assert.ok(codes("while (true)\n a = 1;").includes("missing-end"));

console.log("[OK] syntax parser tests");

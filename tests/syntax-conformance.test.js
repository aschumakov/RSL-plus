"use strict";

const assert = require("assert");
const { lexRsl } = require("../server/out/lexer");
const {
    parseRslExpressionTokens,
    parseRslSyntax
} = require("../server/out/syntaxParser");
const {
    parseOutputForms
} = require("../server/out/parsing/outputFormParser");

function significant(source) {
    return lexRsl(source).tokens.filter(token =>
        token.kind !== "whitespace" &&
        token.kind !== "newline" &&
        token.kind !== "comment" &&
        token.kind !== "bom"
    );
}

for (const operator of ["==", "!=", "<=", ">="]) {
    const tokens = significant(`left${operator}right`);
    assert.deepStrictEqual(
        tokens.map(token => token.raw),
        ["left", operator, "right"],
        `${operator} должен быть единым терминалом`
    );

    const expression = parseRslExpressionTokens(tokens);
    assert.ok(expression);
    assert.strictEqual(expression.kind, "BinaryExpression");
    assert.strictEqual(expression.operator, operator);
}

const referenceTokens = significant("@name");
assert.deepStrictEqual(
    referenceTokens.map(token => [token.kind, token.raw]),
    [["symbol", "@"], ["identifier", "name"]]
);
const referenceExpression = parseRslExpressionTokens(referenceTokens);
assert.ok(referenceExpression);
assert.strictEqual(referenceExpression.kind, "UnaryExpression");
assert.strictEqual(referenceExpression.operator, "@");

const escaped = lexRsl('"a\\nb\\rc\\td\\fe\\x41\\X42"').tokens
    .find(token => token.kind === "string");
assert.ok(escaped);
assert.strictEqual(escaped.value, "a\nb\rc\td\feAB");

const missingConst = parseRslSyntax("const Missing;");
assert.ok(missingConst.diagnostics.some(item =>
    item.code === "missing-const-initializer"
));
assert.deepStrictEqual(
    parseRslSyntax("const Ready = 1;").diagnostics,
    []
);
assert.ok(parseRslSyntax("var Broken =;").diagnostics.some(item =>
    item.code === "expected-initializer-expression"
));

const typedArrays = parseRslSyntax(
    "array Values: Integer, Names: String;"
);
assert.deepStrictEqual(typedArrays.diagnostics, []);
assert.deepStrictEqual(
    typedArrays.root.children[0].children.map(item => ({
        name: item.name,
        typeName: item.typeName,
        elementTypeName: item.elementTypeName
    })),
    [
        {
            name: "Values",
            typeName: "array",
            elementTypeName: "Integer"
        },
        {
            name: "Names",
            typeName: "array",
            elementTypeName: "String"
        }
    ]
);

const fileRecord = parseRslSyntax([
    'file Texts("texts.dat") normal txt 120 blob;',
    'record Buffer("buffer.dat", "buffer.dic") normal mem;'
].join("\n"));
assert.deepStrictEqual(fileRecord.diagnostics, []);
assert.deepStrictEqual(
    fileRecord.root.children[0].specifiers,
    ["normal", "txt", "blob"]
);
assert.deepStrictEqual(
    fileRecord.root.children[1].specifiers,
    ["normal", "mem"]
);
assert.ok(parseRslSyntax("file Empty();").diagnostics.some(item =>
    item.code === "expected-file-name"
));
assert.ok(parseRslSyntax("file Invalid(42);").diagnostics.some(item =>
    item.code === "invalid-file-name"
));
assert.ok(parseRslSyntax('file MissingDictionary("file.dat",);')
    .diagnostics.some(item =>
        item.code === "expected-dictionary-name"
    ));

const output = parseOutputForms(
    lexRsl("[#](value:i, value:iv);").tokens
);
assert.deepStrictEqual(
    output[0].arguments.flatMap(argument =>
        argument.specifiers.map(specifier => specifier.text.toLowerCase())
    ),
    ["i", "iv"]
);

console.log("[OK] RSL syntax conformance tests");

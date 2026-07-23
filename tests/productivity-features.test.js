"use strict";

const assert = require("assert");
const { CBase } = require("../server/out/common");
const { lexRsl } = require("../server/out/lexer");
const { parseRslSyntax } = require("../server/out/syntaxParser");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const {
    parseOutputForms,
    collectFormatSpecifierTokenStarts
} = require("../server/out/parsing/outputFormParser");
const {
    buildRslDocumentHighlights
} = require("../server/out/features/documentHighlights");
const {
    buildRslHoverContent
} = require("../server/out/features/hoverFormatter");
const {
    buildSelectionRanges,
    resolveBlockNavigationPosition
} = require("../server/out/features/blockNavigation");
const {
    buildCyclicImportDiagnostics
} = require("../server/out/diagnostics/cyclicImportDiagnostics");
const {
    RslDiagnosticEngine,
    filterClosedOutputFormDiagnostics
} = require("../server/out/diagnostics/diagnosticEngine");

function createOpenModule(index, uri, source, version = 1) {
    const syntax = parseRslSyntax(source, undefined, {
        buildExpressionTree: false
    });
    const tree = CBase.fromSyntax(source, 0, syntax, true, false);
    return index.updateOpenModule(uri, source, tree, version, syntax);
}

(function outputFormsAreClassifiedAndParsed() {
    const source = [
        "[ Номер счета ########## ]",
        "(Account:10:c, Summa:m);",
        "[Обычный текст]",
        "[",
        "select '[^[[:digit:]]]*' from dual",
        "]",
        "value = accounts[i];",
        "[#] (\"Длинная строка\":w:*, 6);"
    ].join("\n");
    const lex = lexRsl(source);
    const squares = lex.tokens.filter(token => token.kind === "square");

    assert.deepStrictEqual(
        squares.map(token => token.squareKind),
        ["output", "output", "sql", "output"]
    );
    assert.strictEqual(
        lex.tokens.filter(token =>
            token.kind === "symbol" && token.raw === "["
        ).length,
        1,
        "Индекс массива должен оставаться обычным RSL-кодом"
    );

    const forms = parseOutputForms(lex.tokens);
    assert.strictEqual(forms.length, 3);
    assert.deepStrictEqual(
        forms[0].arguments.flatMap(argument =>
            argument.specifiers.map(specifier => specifier.text.toLowerCase())
        ),
        ["10", "c", "m"]
    );
    assert.deepStrictEqual(
        forms[2].arguments.flatMap(argument =>
            argument.specifiers.map(specifier => specifier.text.toLowerCase())
        ),
        ["w", "*"]
    );

    const formatStarts = collectFormatSpecifierTokenStarts(lex.tokens);
    const formatNames = lex.tokens
        .filter(token => formatStarts.has(token.start))
        .map(token => token.value.toLowerCase());
    assert.deepStrictEqual(formatNames, ["c", "m", "w"]);

    const typedParameterSource = "Macro Typed(OnDate:date)\nEnd;";
    const typedParameterLex = lexRsl(typedParameterSource);
    assert.deepStrictEqual(
        Array.from(collectFormatSpecifierTokenStarts(typedParameterLex.tokens)),
        [],
        "Тип DATE в параметре Macro не должен считаться форматом :d:a:t:e"
    );

    const apostropheSource = [
        "[Текст с апострофом customer's account]",
        "Macro Real()",
        "End;"
    ].join("\n");
    const apostropheLex = lexRsl(apostropheSource);
    assert.strictEqual(
        apostropheLex.tokens.find(token => token.kind === "square").squareKind,
        "output"
    );
    assert.ok(apostropheLex.tokens.some(token => token.raw === "Macro"));
})();

(function outputFormSeparatorDoesNotHideClosingBracket() {
    const source = [
        "If (ComisSum == 0)",
        "[ АО \"ЕВРАЗИЙСКИЙ БАНК\" БИК #",
        "  Сумма ##################",
        "  ------------------------------------------------------------]",
        "(Account, Summa:l);",
        "End;"
    ].join("\n");
    const uri = "file:///workspace/output-separator.mac";
    const index = new WorkspaceIndex();
    const module = createOpenModule(index, uri, source);
    const square = module.lex.tokens.find(token =>
        token.kind === "square" && token.squareKind === "output"
    );

    assert.ok(square);
    assert.ok(square.raw.endsWith("]"));

    const falseDiagnostic = {
        code: "unclosed-square-block",
        message: "Блок [ ... ] не закрыт символом ]",
        range: {
            start: { line: square.line, character: square.character },
            end: { line: square.endLine, character: square.endCharacter }
        }
    };
    assert.deepStrictEqual(
        filterClosedOutputFormDiagnostics(module, [falseDiagnostic]),
        []
    );

    const engineDiagnostics = new RslDiagnosticEngine().build(
        module,
        index,
        {
            structure: true,
            unusedVariables: false,
            unusedImports: false,
            debugBreak: false,
            useBeforeDeclaration: false,
            ambiguousReferences: false,
            deprecatedDeclarations: false,
            maxProblems: 200
        }
    );
    assert.ok(
        !engineDiagnostics.some(item =>
            item.code === "unclosed-square-block"
        )
    );
})();

(function exactDocumentHighlightsDoNotMixScopes() {
    const source = [
        "Macro First(p)",
        "  Var value: Integer;",
        "  value = p;",
        "  Return value;",
        "End;",
        "Macro Second()",
        "  Var value: Integer;",
        "  value = 2;",
        "End;"
    ].join("\n");
    const uri = "file:///workspace/highlight.mac";
    const index = new WorkspaceIndex();
    const module = createOpenModule(index, uri, source);
    const resolver = new RslScopeResolver(index);
    const offset = source.indexOf("value = p");
    const highlights = buildRslDocumentHighlights(
        module,
        index,
        resolver,
        offset
    );

    assert.strictEqual(highlights.length, 3);
    assert.ok(highlights.every(item => item.range.start.line <= 3));
})();

(function hoverContainsSignatureLocationAndBaseClass() {
    const source = [
        "Class (TRecHandler) TDocument()",
        "  Macro Build(Account:TRecHandler):Integer",
        "    Return 1;",
        "  End;",
        "End;"
    ].join("\n");
    const uri = "file:///workspace/MC_lib.mac";
    const index = new WorkspaceIndex();
    const module = createOpenModule(index, uri, source);
    const classObject = module.object.RecursiveFind("TDocument");
    const method = classObject.RecursiveFind("Build");

    const classHover = buildRslHoverContent(index, uri, classObject).value;
    const methodHover = buildRslHoverContent(index, uri, method).value;
    assert.ok(classHover.includes("Class (TRecHandler) TDocument"));
    assert.ok(classHover.includes("MC\\_lib\\.mac") || classHover.includes("MC_lib.mac"));
    assert.ok(methodHover.includes("Macro Build(Account:TRecHandler): Integer"));
    assert.ok(methodHover.includes("Контейнер:** TDocument"));
})();

(function selectionRangesAndBlockNavigationFollowSyntaxTree() {
    const source = [
        "Class TestClass()",
        "  Macro Run()",
        "    If (true)",
        "      Var value = 1;",
        "    End;",
        "  End;",
        "End;"
    ].join("\n");
    const uri = "file:///workspace/navigation.mac";
    const index = new WorkspaceIndex();
    const module = createOpenModule(index, uri, source);
    const position = { line: 3, character: 10 };
    const selection = buildSelectionRanges(module, [position])[0];

    let levels = 0;
    let current = selection;
    while (current) {
        levels++;
        current = current.parent;
    }
    assert.ok(levels >= 5, `Ожидалось не менее 5 уровней, получено ${levels}`);

    assert.deepStrictEqual(
        resolveBlockNavigationPosition(module, position, "start"),
        { line: 2, character: 4 }
    );
    assert.deepStrictEqual(
        resolveBlockNavigationPosition(module, position, "end"),
        { line: 4, character: 4 }
    );
})();

(function cyclicImportsAreReportedOnTheRootImport() {
    const index = new WorkspaceIndex();
    index.updateExternalModule(
        "file:///workspace/B.mac",
        "Import C.mac;\nMacro B()\nEnd;",
        1
    );
    index.updateExternalModule(
        "file:///workspace/C.mac",
        "Import A.mac;\nMacro C()\nEnd;",
        1
    );
    const module = createOpenModule(
        index,
        "file:///workspace/A.mac",
        "Import B.mac;\nMacro A()\nEnd;"
    );

    const diagnostics = buildCyclicImportDiagnostics(
        module,
        index,
        { structure: true }
    );
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, "cyclic-import");
    assert.ok(diagnostics[0].message.includes("A.mac"));
    assert.ok(diagnostics[0].message.includes("B.mac"));
    assert.ok(diagnostics[0].message.includes("C.mac"));
})();

console.log("[OK] Productivity features: output forms, highlights, hover, navigation and cyclic imports");

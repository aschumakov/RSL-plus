"use strict";

const assert = require("assert");

const serverModulePath = require.resolve("../server/out/server");
require.cache[serverModulePath] = {
    id: serverModulePath,
    filename: serverModulePath,
    loaded: true,
    exports: {
        getTree: () => [],
        GetFileByNameRequest: () => undefined
    }
};

const { createSymbolTree } = require("./test-helpers");
const { buildRslCodeActions } = require("../server/out/codeActions");
const { buildRslDiagnostics } = require("../server/out/diagnostics");
const {
    buildCyclicImportDiagnostics
} = require("../server/out/diagnostics/cyclicImportDiagnostics");
const {
    RslDiagnosticEngine,
    filterClosedOutputFormDiagnostics
} = require("../server/out/diagnostics/diagnosticEngine");
const {
    findRslReferences
} = require("../server/out/analysis/references");
const {
    buildSelectionRanges,
    resolveCurrentBlockRange,
    resolveBlockNavigationPosition
} = require("../server/out/features/blockNavigation");
const {
    buildRslDocumentHighlights
} = require("../server/out/features/documentHighlights");
const {
    buildRslHoverContent
} = require("../server/out/features/hoverFormatter");
const { lexRsl } = require("../server/out/lexer");
const {
    collectFormatSpecifierTokenStarts,
    parseOutputForms
} = require("../server/out/parsing/outputFormParser");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const {
    buildRslSemanticTokens,
    RSL_SEMANTIC_TOKENS_LEGEND
} = require("../server/out/semanticTokens");
const { parseRslSyntax } = require("../server/out/syntaxParser");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

let passed = 0;
let failed = 0;

function test(name, action) {
    try {
        action();
        passed++;
        console.log(`[OK] ${name}`);
    } catch (error) {
        failed++;
        console.error(`[FAIL] ${name}`);
        console.error(error);
    }
}

function createModule(index, uri, source, open = true) {
    return open
        ? index.updateOpenModule(uri, source, 1)
        : index.updateExternalModule(uri, source, 1);
}

function createSyntaxModule(index, uri, source, version = 1) {
    const syntax = parseRslSyntax(source, undefined, {
        buildExpressionTree: false
    });
    return index.updateOpenModule(uri, source, version, syntax);
}

function paramsFor(module, diagnostic) {
    return {
        textDocument: { uri: module.uri },
        range: diagnostic.range,
        context: { diagnostics: [diagnostic] }
    };
}

test("Quick Fix удаляет DEBUGBREAK", () => {
    const index = new WorkspaceIndex();
    const source = "Macro Test()\n DebugBreak;\nEnd;";
    const module = createModule(index, "file:///main.mac", source);
    const diagnostic = buildRslDiagnostics(module, index)
        .find(item => item.code === "debugbreak");
    assert.ok(diagnostic);

    const actions = buildRslCodeActions(
        module,
        paramsFor(module, diagnostic)
    );
    assert.strictEqual(actions.length, 1);
    const edit = actions[0].edit.changes[module.uri][0];
    assert.strictEqual(edit.newText, "");
    assert.strictEqual(edit.range.start.line, 1);
    assert.strictEqual(edit.range.end.line, 2);
});

test("Quick Fix удаляет один элемент из Import", () => {
    const index = new WorkspaceIndex();
    createModule(index, "file:///common.mac", "Macro Shared()\nEnd;", false);
    const source = "Import common, other;\nMacro Test()\nEnd;";
    const module = createModule(index, "file:///main.mac", source);
    const diagnostic = buildRslDiagnostics(module, index)
        .find(item => item.code === "unused-import");
    assert.ok(diagnostic);

    const actions = buildRslCodeActions(
        module,
        paramsFor(module, diagnostic)
    );
    assert.strictEqual(actions.length, 1);
    const edit = actions[0].edit.changes[module.uri][0];
    assert.strictEqual(edit.newText, "");
    assert.strictEqual(edit.range.start.line, 0);
});

test("Quick Fix добавляет '+' после первого строкового литерала", () => {
    const index = new WorkspaceIndex();
    const source = [
        "Macro Test()",
        "  cmd = RsdCommand(",
        "      \" select t_enddate from ddscn_cel_dbt \"",
        "      \" where t_branch = ? \" +",
        "      \" and t_contractid = ? \");",
        "End;"
    ].join("\n");
    const module = createSyntaxModule(
        index,
        "file:///implicit-concat.mac",
        source
    );
    const diagnostic = buildRslDiagnostics(module, index).find(item =>
        item.code === "implicit-string-concatenation"
    );
    assert.ok(diagnostic);
    assert.strictEqual(diagnostic.range.start.line, 2);

    const actions = buildRslCodeActions(
        module,
        paramsFor(module, diagnostic)
    );
    assert.strictEqual(actions.length, 1);
    const edit = actions[0].edit.changes[module.uri][0];
    assert.strictEqual(edit.newText, " +");
    assert.strictEqual(edit.range.start.line, 2);
    assert.strictEqual(
        edit.range.start.character,
        source.split("\n")[2].length
    );
    assert.deepStrictEqual(edit.range.start, edit.range.end);
});

test("Find All References находит объявление и вызов", () => {
    const index = new WorkspaceIndex();
    const library = "Macro Shared(value)\nEnd;";
    const main = "Import library;\nMacro Test()\n Shared(1);\nEnd;";
    /* Синхронный helper работает по открытым моделям; workspace-поиск — async. */
    createModule(index, "file:///library.mac", library, true);
    createModule(index, "file:///main.mac", main);
    const resolver = new RslScopeResolver(index);
    const references = findRslReferences(
        index,
        resolver,
        "file:///main.mac",
        main.indexOf("Shared"),
        true
    );

    assert.strictEqual(references.length, 2);
    assert.ok(references.some(item => item.uri === "file:///library.mac"));
    assert.ok(references.some(item => item.uri === "file:///main.mac"));
});

test("Find All References умеет исключать объявление", () => {
    const index = new WorkspaceIndex();
    const source = "Macro Shared()\nEnd;\nMacro Test()\n Shared();\nEnd;";
    createModule(index, "file:///main.mac", source);
    const resolver = new RslScopeResolver(index);
    const references = findRslReferences(
        index,
        resolver,
        "file:///main.mac",
        source.lastIndexOf("Shared"),
        false
    );
    assert.strictEqual(references.length, 1);
    assert.strictEqual(references[0].range.start.line, 3);
});

test("Semantic Tokens помечают объявление Macro", () => {
    const index = new WorkspaceIndex();
    const source = "Macro Shared(value)\n Var result;\n result = value;\nEnd;";
    const module = createModule(index, "file:///main.mac", source);
    const tokens = buildRslSemanticTokens(module, index).data;

    assert.ok(tokens.length >= 5);
    assert.strictEqual(tokens[3], 2);
    assert.strictEqual(tokens[4] & 1, 1);
});

test("Semantic Tokens помечают параметр отдельно от переменной", () => {
    const index = new WorkspaceIndex();
    const source = "Macro Shared(value)\n value = 1;\nEnd;";
    const module = createModule(index, "file:///main.mac", source);
    const tokens = buildRslSemanticTokens(module, index).data;
    const tokenTypes = [];

    for (let offset = 0; offset < tokens.length; offset += 5) {
        tokenTypes.push(tokens[offset + 3]);
    }

    assert.ok(tokenTypes.includes(4));
});

test("Semantic Tokens не смещаются после многострочных квадратных блоков", () => {
    for (const eol of ["\n", "\r\n"]) {
        const source = [
            "[",
            "select '[^[[:digit:]]]*' from dual",
            "]",
            "[ Заголовок ####",
            "  продолжение #### ]",
            "(Account);",
            "Macro Real(value)",
            "  Var result;",
            "  result = value;",
            "End;"
        ].join(eol);
        const index = new WorkspaceIndex();
        const module = createModule(index, "file:///square.mac", source);
        const data = buildRslSemanticTokens(module, index).data;
        const lines = source.split(/\r\n|\n|\r/);
        let line = 0;
        let character = 0;
        const decoded = [];

        for (let offset = 0; offset < data.length; offset += 5) {
            line += data[offset];
            character = data[offset] === 0
                ? character + data[offset + 1]
                : data[offset + 1];
            decoded.push({
                line,
                character,
                text: lines[line].substring(
                    character,
                    character + data[offset + 2]
                ),
                type: RSL_SEMANTIC_TOKENS_LEGEND.tokenTypes[data[offset + 3]]
            });
        }

        assert.ok(decoded.some(token =>
            token.line === 6 && token.text === "Real" &&
            token.type === "function"
        ));
        assert.ok(decoded.every(token =>
            token.line < lines.length && token.character >= 0 && token.text
        ));
    }
});

test("Output forms классифицируются и формат-спецификаторы разбираются", () => {
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
            argument.specifiers.map(item => item.text.toLowerCase())
        ),
        ["10", "c", "m"]
    );
    assert.deepStrictEqual(
        forms[2].arguments.flatMap(argument =>
            argument.specifiers.map(item => item.text.toLowerCase())
        ),
        ["w", "*"]
    );

    const formatStarts = collectFormatSpecifierTokenStarts(lex.tokens);
    assert.deepStrictEqual(
        lex.tokens
            .filter(token => formatStarts.has(token.start))
            .map(token => token.value.toLowerCase()),
        ["c", "m", "w"]
    );
    assert.deepStrictEqual(
        Array.from(collectFormatSpecifierTokenStarts(
            lexRsl("Macro Typed(OnDate:date)\nEnd;").tokens
        )),
        [],
        "Тип DATE в параметре Macro не должен считаться форматом"
    );

    const apostropheLex = lexRsl([
        "[Текст с апострофом customer's account]",
        "Macro Real()",
        "End;"
    ].join("\n"));
    assert.strictEqual(
        apostropheLex.tokens.find(
            token => token.kind === "square"
        ).squareKind,
        "output"
    );
    assert.ok(apostropheLex.tokens.some(token => token.raw === "Macro"));
});

test("Закрытая печатная форма не создаёт unclosed-square-block", () => {
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
    const module = createSyntaxModule(index, uri, source);
    const square = module.lex.tokens.find(token =>
        token.kind === "square" && token.squareKind === "output"
    );
    assert.ok(square);
    assert.ok(square.raw.endsWith("]"));

    const falseDiagnostic = {
        code: "unclosed-square-block",
        message: "Блок [ ... ] не закрыт символом ]",
        range: {
            start: {
                line: square.line,
                character: square.character
            },
            end: {
                line: square.endLine,
                character: square.endCharacter
            }
        }
    };
    assert.deepStrictEqual(
        filterClosedOutputFormDiagnostics(module, [falseDiagnostic]),
        []
    );
    const diagnostics = new RslDiagnosticEngine().build(
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
    assert.ok(!diagnostics.some(item =>
        item.code === "unclosed-square-block"
    ));
});

test("Document Highlights не смешивает одинаковые имена разных Macro", () => {
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
    const module = createSyntaxModule(index, uri, source);
    const highlights = buildRslDocumentHighlights(
        module,
        index,
        new RslScopeResolver(index),
        source.indexOf("value = p")
    );
    assert.strictEqual(highlights.length, 3);
    assert.ok(highlights.every(item => item.range.start.line <= 3));
});

test("Hover содержит сигнатуру, расположение и базовый класс", () => {
    const source = [
        "Class (TRecHandler) TDocument()",
        "  Macro Build(Account:TRecHandler):Integer",
        "    Return 1;",
        "  End;",
        "End;"
    ].join("\n");
    const uri = "file:///workspace/MC_lib.mac";
    const index = new WorkspaceIndex();
    const module = createSyntaxModule(index, uri, source);
    const classObject = module.symbolTree.find("TDocument");
    const method = classObject.find("Build");
    const classHover = buildRslHoverContent(index, uri, classObject).value;
    const methodHover = buildRslHoverContent(index, uri, method).value;

    assert.ok(classHover.includes("Class (TRecHandler) TDocument"));
    assert.ok(
        classHover.includes("MC\\_lib\\.mac") ||
        classHover.includes("MC_lib.mac")
    );
    assert.ok(
        methodHover.includes(
            "Macro Build(Account:TRecHandler): Integer"
        )
    );
    assert.ok(methodHover.includes("Контейнер:** TDocument"));
});

test("Hover показывает значение локальной и импортированной константы", () => {
    const index = new WorkspaceIndex();
    const localUri = "file:///workspace/constants.mac";
    const local = createSyntaxModule(
        index,
        localUri,
        "Const PDOC_ORIGIN_LOCAL = 2;"
    );
    const localConstant = local.symbolTree.find("PDOC_ORIGIN_LOCAL");
    assert.ok(localConstant);
    const localHover = buildRslHoverContent(
        index,
        localUri,
        localConstant
    ).value;
    assert.ok(localHover.includes("Const PDOC_ORIGIN_LOCAL = 2"));

    const importedUri = "file:///workspace/primdocext.mac";
    const imported = index.updateExternalModule(
        importedUri,
        "// constants\nConst PDOC_ORIGIN_SAP = 1;",
        1
    );
    const importedConstant = imported.symbolTree.find(
        "PDOC_ORIGIN_SAP"
    );
    assert.ok(importedConstant);
    const importedHover = buildRslHoverContent(
        index,
        importedUri,
        importedConstant
    ).value;
    assert.ok(importedHover.includes("Const PDOC_ORIGIN_SAP = 1"));
    assert.ok(
        importedHover.includes("Строка:** 2"),
        importedHover
    );
});

test("Selection Range и переход по блоку используют syntax tree", () => {
    const source = [
        "Class TestClass()",
        "  Macro Run()",
        "    If (true)",
        "      Var value = 1;",
        "    End;",
        "  End;",
        "End;"
    ].join("\n");
    const index = new WorkspaceIndex();
    const module = createSyntaxModule(
        index,
        "file:///workspace/navigation.mac",
        source
    );
    const position = { line: 3, character: 10 };
    let current = buildSelectionRanges(module, [position])[0];
    let levels = 0;
    while (current) {
        levels++;
        current = current.parent;
    }
    assert.ok(levels >= 5, `Ожидалось не менее 5 уровней: ${levels}`);
    assert.deepStrictEqual(
        resolveBlockNavigationPosition(module, position, "start"),
        { line: 2, character: 4 }
    );
    assert.deepStrictEqual(
        resolveBlockNavigationPosition(module, position, "end"),
        { line: 4, character: 4 }
    );

    const ifRange = resolveCurrentBlockRange(module, position);
    assert.deepStrictEqual(ifRange, {
        start: { line: 2, character: 0 },
        end: { line: 4, character: 8 }
    });
    assert.deepStrictEqual(
        resolveCurrentBlockRange(module, position, ifRange),
        {
            start: { line: 1, character: 0 },
            end: { line: 5, character: 6 }
        }
    );
});

test("Циклический Import диагностируется на корневом Import", () => {
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
    const module = createSyntaxModule(
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
    ["A.mac", "B.mac", "C.mac"].forEach(name =>
        assert.ok(diagnostics[0].message.includes(name))
    );
});

/*
 * Правило порядка разрешения: локальный символ ищется до внешнего индекса.
 *
 * Это то, что делает навигацию по текущему файлу независимой от готовности
 * Import-графа: переменные, параметры и Macro своего файла обязаны находиться,
 * даже если ни один импортированный модуль ещё не загружен (а при фоновой
 * индексации workspace он загружен не будет ещё секунды). Правило легко
 * потерять, поменяв порядок веток в resolveTokenAt, поэтому оно закреплено
 * тестом, а не только комментарием.
 */
test("локальные символы разрешаются без загруженного Import", () => {
    const index = new WorkspaceIndex();
    const source = [
        "Import library;",
        "Macro Handler(parameter)",
        "  Var localValue = 1;",
        "  localValue = parameter + Shared(2);",
        "End;"
    ].join("\n");
    const uri = "file:///workspace/local-first.mac";
    const module = createSyntaxModule(index, uri, source);
    const resolver = new RslScopeResolver(index);

    /* Ни library, ни Shared не загружены: внешнего индекса просто нет. */
    assert.strictEqual(index.findImportedSymbols(uri, "Shared").length, 0);

    const localOffset = source.lastIndexOf("localValue");
    const local = resolver.resolveAt(uri, module.symbolTree, localOffset);
    assert.ok(local, "Локальная переменная должна разрешаться");
    assert.strictEqual(local.uri, uri);
    assert.strictEqual(local.symbol.name, "localValue");

    const parameterOffset = source.lastIndexOf("parameter");
    const parameter = resolver.resolveAt(
        uri,
        module.symbolTree,
        parameterOffset
    );
    assert.ok(parameter, "Параметр должен разрешаться");
    assert.strictEqual(parameter.symbol.name, "parameter");

    const macroOffset = source.indexOf("Handler");
    const macro = resolver.resolveAt(uri, module.symbolTree, macroOffset);
    assert.ok(macro, "Macro текущего файла должно разрешаться");
    assert.strictEqual(macro.symbol.name, "Handler");

    /*
     * Внешний символ с тем же именем не должен перебивать локальный: иначе
     * после загрузки Import переход по локальной переменной уехал бы в
     * другой файл.
     */
    index.updateExternalModule(
        "file:///workspace/library.mac",
        "Macro localValue()\nEnd;\nMacro Shared(value)\nEnd;",
        1
    );
    const afterImport = resolver.resolveAt(uri, module.symbolTree, localOffset);
    assert.strictEqual(
        afterImport.uri,
        uri,
        "Локальное объявление обязано выигрывать у импортированного"
    );
});

console.log("");
console.log(`Пройдено: ${passed}`);
console.log(`Ошибок: ${failed}`);

if (failed > 0) {
    process.exitCode = 1;
}

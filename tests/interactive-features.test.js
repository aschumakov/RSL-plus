"use strict";

const assert = require("assert");
const path = require("path");

const { TextDocument } = require(path.join(
    __dirname,
    "..",
    "server",
    "node_modules",
    "vscode-languageserver-textdocument"
));
const { createSymbolTree } = require("./test-helpers");
const {
    buildKnownAutoImportCompletions,
    resolveAutoImportEdit,
    buildMissingImportActions
} = require("../server/out/features/autoImportProvider");
const {
    RslCallHierarchyProvider
} = require("../server/out/features/callHierarchyProvider");
const {
    formatRslDocumentRange
} = require("../server/out/features/rangeFormatting");
const {
    buildRslSignatureHelp
} = require("../server/out/features/signatureHelpProvider");
const {
    buildRslContextCompletions
} = require("../server/out/features/contextCompletionProvider");
const {
    completionPrefixAt,
    rankCompletionItemsForPrefix
} = require("../server/out/features/completionRanking");
const {
    buildRslSourceCodeActions,
    RSL_FIX_ALL_KIND
} = require("../server/out/features/sourceCodeActions");
const {
    findRslWorkspaceSymbols
} = require("../server/out/features/workspaceSymbolProvider");
const {
    ReferenceIndex
} = require("../server/out/analysis/referenceIndex");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { parseRslSyntax } = require("../server/out/syntaxParser");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

let passed = 0;
let failed = 0;

async function test(name, action) {
    try {
        await action();
        passed++;
        console.log(`[OK] ${name}`);
    } catch (error) {
        failed++;
        console.error(`[FAIL] ${name}`);
        console.error(error);
    }
}

function createModule(index, uri, source) {
    const syntax = parseRslSyntax(source, undefined, {
        buildExpressionTree: false
    });
    return index.updateOpenModule(uri, source, 1, syntax);
}

function positionAt(source, offset) {
    const before = source.substring(0, offset).split("\n");
    return {
        line: before.length - 1,
        character: before[before.length - 1].length
    };
}

function applyTextEdit(document, edit) {
    const source = document.getText();
    return source.substring(0, document.offsetAt(edit.range.start)) +
        edit.newText +
        source.substring(document.offsetAt(edit.range.end));
}

(async () => {
    await test("Signature Help учитывает вложенные вызовы", () => {
        const index = new WorkspaceIndex();
        const library = [
            "Macro Shared(first:Integer, second:String, third:Date):Bool",
            "End;"
        ].join("\n");
        const main = [
            "Import library;",
            "Macro Test()",
            "  Shared(1, Nested(2, 3), );",
            "End;"
        ].join("\n");
        createModule(index, "file:///library.mac", library);
        const module = createModule(index, "file:///main.mac", main);
        const resolver = new RslScopeResolver(index);
        const cursor = main.indexOf(", );") + 2;
        const help = buildRslSignatureHelp(
            module,
            resolver,
            cursor
        );

        assert.ok(help);
        assert.strictEqual(help.activeParameter, 2);
        assert.strictEqual(
            help.signatures[0].label,
            "Shared(first:Integer, second:String, third:Date): Bool"
        );
        assert.deepStrictEqual(
            help.signatures[0].parameters.map(item => item.label),
            ["first:Integer", "second:String", "third:Date"]
        );
    });

    await test("Completion добавляет Import отдельным TextEdit", () => {
        const index = new WorkspaceIndex();
        createModule(
            index,
            "file:///workspace/library.mac",
            "Macro Shared(value)\nEnd;\nMacro Unrelated()\nEnd;"
        );
        const main = "Macro Test()\n  Sha\nEnd;";
        const module = createModule(
            index,
            "file:///workspace/main.mac",
            main
        );
        const completion = buildKnownAutoImportCompletions(module, index).items
            .find(item => item.label === "Shared");

        assert.ok(completion);
        /*
         * Правка Import в списке не считается: её строит resolve для той
         * строки, которую выбрал пользователь. Здесь проверяется именно она.
         */
        assert.strictEqual(completion.additionalTextEdits, undefined);

        const edit = resolveAutoImportEdit(
            module,
            index,
            completion.data.rslAutoImportUri
        );
        assert.ok(edit, "правка Import обязана строиться по выбранной строке");
        assert.strictEqual(edit.newText, "Import library;\n");
        assert.deepStrictEqual(
            buildKnownAutoImportCompletions(module, index, "Sha").items
                .map(item => item.label),
            ["Shared"]
        );
    });

    await test("Quick Fix предлагает Import для неизвестного символа", async () => {
        const index = new WorkspaceIndex();
        const library = createModule(
            index,
            "file:///workspace/library.mac",
            "Macro Shared(value)\nEnd;"
        );
        const main = "Macro Test()\n  Shared(1);\nEnd;";
        const module = createModule(
            index,
            "file:///workspace/main.mac",
            main
        );
        const resolver = new RslScopeResolver(index);
        const tokenOffset = main.indexOf("Shared");
        const position = positionAt(main, tokenOffset);
        const actions = await buildMissingImportActions(
            module,
            index,
            resolver,
            { start: position, end: position },
            async () => [library]
        );

        assert.strictEqual(actions.length, 1);
        assert.ok(actions[0].title.includes("Import library"));
        assert.strictEqual(
            actions[0].edit.changes[module.uri][0].newText,
            "Import library;\n"
        );
    });

    await test("Completion подсказывает Import и строковый ExecMacro", () => {
        const index = new WorkspaceIndex();
        createModule(
            index,
            "file:///workspace/library.mac",
            "Macro Shared(value)\nEnd;"
        );
        const source = [
            "Import library;",
            "Macro Test()",
            "  ExecMacro(\"Sha\");",
            "End;"
        ].join("\n");
        const module = createModule(
            index,
            "file:///workspace/main.mac",
            source
        );
        const macroItems = buildRslContextCompletions(
            module,
            index,
            source.indexOf("Sha") + 2
        );
        assert.ok(macroItems.some(item => item.label === "Shared"));

        const importSource = "Import lib;\nMacro Test()\nEnd;";
        const importModule = createModule(
            index,
            "file:///workspace/import-test.mac",
            importSource
        );
        const importItems = buildRslContextCompletions(
            importModule,
            index,
            importSource.indexOf("lib") + 2
        );
        assert.ok(importItems.some(item => item.label === "library"));
    });

    await test("Completion ранжирует по префиксу, не отбрасывая элементы", () => {
        const source = "Macro Test()\n  GetOr\nEnd;";
        const prefix = completionPrefixAt(
            source,
            source.indexOf("GetOr") + "GetOr".length
        );
        assert.strictEqual(prefix, "GetOr");

        const items = rankCompletionItemsForPrefix([
            { label: "GetOrderFromImport", sortText: "5_getorderfromimport" },
            { label: "UnrelatedImported", sortText: "5_unrelatedimported" },
            { label: "GetOrigin", sortText: "2_getorigin" }
        ], prefix);
        /*
         * Список отдаётся клиенту полным: отбор — его дело. Сервер задаёт
         * только порядок, поэтому непохожее имя остаётся в наборе, но
         * уходит в конец.
         */
        const order = [...items]
            .sort((first, second) =>
                String(first.sortText).localeCompare(String(second.sortText))
            )
            .map(item => item.label);
        assert.deepStrictEqual(
            order,
            ["GetOrigin", "GetOrderFromImport", "UnrelatedImported"]
        );

        /* С отбором — только то, что похоже на набранное. */
        const dropped = rankCompletionItemsForPrefix([
            { label: "GetOrderFromImport", sortText: "5_getorderfromimport" },
            { label: "UnrelatedImported", sortText: "5_unrelatedimported" },
            { label: "GetOrigin", sortText: "2_getorigin" }
        ], prefix, { dropIrrelevant: true });
        assert.deepStrictEqual(
            dropped.map(item => item.label),
            ["GetOrderFromImport", "GetOrigin"]
        );
        const own = items.find(item => item.label === "GetOrigin");
        const imported = items.find(item =>
            item.label === "GetOrderFromImport"
        );
        assert.ok(String(own.sortText) < String(imported.sortText));
        assert.strictEqual(own.preselect, true);
    });

    await test("Workspace Symbols фильтрует известные Macro для Ctrl+T", () => {
        const index = new WorkspaceIndex();
        createModule(
            index,
            "file:///workspace/library.mac",
            "Macro Shared(value)\nEnd;\nMacro Other()\nEnd;"
        );
        const symbols = findRslWorkspaceSymbols(index, "sha");
        assert.deepStrictEqual(symbols.map(item => item.name), ["Shared"]);
        assert.strictEqual(symbols[0].location.uri, "file:///workspace/library.mac");
    });

    await test("Organize Imports удаляет только повторы и сохраняет порядок", () => {
        const index = new WorkspaceIndex();
        const source = [
            "Import first, first, second;",
            "Import second;",
            "Macro Test()",
            "End;"
        ].join("\n");
        const module = createModule(index, "file:///workspace/main.mac", source);
        const actions = buildRslSourceCodeActions(module, {
            textDocument: { uri: module.uri },
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 }
            },
            context: {
                diagnostics: [],
                only: ["source.organizeImports"]
            }
        });
        assert.strictEqual(actions.length, 1);
        const document = TextDocument.create(module.uri, "rsl", 1, source);
        const edits = actions[0].edit.changes[module.uri].slice().sort(
            (left, right) => document.offsetAt(right.range.start) -
                document.offsetAt(left.range.start)
        );
        let result = source;
        for (const edit of edits) {
            const current = TextDocument.create(module.uri, "rsl", 1, result);
            result = applyTextEdit(current, edit);
        }
        assert.strictEqual(
            result,
            "Import first, second;\nMacro Test()\nEnd;"
        );
    });

    await test("Fix All объединяет только безопасные исправления", () => {
        const index = new WorkspaceIndex();
        const source = "DEBUGBREAK;\nMacro Test();;\nEnd;";
        const module = createModule(index, "file:///workspace/main.mac", source);
        const duplicateOffset = source.indexOf(";;") + 1;
        const actions = buildRslSourceCodeActions(module, {
            textDocument: { uri: module.uri },
            range: {
                start: { line: 0, character: 0 },
                end: { line: 2, character: 4 }
            },
            context: {
                only: [RSL_FIX_ALL_KIND],
                diagnostics: [
                    {
                        code: "debugbreak",
                        message: "DEBUGBREAK",
                        range: {
                            start: positionAt(source, 0),
                            end: positionAt(source, "DEBUGBREAK".length)
                        },
                        data: { start: 0, end: "DEBUGBREAK".length }
                    },
                    {
                        code: "duplicate-semicolon",
                        message: "Повторная точка с запятой",
                        range: {
                            start: positionAt(source, duplicateOffset),
                            end: positionAt(source, duplicateOffset + 1)
                        },
                        data: {
                            start: duplicateOffset,
                            end: duplicateOffset + 1
                        }
                    },
                    {
                        code: "unused-declaration",
                        message: "Не используется",
                        range: {
                            start: { line: 1, character: 6 },
                            end: { line: 1, character: 10 }
                        }
                    }
                ]
            }
        });
        assert.strictEqual(actions.length, 1);
        assert.strictEqual(actions[0].kind, RSL_FIX_ALL_KIND);
        assert.strictEqual(actions[0].edit.changes[module.uri].length, 2);
    });

    await test("Call Hierarchy строит входящие и исходящие вызовы", async () => {
        const index = new WorkspaceIndex();
        const librarySource = "Macro Shared(value)\nEnd;";
        const mainSource = [
            "Import library;",
            "Macro Caller()",
            "  Shared(1);",
            "End;"
        ].join("\n");
        const library = createModule(
            index,
            "file:///workspace/library.mac",
            librarySource
        );
        const main = createModule(
            index,
            "file:///workspace/main.mac",
            mainSource
        );
        const resolver = new RslScopeResolver(index);
        const provider = new RslCallHierarchyProvider({
            index,
            resolver,
            referenceIndex: new ReferenceIndex()
        });
        const sharedItem = provider.prepare(
            library.uri,
            librarySource.indexOf("Shared")
        )[0];
        const callerItem = provider.prepare(
            main.uri,
            mainSource.indexOf("Caller")
        )[0];

        assert.ok(sharedItem);
        assert.ok(callerItem);

        const incoming = await provider.incoming(sharedItem);
        assert.strictEqual(incoming.length, 1);
        assert.strictEqual(incoming[0].from.name, "Caller");
        assert.strictEqual(incoming[0].fromRanges.length, 1);

        const outgoing = await provider.outgoing(callerItem);
        assert.strictEqual(outgoing.length, 1);
        assert.strictEqual(outgoing[0].to.name, "Shared");
        assert.strictEqual(outgoing[0].fromRanges.length, 1);

        index.compactModule(library.uri);
        const compactProvider = new RslCallHierarchyProvider({
            index,
            resolver: new RslScopeResolver(index),
            referenceIndex: new ReferenceIndex()
        });
        const compactOutgoing = await compactProvider.outgoing(callerItem);
        assert.strictEqual(compactOutgoing.length, 1);
        const compactIncoming = await compactProvider.incoming(
            compactOutgoing[0].to
        );
        assert.strictEqual(compactIncoming.length, 1);
        assert.strictEqual(compactIncoming[0].from.name, "Caller");
    });

    await test("Range Formatting не меняет строки вне выделения", () => {
        const source = [
            "Macro Test()",
            "  If a==b",
            "  DoWork();",
            "  End;",
            "Unrelated   =    1;",
            "End;"
        ].join("\n");
        const document = TextDocument.create(
            "file:///workspace/main.mac",
            "rsl",
            1,
            source
        );
        const edits = formatRslDocumentRange(document, {
            textDocument: { uri: document.uri },
            range: {
                start: { line: 1, character: 0 },
                end: { line: 4, character: 0 }
            },
            options: {
                tabSize: 4,
                insertSpaces: true
            }
        });

        assert.strictEqual(edits.length, 1);
        const result = applyTextEdit(document, edits[0]);
        assert.deepStrictEqual(result.split("\n"), [
            "Macro Test()",
            "    If a == b",
            "        DoWork();",
            "    End;",
            "Unrelated   =    1;",
            "End;"
        ]);
    });

    console.log("");
    console.log(`Пройдено: ${passed}`);
    console.log(`Ошибок: ${failed}`);

    if (failed > 0) {
        process.exitCode = 1;
    }
})();

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
const { CBase } = require("../server/out/common");
const {
    buildKnownAutoImportCompletions,
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
    const tree = CBase.fromSyntax(source, 0, syntax, true, false);
    return index.updateOpenModule(uri, source, tree, 1, syntax);
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
            "Macro Shared(value)\nEnd;"
        );
        const main = "Macro Test()\n  Sha\nEnd;";
        const module = createModule(
            index,
            "file:///workspace/main.mac",
            main
        );
        const completion = buildKnownAutoImportCompletions(module, index)
            .find(item => item.label === "Shared");

        assert.ok(completion);
        assert.strictEqual(completion.additionalTextEdits.length, 1);
        assert.strictEqual(
            completion.additionalTextEdits[0].newText,
            "Import library;\n"
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

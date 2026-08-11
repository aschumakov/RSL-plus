"use strict";

const assert = require("assert");

const { getDefaults } = require("../server/out/defaults");
const {
    buildRslDiagnostics
} = require("../server/out/diagnostics");
const {
    buildEnhancedRslCodeActions
} = require("../server/out/features/enhancedCodeActions");
const {
    buildRslContextCompletions
} = require("../server/out/features/contextCompletionProvider");
const {
    buildRslHoverContent
} = require("../server/out/features/hoverFormatter");
const {
    buildRslRenameEdit,
    prepareRslRename
} = require("../server/out/features/renameProvider");
const { ReferenceIndex } = require("../server/out/analysis/referenceIndex");
const { RslScopeResolver } = require("../server/out/scopeResolver");
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

function moduleFor(source, uri = "file:///main.mac") {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([uri]);
    const module = index.updateOpenModule(uri, source, 1);
    return { index, module, resolver: new RslScopeResolver(index) };
}

function diagnosticsFor(source, settings, uri) {
    const context = moduleFor(source, uri);
    return {
        ...context,
        diagnostics: buildRslDiagnostics(
            context.module,
            context.index,
            settings
        )
    };
}

function codes(items) {
    return items.map(item => String(item.code || ""));
}

(async () => {
    await test("каталог стандартной библиотеки семантический и без ссылок", () => {
        const catalog = getDefaults();
        assert.ok(catalog.size > 200);
        assert.strictEqual(catalog.find("StrLen").typeName, "Integer");
        assert.strictEqual(catalog.find("{oper}").typeName, "integer");
        assert.ok(catalog.find("Version").signature.startsWith("Version"));
        const command = catalog.findClass("RsdCommand");
        assert.ok(command);
        assert.ok(command.children.some(child => child.name === "Execute"));
        assert.ok(!/https?:\/\//i.test(JSON.stringify(catalog.completionItems)));

        const hover = buildRslHoverContent(
            new WorkspaceIndex(),
            "rsl-builtin:/standard-library",
            catalog.findSymbol("StrLen")
        ).value;
        assert.ok(hover.includes("StrLen"));
        assert.ok(!hover.includes("Файл:"));
        assert.ok(!/https?:\/\//i.test(hover));
        assert.ok(hover.length < 240);
    });

    await test("каждая встроенная процедура описана по существу", () => {
        const {
            RSL_STANDARD_LIBRARY
        } = require("../server/out/builtins/standardLibraryData");
        /*
         * Код вида берётся из самого каталога, а не из vscode-languageserver:
         * пакет лежит в server/node_modules и из корневых тестов не виден.
         */
        const procedureKind = RSL_STANDARD_LIBRARY
            .find(entry => entry.name === "StrLen").kind;
        const procedures = RSL_STANDARD_LIBRARY.filter(
            entry => entry.kind === procedureKind
        );

        /*
         * Раздел «Встроенные процедуры» руководства (стр. 209–307) описывает
         * 239 процедур. Число закреплено, чтобы пропажа или дубль в каталоге
         * были видны сразу, а не проявлялись отсутствующим Completion.
         */
        assert.strictEqual(
            procedures.length,
            239,
            "Состав каталога расошёлся с разделом руководства"
        );

        const generic = procedures
            .filter(item => /Встроенная процедура RSL/.test(item.summary || ""))
            .map(item => item.name);
        assert.deepStrictEqual(
            generic,
            [],
            "Заглушка вместо описания бесполезна в Hover и Completion; " +
                "описание берётся из раздела руководства"
        );

        const tooLong = procedures.filter(item =>
            (item.summary || "").split(/\s+/).filter(Boolean).length > 10
        );
        assert.deepStrictEqual(
            tooLong.map(item => `${item.name}: ${item.summary}`),
            [],
            "Описание длиннее десяти слов не читается в подсказке"
        );

        const unbalanced = procedures.filter(item =>
            /\(\.\.\.\)$/.test(item.signature || "") &&
            !/^(Print|ErrPrint|Trace|SetScroll)/.test(item.name)
        );
        assert.deepStrictEqual(
            unbalanced.map(item => item.name),
            [],
            "Сигнатура выродилась в (...): проверьте баланс скобок — " +
                "balancedSignature молча заменяет такую сигнатуру"
        );
    });

    await test("встроенные функции и классы участвуют в resolve и members", () => {
        const source = [
            "Macro Test()",
            " Var cmd;",
            " cmd = RsdCommand();",
            " value = StrLen(\"abc\");",
            " cmd.Execute();",
            "End;"
        ].join("\n");
        const { module, resolver } = moduleFor(source);
        const strLen = resolver.resolveAt(
            module.uri,
            module.symbolTree,
            source.indexOf("StrLen")
        );
        assert.ok(strLen?.symbol.isBuiltin);
        assert.strictEqual(strLen.symbol.typeName, "Integer");
        const execute = resolver.resolveAt(
            module.uri,
            module.symbolTree,
            source.indexOf("Execute")
        );
        assert.ok(execute?.symbol.isBuiltin);
        assert.strictEqual(execute.symbol.typeName, "RsdRecordset");
    });

    await test("SPNAME из Macro виден во всём unit", () => {
        const source = [
            "Macro First()",
            " Var {shared};",
            "End;",
            "Macro Second()",
            " result = {shared};",
            "End;"
        ].join("\n");
        const { module, resolver } = moduleFor(source);
        const use = source.lastIndexOf("{shared}");
        const resolved = resolver.resolveAt(
            module.uri,
            module.symbolTree,
            use
        );
        assert.ok(resolved);
        assert.strictEqual(resolved.symbol.name, "{shared}");
    });

    await test("контекстный Completion знает типы, FILE и форматы", () => {
        const typeSource = "Macro Test(value:Rs";
        const typeContext = moduleFor(typeSource);
        const types = buildRslContextCompletions(
            typeContext.module,
            typeContext.index,
            typeSource.length
        );
        assert.ok(types.some(item => item.label === "RsdCommand"));

        const fileSource = "File data(\"table\") No";
        const fileContext = moduleFor(fileSource);
        const modifiers = buildRslContextCompletions(
            fileContext.module,
            fileContext.index,
            fileSource.length
        );
        assert.ok(modifiers.some(item => item.label === "Normal"));

        const formatSource = "[###](value:i";
        const formatContext = moduleFor(formatSource);
        const formats = buildRslContextCompletions(
            formatContext.module,
            formatContext.index,
            formatSource.length
        );
        assert.ok(formats.some(item => item.label === "iv"));
    });

    await test("документированные ограничения дают точные диагностики", () => {
        const longName = "a".repeat(81);
        const source = [
            `Const fixed = 1;`,
            `${longName} = 2;`,
            `fixed = 3;`,
            `value = "${"x".repeat(2048)}";`,
            "Macro Nested()",
            " Import local.mac;",
            "End;"
        ].join("\n");
        const { diagnostics } = diagnosticsFor(source);
        const actual = codes(diagnostics);
        assert.ok(actual.includes("identifier-too-long"));
        assert.ok(actual.includes("string-literal-too-long"));
        assert.ok(actual.includes("assignment-to-constant"));
        assert.ok(actual.includes("import-inside-macro"));
    });

    await test("длинная строка получает безопасный Quick Fix", () => {
        const source = `value = "${"x".repeat(2048)}";`;
        const { module, diagnostics } = diagnosticsFor(source);
        const diagnostic = diagnostics.find(item =>
            item.code === "string-literal-too-long"
        );
        assert.ok(diagnostic);
        const actions = buildEnhancedRslCodeActions(module, {
            textDocument: { uri: module.uri },
            range: diagnostic.range,
            context: { diagnostics: [diagnostic] }
        });
        const edit = actions[0].edit.changes[module.uri][0];
        assert.ok(edit.newText.includes(" +\n"));
        assert.ok(edit.newText.split(" +\n").every(part => part.length <= 1802));
    });

    await test("строгие правила включаются только профилем coreRsl", () => {
        const source = [
            "Macro Target(value:@Integer)",
            "End;",
            "Macro Test()",
            " Var local;",
            " Target(local);",
            "End;"
        ].join("\n");
        const bank = diagnosticsFor(source, { dialect: "rsBank" }).diagnostics;
        const core = diagnosticsFor(source, { dialect: "coreRsl" }).diagnostics;
        assert.ok(!codes(bank).includes("missing-reference-argument"));
        assert.ok(codes(core).includes("missing-reference-argument"));
        assert.strictEqual(
            core.filter(item => item.code === "missing-reference-argument")
                .length,
            1
        );

        const privateSource = [
            "Class Service",
            " Private Macro Hidden()",
            " End;",
            " Macro Test()",
            "  this.Hidden();",
            " End;",
            "End;"
        ].join("\n");
        const bankPrivate = diagnosticsFor(
            privateSource,
            { dialect: "rsBank" }
        ).diagnostics;
        const corePrivate = diagnosticsFor(
            privateSource,
            { dialect: "coreRsl" }
        ).diagnostics;
        assert.ok(!codes(bankPrivate).includes(
            "core-private-member-through-this"
        ));
        assert.ok(codes(corePrivate).includes(
            "core-private-member-through-this"
        ));
    });

    await test("одинаковый Import с разными расширениями запрещён", () => {
        const source = "Import shared.mac, shared.d32;";
        const { diagnostics } = diagnosticsFor(source);
        assert.ok(codes(diagnostics).includes("duplicate-import-basename"));
    });

    await test("Rename меняет объявление и все локальные ссылки", async () => {
        const source = [
            "Macro Test()",
            " Var oldName;",
            " oldName = oldName + 1;",
            "End;"
        ].join("\n");
        const { index, module, resolver } = moduleFor(source);
        const offset = source.indexOf("oldName");
        const prepared = prepareRslRename(module, resolver, offset);
        assert.strictEqual(prepared.placeholder, "oldName");
        const edit = await buildRslRenameEdit(
            module,
            index,
            resolver,
            new ReferenceIndex(),
            offset,
            "newName"
        );
        assert.ok(edit);
        assert.strictEqual(edit.changes[module.uri].length, 3);
        assert.ok(edit.changes[module.uri].every(item =>
            item.newText === "newName"
        ));
    });

    console.log(`\nПройдено: ${passed}`);
    console.log(`Ошибок: ${failed}`);
    if (failed > 0) process.exitCode = 1;
})();

"use strict";

/**
 * Состояние полноты Import-контекста, правило о необъявленных переменных и
 * локальность проверки повторных объявлений.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildRslCodeActions } = require("../server/out/codeActions");
const { buildRslDiagnostics } = require("../server/out/diagnostics");
const {
    RslDiagnosticEngine
} = require("../server/out/diagnostics/diagnosticEngine");
const {
    buildUnknownVariableDiagnostics,
    collectUnknownVariables
} = require("../server/out/diagnostics/unknownVariableDiagnostics");
const {
    UnknownVariableAudit
} = require("../server/out/diagnostics/unknownVariableAudit");
const {
    PlatformModuleCatalog
} = require("../server/out/builtins/platformModuleCatalog");
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

const MAIN = "file:///main.mac";

function open(source, files = [MAIN], platformModules) {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles(files);
    const module = index.updateOpenModule(MAIN, source, 1);
    return {
        index,
        module,
        resolver: new RslScopeResolver(index, undefined, platformModules)
    };
}

function names(diagnostics) {
    return diagnostics
        .filter(item => item.code === "unknown-variable")
        .map(item => String(item.data.name));
}

/** Смещение по позиции LSP: правку Quick Fix надо сверить с текстом. */
function offsetOf(source, position) {
    const lines = source.split("\n");
    let offset = 0;
    for (let line = 0; line < position.line; line++) {
        offset += lines[line].length + 1;
    }
    return offset + position.character;
}

function temporaryFile(contents) {
    const file = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "rsl-plus-")),
        "known-globals.txt"
    );
    if (contents !== undefined) {
        fs.writeFileSync(file, contents, "utf8");
    }
    return file;
}

async function main() {
    /*
     * ─── Полнота Import-контекста ──────────────────────────────────────────
     */
    await test("состояние Import-контекста различает loading, ambiguous, opaque", () => {
        const LIB = "file:///lib.mac";
        const index = new WorkspaceIndex();

        /* Каталог файлов проекта ещё не построен. */
        const early = new RslScopeResolver(index);
        assert.strictEqual(
            early.getImportContextState(MAIN).completeness,
            "loading"
        );

        index.registerWorkspaceFiles([MAIN, LIB]);
        index.updateOpenModule(MAIN, "Import lib;\nMacro T()\nEnd;", 1);
        const resolver = new RslScopeResolver(index);

        /* Файл найден, но ещё не проиндексирован. */
        const pending = resolver.getImportContextState(MAIN);
        assert.strictEqual(pending.completeness, "loading");
        assert.deepStrictEqual(Array.from(pending.pending), ["lib"]);

        index.updateExternalModule(LIB, "Macro Helper()\nEnd;", 1);
        assert.strictEqual(
            resolver.getImportContextState(MAIN).completeness,
            "complete"
        );

        /*
         * Неизвестный Import — НЕ отсутствующий: так выглядит модуль RSM, DLM
         * или встроенный модуль платформы, которого в workspace нет вообще.
         */
        index.updateOpenModule(MAIN, "Import someRsmModule;\nMacro T()\nEnd;", 2);
        const opaque = resolver.getImportContextState(MAIN);
        assert.strictEqual(opaque.completeness, "opaque");
        assert.deepStrictEqual(Array.from(opaque.opaque), ["someRsmModule"]);

        /* Один basename на два файла проекта. */
        const ambiguousIndex = new WorkspaceIndex();
        ambiguousIndex.registerWorkspaceFiles([
            MAIN,
            "file:///a/shared.mac",
            "file:///b/shared.mac"
        ]);
        ambiguousIndex.updateOpenModule(
            MAIN,
            "Import shared;\nMacro T()\nEnd;",
            1
        );
        assert.strictEqual(
            new RslScopeResolver(ambiguousIndex)
                .getImportContextState(MAIN).completeness,
            "ambiguous"
        );
    });

    await test("непрочитанный прикладной модуль делает контекст неполным", async () => {
        const catalog = new PlatformModuleCatalog({ log: () => undefined });
        await catalog.ensureIndexLoaded();
        const context = open(
            "Import BankInter;\nMacro T()\nEnd;",
            [MAIN],
            catalog
        );

        const pending = context.resolver.getImportContextState(MAIN);
        assert.strictEqual(pending.completeness, "loading");
        assert.ok(
            pending.pendingPlatformModules.includes("payminter"),
            "Зависимость BankInter обязана попасть в незавершённые: " +
                pending.pendingPlatformModules.join(", ")
        );

        await catalog.ensureModules(["BankInter"]);
        assert.strictEqual(
            context.resolver.getImportContextState(MAIN).completeness,
            "complete"
        );
    });

    /*
     * ─── Необъявленные переменные ──────────────────────────────────────────
     */
    await test("правило выключено по умолчанию", () => {
        const source = [
            "Macro Test()",
            "  Var known;",
            "  known = undeclared;",
            "End;"
        ].join("\n");
        const context = open(source);

        assert.deepStrictEqual(
            names(buildRslDiagnostics(context.module, context.index)),
            [],
            "Без явного включения правило обязано молчать"
        );
        assert.deepStrictEqual(
            names(buildRslDiagnostics(context.module, context.index, {
                unknownVariables: "off"
            })),
            []
        );
    });

    await test("safe предупреждает только при явном VAR в файле", () => {
        const withVar = open([
            "Macro Test()",
            "  Var known;",
            "  known = undeclared;",
            "End;"
        ].join("\n"));
        assert.deepStrictEqual(
            names(buildUnknownVariableDiagnostics(
                withVar.module,
                withVar.resolver,
                { mode: "safe" }
            )),
            ["undeclared"]
        );

        /*
         * Файл без единого VAR написан в стиле, где переменные не объявляют:
         * предупреждать там значит подчёркивать весь файл.
         */
        const withoutVar = open([
            "Macro Test()",
            "  known = undeclared;",
            "End;"
        ].join("\n"));
        assert.deepStrictEqual(
            names(buildUnknownVariableDiagnostics(
                withoutVar.module,
                withoutVar.resolver,
                { mode: "safe" }
            )),
            []
        );
    });

    await test("safe молчит при неполном контексте, strict — нет", () => {
        const source = [
            "Import someRsmModule;",
            "Macro Test()",
            "  Var known;",
            "  known = undeclared;",
            "End;"
        ].join("\n");
        const context = open(source);

        assert.strictEqual(
            context.resolver.getImportContextState(MAIN).completeness,
            "opaque"
        );
        assert.deepStrictEqual(
            names(buildUnknownVariableDiagnostics(
                context.module,
                context.resolver,
                { mode: "safe" }
            )),
            [],
            "Символ может прийти из модуля, которого в workspace нет"
        );

        const strict = collectUnknownVariables(
            context.module,
            context.resolver,
            { mode: "strict" }
        );
        assert.deepStrictEqual(
            strict.map(item => item.name),
            ["undeclared"],
            "strict — явный выбор пользователя проверять неполный контекст"
        );
        assert.strictEqual(strict[0].reason, "incomplete-context");
        assert.strictEqual(strict[0].importContext, "opaque");
    });

    await test("объявления, типы, Import и имена после точки не считаются", () => {
        const source = [
            "Import someLibrary;",
            "Class Holder",
            "  Var Field;",
            "End;",
            "Const LIMIT = 10;",
            "Macro Test(argument)",
            "  Var typed: Holder;",
            "  Var counter = LIMIT;",
            "  typed.Field = argument;",
            "  typed.UnknownMember = counter;",
            "  Var flag = true;",
            "  Var when = {curdate};",
            "  Var kind = V_INTEGER;",
            "End;"
        ].join("\n");
        const context = open(source, [MAIN, "file:///someLibrary.mac"]);
        context.index.updateExternalModule(
            "file:///someLibrary.mac",
            "Macro Exported()\nEnd;",
            1
        );

        assert.deepStrictEqual(
            collectUnknownVariables(context.module, context.resolver, {
                mode: "strict"
            }).map(item => item.name),
            [],
            "Ни объявление, ни тип, ни Import, ни поле, ни спецпеременная, " +
                "ни системная константа не являются необъявленной переменной"
        );
    });

    await test("внешний список известных имён снимает предупреждение", () => {
        const source = [
            "Macro Test()",
            "  Var known;",
            "  known = GlobalRegistry;",
            "  known = StillUnknown;",
            "End;"
        ].join("\n");
        const context = open(source);
        const file = temporaryFile(
            "# известные имена окружения\nGlobalRegistry\n\n"
        );

        assert.deepStrictEqual(
            names(buildUnknownVariableDiagnostics(
                context.module,
                context.resolver,
                { mode: "safe", knownGlobalsFile: file }
            )),
            ["StillUnknown"]
        );

        /* Отсутствующий файл не должен ни ронять сервер, ни менять правило. */
        assert.deepStrictEqual(
            names(buildUnknownVariableDiagnostics(
                context.module,
                context.resolver,
                {
                    mode: "safe",
                    knownGlobalsFile: path.join(path.dirname(file), "no.txt")
                }
            )).sort(),
            ["GlobalRegistry", "StillUnknown"]
        );
    });

    await test("находка содержит всё, что нужно для решения", () => {
        const source = [
            "Class Holder",
            "  Macro Method()",
            "    Var known;",
            "    known = undeclared;",
            "  End;",
            "End;"
        ].join("\n");
        const context = open(source);
        const [finding] = collectUnknownVariables(
            context.module,
            context.resolver,
            { mode: "safe" }
        );

        assert.ok(finding, "Находка обязана быть");
        assert.strictEqual(finding.name, "undeclared");
        assert.strictEqual(finding.uri, MAIN);
        assert.strictEqual(finding.line, 3);
        assert.strictEqual(finding.scope, "Holder.Method");
        assert.strictEqual(finding.hasExplicitVar, true);
        assert.strictEqual(finding.importContext, "complete");
        assert.strictEqual(finding.reason, "no-declaration");
    });

    /*
     * ─── Audit-режим ───────────────────────────────────────────────────────
     */
    await test("audit пишет отчёт и не публикует Problems", () => {
        const source = [
            "Macro Test()",
            "  Var known;",
            "  known = undeclared;",
            "End;"
        ].join("\n");
        const context = open(source);
        const reportFile = path.join(
            path.dirname(temporaryFile("")),
            "audit.jsonl"
        );
        const received = [];
        const engine = new RslDiagnosticEngine({
            audit: (file, findings) => {
                received.push({ file, count: findings.length });
                new UnknownVariableAudit(file, { log: () => undefined })
                    .append(findings);
            }
        });

        const diagnostics = engine.buildWorkspace(
            context.module,
            context.index,
            {
                unknownVariables: "safe",
                unknownVariablesAuditFile: reportFile
            },
            undefined,
            context.resolver
        );

        assert.deepStrictEqual(
            names(diagnostics),
            [],
            "В audit-режиме Problems не публикуются — в этом и смысл"
        );
        assert.deepStrictEqual(received, [{ file: reportFile, count: 1 }]);

        const lines = fs.readFileSync(reportFile, "utf8")
            .split("\n")
            .filter(Boolean)
            .map(line => JSON.parse(line));
        assert.strictEqual(lines.length, 1);
        assert.deepStrictEqual(lines[0], {
            file: lines[0].file,
            line: 3,
            character: 11,
            name: "undeclared",
            scope: "Test",
            hasExplicitVar: true,
            importContext: "complete",
            reason: "no-declaration"
        });
        assert.ok(/main\.mac$/.test(lines[0].file), lines[0].file);
    });

    /*
     * ─── Import, приходящий через другой Import ─────────────────────────────
     */
    await test("лишний транзитивный Import находится и выключается настройкой", () => {
        const A = "file:///a.mac";
        const B = "file:///b.mac";
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([MAIN, A, B]);
        index.updateExternalModule(A, "Import b;\nMacro FromA()\nEnd;", 1);
        index.updateExternalModule(B, "Macro FromB()\nEnd;", 1);
        const module = index.updateOpenModule(
            MAIN,
            "Import a, b;\nMacro T()\n  FromA();\n  FromB();\nEnd;",
            1
        );
        const messagesOf = settings =>
            buildRslDiagnostics(module, index, settings)
                .filter(item => item.code === "redundant-import")
                .map(item => item.message);

        assert.deepStrictEqual(
            messagesOf({}),
            ["Модуль b.mac уже импортирован через a.mac"]
        );
        assert.deepStrictEqual(
            messagesOf({ redundantImports: false }),
            [],
            "Настройка обязана выключать правило: явный Import — ещё и " +
                "страховка, и решение за автором кода"
        );
    });

    /*
     * Разбор реального списка Import из макроса заказчика.
     *
     * Здесь важны две вещи, которых не было в простом случае: несколько имён в
     * ОДНОМ операторе Import и лишнее имя, стоящее РАНЬШЕ того, через который
     * оно приходит.
     */
    await test("лишние имена находятся в списке из одного Import", () => {
        const modules = {
            encash_utils: "Macro EU()\nEnd;",
            rsdhook: "Macro RH()\nEnd;",
            iif: "Macro Iif(a, b, c)\nEnd;",
            utils: "Macro U()\nEnd;",
            oralib: "Macro OL()\nEnd;",
            utlrssl: "import utils, iif;\nMacro UR()\nEnd;"
        };
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([
            MAIN,
            ...Object.keys(modules).map(name => `file:///${name}.mac`)
        ]);
        for (const [name, source] of Object.entries(modules)) {
            index.updateExternalModule(`file:///${name}.mac`, source, 1);
        }

        const source = "import encash_utils, rsdhook,iif,utils,utlrssl,oralib;" +
            "\nMacro T()\n  Iif(1, 2, 3); U(); UR(); EU(); RH(); OL();\nEnd;";
        const module = index.updateOpenModule(MAIN, source, 1);
        const found = buildRslDiagnostics(module, index)
            .filter(item => item.code === "redundant-import");

        assert.deepStrictEqual(
            found.map(item => item.data.moduleName).sort(),
            ["iif.mac", "utils.mac"],
            `Оба имени приходят через utlrssl: ${
                found.map(item => item.message).join("; ")}`
        );

        /*
         * Правка обязана убрать ОДНО имя из списка, а не весь оператор Import:
         * иначе Quick Fix унёс бы с собой пять нужных модулей.
         */
        const [action] = buildRslCodeActions(module, {
            textDocument: { uri: MAIN },
            range: found[0].range,
            context: { diagnostics: [found[0]] }
        });
        assert.ok(action, "Quick Fix обязан предлагаться");
        const edits = action.edit.changes[MAIN];
        assert.strictEqual(edits.length, 1);
        assert.strictEqual(edits[0].newText, "");
        assert.strictEqual(
            source.slice(
                offsetOf(source, edits[0].range.start),
                offsetOf(source, edits[0].range.end)
            ),
            "iif,",
            "Удаляется только лишнее имя вместе со своей запятой"
        );
    });

    await test("взаимная зависимость не объявляется лишней с обеих сторон", () => {
        const A = "file:///a.mac";
        const D = "file:///d.mac";
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([MAIN, A, D]);
        index.updateExternalModule(A, "Import d;\nMacro FromA()\nEnd;", 1);
        index.updateExternalModule(D, "Import a;\nMacro FromD()\nEnd;", 1);
        const module = index.updateOpenModule(
            MAIN,
            "Import a, d;\nMacro T()\n  FromA();\n  FromD();\nEnd;",
            1
        );

        assert.deepStrictEqual(
            buildRslDiagnostics(module, index, { redundantImports: true })
                .filter(item => item.code === "redundant-import"),
            [],
            "Убрать оба Import — значит остаться ни с чем; это цикл, и о нём " +
                "сообщает отдельная проверка"
        );
    });

    await test("при неполном контексте лишний Import не ищется", () => {
        const A = "file:///a.mac";
        const B = "file:///b.mac";
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([MAIN, A, B]);
        /* a.mac в индекс не попал: его собственные Import неизвестны. */
        index.updateExternalModule(B, "Macro FromB()\nEnd;", 1);
        const module = index.updateOpenModule(
            MAIN,
            "Import a, b;\nMacro T()\n  FromB();\nEnd;",
            1
        );

        assert.deepStrictEqual(
            buildRslDiagnostics(module, index, { redundantImports: true })
                .filter(item => item.code === "redundant-import"),
            [],
            "«Уже импортирован через» при неполном замыкании — утверждение ни " +
                "на чём"
        );
    });

    /*
     * ─── Повторные объявления остаются локальными ──────────────────────────
     */
    await test("повтор объявления проверяется только в своей области", () => {
        const source = [
            "Var shared;",
            "Macro First()",
            "  Var item;",
            "  Var item;",
            "End;",
            "Macro Second()",
            "  Var item;",
            "  Var shared;",
            "End;"
        ].join("\n");
        const context = open(source);
        const duplicates = buildRslDiagnostics(
            context.module,
            context.index
        ).filter(item => item.code === "duplicate-declaration");

        assert.strictEqual(
            duplicates.length,
            1,
            "Повтор в одной области — одно предупреждение; одноимённые " +
                "объявления в разных Macro и пара глобальное/локальное " +
                `допустимы: ${duplicates.map(item => item.message).join("; ")}`
        );
        assert.strictEqual(duplicates[0].range.start.line, 3);
    });

    await test("конфликт имён из импортов остаётся ambiguous-reference", () => {
        const LEFT = "file:///left.mac";
        const RIGHT = "file:///right.mac";
        const source = [
            "Import left, right;",
            "Macro Test()",
            "  Var value = Shared();",
            "End;"
        ].join("\n");
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([MAIN, LEFT, RIGHT]);
        index.updateExternalModule(LEFT, "Macro Shared()\nEnd;", 1);
        index.updateExternalModule(RIGHT, "Macro Shared()\nEnd;", 1);
        const module = index.updateOpenModule(MAIN, source, 1);
        const codes = buildRslDiagnostics(module, index).map(item => item.code);

        assert.ok(
            codes.includes("ambiguous-reference"),
            `Конфликт импортов обязан быть ambiguous-reference: ${
                codes.join(", ")}`
        );
        assert.ok(
            !codes.includes("duplicate-declaration"),
            "Символы из разных модулей повторным объявлением не являются"
        );
    });

    await test("объявления импортированных модулей не проверяются на повтор", () => {
        const LIB = "file:///lib.mac";
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([MAIN, LIB]);
        /* В самом импортируемом файле имя объявлено дважды. */
        index.updateExternalModule(
            LIB,
            "Var duplicated;\nVar duplicated;\n",
            1
        );
        const module = index.updateOpenModule(
            MAIN,
            "Import lib;\nMacro Test()\n  Var own;\nEnd;",
            1
        );

        assert.deepStrictEqual(
            buildRslDiagnostics(module, index)
                .filter(item => item.code === "duplicate-declaration"),
            [],
            "Проверка повторных объявлений строго локальна для файла"
        );
    });

    if (failed > 0) {
        console.error(`\nПройдено: ${passed}\nОшибок: ${failed}`);
        process.exitCode = 1;
    } else {
        console.log(`\nПройдено: ${passed}\nОшибок: ${failed}`);
    }
}

main();

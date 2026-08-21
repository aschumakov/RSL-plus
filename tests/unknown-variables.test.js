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
     * Ошибка чтения каталога — это не «ещё грузится».
     *
     * Пока разницы не было, непрочитанный индекс или битый файл модуля оставляли
     * контекст в состоянии loading навсегда, а вместе с ним молча и навсегда
     * выключались все проверки, которым нужен полный контекст.
     */
    await test("непрочитанный каталог делает контекст opaque, а не loading", async () => {
        const previousDirectory = process.env.RSL_PLATFORM_MODULES_DIR;
        const contextOf = catalog => {
            const index = new WorkspaceIndex();
            index.registerWorkspaceFiles([MAIN]);
            index.updateOpenModule(
                MAIN,
                "Import CommonInter;\nMacro T()\nEnd;",
                1
            );
            return new RslScopeResolver(index, undefined, catalog)
                .getImportContextState(MAIN);
        };

        try {
            /* Индекс каталога не читается вовсе. */
            process.env.RSL_PLATFORM_MODULES_DIR = path.join(
                os.tmpdir(),
                "rsl-plus-no-such-catalog"
            );
            const withoutIndex = new PlatformModuleCatalog({
                log: () => undefined
            });
            await withoutIndex.ensureModules(["CommonInter"]);

            assert.strictEqual(withoutIndex.indexState, "failed");
            assert.strictEqual(contextOf(withoutIndex).completeness, "opaque");
            assert.ok(
                withoutIndex.revision > 0,
                "Ошибка меняет состояние каталога, значит и ревизию: иначе " +
                    "кэши так и останутся с ответом «ещё грузится»"
            );

            /* Индекс есть, а файл состава испорчен. */
            const directory = fs.mkdtempSync(
                path.join(os.tmpdir(), "rsl-plus-catalog-")
            );
            fs.writeFileSync(
                path.join(directory, "index.json"),
                JSON.stringify({
                    version: 3,
                    modules: { CommonInter: { file: "broken.json" } }
                }),
                "utf8"
            );
            fs.writeFileSync(
                path.join(directory, "broken.json"),
                "{ это не JSON",
                "utf8"
            );
            process.env.RSL_PLATFORM_MODULES_DIR = directory;
            const withBrokenBody = new PlatformModuleCatalog({
                log: () => undefined
            });
            await withBrokenBody.ensureModules(["CommonInter"]);

            assert.strictEqual(withBrokenBody.indexState, "loaded");
            assert.strictEqual(
                withBrokenBody.moduleState("CommonInter"),
                "failed"
            );
            const state = contextOf(withBrokenBody);
            assert.strictEqual(state.completeness, "opaque");
            assert.deepStrictEqual(Array.from(state.opaque), ["commoninter"]);
            assert.deepStrictEqual(
                Array.from(state.pendingPlatformModules),
                [],
                "Ждать нечего: файл прочитать не удалось"
            );
        } finally {
            if (previousDirectory === undefined) {
                delete process.env.RSL_PLATFORM_MODULES_DIR;
            } else {
                process.env.RSL_PLATFORM_MODULES_DIR = previousDirectory;
            }
        }
    });

    /*
     * ─── Необъявленные переменные ──────────────────────────────────────────
     */
    await test("по умолчанию правило работает в безопасном режиме", () => {
        /*
         * Прежде правило было выключено: оно проверяло любые неразрешённые
         * имена и слишком часто ошибалось. Теперь проверяется только имя
         * слева от знака присваивания, и это можно включить по умолчанию.
         */
        const source = [
            "Macro Test()",
            "  Var known;",
            "  undeclared = known;",
            "End;"
        ].join("\n");
        const context = open(source);

        assert.deepStrictEqual(
            names(buildRslDiagnostics(context.module, context.index)),
            ["undeclared"],
            "Без настроек действует то же значение, что и в окне параметров"
        );
        assert.deepStrictEqual(
            names(buildRslDiagnostics(context.module, context.index, {
                unknownVariables: "off"
            })),
            [],
            "Выключенное правило обязано молчать"
        );
    });

    await test("safe смотрит только на имя слева от «=»", () => {
        /*
         * Чтение неизвестного имени слишком часто оказывается не ошибкой:
         * имя может прийти из модуля, о котором сервер знает не всё, или
         * его подставляет система. Присваивание же создаёт переменную прямо
         * здесь, и опечатка в её имени видна наверняка.
         */
        const context = open([
            "Macro Test()",
            "  Var known;",
            "  known = SomeReadOnlyName;",
            "  Typo = known;",
            "End;"
        ].join(String.fromCharCode(10)));

        assert.deepStrictEqual(
            names(buildUnknownVariableDiagnostics(
                context.module,
                context.resolver,
                { mode: "safe" }
            )),
            ["Typo"]
        );
        assert.deepStrictEqual(
            names(buildUnknownVariableDiagnostics(
                context.module,
                context.resolver,
                { mode: "strict" }
            )).sort(),
            ["SomeReadOnlyName", "Typo"]
        );
    });

    await test("safe предупреждает только при явном VAR в файле", () => {
        const withVar = open([
            "Macro Test()",
            "  Var known;",
            "  undeclared = known;",
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
            "  undeclared = known;",
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
            "  undeclared = known;",
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
            "  GlobalRegistry = known;",
            "  StillUnknown = known;",
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

    await test("сообщение соответствует ошибке компилятора", () => {
        /*
         * Проверка называется «необъявленные переменные», но неизвестным может
         * оказаться и вызов процедуры: MissingProc переменной не является, а
         * компилятор на всё это отвечает «неопределенный идентификатор».
         */
        const source = [
            "Macro Test()",
            "  Var known;",
            "  MissingProc = known;",
            "End;"
        ].join("\n");
        const context = open(source);

        assert.deepStrictEqual(
            buildUnknownVariableDiagnostics(
                context.module,
                context.resolver,
                { mode: "safe" }
            ).map(item => item.message),
            ["Идентификатор MissingProc не определён"]
        );
    });

    /*
     * Обход не имеет права быть ни бесконечным, ни неотменяемым.
     *
     * Раньше он проходил весь файл и копил все находки, а лишнее отбрасывалось
     * уже после: на 692 КБ с 30 тысячами неизвестных имён это пять секунд
     * работы, из которой в Problems попадали первые двести.
     */
    await test("обход ограничен лимитом и прерывается отменой", () => {
        const lines = ["Macro Test()", "  Var known;"];
        for (let index = 0; index < 5000; index++) {
            lines.push(`  unknown${index} = known;`);
        }
        lines.push("End;");
        const context = open(lines.join("\n"));
        const collect = options => collectUnknownVariables(
            context.module,
            context.resolver,
            { mode: "safe", ...options }
        );

        assert.strictEqual(collect({}).length, 5000, "Без лимита — все");
        assert.strictEqual(collect({ limit: 200 }).length, 200);
        assert.strictEqual(collect({ limit: 0 }).length, 0);

        /*
         * Отмена проверяется раз в тысячу токенов, поэтому обход прекращается
         * почти сразу, а не на последнем имени.
         */
        const cancelled = collect({ isCancelled: () => true });
        assert.ok(
            cancelled.length > 0 && cancelled.length < 1000,
            `Обход обязан прекратиться на первой же проверке: ${
                cancelled.length}`
        );

        /* Через настройки лимит берётся из maxProblems. */
        assert.strictEqual(
            buildRslDiagnostics(context.module, context.index, {
                unknownVariables: "safe",
                maxProblems: 25
            }).filter(item => item.code === "unknown-variable").length,
            25
        );
    });

    await test("находка содержит всё, что нужно для решения", () => {
        const source = [
            "Class Holder",
            "  Macro Method()",
            "    Var known;",
            "    undeclared = known;",
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
            "  undeclared = known;",
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
            character: 3,
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

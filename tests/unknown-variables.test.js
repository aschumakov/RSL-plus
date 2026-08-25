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
    buildRslUndeclaredAssignmentDiagnostics,
    collectRslUndeclaredAssignments
} = require("../server/out/diagnostics/undeclaredAssignmentDiagnostics");
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

/** Имена из находок проверки «переменная не объявлена». */
function undeclared(diagnostics) {
    return diagnostics
        .filter(item => item.code === "undeclared-variable")
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
    /*
     * ─── Необъявленная переменная (safe) ───────────────────────────────
     *
     * Отдельная проверка, а не режим соседней: вопрос у неё местный —
     * объявлена ли переменная в этой области, — и ответ на него не зависит
     * от того, прочитаны ли импортированные модули.
     */
    await test("по умолчанию проверяется необъявленная переменная", () => {
        const source = [
            "Macro Test()",
            "  Var known;",
            "  undeclared = known;",
            "End;"
        ].join(String.fromCharCode(10));
        const context = open(source);

        assert.deepStrictEqual(
            undeclared(buildRslDiagnostics(context.module, context.index)),
            ["undeclared"],
            "Без настроек действует то же значение, что и в окне параметров"
        );
        assert.deepStrictEqual(
            buildRslDiagnostics(context.module, context.index, {
                unknownVariables: "off"
            }).filter(item => item.code === "undeclared-variable"),
            [],
            "Выключенное правило обязано молчать"
        );
    });

    /*
     * Главное отличие от прежнего поведения.
     *
     * Один неизвестный RSM- или DLM-модуль выключал проверку целиком, хотя
     * к вопросу «объявлена ли эта переменная в процедуре» он отношения не
     * имеет: снаружи приходят процедуры, классы и константы, а не VAR
     * чужой процедуры.
     */
    await test("непрочитанный Import не выключает проверку", () => {
        const context = open([
            "Import someRsmModule;",
            "Macro Test(argument)",
            "    Var result, value;",
            "",
            "    parm = argument;",
            "End;"
        ].join(String.fromCharCode(10)));

        assert.strictEqual(
            context.resolver.getImportContextState(MAIN).completeness,
            "opaque"
        );
        assert.deepStrictEqual(
            undeclared(buildRslUndeclaredAssignmentDiagnostics(
                context.module,
                context.resolver
            )),
            ["parm"]
        );
    });

    await test("проверяется только простая цель присваивания", () => {
        /*
         * Чтение неизвестного имени слишком часто оказывается не ошибкой:
         * это может быть константа или имя из модуля, о котором сервер
         * знает не всё. Присваивание же создаёт переменную прямо здесь.
         */
        const context = open([
            "Macro Test()",
            "  Var known, typed: Holder;",
            "  known = SomeReadOnlyName;",
            "  SomeMacro();",
            "  known = SomeClass();",
            "  typed.Field = known;",
            "  Typo = known;",
            "End;"
        ].join(String.fromCharCode(10)));

        assert.deepStrictEqual(
            undeclared(buildRslUndeclaredAssignmentDiagnostics(
                context.module,
                context.resolver
            )),
            ["Typo"],
            "Вызов, конструктор, чтение и обращение к члену — не эта проверка"
        );
    });

    await test("параметр, VAR объемлющей области и переменная модуля", () => {
        const context = open([
            "Var moduleLevel;",
            "Macro Test(argument)",
            "  Var local;",
            "  argument = 1;",
            "  local = 2;",
            "  moduleLevel = 3;",
            "End;"
        ].join(String.fromCharCode(10)));

        assert.deepStrictEqual(
            undeclared(buildRslUndeclaredAssignmentDiagnostics(
                context.module,
                context.resolver
            )),
            []
        );
    });

    /*
     * Поле родительского класса разрешением имени по позиции не находится:
     * из тела метода оно доступно по короткому имени, а областью видимости
     * считается сам класс. Иерархия обходится отдельно.
     */
    await test("поле своего и родительского класса объявлением считаются", () => {
        const context = open([
            "Class Base",
            "  Var baseField;",
            "End;",
            "Class(Base) Child",
            "  Var ownField;",
            "  Macro Method()",
            "    Var helper;",
            "    ownField = 1;",
            "    baseField = 2;",
            "    helper = 3;",
            "    strayField = 4;",
            "  End;",
            "End;"
        ].join(String.fromCharCode(10)));

        assert.deepStrictEqual(
            undeclared(buildRslUndeclaredAssignmentDiagnostics(
                context.module,
                context.resolver
            )),
            ["strayField"]
        );
    });

    /*
     * Процедура, класс и константа объявлением ПЕРЕМЕННОЙ не являются, но и
     * сообщения о них здесь быть не должно: пока их только читают, имя
     * вполне может прийти извне проекта.
     */
    await test("неизвестные процедура, класс и константа не проверяются", () => {
        const context = open([
            "Macro Test()",
            "  Var value;",
            "  value = UnknownProc();",
            "  value = UnknownClass();",
            "  value = UNKNOWN_CONSTANT;",
            "End;"
        ].join(String.fromCharCode(10)));

        assert.deepStrictEqual(
            undeclared(buildRslUndeclaredAssignmentDiagnostics(
                context.module,
                context.resolver
            )),
            []
        );
    });

    /*
     * Процедура, класс и константа с таким именем — не объявление
     * переменной: присваивание им и создаёт ту самую необъявленную
     * переменную. Исключение — константа: о ней уже сказано ошибкой
     * assignment-to-constant, и второе сообщение о том же месте лишнее.
     */
    await test("процедура с таким именем объявлением не считается", () => {
        const context = open([
            "Const LIMIT = 10;",
            "Macro Target()",
            "  return 1;",
            "End;",
            "Macro Test()",
            "  Var value;",
            "  Target = value;",
            "  LIMIT = value;",
            "End;"
        ].join(String.fromCharCode(10)));

        assert.deepStrictEqual(
            undeclared(buildRslUndeclaredAssignmentDiagnostics(
                context.module,
                context.resolver
            )),
            ["Target"]
        );
        assert.deepStrictEqual(
            buildRslDiagnostics(context.module, context.index)
                .filter(item => item.code === "assignment-to-constant")
                .map(item => item.message),
            ["Константе LIMIT нельзя присваивать новое значение"],
            "О присваивании константе говорит своя ошибка, и только она"
        );
    });

    /*
     * База из модуля, которого в проекте нет.
     *
     * Состав такого класса неизвестен, и поле вполне может быть объявлено
     * в нём. Утверждать обратное не на чем, поэтому проверка молчит.
     */
    await test("нечитаемый базовый класс снимает проверку полей", () => {
        const context = open([
            "Import someRsmModule;",
            "Class(UnknownBase) Child",
            "  Var ownField;",
            "  Macro Method()",
            "    Var helper;",
            "    inheritedMaybe = 1;",
            "    ownField = 2;",
            "  End;",
            "End;"
        ].join(String.fromCharCode(10)));

        assert.deepStrictEqual(
            undeclared(buildRslUndeclaredAssignmentDiagnostics(
                context.module,
                context.resolver
            )),
            []
        );
    });

    await test("процедура без единого VAR не проверяется", () => {
        const withVar = open([
            "Macro Test()",
            "  Var known;",
            "  undeclared = known;",
            "End;"
        ].join(String.fromCharCode(10)));
        assert.deepStrictEqual(
            undeclared(buildRslUndeclaredAssignmentDiagnostics(
                withVar.module,
                withVar.resolver
            )),
            ["undeclared"]
        );

        /*
         * Файл без единого VAR написан в стиле, где переменные не
         * объявляют: отличить опечатку от намеренной неявной переменной
         * там нечем.
         */
        const withoutVar = open([
            "Macro Test()",
            "  undeclared = known;",
            "End;"
        ].join(String.fromCharCode(10)));
        assert.deepStrictEqual(
            undeclared(buildRslUndeclaredAssignmentDiagnostics(
                withoutVar.module,
                withoutVar.resolver
            )),
            []
        );
    });

    await test("объявление убирает сообщение сразу", () => {
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([MAIN]);
        const before = index.updateOpenModule(MAIN, [
            "Macro Test()",
            "  Var known;",
            "  parm = known;",
            "End;"
        ].join(String.fromCharCode(10)), 1);

        assert.deepStrictEqual(
            undeclared(buildRslDiagnostics(before, index)),
            ["parm"]
        );

        const after = index.updateOpenModule(MAIN, [
            "Macro Test()",
            "  Var known, parm;",
            "  parm = known;",
            "End;"
        ].join(String.fromCharCode(10)), 2);

        assert.deepStrictEqual(
            undeclared(buildRslDiagnostics(after, index)),
            []
        );
    });

    await test("внешний список известных имён снимает предупреждение", () => {
        const context = open([
            "Macro Test()",
            "  Var known;",
            "  GlobalRegistry = known;",
            "  StillUnknown = known;",
            "End;"
        ].join(String.fromCharCode(10)));
        const file = temporaryFile(
            "# известные имена окружения\nGlobalRegistry\n\n"
        );

        assert.deepStrictEqual(
            undeclared(buildRslUndeclaredAssignmentDiagnostics(
                context.module,
                context.resolver,
                { knownGlobalsFile: file }
            )),
            ["StillUnknown"]
        );

        /* Отсутствующий файл не должен ни ронять сервер, ни менять правило. */
        assert.deepStrictEqual(
            undeclared(buildRslUndeclaredAssignmentDiagnostics(
                context.module,
                context.resolver,
                {
                    knownGlobalsFile: path.join(path.dirname(file), "no.txt")
                }
            )).sort(),
            ["GlobalRegistry", "StillUnknown"]
        );
    });

    await test("сообщение говорит про область, а не про существование", () => {
        /*
         * Утверждать, что имени нет вовсе, нельзя: компилятор берёт имена и
         * из RSM, и из DLM. Нарушено другое — принятый в самой процедуре
         * способ объявлять переменные.
         */
        const context = open([
            "Macro Test()",
            "  Var known;",
            "  parm = known;",
            "End;"
        ].join(String.fromCharCode(10)));

        assert.deepStrictEqual(
            buildRslUndeclaredAssignmentDiagnostics(
                context.module,
                context.resolver
            ).map(item => ({ message: item.message, code: item.code })),
            [{
                message: "Переменная parm не объявлена в текущей области",
                code: "undeclared-variable"
            }]
        );
    });

    /*
     * Обход не имеет права быть ни бесконечным, ни неотменяемым.
     *
     * Раньше он проходил весь файл и копил все находки, а лишнее
     * отбрасывалось уже после: на 692 КБ с 30 тысячами неизвестных имён это
     * пять секунд работы, из которой в Problems попадали первые двести.
     */
    await test("обход ограничен лимитом и прерывается отменой", () => {
        const lines = ["Macro Test()", "  Var known;"];
        for (let index = 0; index < 5000; index++) {
            lines.push(`  unknown${index} = known;`);
        }
        lines.push("End;");
        const context = open(lines.join(String.fromCharCode(10)));
        const collect = options => collectRslUndeclaredAssignments(
            context.module,
            context.resolver,
            options
        );

        assert.strictEqual(collect({}).length, 5000, "Без лимита — все");
        assert.strictEqual(collect({ limit: 200 }).length, 200);
        assert.strictEqual(collect({ limit: 0 }).length, 0);

        /*
         * Отмена проверяется раз в тысячу токенов, поэтому обход
         * прекращается почти сразу, а не на последнем имени.
         */
        const cancelled = collect({ isCancelled: () => true });
        assert.ok(
            cancelled.length > 0 && cancelled.length < 1000,
            `Обход обязан прекратиться на первой же проверке: ${
                cancelled.length}`
        );

        /* Через настройки лимит берётся из maxProblems. */
        assert.strictEqual(
            undeclared(buildRslDiagnostics(context.module, context.index, {
                maxProblems: 25
            })).length,
            25
        );
    });

    /*
     * Рост от числа присваиваний — линейный.
     *
     * Три предыдущих дефекта подряд были квадратичностями, и каждая
     * становилась видна только на крупном файле. Порог взят с запасом:
     * квадратичность на учетверении дала бы около шестнадцати.
     */
    await test("рост от числа присваиваний линейный", () => {
        const build = count => {
            const lines = ["Macro Test()", "  Var known;"];

            for (let index = 0; index < count; index++) {
                lines.push(`  unknown${index} = known;`);
            }

            lines.push("End;");

            return lines.join(String.fromCharCode(10));
        };
        const measure = count => {
            const context = open(build(count));
            let best = Infinity;

            for (let run = 0; run < 3; run++) {
                const started = process.hrtime.bigint();
                collectRslUndeclaredAssignments(
                    context.module,
                    context.resolver
                );
                best = Math.min(
                    best,
                    Number(process.hrtime.bigint() - started) / 1e6
                );
            }

            return best;
        };

        const small = measure(2000);
        const large = measure(8000);
        const ratio = large / Math.max(small, 0.5);

        assert.ok(
            ratio < 8,
            `Учетверение размера дало рост ×${ratio.toFixed(1)}: ` +
                `${small.toFixed(1)} мс -> ${large.toFixed(1)} мс`
        );
    });

    /*
     * ─── Неразрешённые имена (strict) ─────────────────────────────────
     */
    await test("strict проверяет и файл без объявлений", () => {
        /*
         * Требование объявленного VAR — правило соседней проверки. Режим
         * strict обещан как «все неразрешённые имена», и файл без единого
         * VAR он тоже проверяет: пользователь выбрал его сознательно.
         */
        const context = open([
            "Macro Test()",
            "    typo = Missing;",
            "End;"
        ].join(String.fromCharCode(10)));

        assert.deepStrictEqual(
            names(buildUnknownVariableDiagnostics(
                context.module,
                context.resolver,
                { mode: "strict" }
            )).sort(),
            ["Missing", "typo"]
        );
    });

    await test("strict проверяет и неполный контекст", () => {
        const context = open([
            "Import someRsmModule;",
            "Macro Test()",
            "  Var known;",
            "  undeclared = known;",
            "End;"
        ].join(String.fromCharCode(10)));

        assert.strictEqual(
            context.resolver.getImportContextState(MAIN).completeness,
            "opaque"
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

    await test("сообщение strict соответствует ошибке компилятора", () => {
        /*
         * Неизвестным здесь может оказаться и вызов процедуры: MissingProc
         * переменной не является, а компилятор на всё это отвечает
         * «неопределенный идентификатор».
         */
        const context = open([
            "Macro Test()",
            "  Var known;",
            "  known = MissingProc();",
            "End;"
        ].join(String.fromCharCode(10)));

        assert.deepStrictEqual(
            buildUnknownVariableDiagnostics(
                context.module,
                context.resolver,
                { mode: "strict" }
            ).map(item => item.message),
            ["Идентификатор MissingProc не определён"]
        );
    });

    await test("находка содержит всё, что нужно для решения", () => {
        const context = open([
            "Class Holder",
            "  Macro Method()",
            "    Var known;",
            "    undeclared = known;",
            "  End;",
            "End;"
        ].join(String.fromCharCode(10)));
        const [finding] = collectRslUndeclaredAssignments(
            context.module,
            context.resolver
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
        ].join(String.fromCharCode(10));
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

    /*
     * Константы классов Rsd описаны в справке внутри описаний методов, а
     * не в разделе констант, и каталог их не знал: написанное по
     * документации `cmd.AddParam("p", RSDBP_OUT, V_INTEGER)` строгий
     * режим считал обращением к неопределённому идентификатору.
     */
    await test("константы Rsd из справки известны строгому режиму", () => {
        const context = open([
            "Macro Test()",
            "  Var con = RsdConnection();",
            "  Var cmd = RsdCommand(con, 'call p(?)', RsdCmdStoreProc);",
            "  cmd.AddParam('result', RSDBP_OUT, V_INTEGER);",
            "  cmd.Param(0).Direction = RSDBP_IN_OUT;",
            "  Var rs = cmd.Execute();",
            "  rs.CursorLocation = RSDVAL_CLIENT;",
            "  rs.CursorType = RSDVAL_DYNAMIC;",
            "  rs.AddUserCmdParam('p', 'f', RSDRVER_OLDVAL);",
            "  rs.Move(1, RELATIVE);",
            "  return rs;",
            "End;"
        ].join(String.fromCharCode(10)));

        assert.deepStrictEqual(
            collectUnknownVariables(
                context.module,
                context.resolver,
                { mode: "strict" }
            ).map(finding => finding.name),
            []
        );
    });

    /*
     * Коды ссылочных типов на странице VALTYPE не перечислены, но
     * руководство требует ими пользоваться: «параметр должен иметь тип,
     * соответствующий коду V_SREF или V_FREF».
     */
    await test("коды ссылочных типов известны строгому режиму", () => {
        const context = open([
            "Macro Test(buffer)",
            "  if (ValType(buffer) == V_SREF) return V_FREF;",
            "  return V_AREF + V_TREF + V_DREF;",
            "End;"
        ].join(String.fromCharCode(10)));

        assert.deepStrictEqual(
            collectUnknownVariables(
                context.module,
                context.resolver,
                { mode: "strict" }
            ).map(finding => finding.name),
            []
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

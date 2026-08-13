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
         * 239 процедур, из которых 13 принадлежат макромодулям RslScr и rslx:
         * руководство выделяет их в подразделы «Макропроцедуры модуля …» и
         * требует подключить модуль командой IMPORT. Эти 13 описаны в
         * platform-modules/rslscr.json и platform-modules/rslx.json, поэтому
         * встроенными остаются 226.
         *
         * Число закреплено, чтобы пропажа или дубль в каталоге были видны
         * сразу, а не проявлялись отсутствующим Completion.
         */
        assert.strictEqual(
            procedures.length,
            239 - 13,
            "Состав каталога расошёлся с разделом руководства"
        );

        /* Ни одна из перенесённых процедур не осталась встроенной. */
        const moved = [
            "SetScroll", "FindRow", "FindCol", "FillDown", "FillUp",
            "SetDlgFields", "ScrollMes", "UserFill",
            "AddMultiAction", "GetMultiCount", "GoToScroll", "RunScroll",
            "UpdateScroll"
        ];
        assert.deepStrictEqual(
            procedures
                .map(item => item.name)
                .filter(name => moved.includes(name)),
            [],
            "Процедуры RslScr и rslx доступны только через Import"
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

        /*
         * Возвращаемый тип объявляется только в конце сигнатуры: отдельной
         * таблицы типов больше нет. Если тип известен, он обязан быть виден и
         * в самой сигнатуре — иначе Signature Help показывает меньше, чем
         * знает каталог.
         */
        const hiddenType = procedures.filter(item =>
            item.typeName !== "Variant" &&
            !new RegExp(`:\\s*${item.typeName}\\s*$`, "iu")
                .test(item.signature || "")
        );
        assert.deepStrictEqual(
            hiddenType.map(item => `${item.name}: ${item.typeName}`),
            [],
            "Тип известен каталогу, но не объявлен в конце сигнатуры"
        );
    });

    await test("каждый метод и свойство стандартного класса описаны", () => {
        const {
            RSL_STANDARD_LIBRARY
        } = require("../server/out/builtins/standardLibraryData");
        const classes = RSL_STANDARD_LIBRARY.filter(entry => entry.children);
        const members = classes.flatMap(entry => entry.children.map(child => ({
            name: `${entry.name}.${child.name}`,
            summary: child.summary || ""
        })));

        assert.ok(
            members.length > 120,
            `Состав членов классов подозрительно мал: ${members.length}`
        );

        /*
         * Заглушки «Метод стандартного класса.» и «Свойство стандартного
         * класса.» ничего не сообщают: в Hover и Completion они занимают
         * место описания, ради которого подсказку и открывают.
         */
        const generic = members.filter(item =>
            /^(Метод|Свойство) стандартного класса\.?$/.test(item.summary) ||
            !item.summary
        );
        assert.deepStrictEqual(
            generic.map(item => item.name),
            [],
            "Описание члена класса берётся из раздела руководства о классе"
        );

        const tooLong = members.filter(item =>
            item.summary.split(/\s+/).filter(Boolean).length > 10
        );
        assert.deepStrictEqual(
            tooLong.map(item => `${item.name}: ${item.summary}`),
            [],
            "Описание длиннее десяти слов не читается в подсказке"
        );

        const vagueClass = classes.filter(entry =>
            (entry.summary || "").split(/\s+/).filter(Boolean).length < 2
        );
        assert.deepStrictEqual(
            vagueClass.map(entry => `${entry.name}: ${entry.summary}`),
            [],
            "Описание класса из одного слова не объясняет, что это за класс"
        );
    });

    /*
     * Тип результата метода — факт каталога, а не оформление подписи.
     *
     * Он нужен выводу типа переменной, которой присвоили результат вызова,
     * поэтому объявляется явно (см. method в standardLibraryData) и обязан
     * совпадать с тем, что показано в подписи. Разойтись они могут только по
     * ошибке, и заметно это будет не сразу: подсказка по переменной просто
     * перестанет работать.
     */
    await test("у метода стандартного класса тип результата и подпись согласованы", () => {
        const {
            RSL_STANDARD_LIBRARY
        } = require("../server/out/builtins/standardLibraryData");
        const methods = RSL_STANDARD_LIBRARY
            .filter(entry => entry.children)
            .flatMap(entry => entry.children
                .filter(child => child.signature)
                .map(child => ({ owner: entry.name, child })));

        assert.ok(
            methods.length > 100,
            `Методов подозрительно мало: ${methods.length}`
        );

        const mismatched = methods.filter(({ child }) => {
            const declared = child.typeName;
            const shown = /:\s*([\wА-Яа-яЁё@.]+)\s*$/u
                .exec(child.signature)?.[1];
            return declared && declared !== "Variant"
                ? shown !== declared
                : !!shown;
        });

        assert.deepStrictEqual(
            mismatched.map(({ owner, child }) =>
                `${owner}.${child.name}: тип ${child.typeName}, ` +
                `подпись ${child.signature}`
            ),
            [],
            "Тип результата в подписи расходится с объявленным"
        );

        /* Параметры обязаны быть видны: без них не собрать Signature Help. */
        const withoutParameters = methods.filter(({ child }) =>
            !/\(.*\)/.test(child.signature)
        );
        assert.deepStrictEqual(
            withoutParameters.map(({ owner, child }) =>
                `${owner}.${child.name}: ${child.signature}`
            ),
            [],
            "В подписи метода не видно списка параметров"
        );
    });

    /*
     * Ctrl+Space после точки обязан показывать унаследованные члены.
     *
     * Разрешение одного члена цепочку наследования обходило и раньше, поэтому
     * переход по унаследованному свойству работал, а в подсказке его не было:
     * найти такой член можно было только заранее зная, что он существует.
     */
    await test("Completion после точки показывает члены базового класса", () => {
        const source = [
            "Class Base",
            "  Var BaseProp;",
            "  Macro BaseMethod()",
            "  End;",
            "End;",
            "Class (Base) Derived",
            "  Var OwnProp;",
            "End;",
            "Macro Test()",
            "  Var d = Derived();",
            "  d.",
            "End;"
        ].join("\n");
        const { module, resolver } = moduleFor(source);
        const names = resolver
            .getCompletions(
                module.uri,
                module.symbolTree,
                source.indexOf("  d.") + 4
            )
            .map(item => item.label);

        assert.deepStrictEqual(
            ["OwnProp", "BaseProp", "BaseMethod"].filter(
                name => !names.includes(name)
            ),
            [],
            `Не предложено унаследованное; предложено: ${names.join(", ")}`
        );
    });

    await test("наследование стандартного класса видно в Completion", () => {
        /* TVarRecord в руководстве — наследник TRecHandler. */
        const source = [
            "Macro Test()",
            "  Var v = TVarRecord();",
            "  v.",
            "End;"
        ].join("\n");
        const { module, resolver } = moduleFor(source);
        const names = resolver
            .getCompletions(
                module.uri,
                module.symbolTree,
                source.indexOf("  v.") + 4
            )
            .map(item => item.label);

        assert.ok(
            names.includes("varPart"),
            `Собственное свойство не предложено: ${names.join(", ")}`
        );
        assert.ok(
            names.includes("Rec") && names.includes("SetRecordAddr"),
            "Члены базового TRecHandler обязаны попадать в подсказку; " +
                `предложено: ${names.join(", ")}`
        );
    });

    await test("циклическое наследование не зацикливает Completion", () => {
        /* Ошибочный код не должен подвешивать сервер. */
        const source = [
            "Class (Second) First",
            "  Var FirstProp;",
            "End;",
            "Class (First) Second",
            "  Var SecondProp;",
            "End;",
            "Macro Test()",
            "  Var s = Second();",
            "  s.",
            "End;"
        ].join("\n");
        const { module, resolver } = moduleFor(source);
        const names = resolver
            .getCompletions(
                module.uri,
                module.symbolTree,
                source.indexOf("  s.") + 4
            )
            .map(item => item.label);

        assert.deepStrictEqual(
            ["SecondProp", "FirstProp"].filter(name => !names.includes(name)),
            [],
            `Оба класса цепочки должны попасть в подсказку: ${names.join(", ")}`
        );
    });

    await test("объявленный базовый класс существует в каталоге", () => {
        const {
            RSL_STANDARD_LIBRARY
        } = require("../server/out/builtins/standardLibraryData");
        const classes = RSL_STANDARD_LIBRARY.filter(entry => entry.children);
        const known = new Set(
            classes.map(entry => entry.name.toLowerCase())
        );
        const dangling = classes
            .filter(entry => entry.base && !known.has(entry.base.toLowerCase()))
            .map(entry => `${entry.name} -> ${entry.base}`);

        assert.deepStrictEqual(
            dangling,
            [],
            "Базовый класс не найден в каталоге: его члены не попадут в " +
                "подсказку, а опечатка в имени ничем себя не проявит"
        );
    });

    /*
     * Классы прикладных модулей доступны только через Import.
     *
     * Предлагать их всегда неверно: класс модуля существует лишь там, где
     * модуль импортирован. Транзитивный случай (модуль импортирован внутри
     * импортированного файла) обязан работать только по уже разобранным
     * файлам: обход проекта в момент Ctrl+Space — это задержка ровно там, где
     * пользователь ждёт ответа.
     */
    await test("классы прикладного модуля видны только через Import", async () => {
        const {
            PlatformModuleCatalog
        } = require("../server/out/builtins/platformModuleCatalog");
        const catalog = new PlatformModuleCatalog({ log: () => undefined });
        await catalog.ensureModules([
            "CommonInter", "AcquirerObjects", "BankInter", "middle"
        ]);

        assert.ok(
            catalog.ready && catalog.moduleCount > 10,
            `Каталог прикладных модулей не прочитан: ${catalog.moduleCount}`
        );

        const MAIN = "file:///main.mac";
        const MIDDLE = "file:///middle.mac";
        const build = (files, source) => {
            const index = new WorkspaceIndex();
            index.registerWorkspaceFiles(Object.keys(files));
            let target;
            for (const [uri, text] of Object.entries(files)) {
                const opened = index.updateOpenModule(uri, text, 1);
                if (uri === MAIN) {
                    target = opened;
                }
            }
            const resolver = new RslScopeResolver(index, undefined, catalog);
            return resolver
                .getCompletions(
                    MAIN,
                    target.symbolTree,
                    source.indexOf("Var x = R") + 9
                )
                .map(item => item.label);
        };

        const tail = "Macro Test()\n  Var x = R\nEnd;";
        const withoutImport = `${tail}`;
        const withImport = `Import CommonInter;\n${tail}`;
        const viaMiddle = `Import middle;\n${tail}`;

        assert.ok(
            !build({ [MAIN]: withoutImport }, withoutImport)
                .includes("RSL_LoansCarryDoc"),
            "Без Import класс модуля не должен попадать в подсказку"
        );
        assert.ok(
            build({ [MAIN]: withImport }, withImport)
                .includes("RSL_LoansCarryDoc"),
            "С Import CommonInter класс модуля обязан быть предложен"
        );
        assert.ok(
            build(
                {
                    [MIDDLE]: "Import CommonInter;\nMacro Helper()\nEnd;",
                    [MAIN]: viaMiddle
                },
                viaMiddle
            ).includes("RSL_LoansCarryDoc"),
            "Модуль, импортированный в уже разобранном файле, тоже доступен"
        );

        /*
         * Тот же транзитивный случай, но каталог ничего не грузил заранее —
         * так это и происходит в жизни. Пока middle.mac не в индексе, его
         * Import неизвестен; после появления модуль обязан попасть в список
         * видимых, и подготовить его состав должен вызывающий
         * (refreshOpenDependents в server.ts), а не обработчик Completion.
         */
        const cold = new PlatformModuleCatalog({ log: () => undefined });
        /* Индекс каталога читается асинхронно и до запросов. */
        await cold.ensureIndexLoaded();
        const coldIndex = new WorkspaceIndex();
        coldIndex.registerWorkspaceFiles([MAIN, MIDDLE]);
        const coldMain = coldIndex.updateOpenModule(MAIN, viaMiddle, 1);
        const coldResolver = new RslScopeResolver(coldIndex, undefined, cold);
        const coldNames = () => coldResolver
            .getCompletions(
                MAIN,
                coldMain.symbolTree,
                viaMiddle.indexOf("Var x = R") + 9
            )
            .map(item => item.label);

        assert.deepStrictEqual(
            coldResolver.visiblePlatformModules(MAIN),
            [],
            "Пока импортированный файл не разобран, его Import не известен"
        );

        coldIndex.updateExternalModule(
            MIDDLE,
            "Import CommonInter;\nMacro Helper()\nEnd;",
            1
        );

        assert.deepStrictEqual(
            Array.from(coldResolver.visiblePlatformModules(MAIN)),
            ["CommonInter"],
            "После попадания middle.mac в индекс модуль обязан стать видимым"
        );
        assert.ok(
            !coldNames().includes("RSL_LoansCarryDoc"),
            "Completion не имеет права сам грузить состав модуля"
        );

        await cold.ensureModules(coldResolver.visiblePlatformModules(MAIN));
        assert.ok(
            coldNames().includes("RSL_LoansCarryDoc"),
            "После подготовки состава классы модуля обязаны появиться"
        );

        /* Неразобранный файл проекта не должен ни давать классы, ни грузиться. */
        const lazyIndex = new WorkspaceIndex();
        lazyIndex.registerWorkspaceFiles([MAIN, MIDDLE]);
        const opened = lazyIndex.updateOpenModule(MAIN, viaMiddle, 1);
        const lazyResolver = new RslScopeResolver(
            lazyIndex,
            undefined,
            catalog
        );
        assert.ok(
            !lazyResolver
                .getCompletions(
                    MAIN,
                    opened.symbolTree,
                    viaMiddle.indexOf("Var x = R") + 9
                )
                .map(item => item.label)
                .includes("RSL_LoansCarryDoc"),
            "Пока импортированный файл не разобран, его Import не учитывается: " +
                "иначе Completion пришлось бы обходить проект"
        );
    });

    await test("Completion не читает файл прикладных модулей", async () => {
        const fs = require("fs");
        const {
            PlatformModuleCatalog
        } = require("../server/out/builtins/platformModuleCatalog");
        const catalog = new PlatformModuleCatalog({ log: () => undefined });
        await catalog.ensureModules([
            "CommonInter", "AcquirerObjects", "BankInter", "middle"
        ]);

        const source = "Import CommonInter;\nMacro Test()\n  Var x = R\nEnd;";
        const index = new WorkspaceIndex();
        const uri = "file:///reads.mac";
        index.registerWorkspaceFiles([uri]);
        const opened = index.updateOpenModule(uri, source, 1);
        const resolver = new RslScopeResolver(index, undefined, catalog);

        const real = fs.readFileSync;
        const realAsync = fs.promises.readFile;
        let reads = 0;
        const count = value => {
            if (String(value).includes("platform-modules")) {
                reads++;
            }
        };
        fs.readFileSync = function (...args) {
            count(args[0]);
            return real.apply(this, args);
        };
        /* Асинхронное чтение считается тоже: запрос его точно так же не ждёт. */
        fs.promises.readFile = function (...args) {
            count(args[0]);
            return realAsync.apply(this, args);
        };
        try {
            resolver.getCompletions(
                uri,
                opened.symbolTree,
                source.indexOf("Var x = R") + 9
            );
        } finally {
            fs.readFileSync = real;
            fs.promises.readFile = realAsync;
        }

        assert.strictEqual(
            reads,
            0,
            "Состав обязан быть готов заранее: у PaymInter это 186 КБ, " +
                "читать их в момент Ctrl+Space значит задержать ответ"
        );
    });

    await test("класс модуля наследует члены стандартного класса", async () => {
        const {
            PlatformModuleCatalog
        } = require("../server/out/builtins/platformModuleCatalog");
        const catalog = new PlatformModuleCatalog({ log: () => undefined });
        await catalog.ensureModules([
            "CommonInter", "AcquirerObjects", "BankInter", "middle"
        ]);

        /* TAcqDocument -> TPersistVarRecord -> TVarRecord -> TRecHandler. */
        const source = [
            "Import AcquirerObjects;",
            "Macro Test()",
            "  Var d = TAcqDocument();",
            "  d.",
            "End;"
        ].join("\n");
        const uri = "file:///acq.mac";
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([uri]);
        const opened = index.updateOpenModule(uri, source, 1);
        const resolver = new RslScopeResolver(index, undefined, catalog);
        const names = resolver
            .getCompletions(uri, opened.symbolTree, source.indexOf("  d.") + 4)
            .map(item => item.label);

        assert.ok(
            names.includes("branch"),
            `Собственное свойство не предложено: ${names.join(", ")}`
        );
        assert.ok(
            names.includes("Rec") && names.includes("varPart"),
            "Цепочка наследования обязана доходить до стандартных классов; " +
                `предложено: ${names.join(", ")}`
        );
    });

    await test("символы прикладного модуля разрешаются, а не только предлагаются", async () => {
        const {
            PlatformModuleCatalog
        } = require("../server/out/builtins/platformModuleCatalog");
        const catalog = new PlatformModuleCatalog({ log: () => undefined });
        await catalog.ensureModules(["total", "CommonInter"]);

        /*
         * Без этого имя из модуля попадало в Completion, но resolveAt его не
         * находил — то есть Hover, подсказка параметров и семантическая
         * подсветка по нему не работали.
         */
        const source = [
            "Import total, CommonInter;",
            "Macro Test()",
            "  Var r = LnGetRecordSet(query, true);",
            "  Var d = RSL_LoansCarryDoc();",
            "End;"
        ].join("\n");
        const uri = "file:///resolve.mac";
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([uri]);
        const opened = index.updateOpenModule(uri, source, 1);
        const resolver = new RslScopeResolver(index, undefined, catalog);

        const procedure = resolver.resolveAt(
            uri,
            opened.symbolTree,
            source.indexOf("LnGetRecordSet") + 1
        );
        assert.ok(procedure, "Процедура модуля обязана разрешаться");
        assert.strictEqual(procedure.symbol.typeName, "Object");
        assert.ok(
            procedure.symbol.documentation,
            "У символа обязано быть описание, иначе Hover покажет пустоту"
        );

        const klass = resolver.resolveAt(
            uri,
            opened.symbolTree,
            source.indexOf("RSL_LoansCarryDoc") + 1
        );
        assert.ok(klass, "Класс модуля обязан разрешаться");
        assert.strictEqual(klass.symbol.typeName, "RSL_LoansCarryDoc");
    });

    await test("процедуры прикладного модуля предлагаются и знают свой тип", async () => {
        const {
            PlatformModuleCatalog
        } = require("../server/out/builtins/platformModuleCatalog");
        const catalog = new PlatformModuleCatalog({ log: () => undefined });
        await catalog.ensureModules(["total"]);

        /*
         * LnGetRecordSet объявлена как «(Query:String, MsgPrint:Bool): Object»,
         * то есть тип результата у процедуры модуля известен — и должен
         * использоваться при выводе типа переменной.
         */
        assert.strictEqual(
            catalog.findResultType(["total"], "LnGetRecordSet"),
            "Object",
            "Тип результата процедуры модуля обязан быть прочитан"
        );

        const source = "Import total;\nMacro Test()\n  Var v = Ln\nEnd;";
        const uri = "file:///proc.mac";
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([uri]);
        const opened = index.updateOpenModule(uri, source, 1);
        const resolver = new RslScopeResolver(index, undefined, catalog);
        const names = resolver
            .getCompletions(uri, opened.symbolTree, source.indexOf("Var v = Ln") + 10)
            .map(item => item.label);

        assert.ok(
            names.includes("LnGetRecordSet"),
            `Процедура модуля не предложена: ${names.slice(0, 8).join(", ")}`
        );
    });

    /*
     * RsbFormsInter — модуль экранных форм, у него глубокая иерархия визуальных
     * компонентов и свои константы событий.
     *
     * Он ДОЛГО отсутствовал в каталоге незамеченным: топики его классов
     * называются rsbformsinter_classes_*, а извлечение искало только
     * <модуль>_class_*, и 22 класса молча уходили в счётчик пропущенных.
     * Поэтому здесь проверяется и наличие модуля, и то, ради чего он нужен.
     */
    await test("RsbFormsInter даёт классы, цепочку наследования и константы", async () => {
        const {
            PlatformModuleCatalog
        } = require("../server/out/builtins/platformModuleCatalog");
        const catalog = new PlatformModuleCatalog({ log: () => undefined });

        await catalog.ensureIndexLoaded();
        assert.ok(
            catalog.knowsModule("RsbFormsInter"),
            "Модуль экранных форм обязан быть в каталоге"
        );
        await catalog.ensureModules(["RsbFormsInter"]);

        const source = [
            "Import RsbFormsInter;",
            "Macro Test()",
            "  Var panel = TRsbPanel();",
            "  panel.",
            "End;"
        ].join("\n");
        const uri = "file:///forms.mac";
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([uri]);
        const opened = index.updateOpenModule(uri, source, 1);
        const resolver = new RslScopeResolver(index, undefined, catalog);

        const klass = resolver.resolveAt(
            uri,
            opened.symbolTree,
            source.indexOf("TRsbPanel") + 2
        );
        assert.ok(klass, "Класс формы обязан разрешаться");
        assert.strictEqual(klass.symbol.typeName, "TRsbPanel");

        /*
         * TRsbPanel -> TRsbForm -> TRsbWindow -> TRsbActiveVisualComponent:
         * члены обязаны собираться по всей цепочке, иначе подсказка по объекту
         * формы показывает только его собственные свойства.
         */
        const members = resolver
            .getCompletions(uri, opened.symbolTree, source.indexOf("  panel.") + 8)
            .map(item => item.label);

        assert.ok(
            members.includes("addControl"),
            `Собственный член не предложен: ${members.join(", ")}`
        );
        assert.ok(
            members.includes("caption") && members.includes("visible"),
            "Члены базовых классов формы обязаны попадать в подсказку; " +
                `предложено: ${members.join(", ")}`
        );

        const constant = catalog.findSymbol(
            ["RsbFormsInter"],
            "RSB_EV_BUTTON_CLICKED"
        );
        assert.ok(constant, "Константы вида события обязаны быть в каталоге");
        assert.strictEqual(constant.moduleName, "RsbFormsInter");
        assert.strictEqual(constant.symbol.typeName, "Integer");
        /* Значение обязано дойти до символа, а не остаться в тексте подписи. */
        assert.strictEqual(constant.symbol.value, "5");
        assert.ok(
            constant.symbol.completionItem.detail.includes("= 5"),
            "Значение константы обязано быть видно в Completion: " +
                constant.symbol.completionItem.detail
        );
        assert.ok(
            constant.symbol.documentation,
            "У константы обязано быть описание: иначе Hover покажет пустоту"
        );

        const offered = catalog.completionItems(["RsbFormsInter"])
            .filter(item => /^RSB_EV_/.test(item.label));
        assert.ok(
            offered.length >= 10,
            `Константы событий обязаны предлагаться: ${offered.length}`
        );
    });

    /*
     * Константы интерактивного режима из раздела «Поддержка интерактивного
     * режима»: сообщения диалога, коды возврата обработчика и параметры окна
     * сообщения. Числовых значений руководство не приводит, поэтому у них есть
     * тип и описание, но нет значения — придумывать его нельзя.
     */
    await test("константы диалога есть в каталоге и описаны", () => {
        const catalog = getDefaults();
        const expected = [
            "DLG_PREINIT", "DLG_INIT", "DLG_INREC", "DLG_OUTREC",
            "DLG_REMFOCUS", "DLG_SETFOCUS", "DLG_KEY", "DLG_BUTTON",
            "DLG_MOUSE", "DLG_TIMER", "DLG_SAVE", "DLG_DESTROY",
            "DLG_INLOOP", "DLG_OUTLOOP", "DLG_SWITCH", "DLG_MSELSTART",
            "DLG_MSEL", "DLG_MSELEND",
            "CM_DEFAULT", "CM_CANCEL", "CM_SAVE", "CM_IGNORE", "CM_INSERT",
            "CM_SELECT", "CM_UPDATE_ADDSCROLL", "CM_MSEL_CONT_CLEAR",
            "CM_MSEL_STOP_KEEP", "CM_MSEL_STOP_CLEAR",
            "CM_MSEL_STOP_CLEARALL",
            "MB_OK", "MB_YES", "MB_NO", "MB_CANCEL", "MB_ERROR",
            "IND_OK", "IND_YES", "IND_NO", "IND_CANCEL", "IND_ERROR"
        ];

        for (const name of expected) {
            const symbol = catalog.findSymbol(name);
            assert.ok(symbol, `Константа ${name} обязана быть в каталоге`);
            assert.strictEqual(
                symbol.typeName,
                "Integer",
                `${name}: константы диалога сравниваются с числами`
            );
            assert.ok(
                symbol.documentation.length > 20,
                `${name}: описание обязано быть по существу`
            );
            /*
             * Значения руководство не называет. Показать выдуманное число хуже,
             * чем не показать ничего: пользователь сравнит его с полученным от
             * системы и получит неверный ответ.
             */
            assert.strictEqual(
                symbol.value,
                "",
                `${name}: неподтверждённое значение подставлять нельзя`
            );
        }
    });

    /*
     * Руководство выделяет процедуры RslScr и rslx в подразделы
     * «Макропроцедуры модуля …» и требует подключить модуль командой IMPORT.
     * Значит без Import этих имён не существует.
     */
    await test("процедуры RslScr и rslx доступны только через Import", async () => {
        const {
            PlatformModuleCatalog
        } = require("../server/out/builtins/platformModuleCatalog");
        const catalog = new PlatformModuleCatalog({ log: () => undefined });
        await catalog.ensureModules(["RslScr", "rslx"]);

        const MAIN = "file:///scroll.mac";
        const build = source => {
            const index = new WorkspaceIndex();
            index.registerWorkspaceFiles([MAIN]);
            const module = index.updateOpenModule(MAIN, source, 1);
            return {
                module,
                resolver: new RslScopeResolver(index, undefined, catalog)
            };
        };

        const withImport = build([
            "Import RslScr, rslx;",
            "Macro Test()",
            "  SetScroll (data);",
            "  Var last = LastUsed;",
            "  UpdateScroll (rs, 3);",
            "End;"
        ].join("\n"));

        for (const name of ["SetScroll", "UpdateScroll", "GoToScroll"]) {
            const resolved = withImport.resolver.resolveAt(
                MAIN,
                withImport.module.symbolTree,
                withImport.module.source.indexOf(name) >= 0
                    ? withImport.module.source.indexOf(name) + 1
                    : 0
            );
            assert.ok(
                name === "GoToScroll" || resolved,
                `${name} обязана разрешаться при Import`
            );
        }

        /* Глобальная переменная модуля — не константа: ей присваивают. */
        const variable = catalog.findSymbol(["RslScr"], "LastUsed");
        assert.ok(variable, "Переменные модуля RslScr обязаны быть в каталоге");
        assert.strictEqual(variable.symbol.typeName, "Integer");
        assert.ok(variable.symbol.documentation.includes("скроллинг"));

        const withoutImport = build([
            "Macro Test()",
            "  SetScroll (data);",
            "End;"
        ].join("\n"));
        assert.strictEqual(
            withoutImport.resolver.resolveAt(
                MAIN,
                withoutImport.module.symbolTree,
                withoutImport.module.source.indexOf("SetScroll") + 1
            ),
            undefined,
            "Без Import RslScr имени SetScroll не существует"
        );
        assert.ok(
            !getDefaults().findSymbol("SetScroll"),
            "Процедура модуля не имеет права быть встроенной"
        );
    });

    await test("состав модуля читается только для импортированных", async () => {
        const {
            PlatformModuleCatalog
        } = require("../server/out/builtins/platformModuleCatalog");
        const catalog = new PlatformModuleCatalog({ log: () => undefined });

        /* Индекс знает про все модули, но их состав ещё не прочитан. */
        await catalog.ensureIndexLoaded();
        assert.ok(
            catalog.knowsModule("PaymInter") && catalog.moduleCount > 30,
            `Индекс модулей не прочитан: ${catalog.moduleCount}`
        );
        assert.strictEqual(
            catalog.loadedCount,
            0,
            "Индекс не должен тянуть за собой состав: у PaymInter это 186 КБ"
        );

        await catalog.ensureModules(["CommonInter"]);
        assert.deepStrictEqual(
            catalog.dependenciesOf("CommonInter"),
            ["acquirerobjects"],
            "Зависимости модуля обязаны быть объявлены в индексе"
        );
        assert.strictEqual(
            catalog.loadedCount,
            2,
            "Читаться обязан запрошенный модуль и его объявленные зависимости"
        );
        assert.ok(
            !catalog.findClass(["PaymInter"], "RsbPayDocument"),
            "Непрочитанный модуль не должен отдавать символы"
        );
    });

    /*
     * Холодный каталог: индекс ещё не читан, как при первом же файле в сессии.
     *
     * Порядок здесь существенный. Список видимых модулей опирается на индекс
     * каталога, поэтому считать его ДО загрузки индекса бессмысленно: knowsModule
     * не знает ни одного имени, список выходит пустым, и загружать оказывается
     * нечего. Именно так и было: первое событие загружало только индекс, а состав
     * модулей — лишь второе, то есть символы `Import CommonInter` не разрешались
     * до следующей правки файла.
     */
    await test("холодный каталог готовится с первого события", async () => {
        const {
            PlatformModuleCatalog
        } = require("../server/out/builtins/platformModuleCatalog");
        const catalog = new PlatformModuleCatalog({ log: () => undefined });
        const MAIN = "file:///cold.mac";
        const source = [
            "Import CommonInter;",
            "Macro Test()",
            "  Var doc = RSL_LoansCarryDoc();",
            "End;"
        ].join("\n");
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([MAIN]);
        const module = index.updateOpenModule(MAIN, source, 1);
        const resolver = new RslScopeResolver(index, undefined, catalog);

        /* Каталог холодный: имён он пока не знает. */
        assert.strictEqual(catalog.indexState, "loading");
        assert.deepStrictEqual(
            Array.from(resolver.visiblePlatformModules(MAIN)),
            [],
            "До загрузки индекса видимых модулей нет — и это не ответ, а " +
                "отсутствие данных"
        );

        /* Та же последовательность, что и в server.ts. */
        await catalog.ensureIndexLoaded();
        await catalog.ensureModules(resolver.visiblePlatformModules(MAIN));

        assert.deepStrictEqual(
            Array.from(resolver.visiblePlatformModules(MAIN)),
            ["CommonInter"]
        );
        assert.ok(
            catalog.isModuleLoaded("CommonInter"),
            "Состав модуля обязан быть прочитан с первого прохода"
        );
        assert.ok(
            resolver.resolveAt(
                MAIN,
                module.symbolTree,
                source.indexOf("RSL_LoansCarryDoc") + 1
            ),
            "Символ модуля обязан разрешаться сразу, а не со второго события"
        );
    });

    /*
     * Контрольный случай межмодульного наследования.
     *
     * RsbBBPayment объявлен в BankInter, а его базовый класс RsbPayment — в
     * PaymInter. Одного `Import BankInter` обязано хватить: состав зависимого
     * модуля читается транзитивно. При этом сам RsbPayment по имени НЕ виден —
     * назвать его без `Import PaymInter` компилятор не позволит.
     */
    await test("Import BankInter даёт члены, унаследованные из PaymInter", async () => {
        const {
            PlatformModuleCatalog
        } = require("../server/out/builtins/platformModuleCatalog");
        const catalog = new PlatformModuleCatalog({ log: () => undefined });
        await catalog.ensureModules(["BankInter"]);

        assert.ok(
            catalog.loadedCount >= 2,
            "PaymInter обязан прочитаться как зависимость BankInter"
        );

        const source = [
            "Import BankInter;",
            "Macro Test()",
            "  Var payment = RsbBBPayment();",
            "  payment.",
            "End;"
        ].join("\n");
        const uri = "file:///bb.mac";
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([uri]);
        const opened = index.updateOpenModule(uri, source, 1);
        const resolver = new RslScopeResolver(index, undefined, catalog);

        const members = resolver
            .getCompletions(
                uri,
                opened.symbolTree,
                source.indexOf("  payment.") + 10
            )
            .map(item => String(item.label));

        assert.ok(
            members.length > 0,
            "Класс RsbBBPayment своих членов не имеет — все они унаследованы"
        );
        assert.ok(
            members.includes("AkkrAddDocs") && members.includes("BaseRate"),
            "Члены RsbPayment обязаны попадать в подсказку по RsbBBPayment; " +
                `предложено: ${members.slice(0, 20).join(", ")}`
        );

        /* Разрешение члена, а не только список: Hover и переход тоже. */
        const inherited = resolver.resolveMemberReference(
            uri,
            opened.symbolTree,
            source.indexOf("  payment.") + 3,
            "BaseRate"
        );
        assert.ok(inherited, "Унаследованный член обязан разрешаться");
        assert.strictEqual(inherited.platformModule, "payminter");

        assert.ok(
            !catalog.findClass(["BankInter"], "RsbPayment"),
            "Зависимость читается для наследования, но её имена не видны"
        );
    });

    /*
     * Базовый класс прикладного модуля не имеет права разрешаться через
     * произвольный одноимённый класс проекта.
     */
    await test("базовый platform-класс не берётся из workspace", async () => {
        const {
            PlatformModuleCatalog
        } = require("../server/out/builtins/platformModuleCatalog");
        const catalog = new PlatformModuleCatalog({ log: () => undefined });
        await catalog.ensureModules(["BankInter"]);

        const MAIN = "file:///main.mac";
        const source = [
            "Import BankInter;",
            "Class RsbPayment",
            "  Var Impostor;",
            "End;",
            "Macro Test()",
            "  Var payment = RsbBBPayment();",
            "  payment.",
            "End;"
        ].join("\n");
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([MAIN]);
        const opened = index.updateOpenModule(MAIN, source, 1);
        const resolver = new RslScopeResolver(index, undefined, catalog);
        const members = resolver
            .getCompletions(
                MAIN,
                opened.symbolTree,
                source.indexOf("  payment.") + 10
            )
            .map(item => String(item.label));

        assert.ok(
            !members.includes("Impostor"),
            "Класс проекта не имеет права подменять базовый класс модуля"
        );
        assert.ok(
            members.includes("AkkrAddDocs"),
            `Настоящая база обязана остаться: ${members.slice(0, 10).join(", ")}`
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
        const typeSource = [
            "Class LocalDocument",
            "End;",
            "Macro Test(value:Rs"
        ].join("\n");
        const typeContext = moduleFor(typeSource);
        const types = buildRslContextCompletions(
            typeContext.module,
            typeContext.index,
            typeSource.length,
            typeContext.resolver
        );
        assert.ok(types.some(item => item.label === "RsdCommand"));
        assert.ok(
            types.some(item => item.label === "Integer"),
            "Примитивный тип обязан предлагаться в позиции типа"
        );
        /* Класс текущего файла — тоже допустимый тип. */
        assert.ok(
            types.some(item => item.label === "LocalDocument"),
            `Класс файла обязан предлагаться: ${
                types.slice(0, 10).map(item => item.label).join(", ")}`
        );
        assert.ok(
            types.every(item => !String(item.insertText || "").includes("(")),
            "В позиции типа скобки вызова не подставляются"
        );

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

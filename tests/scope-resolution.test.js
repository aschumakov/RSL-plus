"use strict";

/**
 * Области видимости, вывод типов и граница между resolver-ом и Auto Import.
 *
 * Присваивания индексируются по объявлению (uri + symbolId), а для переменной
 * без объявления — по области присваивания (uri + scopeId + name). Раньше ключом
 * было одно имя на весь модуль, и тип «протекал» между одноимёнными переменными
 * разных Macro, методов и классов.
 */

const assert = require("assert");

const {
    buildKnownAutoImportCompletions,
    buildMissingImportActions
} = require("../server/out/features/autoImportProvider");
const {
    prepareRslRename
} = require("../server/out/features/renameProvider");
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

/** Индекс из одного открытого документа. */
function open(source, uri = MAIN) {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([uri]);
    const module = index.updateOpenModule(uri, source, 1);
    return {
        index,
        module,
        resolver: new RslScopeResolver(index),
        source,
        uri
    };
}

/** Позиция occurrence-го вхождения подстроки. */
function at(source, text, occurrence = 0) {
    let offset = -1;
    for (let index = 0; index <= occurrence; index++) {
        offset = source.indexOf(text, offset + 1);
        assert.notStrictEqual(offset, -1, `нет вхождения ${occurrence} ${text}`);
    }
    return offset;
}

/** Действующий тип переменной name в позиции offset. */
function typeOf(context, name, offset) {
    const resolved = context.resolver.resolveName(
        context.uri,
        context.module.symbolTree,
        name,
        offset
    );
    assert.ok(resolved, `имя ${name} не разрешилось`);
    return context.resolver.effectiveTypeName(
        context.uri,
        context.module.symbolTree,
        resolved.symbol,
        offset
    );
}

/** Члены, предлагаемые после точки в позиции offset. */
function membersAt(context, offset) {
    return context.resolver
        .getCompletions(context.uri, context.module.symbolTree, offset)
        .map(item => String(item.label));
}

async function main() {
    /*
     * ─── Вывод типа локальной переменной ───────────────────────────────────
     */
    await test("тип локальной переменной выводится из её присваивания", () => {
        const source = [
            "Class Document",
            "  Var Number;",
            "End;",
            "Macro Handle()",
            "  Var doc;",
            "  doc = Document();",
            "  doc.Number;",
            "End;"
        ].join("\n");
        const context = open(source);

        assert.strictEqual(
            typeOf(context, "doc", at(source, "doc.Number")),
            "Document"
        );
        assert.ok(
            membersAt(context, at(source, "doc.Number") + 4)
                .includes("Number")
        );
    });

    /*
     * ─── Одноимённые переменные разных Macro ───────────────────────────────
     */
    await test("тип не переносится между одноимёнными переменными Macro", () => {
        const source = [
            "Class Invoice",
            "  Var Total;",
            "End;",
            "Macro WithType()",
            "  Var doc;",
            "  doc = Invoice();",
            "  doc.Total;",
            "End;",
            "Macro WithoutType()",
            "  Var doc;",
            "  doc.Total;",
            "End;"
        ].join("\n");
        const context = open(source);

        assert.strictEqual(
            typeOf(context, "doc", at(source, "doc.Total", 0)),
            "Invoice"
        );
        /*
         * Второй Macro своего присваивания не имеет: `Invoice` из первого к его
         * переменной отношения не имеет, даже что имена совпали.
         */
        assert.strictEqual(
            typeOf(context, "doc", at(source, "doc.Total", 1)),
            "variant"
        );
        assert.deepStrictEqual(
            membersAt(context, at(source, "doc.Total", 1) + 4),
            [],
            "Члены чужого класса не имеют права появляться у одноимённой " +
                "переменной другого Macro"
        );
    });

    await test("тип не переносится между методами и классами", () => {
        const source = [
            "Class Payment",
            "  Var Amount;",
            "End;",
            "Class Left",
            "  Macro Fill()",
            "    Var item;",
            "    item = Payment();",
            "  End;",
            "End;",
            "Class Right",
            "  Macro Read()",
            "    Var item;",
            "    item.Amount;",
            "  End;",
            "End;"
        ].join("\n");
        const context = open(source);

        assert.strictEqual(
            typeOf(context, "item", at(source, "item.Amount")),
            "variant"
        );
        assert.deepStrictEqual(
            membersAt(context, at(source, "item.Amount") + 5),
            []
        );
    });

    /*
     * ─── Глобальная переменная модуля ──────────────────────────────────────
     */
    await test("тип глобальной переменной модуля выводится и виден в Macro", () => {
        const source = [
            "Class Ledger",
            "  Var Balance;",
            "End;",
            "Private Var ledger = Ledger();",
            "Macro Report()",
            "  ledger.Balance;",
            "End;"
        ].join("\n");
        const context = open(source);

        assert.strictEqual(
            typeOf(context, "ledger", at(source, "ledger.Balance")),
            "Ledger"
        );
        assert.ok(
            membersAt(context, at(source, "ledger.Balance") + 7)
                .includes("Balance")
        );
    });

    await test("присваивание на уровне модуля работает и без Var", () => {
        const source = [
            "Class Ledger",
            "  Var Balance;",
            "End;",
            "ledger = Ledger();",
            "Macro Report()",
            "  ledger.Balance;",
            "End;"
        ].join("\n");
        const context = open(source);

        /*
         * Переменной без объявления в дереве символов нет, поэтому ключом
         * присваивания служит область — здесь модуль. Обход областей идёт от
         * внутренней к внешней, и внутри Macro присваивание модуля находится.
         */
        assert.ok(
            membersAt(context, at(source, "ledger.Balance") + 7)
                .includes("Balance"),
            "Неявная переменная модуля обязана сохранять выведенный тип"
        );
    });

    await test("неявные одноимённые переменные разных Macro независимы", () => {
        const source = [
            "Class Ledger",
            "  Var Balance;",
            "End;",
            "Macro Fill()",
            "  ledger = Ledger();",
            "End;",
            "Macro Report()",
            "  ledger.Balance;",
            "End;"
        ].join("\n");
        const context = open(source);

        assert.deepStrictEqual(
            membersAt(context, at(source, "ledger.Balance") + 7),
            [],
            "Присваивание в соседнем Macro не задаёт тип здесь"
        );
    });

    /*
     * ─── Затенение ─────────────────────────────────────────────────────────
     */
    await test("локальное объявление затеняет одноимённое глобальное", () => {
        const source = [
            "Class Outer",
            "  Var OuterField;",
            "End;",
            "Class Inner",
            "  Var InnerField;",
            "End;",
            "Var shared = Outer();",
            "Macro Shadow()",
            "  Var shared = Inner();",
            "  shared.InnerField;",
            "End;",
            "Macro Global()",
            "  shared.OuterField;",
            "End;"
        ].join("\n");
        const context = open(source);

        assert.strictEqual(
            typeOf(context, "shared", at(source, "shared.InnerField")),
            "Inner"
        );
        assert.strictEqual(
            typeOf(context, "shared", at(source, "shared.OuterField")),
            "Outer"
        );

        const shadowed = membersAt(
            context,
            at(source, "shared.InnerField") + 7
        );
        assert.ok(shadowed.includes("InnerField"));
        assert.ok(
            !shadowed.includes("OuterField"),
            "Затенённое объявление не имеет права давать свои члены"
        );
    });

    await test("переменная не подменяет одноимённый класс в позиции вызова", () => {
        /*
         * `service = Service()` внутри `Var service;`: слева переменная, справа
         * конструктор. Разрешать имя в позиции вызова надо среди вызываемых,
         * иначе переменная затеняет собственный конструктор и тип теряется.
         */
        const source = [
            "Class Service",
            "  Macro Run()",
            "  End;",
            "End;",
            "Macro Test()",
            "  Var service;",
            "  service = Service();",
            "  service.Run();",
            "End;"
        ].join("\n");
        const context = open(source);

        assert.strictEqual(
            typeOf(context, "service", at(source, "service.Run")),
            "Service"
        );
    });

    /*
     * ─── Члены класса по имени, без this ───────────────────────────────────
     */
    await test("член класса разрешается по имени, без this", () => {
        const source = [
            "Class Base",
            "  Var Inherited;",
            "  Macro BaseMethod()",
            "  End;",
            "End;",
            "Class (Base) Derived",
            "  Var Own;",
            "  Macro Use(argument)",
            "    Var local;",
            "    Own = 1;",
            "    Inherited = 2;",
            "    BaseMethod();",
            "  End;",
            "End;"
        ].join("\n");
        const context = open(source);
        const tree = context.module.symbolTree;

        const own = context.resolver.resolveName(
            context.uri,
            tree,
            "Own",
            at(source, "Own = 1")
        );
        assert.ok(own, "Собственное свойство обязано разрешаться без this");
        assert.strictEqual(own.symbol.name, "Own");

        const inherited = context.resolver.resolveName(
            context.uri,
            tree,
            "Inherited",
            at(source, "Inherited = 2")
        );
        assert.ok(inherited, "Унаследованное свойство обязано разрешаться");
        assert.strictEqual(inherited.symbol.name, "Inherited");

        const method = context.resolver.resolveName(
            context.uri,
            tree,
            "BaseMethod",
            at(source, "BaseMethod()", 1)
        );
        assert.ok(method, "Унаследованный метод обязан разрешаться");
        assert.strictEqual(method.symbol.name, "BaseMethod");

        /* Параметр и локальная переменная — раньше собственных членов. */
        const parameter = context.resolver.resolveName(
            context.uri,
            tree,
            "argument",
            at(source, "Own = 1")
        );
        assert.ok(parameter);
        assert.strictEqual(parameter.symbol.name, "argument");
    });

    await test("параметр метода важнее одноимённого свойства класса", () => {
        const source = [
            "Class Holder",
            "  Var value;",
            "  Macro Set(value)",
            "    value = 1;",
            "  End;",
            "End;"
        ].join("\n");
        const context = open(source);
        const resolved = context.resolver.resolveName(
            context.uri,
            context.module.symbolTree,
            "value",
            at(source, "value = 1")
        );

        assert.ok(resolved);
        /* Параметр объявлен внутри Macro, свойство — на уровне класса. */
        const method = context.module.symbolTree.children
            .find(item => item.name === "Holder")
            .children.find(item => item.name === "Set");
        assert.ok(
            method.children.some(item => item === resolved.symbol),
            "Найтись обязан параметр, а не свойство класса"
        );
    });

    /*
     * ─── Ветвление ─────────────────────────────────────────────────────────
     *
     * Последнее по тексту присваивание не значит «последнее исполненное». Пока
     * анализа потока нет, выбор один: либо не отвечать, либо обещать тип одной
     * ветки. Обещать нельзя — это члены класса, которого в другой ветке нет.
     */
    await test("расходящиеся ветки не дают типа, совпадающие дают", () => {
        const classes = [
            "Class A",
            "  Macro Alpha()",
            "  End;",
            "End;",
            "Class B",
            "  Macro Beta()",
            "  End;",
            "End;"
        ].join("\n");
        const cases = [
            ["    x = A();", "    x = B();", [], "ветки расходятся"],
            ["    x = A();", "    x = A();", ["Alpha"], "ветки совпадают"]
        ];

        for (const [thenBranch, elseBranch, expected, label] of cases) {
            const source = [
                classes,
                "Macro Test(cond)",
                "  Var x;",
                "  If (cond)",
                thenBranch,
                "  Else",
                elseBranch,
                "  End;",
                "  x.",
                "End;"
            ].join("\n");
            const context = open(source);

            assert.deepStrictEqual(
                membersAt(context, at(source, "  x.") + 4),
                expected,
                label
            );
        }
    });

    await test("безусловное присваивание перекрывает условное только совпадая", () => {
        const classes = [
            "Class A",
            "  Macro Alpha()",
            "  End;",
            "End;",
            "Class B",
            "  Macro Beta()",
            "  End;",
            "End;"
        ].join("\n");
        const build = unconditional => open([
            classes,
            "Macro Test(cond)",
            "  Var x;",
            `  x = ${unconditional}();`,
            "  If (cond)",
            "    x = A();",
            "  End;",
            "  x.",
            "End;"
        ].join("\n"));

        const same = build("A");
        assert.deepStrictEqual(
            membersAt(same, same.source.indexOf("  x.") + 4),
            ["Alpha"],
            "Оба пути дают A"
        );

        const different = build("B");
        assert.deepStrictEqual(
            membersAt(different, different.source.indexOf("  x.") + 4),
            [],
            "Путь без ветки даёт B, путь с веткой — A: тип неизвестен"
        );
    });

    await test("внутри своей ветки условное присваивание действует", () => {
        const source = [
            "Class A",
            "  Macro Alpha()",
            "  End;",
            "End;",
            "Macro Test(cond)",
            "  Var x;",
            "  If (cond)",
            "    x = A();",
            "    x.",
            "  End;",
            "End;"
        ].join("\n");
        const context = open(source);

        assert.deepStrictEqual(
            membersAt(context, at(source, "    x.") + 6),
            ["Alpha"],
            "Точка запроса в том же блоке: присваивание уже выполнилось"
        );
    });

    /*
     * ─── Присваивание через this ────────────────────────────────────────────
     */
    await test("тип поля выводится и при присваивании через this", () => {
        const declarations = [
            "Class Helper",
            "  Macro Run()",
            "  End;",
            "End;",
            "Class Doc",
            "  Var field;"
        ];
        /* Присваивание и обращение — в любом сочетании с this и без. */
        const combinations = [
            ["    this.field = Helper();", "    this.field."],
            ["    this.field = Helper();", "    field."],
            ["    field = Helper();", "    this.field."]
        ];

        for (const [assignment, access] of combinations) {
            const source = declarations.concat([
                "  Macro Fill()",
                assignment,
                access,
                "  End;",
                "End;"
            ]).join("\n");
            const context = open(source);

            assert.deepStrictEqual(
                membersAt(context, at(source, access) + access.length),
                ["Run"],
                `${assignment.trim()} / ${access.trim()}`
            );
        }
    });

    await test("присваивание чужому полю целью не считается", () => {
        const source = [
            "Class Helper",
            "  Macro Run()",
            "  End;",
            "End;",
            "Macro Test(other)",
            "  other.field = Helper();",
            "  other.field.",
            "End;"
        ].join("\n");
        const context = open(source);

        assert.deepStrictEqual(
            membersAt(context, at(source, "  other.field.") + 14),
            [],
            "Состав чужого объекта нам неизвестен, и присваивание его полю " +
                "ничего о нём не сообщает"
        );
    });

    /*
     * ─── Декларация типа против присваивания ───────────────────────────────
     *
     * Руководство: «Декларация типа переменных в RSL необязательна… Любая
     * переменная без декларации типа эквивалентна декларации с использованием
     * ключевого слова Variant. В этом случае переменная может содержать значение
     * любого типа». То есть явная декларация — приведение, и присваивание её не
     * меняет; тип из присваивания выводится ровно для Variant-переменных.
     */
    const RECORDSET_CLASS = [
        "Class Recordset",
        "  Macro MoveNext()",
        "  End;",
        "  Macro Value(index)",
        "  End;",
        "End;"
    ].join("\n");

    /** Тот же код с разной декларацией sql. */
    function sqlSource(declaration) {
        return [
            RECORDSET_CLASS,
            "Macro Test()",
            declaration,
            "  sql = \"select t_code from ddp_dep_dbt\";",
            "  sql = Recordset ();",
            "  if ( sql.MoveNext () and (sql.Value (0)) )",
            "  End;",
            "End;"
        ].filter(Boolean).join("\n");
    }

    await test("явная декларация типа присваиванием не меняется", () => {
        const source = sqlSource("  Var sql: String;");
        const context = open(source);
        const offset = at(source, "sql.MoveNext");

        assert.strictEqual(
            typeOf(context, "sql", offset),
            "string",
            "Var sql: String — это приведение к типу, а не подсказка"
        );
        assert.deepStrictEqual(
            membersAt(context, offset + 4),
            [],
            "У строки нет членов, и состав чужого типа предлагать нельзя"
        );
    });

    await test("переменная без декларации меняет тип по присваиванию", () => {
        /*
         * Var sql; Var sql: Variant; Var sql = "..."; и вовсе без Var — всё это
         * Variant. Инициализатор задаёт текущий тип значения, а не приведение:
         * следующее присваивание его меняет.
         */
        for (const declaration of [
            "  Var sql;",
            "  Var sql: Variant;",
            "  Var sql = \"aaa\";",
            ""
        ]) {
            const source = sqlSource(declaration);
            const context = open(source);
            const offset = at(source, "sql.MoveNext");

            assert.deepStrictEqual(
                membersAt(context, offset + 4).sort(),
                ["MoveNext", "Value"],
                `Декларация ${JSON.stringify(declaration)}: тип задаёт ` +
                    "присваивание"
            );
        }
    });

    await test("инициализатор задаёт текущий тип, но не приведение", () => {
        /*
         * `Var sql = "aaa"` — это Variant, приведённый к строке. Тип виден,
         * потому что значение известно, но приведением он не является.
         */
        const source = [
            "Macro Test()",
            "  Var sql = \"aaa\";",
            "  Var fixed: String;",
            "End;"
        ].join("\n");
        const context = open(source);
        const declarations = context.module.symbolTree.children[0].children;
        const initialized = declarations.find(item => item.name === "sql");
        const declared = declarations.find(item => item.name === "fixed");

        assert.strictEqual(initialized.typeName, "string");
        assert.strictEqual(
            initialized.isTypeVariant,
            true,
            "Тип из инициализатора приведением не является"
        );
        assert.strictEqual(declared.typeName, "string");
        assert.strictEqual(declared.isTypeVariant, false);
    });

    /*
     * Var sql; и Var sql: Variant; — по руководству одно и то же, и вести себя
     * обязаны неотличимо. Проверяется не только вывод типа, но и всё, что от
     * него зависит.
     */
    await test("Var sql; и Var sql: Variant; неотличимы", () => {
        const forms = ["  Var sql;", "  Var sql: Variant;", "  Var sql: variant;"];
        const results = forms.map(declaration => {
            const source = sqlSource(declaration);
            const context = open(source);
            const offset = at(source, "sql.MoveNext");
            const resolved = context.resolver.resolveName(
                context.uri,
                context.module.symbolTree,
                "sql",
                offset
            );

            return {
                isTypeVariant: resolved.symbol.isTypeVariant,
                type: typeOf(context, "sql", offset),
                members: membersAt(context, offset + 4).sort(),
                errors: []
            };
        });

        for (const result of results.slice(1)) {
            assert.deepStrictEqual(
                result,
                results[0],
                `Формы ${forms.join(" / ")} обязаны совпадать во всём`
            );
        }
        assert.strictEqual(results[0].isTypeVariant, true);
        assert.strictEqual(results[0].type, "Recordset");
    });

    await test("неизвестный вызов не выдаёт своё имя за тип", () => {
        /*
         * У неразрешённого имени вывод возвращает само имя вызываемого —
         * предположение, что это ещё не загруженный класс. Показывать такое имя
         * как тип нельзя: это не тип.
         */
        const source = [
            "Macro Test()",
            "  Var sql;",
            "  sql = СовершенноНеизвестныйВызов ();",
            "  if ( sql.MoveNext () )",
            "  End;",
            "End;"
        ].join("\n");
        const context = open(source);

        assert.strictEqual(
            typeOf(context, "sql", at(source, "sql.MoveNext")),
            "variant"
        );
    });

    await test("тип берётся из последнего присваивания перед обращением", () => {
        const source = [
            "Class First",
            "  Var Alpha;",
            "End;",
            "Class Second",
            "  Var Beta;",
            "End;",
            "Macro Test()",
            "  Var value;",
            "  value = First ();",
            "  value.Alpha;",
            "  value = Second ();",
            "  value.Beta;",
            "End;"
        ].join("\n");
        const context = open(source);

        assert.ok(
            membersAt(context, at(source, "value.Alpha") + 6)
                .includes("Alpha"),
            "До второго присваивания действует первый тип"
        );
        assert.ok(
            membersAt(context, at(source, "value.Beta") + 6).includes("Beta"),
            "После второго присваивания — второй"
        );
        assert.ok(
            !membersAt(context, at(source, "value.Beta") + 6)
                .includes("Alpha"),
            "Прежний тип не должен оставаться"
        );
    });

    /*
     * ─── Инициализатор базового класса ─────────────────────────────────────
     *
     * Руководство: «Для инициализации базового класса необходимо вызвать
     * предопределенный метод, название которого образуется путем добавления к
     * имени класса приставки Init». Объявления с таким именем в тексте нет ни у
     * одного из двух классов.
     */
    await test("InitБаза разрешается внутри производного класса", () => {
        const source = [
            "Class Персона (п_Имя, п_Фамилия)",
            "  Var Имя;",
            "End;",
            "Class ( Персона ) Сотрудник ( п_Имя, п_Фамилия, п_Должность)",
            "  Var Должность;",
            "  InitПерсона (п_Имя, п_Фамилия);",
            "  Должность = п_Должность;",
            "End;"
        ].join("\n");
        const context = open(source);
        const offset = at(source, "InitПерсона");
        const resolved = context.resolver.resolveAt(
            context.uri,
            context.module.symbolTree,
            offset + 2
        );

        assert.ok(resolved, "Инициализатор базового класса обязан разрешаться");
        assert.strictEqual(resolved.symbol.name, "InitПерсона");
        /* Параметры берутся у базового класса: он их и принимает. */
        assert.strictEqual(
            resolved.symbol.parameterText,
            "(п_Имя, п_Фамилия)"
        );
        assert.ok(resolved.symbol.documentation.includes("Персона"));

        /*
         * Символ помечен встроенным: объявления в тексте у него нет, и
         * переименование обязано отказаться. Иначе оно переименовало бы
         * базовый класс, чего никто не просил.
         */
        assert.ok(resolved.symbol.isBuiltin);
        assert.strictEqual(
            prepareRslRename(context.module, context.resolver, offset + 2),
            null
        );

        assert.ok(
            membersAt(context, offset).includes("InitПерсона"),
            "Инициализатор обязан предлагаться: подсказать его больше некому"
        );
    });

    await test("InitБаза не существует без базового класса и вне класса", () => {
        const source = [
            "Class Персона (п_Имя)",
            "End;",
            "Class Отдельный (п_Имя)",
            "  InitПерсона (п_Имя);",
            "End;",
            "Macro Снаружи()",
            "  InitПерсона (1);",
            "End;"
        ].join("\n");
        const context = open(source);

        assert.strictEqual(
            context.resolver.resolveAt(
                context.uri,
                context.module.symbolTree,
                at(source, "InitПерсона", 0) + 2
            ),
            undefined,
            "У класса без базы инициализатора базы нет"
        );
        assert.strictEqual(
            context.resolver.resolveAt(
                context.uri,
                context.module.symbolTree,
                at(source, "InitПерсона", 1) + 2
            ),
            undefined,
            "Вне класса инициализатора базы нет"
        );
        assert.ok(
            !membersAt(context, at(source, "InitПерсона", 1))
                .includes("InitПерсона")
        );
    });

    await test("InitБаза работает и для встроенного базового класса", () => {
        const source = [
            "Class ( TRecHandler ) МойОбработчик (п)",
            "  InitTRecHandler (п);",
            "End;"
        ].join("\n");
        const context = open(source);
        const resolved = context.resolver.resolveAt(
            context.uri,
            context.module.symbolTree,
            at(source, "InitTRecHandler") + 2
        );

        assert.ok(resolved, "База из стандартной библиотеки тоже инициализируется");
        assert.strictEqual(resolved.symbol.name, "InitTRecHandler");
    });

    /*
     * ─── Обычное разрешение против Auto Import ─────────────────────────────
     */
    await test("класс из неимпортированного файла не разрешается", async () => {
        const LIB = "file:///lib/helpers.mac";
        /*
         * Имя переменной намеренно отличается от имени класса: RSL не различает
         * регистр, и `Var helper = Helper()` — это одно и то же имя.
         */
        const source = [
            "Macro Test()",
            "  Var assistant = Helper();",
            "  assistant.Assist();",
            "End;"
        ].join("\n");
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([MAIN, LIB]);
        const module = index.updateOpenModule(MAIN, source, 1);
        index.updateExternalModule(
            LIB,
            "Class Helper\n  Macro Assist()\n  End;\nEnd;",
            1
        );
        const resolver = new RslScopeResolver(index);

        /*
         * Класс в проекте есть, но текущий файл его не импортирует — значит
         * компилятору он не виден. Раньше resolver обходил весь workspace, и
         * Hover, Definition, подсветка и вывод типа показывали имя как
         * известное: подсказка обещала то, чего в сборке нет.
         */
        assert.strictEqual(
            resolver.resolveAt(MAIN, module.symbolTree, at(source, "Helper()")),
            undefined,
            "Имя из неимпортированного файла не имеет права разрешаться"
        );
        assert.strictEqual(
            resolver.resolveTypeName(MAIN, module.symbolTree, "Helper"),
            undefined
        );
        assert.deepStrictEqual(
            resolver
                .getCompletions(
                    MAIN,
                    module.symbolTree,
                    at(source, "assistant.Assist") + 10
                )
                .map(item => String(item.label)),
            [],
            "Члены неразрешённого класса не имеют права предлагаться"
        );

        /* Зато Auto Import обязан его предложить — с правкой Import. */
        const offered = buildKnownAutoImportCompletions(module, index, "Hel").items;
        const candidate = offered.find(item => item.label === "Helper");
        assert.ok(candidate, "Auto Import обязан предложить класс проекта");
        assert.ok(
            candidate.additionalTextEdits?.some(edit =>
                /^Import\s+\S*helpers;/i.test(edit.newText)
            ),
            `Правка Import обязана быть в предложении: ${
                JSON.stringify(candidate.additionalTextEdits)}`
        );

        /* И Quick Fix по неразрешённому имени — тоже через глобальный поиск. */
        const actions = await buildMissingImportActions(
            module,
            index,
            resolver,
            {
                start: positionOf(source, at(source, "Helper()")),
                end: positionOf(source, at(source, "Helper()") + 6)
            },
            async () => [index.getModule(LIB)]
        );
        assert.ok(
            actions.some(action => /Import/.test(action.title)),
            `Quick Fix обязан предложить Import: ${
                actions.map(item => item.title).join(", ")}`
        );

        /* После Import то же имя обязано разрешаться обычным путём. */
        const imported = index.updateOpenModule(
            MAIN,
            `Import ${index.getImportNameForUri(LIB)};\n${source}`,
            2
        );
        assert.ok(
            resolver.resolveAt(
                MAIN,
                imported.symbolTree,
                imported.source.indexOf("Helper()")
            ),
            "После Import имя обязано разрешаться"
        );
    });

    /*
     * ─── Голое имя класса справа от «=» ─────────────────────────────────────
     *
     * `Var list = TStringList;` создаёт объект так же, как `TStringList()`, но
     * в индекс присваиваний попадали только формы со скобками. Тип оставался
     * Variant, и автодополнение по такой переменной молчало.
     *
     * Типом считается только класс. Пропустить голое имя через разрешение
     * вызова нельзя: у `callback = SomeMacro` переменная получила бы тип
     * результата процедуры, хотя присвоена сама процедура.
     */
    const CLASSES = [
        "Class TStringList",
        "  Macro Add(s)",
        "  End;",
        "End;",
        "Macro SomeMacro():TStringList",
        "End;"
    ].join("\n");

    /** Тип переменной list в позиции её использования. */
    function listTypeOf(body) {
        const source = `${CLASSES}\nMacro T()\n${body}\n  list.\nEnd;`;
        const context = open(source);
        const offset = source.indexOf("  list.") + 7;
        const resolved = context.resolver.resolveName(
            MAIN,
            context.module.symbolTree,
            "list",
            offset
        );

        return resolved
            ? context.resolver.effectiveTypeName(
                MAIN,
                context.module.symbolTree,
                resolved.symbol,
                offset
            )
            : undefined;
    }

    await test("голое имя класса справа от = задаёт тип", async () => {
        assert.strictEqual(listTypeOf("  Var list = TStringList;"),
            "TStringList", "инициализация при объявлении");
        assert.strictEqual(
            listTypeOf("  Var list;\n  list = TStringList;"),
            "TStringList",
            "отдельное присваивание"
        );
        assert.strictEqual(listTypeOf("  Var list = TStringList();"),
            "TStringList", "форма со скобками не сломана");
    });

    await test("голым классом считается только класс", async () => {
        assert.notStrictEqual(
            listTypeOf("  Var list = SomeMacro;"),
            "TStringList",
            "присвоена сама процедура, а не то, что она возвращает"
        );
        assert.notStrictEqual(
            listTypeOf("  Var other = TStringList();\n  Var list = other;"),
            "TStringList",
            "переменная справа типом не является"
        );
        assert.strictEqual(
            listTypeOf("  Var list: String = TStringList;"),
            "string",
            "написанный тип — приведение, присваивание его не меняет"
        );
    });

    if (failed > 0) {
        console.error(`\nПройдено: ${passed}\nОшибок: ${failed}`);
        process.exitCode = 1;
    } else {
        console.log(`\nПройдено: ${passed}\nОшибок: ${failed}`);
    }
}

function positionOf(source, offset) {
    const before = source.slice(0, offset).split("\n");
    return {
        line: before.length - 1,
        character: before[before.length - 1].length
    };
}

main();

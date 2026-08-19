"use strict";

/**
 * Спецпеременные: `{curdate}`, `{oper}`, `{ФИЛИАЛ}`, `{Название отчета}`.
 *
 * Сводка синтаксиса RSL определяет SPNAME как последовательность любых символов
 * в фигурных скобках, а руководство добавляет, что объявлять спецпеременную в
 * макросе не требуется — значение подставляет система. Отсюда все проверки
 * ниже: имя целиком, включая скобки; ничего не требуется объявлять; список
 * общесистемных нужен для типа и описания, а не для того, чтобы отвергать
 * остальные.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { lexRsl } = require("../server/out/lexer");
const { buildRslDiagnostics } = require("../server/out/diagnostics");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { getDefaults } = require("../server/out/defaults");
const {
    completionPrefixAt,
    rankCompletionItemsForPrefix
} = require("../server/out/features/completionRanking");
const {
    isRslSpecialVariableReference,
    isRslSystemSpecialVariableName,
    RSL_SYSTEM_SPECIAL_VARIABLES
} = require("../server/out/systemSpecialVariables");
const {
    PlatformModuleCatalog
} = require("../server/out/builtins/platformModuleCatalog");

let passed = 0;
let failed = 0;

async function test(name, action) {
    try {
        await action();
        passed++;
        console.log("[OK] " + name);
    } catch (error) {
        failed++;
        console.error("[FAIL] " + name);
        console.error(error);
    }
}

const MAIN = "file:///main.mac";

function diagnose(source, settings) {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([MAIN]);

    return buildRslDiagnostics(
        index.updateOpenModule(MAIN, source, 1),
        index,
        settings
    );
}

async function main() {
    await test("имя в скобках — один токен, что бы внутри ни стояло", () => {
        const source = "x = {curdate} + {ФИЛИАЛ} + {Название отчета} + {34-23-O};";
        const braces = lexRsl(source).tokens
            .filter(token => token.kind === "identifier" &&
                token.raw.startsWith("{"))
            .map(token => token.raw);

        assert.deepStrictEqual(braces, [
            "{curdate}", "{ФИЛИАЛ}", "{Название отчета}", "{34-23-O}"
        ]);
    });

    await test("спецпеременную не требуется объявлять", () => {
        const source = [
            "Macro Test()",
            "  Var known;",
            "  known = undeclaredName;",
            "  known = {curdate};",
            "  known = {GROUP_MODE};",
            "  known = {ФИЛИАЛ};",
            "  known = {Название отчета};",
            "End;"
        ].join("\n");
        const unknown = diagnose(source, { unknownVariables: "safe" })
            .filter(item => item.code === "unknown-variable")
            .map(item => String(item.data.name));

        /*
         * Прежде исключение делалось только для двадцати восьми
         * общесистемных, и {GROUP_MODE} из SbCrdInter вместе с заведённой
         * банком {ФИЛИАЛ} объявлялись необъявленными.
         */
        assert.deepStrictEqual(unknown, ["undeclaredName"]);
    });

    await test("ссылка на спецпеременную отличается от обычного имени", () => {
        assert.ok(isRslSpecialVariableReference("{oper}"));
        assert.ok(isRslSpecialVariableReference("{Название отчета}"));
        assert.ok(!isRslSpecialVariableReference("oper"));
        assert.ok(!isRslSpecialVariableReference("{}"));
        /* Общесистемные знает по списку — для типа и описания. */
        assert.ok(isRslSystemSpecialVariableName("{oper}"));
        assert.ok(!isRslSystemSpecialVariableName("{ФИЛИАЛ}"));
    });

    await test("типы общесистемных названы как в RSL", () => {
        const types = new Set(
            RSL_SYSTEM_SPECIAL_VARIABLES.map(variable => variable.type)
        );

        /*
         * Variant — у тех, что объявлены в globals.mac поставки: там указаны
         * только имена, тип придумывать нечем.
         */
        assert.deepStrictEqual(
            [...types].sort(),
            ["Bool", "Date", "Integer", "String", "Variant"]
        );

        const byName = new Map(
            RSL_SYSTEM_SPECIAL_VARIABLES.map(item => [item.name, item.type])
        );
        /* Типы взяты из справки: там оговорены ровно эти исключения. */
        assert.strictEqual(byName.get("curdate"), "Date");
        assert.strictEqual(byName.get("oper"), "Integer");
        assert.strictEqual(byName.get("BPromUse"), "Bool");
        assert.strictEqual(byName.get("Name_Bank"), "String");

        const item = getDefaults().completionItems.find(
            candidate => String(candidate.label) === "{curdate}"
        );
        assert.strictEqual(item.detail, "{curdate}: Date");
    });

    await test("набранное {cur предлагает {curdate} первым", () => {
        const source = "Macro Test()\n  Var x = {cur";
        const prefix = completionPrefixAt(source, source.length);
        assert.strictEqual(prefix, "{cur");

        const ranked = rankCompletionItemsForPrefix(
            getDefaults().completionItems,
            prefix
        ).sort((first, second) =>
            String(first.sortText).localeCompare(String(second.sortText))
        );

        assert.strictEqual(String(ranked[0].label), "{curdate}");
    });

    await test("спецпеременные модуля приходят из каталога", async () => {
        const catalog = new PlatformModuleCatalog({ log: () => undefined });
        await catalog.ensureModules(["SbCrdInter", "ExchangeInter"]);
        const items = catalog.completionItems(["SbCrdInter", "ExchangeInter"]);
        const detail = name => {
            const found = items.find(item => String(item.label) === name);
            return found ? String(found.detail) : "нет";
        };

        assert.match(detail("{GROUP_MODE}"), /Bool/);
        assert.match(detail("{ФИЛИАЛ}"), /Integer/);
        assert.match(detail("{NationalCur}"), /ExchangeInter/);

        const found = catalog.findSymbol(["SbCrdInter"], "{ФИЛИАЛ}");
        assert.ok(found, "спецпеременная модуля не разрешается по имени");
        assert.match(
            String(found.symbol.documentation || ""),
            /код структурного подразделения/i
        );
    });

    await test("присваивание без объявления замечается по умолчанию", () => {
        const source = [
            "Macro Test()",
            "  Var x, {Объявленная};",
            "  {Объявленная} = 1;",
            "  {txtfile} = GetIniString(\"TEXTDIR\");",
            "  x = {curdate};",
            "End;"
        ].join("\n");
        const found = diagnose(source, {})
            .filter(item => item.code === "unknown-special-variable");

        /*
         * Имя, которому присваивают, — обычная переменная, и её объявляют
         * через VAR. Объявленная рядом и общесистемная {curdate} к проверке
         * отношения не имеют.
         */
        assert.deepStrictEqual(
            found.map(item => String(item.data.name)),
            ["{txtfile}"]
        );
        assert.match(found[0].message, /объявления нет/u);
    });

    await test("описка в имени замечается и называет похожее", () => {
        /*
         * Ради этого правило и включено: компилятор `{currdate}` не заметит —
         * имя в скобках законно любое, и значение просто окажется пустым.
         */
        const source = [
            "Macro Test()",
            "  Var x;",
            "  x = {currdate};",
            "  x = {curdate};",
            "End;"
        ].join("\n");
        const found = diagnose(source, {})
            .filter(item => item.code === "unknown-special-variable");

        assert.deepStrictEqual(
            found.map(item => String(item.data.name)),
            ["{currdate}"]
        );
        assert.match(found[0].message, /имелась в виду \{curdate\}/u);
        assert.strictEqual(found[0].severity, 2);
    });

    await test("известное имя и режим off замечаний не дают", () => {
        const source = [
            "Macro Test()",
            "  Var x;",
            "  x = {Name_Oper};",
            "  x = {ДругоеИмяБанка};",
            "End;"
        ].join("\n");

        /* {Name_Oper} объявлена в globals.mac — она известна. */
        assert.deepStrictEqual(
            diagnose(source, {})
                .filter(item => item.code === "unknown-special-variable")
                .map(item => String(item.data.name)),
            ["{ДругоеИмяБанка}"]
        );
        assert.deepStrictEqual(
            diagnose(source, { unknownSpecialVariables: "off" })
                .filter(item => item.code === "unknown-special-variable"),
            []
        );
        /* Режим assigned проверяет только имена с присваиванием. */
        assert.deepStrictEqual(
            diagnose(source, { unknownSpecialVariables: "assigned" })
                .filter(item => item.code === "unknown-special-variable"),
            []
        );
    });

    await test("режим all ловит и читаемое незнакомое имя", () => {
        const source = [
            "Macro Test()",
            "  Var x, {МойПараметр};",
            "  x = {curdate};",
            "  x = {Name_Oper};",
            "  x = {МойПараметр};",
            "  x = {CNum};",
            "  x = {ResidentCountryCodeNuum};",
            "End;"
        ].join("\n");
        const found = diagnose(source, { unknownSpecialVariables: "all" })
            .filter(item => item.code === "unknown-special-variable")
            .map(item => String(item.data.name));

        /*
         * {curdate} описана в справке, {Name_Oper} объявлена в globals.mac,
         * {МойПараметр} объявлена рядом, {CNum} встречается в примерах
         * справки. Остаётся описка в имени.
         */
        assert.deepStrictEqual(found, ["{ResidentCountryCodeNuum}"]);
    });

    await test("список известных имён снимает замечание", () => {
        const file = path.join(
            fs.mkdtempSync(path.join(os.tmpdir(), "rsl-known-")),
            "known.txt"
        );
        fs.writeFileSync(file, "# имена банка\n{txtfile}\n", "utf8");
        const source = [
            "Macro Test()",
            "  Var x;",
            "  x = {txtfile};",
            "End;"
        ].join("\n");
        const settings = {
            unknownSpecialVariables: "all",
            unknownVariablesKnownGlobalsFile: file
        };

        assert.deepStrictEqual(
            diagnose(source, settings)
                .filter(item => item.code === "unknown-special-variable"),
            []
        );
        assert.strictEqual(
            diagnose(source, { unknownSpecialVariables: "all" })
                .filter(item => item.code === "unknown-special-variable")
                .length,
            1
        );
    });

    await test("мусор из двоичной вставки именем не считается", () => {
        /*
         * В репозитории есть `.mac` со встроенным содержимым XLSX: открывающая
         * скобка там попадается случайно, и «именем» оказывается страница
         * мусора. Предел — 80 символов из сводки синтаксиса.
         */
        const junk = "{" + "ЮЇнйR".repeat(3) + "}";
        const long = "{" + "И".repeat(100) + "}";
        const source = [
            "Macro Test()",
            "  Var x;",
            "  x = " + junk + ";",
            "  x = " + long + ";",
            "End;"
        ].join("\n");

        assert.deepStrictEqual(
            diagnose(source, { unknownSpecialVariables: "all" })
                .filter(item => item.code === "unknown-special-variable"),
            []
        );
    });

    console.log("\nПройдено: " + passed + ", провалено: " + failed);

    if (failed > 0) {
        process.exitCode = 1;
    }
}

main();

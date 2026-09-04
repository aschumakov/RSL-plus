"use strict";

/**
 * «Такого члена нет» — только там, где это доказуемо.
 *
 * Проверка знала лишь классы, прочитанные из файла проекта: у них есть
 * moduleUri. Встроенные и прикладные классы она пропускала целиком, и описка
 * `rs.MoooveNext()` на RsdRecordset оставалась незамеченной. Теперь состав
 * спрашивается у того же слоя, что отвечает подсказке, переходу и Hover, — и
 * вместе с составом приходит его полнота.
 *
 * Полнота и решает. Доказательством отсутствия считается только `complete`:
 * вся цепочка наследования разрешена, и у каждого уровня состав известен
 * целиком. У класса файла и встроенного он таков по построению, у прикладного
 * — лишь там, где полнота заявлена в каталоге: справка описывает часть
 * модулей прозой, и отсутствие члена там ничего не значит.
 */

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

const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { getDefaults } = require("../server/out/defaults");
const {
    PlatformModuleCatalog
} = require("../server/out/builtins/platformModuleCatalog");
const {
    collectUnknownVariables
} = require("../server/out/diagnostics/unknownVariableDiagnostics");
const {
    getRslMemberSet,
    isProvenRslMemberSet
} = require("../server/out/analysis/memberSet");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const URI = "file:///d:/member/main.mac";

/** Каталог читается один раз на весь файл проверок. */
let catalog;

async function platform() {
    if (!catalog) {
        catalog = new PlatformModuleCatalog({ log: () => undefined });
        await catalog.ensureModules(["rsd", "BankInter"]);
    }

    return catalog;
}

/** Имена членов, о которых проверка сказала «такого нет». */
async function missingMembers(body) {
    const known = await platform();
    const source = body.join("\n") + "\n";
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([URI]);

    const module = index.updateOpenModule(URI, source, 1);
    const resolver = new RslScopeResolver(index, getDefaults(), known);

    return collectUnknownVariables(module, resolver, {
        mode: "safe",
        checkMembers: true
    })
        .filter(item => item.kind === "member")
        .map(item => item.name);
}

test("описка в члене класса прикладного модуля находится", async () => {
    /*
     * Ровно тот случай, ради которого проверка и доводилась: состав rsd
     * заявлен полным, поэтому отсутствие члена доказуемо.
     */
    assert.deepStrictEqual(
        await missingMembers([
            "Import rsd;",
            "Macro T()",
            "  Var rs: RsdRecordset;",
            "  rs.MoooveNext();",
            "End;"
        ]),
        ["MoooveNext"]
    );
});

test("настоящий член того же класса молчит", async () => {
    assert.deepStrictEqual(
        await missingMembers([
            "Import rsd;",
            "Macro T()",
            "  Var rs: RsdRecordset;",
            "  rs.MoveNext();",
            "End;"
        ]),
        []
    );
});

test("описка в члене встроенного класса находится", async () => {
    assert.deepStrictEqual(
        await missingMembers([
            "Macro T()",
            "  Var s: TStream;",
            "  s.НетТакогоЧлена();",
            "End;"
        ]),
        ["НетТакогоЧлена"]
    );
    assert.deepStrictEqual(
        await missingMembers([
            "Macro T()",
            "  Var s: TStream;",
            "  s.Flush();",
            "End;"
        ]),
        []
    );
});

test("Variant молчит всегда", async () => {
    /*
     * Тип неизвестен, а не «известен и пуст»: состав такого объекта
     * определяется во время исполнения.
     */
    assert.deepStrictEqual(
        await missingMembers([
            "Macro T()",
            "  Var v;",
            "  v.ЧтоУгодно();",
            "End;"
        ]),
        []
    );
});

test("класс без заявленной полноты состава молчит", async () => {
    /*
     * BankInter собран со страниц справки, и полнота его состава не
     * заявлена. Отсутствие члена там ничего не доказывает.
     */
    assert.deepStrictEqual(
        await missingMembers([
            "Import BankInter;",
            "Macro T()",
            "  Var p: RsbBBPayment;",
            "  p.НетТакогоЧлена();",
            "End;"
        ]),
        []
    );
});

test("неизвестная база выключает проверку", async () => {
    /*
     * У класса есть база, о которой сказать нечего: часть состава сервер
     * просто не видел. Молчать здесь обязательно.
     */
    assert.deepStrictEqual(
        await missingMembers([
            "Class (НетТакойБазы) TChild",
            "  Macro Own()",
            "  End;",
            "End;",
            "Macro T()",
            "  Var c: TChild;",
            "  c.НетТакогоЧлена();",
            "End;"
        ]),
        []
    );
});

test("унаследованный член не считается отсутствующим", async () => {
    assert.deepStrictEqual(
        await missingMembers([
            "Class TBase",
            "  Macro FromBase()",
            "  End;",
            "End;",
            "Class (TBase) TChild",
            "  Macro Own()",
            "  End;",
            "End;",
            "Macro T()",
            "  Var c: TChild;",
            "  c.FromBase();",
            "End;"
        ]),
        []
    );
});

test("описка при известной базе находится", async () => {
    assert.deepStrictEqual(
        await missingMembers([
            "Class TBase",
            "  Macro FromBase()",
            "  End;",
            "End;",
            "Class (TBase) TChild",
            "  Macro Own()",
            "  End;",
            "End;",
            "Macro T()",
            "  Var c: TChild;",
            "  c.НетТакогоЧлена();",
            "End;"
        ]),
        ["НетТакогоЧлена"]
    );
});

test("состав и его полнота — один ответ на всех", async () => {
    /*
     * Главный инвариант выпуска: подсказка и проверка не имеют права видеть
     * разное. Если состав доказуем, то член, которого проверка не нашла, не
     * должен предлагаться подсказкой — и наоборот.
     */
    const known = await platform();
    const source = [
        "Import rsd;",
        "Macro T()",
        "  Var rs: RsdRecordset;",
        "  rs.MoveNext();",
        "End;",
        ""
    ].join("\n");
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([URI]);

    const module = index.updateOpenModule(URI, source, 1);
    const resolver = new RslScopeResolver(index, getDefaults(), known);
    const options = {
        resolver,
        uri: URI,
        imports: module.imports,
        offset: source.indexOf("rs.MoveNext"),
        platformMembersComplete: key => known.membersComplete(key)
    };
    const set = getRslMemberSet("RsdRecordset", options);

    assert.ok(
        isProvenRslMemberSet(set),
        "состав RsdRecordset обязан быть доказуемым: " + set.completeness +
            " " + (set.reason || "")
    );
    assert.strictEqual(set.source, "platform");

    /* И подсказка видит ровно этот же состав. */
    const members = resolver.getCompletions(
        URI,
        module.symbolTree,
        source.indexOf("rs.MoveNext") + 3
    ).map(item => String(item.label).toLowerCase());

    assert.ok(
        members.includes("movenext"),
        "подсказка обязана предлагать тот член, который проверка признаёт: " +
            members.slice(0, 8).join(", ")
    );
});

(async () => {
    for (const item of tests) {
        try {
            await item.action();
            passed++;
            console.log("[OK] " + item.name);
        } catch (error) {
            failed++;
            console.error("[FAIL] " + item.name);
            console.error(error);
        }
    }

    console.log(
        failed === 0
            ? "\nПройдено: " + passed
            : "\nПройдено: " + passed + ", провалено: " + failed
    );

    if (failed > 0) {
        process.exitCode = 1;
    }
})();

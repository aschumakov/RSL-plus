"use strict";

/**
 * Имя из прикладного модуля доступно через Import — и модуль назван правильно.
 *
 * Две вещи, найденные на настоящем проекте.
 *
 * Первая: каталог знал модули под именами, которых никто не пишет. Ключом
 * кириллического модуля стало имя его корневой страницы справки — `calendar`
 * вместо `Календарь`, — и панель «RSL: зависимости» называла такой модуль «не
 * найден». Тем же вопросом решается, искать ли под этим именем файл проекта.
 *
 * Вторая: состав модулей rsexts, rsd и CFormInter лежал не там. Процедуры
 * управления файлами и классы RSD числились безымянной частью языка, хотя
 * справка называет их модуль прямо: «Модуль rsexts содержит процедуры …».
 * Теперь они в составе своих модулей, и это меняет поведение: без Import имя
 * не разрешается, а проверка называет модуль, которого не хватает.
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

const {
    PlatformModuleCatalog
} = require("../server/out/builtins/platformModuleCatalog");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { getDefaults } = require("../server/out/defaults");
const {
    buildRslHoverContent
} = require("../server/out/features/hoverFormatter");
const {
    buildRslPlatformModuleDiagnostics
} = require("../server/out/diagnostics/platformModuleDiagnostics");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const MOVED = ["rsexts", "rsd", "CFormInter"];

/** Каталог читается один раз на весь файл проверок. */
let catalog;

async function platform() {
    if (!catalog) {
        catalog = new PlatformModuleCatalog({ log: () => undefined });
        await catalog.ensureModules(MOVED);
    }

    return catalog;
}

const URI = "file:///d:/names/files.mac";

/**
 * Как разрешается имя и кто назван его владельцем.
 *
 * `imports` — директивы файла: без них имя прикладного модуля не должно
 * разрешаться, с ними должно.
 */
async function ask(name, imports = []) {
    const known = await platform();
    const source = imports.map(item => "Import " + item + ";\n").join("") +
        [
            "Macro Run()",
            "  Var value = " + name + ";",
            "  return value;",
            "End;",
            ""
        ].join("\n");
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([URI]);

    const module = index.updateOpenModule(URI, source, 1);
    const resolver = new RslScopeResolver(index, getDefaults(), known);
    const resolved = resolver.resolveAt(
        URI,
        module.symbolTree,
        source.indexOf(name + ";")
    );
    const found = buildRslPlatformModuleDiagnostics(module, resolver, {
        platformModules: known,
        visibleModules: imports,
        limit: 10
    });

    return {
        resolved: Boolean(resolved),
        owner: resolved && resolved.platformModuleName
            ? resolved.platformModuleName
            : "",
        hover: resolved
            ? buildRslHoverContent(
                index,
                resolved.uri,
                resolved.symbol,
                undefined,
                resolved.platformModuleName
            ).value
            : "",
        messages: found.map(item => item.message)
    };
}

test("модуль платформы открывает то, что подключает сам", async () => {
    /*
     * `total` из поставки пишет у себя `Import … rsd …`, и файл,
     * подключивший total, видит имена rsd — так же, как если бы подключил
     * файл проекта с тем же Import. Без этого отношения обход
     * останавливался на самом total: у модуля платформы преимущество
     * перед файлом, и внутрь него он не заходит.
     *
     * От dependencies это отличается тем, что имена ОТКРЫВАЮТСЯ:
     * dependencies дочитывают состав ради унаследованных членов и
     * назвать `RsbPayment` без `Import PaymInter` по-прежнему нельзя.
     */
    const known = await platform();

    assert.deepStrictEqual(
        known.importsOfModule("total"),
        ["rsd"],
        "total обязан числиться подключающим rsd"
    );

    const uri = "file:///d:/names/uses-total.mac";
    const source = [
        "Import total;",
        "Macro Run()",
        "  Var cmd = RsdCommand(\"select 1\");",
        "  return cmd;",
        "End;",
        ""
    ].join("\n");
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([uri]);

    const module = index.updateOpenModule(uri, source, 1);
    const resolver = new RslScopeResolver(index, getDefaults(), known);
    const visible = resolver.visiblePlatformModules(uri);

    assert.ok(
        visible.some(name => /^rsd$/iu.test(name)),
        "rsd обязан быть виден через total, а видно: " + visible.join(", ")
    );

    /* И имя из rsd после этого разрешается, а проверка молчит. */
    const resolved = resolver.resolveAt(
        uri,
        module.symbolTree,
        source.indexOf("RsdCommand")
    );

    assert.ok(resolved, "RsdCommand обязан разрешиться при Import total");

    const found = buildRslPlatformModuleDiagnostics(module, resolver, {
        platformModules: known,
        visibleModules: visible,
        limit: 5
    });

    assert.deepStrictEqual(
        found.map(item => item.message),
        [],
        "при видимом модуле сказать нечего"
    );
});

test("dependencies имён по-прежнему не открывают", async () => {
    /*
     * Обратная сторона: BankInter дочитывает PaymInter ради
     * унаследованных членов, но назвать `RsbPayment` без
     * `Import PaymInter` нельзя. Новое отношение это правило не трогает.
     */
    const known = await platform();

    await known.ensureModules(["BankInter"]);

    const uri = "file:///d:/names/uses-bank.mac";
    const source = [
        "Import BankInter;",
        "Macro Run()",
        "  Var p = RsbPayment;",
        "  return p;",
        "End;",
        ""
    ].join("\n");
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([uri]);

    const module = index.updateOpenModule(uri, source, 1);
    const resolver = new RslScopeResolver(index, getDefaults(), known);
    const visible = resolver.visiblePlatformModules(uri);

    assert.ok(
        !visible.some(name => /^payminter$/iu.test(name)),
        "PaymInter не открывается через BankInter: " + visible.join(", ")
    );

    void module;
});

test("кириллические модули известны под своим именем", async () => {
    const known = await platform();

    for (const name of [
        "Календарь",
        "Проценты",
        "ПроцентыБухгалтер",
        "Шлюз"
    ]) {
        assert.ok(
            known.knowsModule(name),
            "каталог обязан знать модуль «" + name + "»"
        );
    }

    /*
     * И под прежним ключом — уже нет: `Import calendar` не встречается ни в
     * одном файле проекта, а знать имя, которого не пишут, значит принимать
     * за платформенный модуль что-то другое.
     */
    assert.ok(
        !known.knowsModule("calendar"),
        "имя корневой страницы ключом больше не является"
    );
});

test("состав перенесённых модулей на месте", async () => {
    const known = await platform();

    for (const name of MOVED) {
        assert.ok(
            known.knowsModule(name),
            "каталог обязан знать модуль «" + name + "»"
        );
    }

    /* Файл проекта прикладным модулем при этом не становится. */
    assert.ok(
        !known.knowsModule("oratools"),
        "модуль проекта каталогу платформы неизвестен"
    );

    /* Справка: «Модуль rsexts содержит … и класс TDirList». */
    for (const [name, module] of [
        ["CopyFile", "rsexts"],
        ["GetCurDir", "rsexts"],
        ["TDirList", "rsexts"],
        ["RsdCommand", "rsd"],
        ["RsdRecordset", "rsd"],
        ["getCaption", "CFormInter"],
        ["setFieldValue", "CFormInter"]
    ]) {
        assert.deepStrictEqual(
            known.modulesDeclaring(name),
            [module],
            name + " обязан числиться за " + module
        );
    }
});

test("имя перенесённого модуля доступно по Import", async () => {
    for (const [name, module] of [
        ["CopyFile", "rsexts"],
        ["RenameFile", "rsexts"],
        ["GetCurDir", "rsexts"],
        ["CallRemoteRsl", "rsexts"],
        ["TDirList", "rsexts"],
        ["RsdConnection", "rsd"],
        ["RsdRecordset", "rsd"],
        ["getCaption", "CFormInter"],
        ["setStatus", "CFormInter"]
    ]) {
        const answer = await ask(name, [module]);

        assert.ok(
            answer.resolved,
            name + " обязан разрешаться при Import " + module
        );
        assert.strictEqual(
            answer.owner,
            module,
            name + ": владельцем обязан быть " + module + ", а назван «" +
                answer.owner + "»"
        );
        assert.ok(
            answer.hover.includes("**Модуль:** " + module),
            name + ": Hover обязан называть модуль, а показал:\n" +
                answer.hover
        );
        assert.deepStrictEqual(
            answer.messages,
            [],
            name + ": при подключённом модуле сказать нечего"
        );
    }
});

test("без Import проверка называет недостающий модуль", async () => {
    /*
     * Это и есть цена переноса, и она названа прямо: пока имена лежали в
     * стандартной библиотеке, они разрешались всегда. Справка говорит иначе,
     * и теперь про нехватку Import сказано вслух — с готовым исправлением.
     */
    for (const [name, module] of [
        ["CopyFile", "rsexts"],
        ["TDirList", "rsexts"],
        ["RsdCommand", "rsd"],
        ["setCaption", "CFormInter"]
    ]) {
        const answer = await ask(name);

        assert.ok(
            !answer.resolved,
            name + " без Import " + module + " разрешаться не должен"
        );
        assert.strictEqual(
            answer.messages.length,
            1,
            name + ": ожидалось одно сообщение, получено " +
                JSON.stringify(answer.messages)
        );
        assert.ok(
            answer.messages[0].includes(module),
            name + ": сообщение обязано назвать модуль, а сказано «" +
                answer.messages[0] + "»"
        );
    }
});

test("соседние процедуры раздела остались частью языка", async () => {
    /*
     * Справка перечисляет состав rsexts поимённо, и эти в список не входят:
     * они доступны без Import, и переносить их значило бы требовать Import
     * там, где справка его не требует.
     */
    for (const name of [
        "SplitFile",
        "MergeFile",
        "FindPath",
        "GetSysDir",
        "GetIniFileValue",
        "GetFileInfo"
    ]) {
        const answer = await ask(name);

        assert.ok(
            answer.resolved,
            name + " обязан разрешаться без всякого Import"
        );
        assert.strictEqual(
            answer.owner,
            "",
            name + ": владельца справка не называет, а назван «" +
                answer.owner + "»"
        );
    }
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

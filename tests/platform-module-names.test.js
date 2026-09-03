"use strict";

/**
 * Модуль платформы известен под тем именем, которое пишут в Import.
 *
 * Каталог знал `calendar` — имя корневой страницы справки, — а в коде написано
 * `Import Календарь`. Панель «RSL: зависимости» называет такой модуль «не
 * найден», и это не косметика: тем же вопросом решается, искать ли под этим
 * именем файл проекта. На настоящем проекте под удар попали четыре модуля с
 * кириллическими названиями плюс rsexts, rsd и CFormInter, которых в каталоге
 * не было вовсе: 821, 302 и 75 файлов соответственно.
 *
 * Здесь же проверяется вторая половина: у части стандартных имён есть
 * модуль-владелец, и справка называет его прямо. Владелец, а не условие —
 * имя разрешается и без Import, — поэтому проверяется и то, что владелец
 * показан, и то, что доступность от этого не изменилась.
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

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

/** Каталог читается один раз на весь файл проверок. */
let catalog;

async function platform() {
    if (!catalog) {
        catalog = new PlatformModuleCatalog({ log: () => undefined });
        await catalog.ensureIndexLoaded();
    }

    return catalog;
}

const URI = "file:///d:/names/files.mac";

/** Как разрешается имя и кто назван его владельцем. */
function ownerOf(name) {
    const source = [
        "Macro Run()",
        "  Var value = " + name + ";",
        "  return value;",
        "End;",
        ""
    ].join("\n");
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([URI]);

    const module = index.updateOpenModule(URI, source, 1);
    const resolver = new RslScopeResolver(index, getDefaults());
    const resolved = resolver.resolveAt(
        URI,
        module.symbolTree,
        source.indexOf(name)
    );

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
            : ""
    };
}

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

test("встроенные модули без разобранного состава всё равно известны",
    async () => {
    /*
     * У rsexts, rsd и CFormInter состав в каталоге пустой, и причина у каждого
     * записана в самой записи (emptyBecause). Пустой состав ничего не решает:
     * вопрос «это модуль платформы?» отвечается по списку модулей.
     */
    const known = await platform();

    for (const name of ["rsexts", "rsd", "CFormInter"]) {
        assert.ok(
            known.knowsModule(name),
            "каталог обязан знать модуль «" + name + "»"
        );
    }

    /* Файл проекта платформенным модулем при этом не становится. */
    assert.ok(
        !known.knowsModule("oratools"),
        "модуль проекта каталогу платформы неизвестен"
    );
});

test("владелец назван у тех имён, о которых так говорит справка", () => {
    /*
     * «Чтобы эта процедура была доступна в макропрограмме пользователя,
     * следует явно импортировать модуль rsexts» — так сказано о шести
     * процедурах раздела «Управление файлами и каталогами», о CallRemoteRsl
     * и о классе TDirList.
     */
    for (const name of [
        "RenameFile",
        "RemoveFile",
        "ExistDir",
        "MakeDir",
        "RemoveDir",
        "GetCurDir",
        "CallRemoteRsl",
        "TDirList"
    ]) {
        const answer = ownerOf(name);

        assert.strictEqual(
            answer.owner,
            "rsexts",
            name + ": владельцем обязан быть rsexts, а назван «" +
                answer.owner + "»"
        );
        assert.ok(
            answer.hover.includes("**Модуль:** rsexts"),
            name + ": Hover обязан называть модуль, а показал:\n" +
                answer.hover
        );
    }
});

test("соседним процедурам того же раздела владелец не приписан", () => {
    /*
     * Справка называет rsexts у большей части раздела, но не у всей: про
     * CopyFile, SplitFile, MergeFile, FindPath, GetSysDir, GetIniFileValue и
     * GetFileInfo не сказано ничего. Приписать модуль и им значило бы выдать
     * догадку за то, что написано.
     */
    for (const name of [
        "CopyFile",
        "SplitFile",
        "MergeFile",
        "FindPath",
        "GetSysDir",
        "GetIniFileValue",
        "GetFileInfo"
    ]) {
        const answer = ownerOf(name);

        assert.strictEqual(
            answer.owner,
            "",
            name + ": владельца справка не называет, а назван «" +
                answer.owner + "»"
        );
    }
});

test("владелец не ограничивает доступность имени", () => {
    /*
     * Существенное: модуль показан как владелец, а не как условие. На
     * настоящем проекте rsexts подключают 821 файл, но из пользующихся
     * GetCurDir — 324 из 505; объявить остальные 181 ошибкой измерения не
     * позволяют.
     */
    for (const name of ["RenameFile", "GetCurDir", "TDirList"]) {
        assert.ok(
            ownerOf(name).resolved,
            name + " обязан разрешаться и без Import rsexts"
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

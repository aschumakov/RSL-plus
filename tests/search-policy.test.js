"use strict";

/**
 * Одно правило поиска на обход состава и на адресный resolver.
 *
 * Это были два разных пути к одному ответу, и они расходились: обход учитывал
 * `exclude` из настройки, а адресный поиск шёл по диску своим ходом и находил
 * файл, который настройка исключила. Получалось, что один и тот же Import
 * разрешался по-разному до и после того, как каталог достроится, — и это
 * недопустимо: ответ не должен зависеть от того, что успела прочитать фоновая
 * индексация.
 *
 * Отдельно проверяется семантика moduleRoots: это ЗАМЕНА корней, а не
 * добавление к ним. Иначе `moduleRoots: ["macro"]` заставлял бы обходить и
 * весь проект, и macro внутри него — то есть удваивал бы работу вместо того,
 * чтобы ограничить поиск.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

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
    collapseRoots,
    createRslSearchPolicy
} = require("../server/out/config/searchPolicy");
const {
    WorkspaceModuleResolver
} = require("../server/out/indexing/workspaceModuleResolver");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

function config(values = {}) {
    return {
        moduleRoots: [],
        exclude: [],
        stubPaths: [],
        dialect: "",
        ...values
    };
}

/** Каталог на диске: возвращает корень и убирает его за собой. */
function workspace(files) {
    const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "rsl-policy-"))
    );

    for (const [relative, text] of Object.entries(files)) {
        const full = path.join(root, relative);

        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, text);
    }

    return {
        root,
        dispose: () => fs.rmSync(root, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 25
        })
    };
}

test("без настройки корни прежние", () => {
    const policy = createRslSearchPolicy(["D:/project"], config());

    assert.deepStrictEqual(
        policy.searchRoots.map(item => path.basename(item)),
        ["project"]
    );
});

test("moduleRoots заменяют корень, а не добавляются к нему", () => {
    const policy = createRslSearchPolicy(
        ["D:/project"],
        config({ moduleRoots: ["macro"] })
    );

    assert.deepStrictEqual(
        policy.searchRoots.map(item => path.basename(item)),
        ["macro"],
        "иначе обходились бы и весь проект, и macro внутри него"
    );
});

test("stubPaths добавляют отдельный корень", () => {
    const policy = createRslSearchPolicy(
        ["D:/project"],
        config({ moduleRoots: ["macro"], stubPaths: ["stubs"] })
    );

    assert.deepStrictEqual(
        policy.searchRoots.map(item => path.basename(item)).sort(),
        ["macro", "stubs"]
    );
});

test("повторяющиеся корни схлопываются", () => {
    assert.deepStrictEqual(
        collapseRoots(["D:/a", "D:/a", "D:/a/"]).length,
        1
    );
});

test("вложенные корни схлопываются", () => {
    /* Вложенный корень означал бы второй обход тех же файлов. */
    assert.deepStrictEqual(
        collapseRoots(["D:/a/b", "D:/a"]).map(item => path.basename(item)),
        ["a"]
    );
});

test("разделитель пути значения не имеет", () => {
    const policy = createRslSearchPolicy(
        ["D:\\project"],
        config({ exclude: ["legacy/**"] })
    );

    assert.ok(policy.isExcluded("D:\\project\\legacy\\good.mac"));
    assert.ok(policy.isExcluded("D:/project/legacy/good.mac"));
});

test("шаблоны *, ? и ** работают в политике", () => {
    const policy = createRslSearchPolicy(
        ["D:/project"],
        config({ exclude: ["archive/**", "*.bak.mac", "tmp?.mac"] })
    );

    assert.ok(policy.isExcluded("D:/project/archive/2020/a.mac"));
    assert.ok(policy.isExcluded("D:/project/lib.bak.mac"));
    assert.ok(policy.isExcluded("D:/project/tmp1.mac"));
    assert.ok(!policy.isExcluded("D:/project/macro/lib.mac"));
});

test("корень внутри каталога с системным именем не прячется", () => {
    /*
     * Проект вполне может лежать в каталоге с именем build или dist. Смотреть
     * сегменты выше корня значило бы спрятать его целиком.
     */
    const policy = createRslSearchPolicy(["D:/build/project"], config());

    assert.ok(!policy.isExcluded("D:/build/project/macro/lib.mac"));
    assert.ok(!policy.isExcluded("D:/build/project/lib.mac"));
    assert.ok(
        policy.isExcluded("D:/build/project/dist/lib.mac"),
        "а ниже корня системное правило по-прежнему действует"
    );
});

test("исключается и сам служебный каталог", () => {
    const policy = createRslSearchPolicy(["D:/project"], config());

    assert.ok(
        policy.isExcluded("D:/project/node_modules"),
        "обход не должен в него заходить"
    );
});

test("системное исключение действует на любом уровне", () => {
    const policy = createRslSearchPolicy(["D:/project"], config());

    assert.ok(
        policy.isExcluded("D:/project/sub/node_modules/lib.mac"),
        "служебные каталоги не обходятся независимо от настройки"
    );
});

/** Адресный поиск с той же политикой, что у обхода. */
function resolverFor(root, policy) {
    const index = new WorkspaceIndex();

    return {
        index,
        resolver: new WorkspaceModuleResolver({
            catalog: {
                resolveWorkspaceFile: name => index.resolveWorkspaceFile(name),
                registerWorkspaceFile: uri => index.registerWorkspaceFile(uri),
                workspaceFilesReady: () => index.workspaceFilesReady
            },
            roots: () => [...policy.searchRoots],
            isExcluded: full => policy.isExcluded(full),
            log: () => undefined
        })
    };
}

test("ответ одинаков до и после готовности каталога", async () => {
    /*
     * Тот самый случай: два файла с одним именем, один из них исключён
     * настройкой. До построения каталога отвечает обход диска, после —
     * каталог, и ответы обязаны совпасть.
     */
    const board = workspace({
        "macro/good.mac": "Macro Good()\nEnd;\n",
        "legacy/good.mac": "Macro Good()\nEnd;\n"
    });

    try {
        const policy = createRslSearchPolicy(
            [board.root],
            config({ moduleRoots: ["macro"], exclude: ["legacy/**"] })
        );
        const cold = resolverFor(board.root, policy);
        const beforeCatalog = await cold.resolver.resolve("good");

        assert.strictEqual(
            beforeCatalog.kind,
            "resolved",
            "до каталога файл обязан найтись"
        );
        assert.ok(
            beforeCatalog.value.toLowerCase().includes("/macro/"),
            "и это macro/good.mac, а не legacy: " + beforeCatalog.value
        );

        /* Теперь каталог готов и знает оба файла с диска. */
        const warm = resolverFor(board.root, policy);
        const discovered = [
            path.join(board.root, "macro", "good.mac"),
            path.join(board.root, "legacy", "good.mac")
        ].filter(file => !policy.isExcluded(file));

        warm.index.registerWorkspaceFiles(
            discovered.map(file => pathToFileURL(file).toString())
        );

        const afterCatalog = await warm.resolver.resolve("good");

        assert.strictEqual(afterCatalog.kind, beforeCatalog.kind);
        assert.strictEqual(
            afterCatalog.value.toLowerCase(),
            beforeCatalog.value.toLowerCase(),
            "ответ не должен зависеть от готовности каталога"
        );
    } finally {
        board.dispose();
    }
});

test("исключённый файл не находится адресным поиском", async () => {
    const board = workspace({ "legacy/only.mac": "Macro Only()\nEnd;\n" });

    try {
        const policy = createRslSearchPolicy(
            [board.root],
            config({ exclude: ["legacy/**"] })
        );
        const cold = resolverFor(board.root, policy);

        assert.strictEqual(
            (await cold.resolver.resolve("only")).kind,
            "missing",
            "настройка исключила файл — значит его нет и для перехода"
        );
    } finally {
        board.dispose();
    }
});

test("неоднозначность решается одинаково", async () => {
    const board = workspace({
        "a/same.mac": "Macro Same()\nEnd;\n",
        "b/same.mac": "Macro Same()\nEnd;\n"
    });

    try {
        const policy = createRslSearchPolicy([board.root], config());
        const cold = resolverFor(board.root, policy);
        const answer = await cold.resolver.resolve("same");

        assert.strictEqual(
            answer.kind,
            "ambiguous",
            "два файла с одним именем — не повод выбрать молча"
        );
        assert.strictEqual(answer.candidates.length, 2);
    } finally {
        board.dispose();
    }
});

test("файл вне moduleRoots не находится", async () => {
    const board = workspace({
        "macro/inside.mac": "Macro Inside()\nEnd;\n",
        "other/outside.mac": "Macro Outside()\nEnd;\n"
    });

    try {
        const policy = createRslSearchPolicy(
            [board.root],
            config({ moduleRoots: ["macro"] })
        );
        const cold = resolverFor(board.root, policy);

        assert.strictEqual(
            (await cold.resolver.resolve("inside")).kind,
            "resolved"
        );
        assert.strictEqual(
            (await cold.resolver.resolve("outside")).kind,
            "missing",
            "moduleRoots ограничивают область поиска"
        );
    } finally {
        board.dispose();
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

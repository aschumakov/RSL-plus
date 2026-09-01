"use strict";

/**
 * Переход к объявлению закрытого файла не читает файл заново.
 *
 * Диапазоны объявлений ключуются самим объектом символа. При закрытии дерево
 * обрезается, и там, где состав детей изменился, появляются НОВЫЕ экземпляры
 * RslSymbol — Macro и Class в первую очередь. Карта, перенесённая от прежней
 * модели, на них не отвечала: getDefinitionRange возвращал undefined, и
 * Definition уходил читать файл с диска запасным путём.
 *
 * Здесь проверяется и сам поиск по новому дереву, и то, ради чего он нужен:
 * чтения файла нет.
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
    compactOpenModuleModel,
    createOpenModuleModel
} = require("../server/out/moduleModel");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const {
    RslDefinitionProvider
} = require("../server/out/features/definitionProvider");

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

const SOURCE = [
    "Macro Run(value)",
    "  Var local = value;",
    "  return local;",
    "End;",
    "",
    "Class Holder",
    "  Var Code: String;",
    "  Macro Load(id)",
    "    return id;",
    "  End;",
    "End;",
    ""
].join("\n");

/** Символ дерева по пути имён. */
function find(tree, ...names) {
    let current = { children: tree.children };

    for (const name of names) {
        current = current.children.find(child => child.name === name);

        if (!current) {
            throw new Error("нет символа " + names.join("."));
        }
    }

    return current;
}

(async () => {
    await test("диапазоны переживают обрезку дерева", () => {
        const open = createOpenModuleModel(SOURCE);
        const compact = compactOpenModuleModel(open);
        const cases = [["Run"], ["Holder"], ["Holder", "Load"]];

        for (const names of cases) {
            const before = open.definitionRanges.get(find(open.symbolTree, ...names));
            const after = compact.definitionRanges.get(
                find(compact.symbolTree, ...names)
            );

            assert.ok(
                after,
                names.join(".") + ": диапазон обязан найтись по новому символу"
            );
            assert.deepStrictEqual(
                after,
                before,
                names.join(".") + ": и совпасть с исходным"
            );
        }
    });

    await test("выброшенные дети ключами новой карты не остаются", () => {
        const open = createOpenModuleModel(SOURCE);
        const parameter = find(open.symbolTree, "Run").children
            .find(child => child.name === "value");
        const compact = compactOpenModuleModel(open);

        assert.ok(parameter, "параметр в полной модели есть");
        assert.strictEqual(
            find(compact.symbolTree, "Run").children.length,
            0,
            "во внешней сводке параметров нет"
        );
        assert.strictEqual(
            compact.definitionRanges.get(parameter),
            undefined,
            "и в карте их тоже нет"
        );
    });

    await test("после закрытия переход не читает файл", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rsl-defrange-"));
        const file = path.join(directory, "lib.mac");

        fs.writeFileSync(file, SOURCE, "utf8");

        const uri = pathToFileURL(file).toString();
        const index = new WorkspaceIndex();

        index.registerWorkspaceFiles([uri]);
        index.updateOpenModule(uri, SOURCE, 1);

        /* Файл закрыли: индекс сжимает модель до внешней сводки. */
        index.markClosed(uri);
        index.compactModule(uri);

        const module = index.getModule(uri);
        const target = find(module.symbolTree, "Holder", "Load");

        let reads = 0;
        const originalReadFile = fs.promises.readFile;

        fs.promises.readFile = function (...args) {
            reads++;

            return originalReadFile.apply(this, args);
        };

        try {
            const provider = new RslDefinitionProvider({
                getOpenDocument: () => undefined,
                findWorkspaceFileUri: () => undefined,
                getDefinitionRange: (moduleUri, symbol) =>
                    index.getDefinitionRange(moduleUri, symbol),
                log: () => undefined
            });
            const location = await provider.createObjectLocationByUri(uri, target);

            assert.ok(location, "переход обязан получиться");
            assert.deepStrictEqual(
                location.range,
                {
                    start: { line: 7, character: 8 },
                    end: { line: 7, character: 12 }
                },
                "переход ведёт на имя метода"
            );
            assert.strictEqual(
                reads,
                0,
                "диапазон известен: читать файл незачем"
            );
        } finally {
            fs.promises.readFile = originalReadFile;
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    console.log(
        failed === 0
            ? "\nПройдено: " + passed
            : "\nПройдено: " + passed + ", провалено: " + failed
    );

    if (failed > 0) {
        process.exitCode = 1;
    }
})();

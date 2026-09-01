"use strict";

/**
 * Один ответ на вопрос «что видно через цепочку Import».
 *
 * Уровнем ниже уже всё общее: слово Import опознаёт importDirective, написание
 * имени разбирает moduleName, имя в файл превращает WorkspaceModuleResolver. А
 * обход самой цепочки был написан заново в пяти местах, и разойтись он мог
 * незаметно: Completion увидел бы одну цепочку, проверки другую, переход
 * третью. Прошлый разбор Import ровно так и разошёлся.
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
const {
    collectRslImportClosure
} = require("../server/out/indexing/importClosure");

let passed = 0;
let failed = 0;

function test(name, action) {
    try {
        action();
        passed++;
        console.log("[OK] " + name);
    } catch (error) {
        failed++;
        console.error("[FAIL] " + name);
        console.error(error);
    }
}

const MAIN = "file:///d:/closure/main.mac";

/**
 * Проект: главный файл и модули с их текстами.
 *
 * `registered` задаётся отдельно от `loaded`: файл проекта может быть известен
 * каталогу и ещё не прочитан, и это разные ответы замыкания.
 */
function stand(mainSource, loaded = {}, extraRegistered = []) {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([
        MAIN,
        ...Object.keys(loaded),
        ...extraRegistered
    ]);

    for (const [uri, text] of Object.entries(loaded)) {
        index.updateExternalModule(uri, text, 1);
    }

    index.updateOpenModule(MAIN, mainSource, 1);

    return index;
}

function namesOf(closure) {
    return closure.modules
        .map(item => item.uri.replace(/^.*\//u, ""))
        .sort();
}

test("прямой Import", () => {
    const index = stand("Import alpha;\n\nMacro Run()\nEnd;\n", {
        "file:///d:/closure/alpha.mac": "Macro AlphaOne()\nEnd;\n"
    });
    const closure = collectRslImportClosure(index, MAIN);

    assert.deepStrictEqual(namesOf(closure), ["alpha.mac"]);
    assert.deepStrictEqual(closure.missing, []);
});

test("транзитивный Import", () => {
    const index = stand("Import alpha;\n\nMacro Run()\nEnd;\n", {
        "file:///d:/closure/alpha.mac": "Import beta;\nMacro AlphaOne()\nEnd;\n",
        "file:///d:/closure/beta.mac": "Import gamma;\nMacro BetaOne()\nEnd;\n",
        "file:///d:/closure/gamma.mac": "Macro GammaOne()\nEnd;\n"
    });
    const closure = collectRslImportClosure(index, MAIN);

    assert.deepStrictEqual(
        namesOf(closure),
        ["alpha.mac", "beta.mac", "gamma.mac"],
        "цепочка обязана пройтись до конца"
    );
});

test("циклический Import не зацикливает обход", () => {
    const index = stand("Import alpha;\n\nMacro Run()\nEnd;\n", {
        "file:///d:/closure/alpha.mac": "Import beta;\nMacro AlphaOne()\nEnd;\n",
        "file:///d:/closure/beta.mac":
            "Import alpha;\nImport main;\nMacro BetaOne()\nEnd;\n"
    });
    const closure = collectRslImportClosure(index, MAIN);

    assert.deepStrictEqual(
        namesOf(closure),
        ["alpha.mac", "beta.mac"],
        "каждый модуль ровно один раз, и сам документ в список не входит"
    );
});

test("отсутствующий модуль", () => {
    const index = stand(
        "Import alpha;\nImport нетакого;\n\nMacro Run()\nEnd;\n",
        { "file:///d:/closure/alpha.mac": "Macro AlphaOne()\nEnd;\n" }
    );
    const closure = collectRslImportClosure(index, MAIN);

    assert.deepStrictEqual(namesOf(closure), ["alpha.mac"]);
    assert.deepStrictEqual(
        closure.missing,
        ["нетакого"],
        "имя без файла обязано быть названо отдельно"
    );
});

test("неоднозначное имя модуля", () => {
    const index = stand("Import lib;\n\nMacro Run()\nEnd;\n", {
        "file:///d:/closure/one/lib.mac": "Macro OneLib()\nEnd;\n",
        "file:///d:/closure/two/lib.mac": "Macro TwoLib()\nEnd;\n"
    });
    const closure = collectRslImportClosure(index, MAIN);

    assert.deepStrictEqual(
        closure.ambiguous,
        ["lib"],
        "неоднозначность обязана называться отдельно, а не молча выбираться"
    );
    assert.deepStrictEqual(
        namesOf(closure),
        [],
        "и ни один из двух файлов не считается подключённым"
    );
});

test("Import с путём", () => {
    const index = stand(
        'Import "sub/lib.mac";\n\nMacro Run()\nEnd;\n',
        {
            "file:///d:/closure/sub/lib.mac": "Macro SubLib()\nEnd;\n",
            "file:///d:/closure/other/lib.mac": "Macro OtherLib()\nEnd;\n"
        }
    );
    const closure = collectRslImportClosure(index, MAIN);

    assert.deepStrictEqual(
        closure.modules.map(item => item.uri),
        ["file:///d:/closure/sub/lib.mac"],
        "путь обязан снять неоднозначность"
    );
});

test("файл проекта есть, но ещё не прочитан", () => {
    const index = stand(
        "Import alpha;\nImport later;\n\nMacro Run()\nEnd;\n",
        { "file:///d:/closure/alpha.mac": "Macro AlphaOne()\nEnd;\n" },
        ["file:///d:/closure/later.mac"]
    );
    const closure = collectRslImportClosure(index, MAIN);

    assert.deepStrictEqual(
        closure.unloaded,
        ["later"],
        "«ещё не прочитан» и «такого нет» — разные ответы"
    );
    assert.deepStrictEqual(closure.missing, []);
});

test("seedImports: текст новее модели", () => {
    /*
     * Быстрый путь Completion: пользователь только что дописал Import, а полная
     * модель этой версии ещё не построена. Import берутся из текста.
     */
    const index = stand("Macro Run()\nEnd;\n", {
        "file:///d:/closure/alpha.mac": "Import beta;\nMacro AlphaOne()\nEnd;\n",
        "file:///d:/closure/beta.mac": "Macro BetaOne()\nEnd;\n"
    });

    assert.deepStrictEqual(
        namesOf(collectRslImportClosure(index, MAIN)),
        [],
        "в модели документа Import ещё нет"
    );
    assert.deepStrictEqual(
        namesOf(collectRslImportClosure(index, MAIN, {
            seedImports: ["alpha"]
        })),
        ["alpha.mac", "beta.mac"],
        "по переданным именам цепочка обязана пройтись целиком"
    );
});

test("directOnly: только первый уровень", () => {
    const index = stand("Import alpha;\n\nMacro Run()\nEnd;\n", {
        "file:///d:/closure/alpha.mac": "Import beta;\nMacro AlphaOne()\nEnd;\n",
        "file:///d:/closure/beta.mac": "Macro BetaOne()\nEnd;\n"
    });

    assert.deepStrictEqual(
        namesOf(collectRslImportClosure(index, MAIN, { directOnly: true })),
        ["alpha.mac"]
    );
});

test("skipName отдаёт имя вызывающему и внутрь не заходит", () => {
    const index = stand("Import alpha;\n\nMacro Run()\nEnd;\n", {
        "file:///d:/closure/alpha.mac": "Import beta;\nMacro AlphaOne()\nEnd;\n",
        "file:///d:/closure/beta.mac": "Macro BetaOne()\nEnd;\n"
    });
    const claimed = [];
    const closure = collectRslImportClosure(index, MAIN, {
        skipName: name => {
            claimed.push(name);

            return name === "alpha";
        }
    });

    assert.deepStrictEqual(claimed, ["alpha"], "имя предложено вызывающему");
    assert.deepStrictEqual(
        namesOf(closure),
        [],
        "забранное имя не разрешается, и в его цепочку обход не заходит"
    );
});

test("повтор одного имени разными написаниями считается один раз", () => {
    const index = stand(
        'Import alpha;\nImport "alpha.mac";\nImport ALPHA;\n\n' +
        "Macro Run()\nEnd;\n",
        { "file:///d:/closure/alpha.mac": "Macro AlphaOne()\nEnd;\n" }
    );

    assert.deepStrictEqual(
        namesOf(collectRslImportClosure(index, MAIN)),
        ["alpha.mac"]
    );
});

console.log(
    failed === 0
        ? "\nПройдено: " + passed
        : "\nПройдено: " + passed + ", провалено: " + failed
);

if (failed > 0) {
    process.exitCode = 1;
}

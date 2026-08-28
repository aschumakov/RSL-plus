"use strict";

/**
 * Auto Import ищет по всему проекту, а не по первым пятистам файлам.
 *
 * Кандидатов искали чтением файлов и останавливались на пятисотом: на проекте
 * в шесть тысяч файлов экспорт из шестисотого файла по алфавиту не находился
 * вовсе, и Quick Fix про него молчал. Каталог проекта отвечает на тот же
 * вопрос по своей записи, без чтения файла.
 *
 * Проверяется и обратное: пока каталог не достроен, работает прежнее
 * сканирование — иначе на холодном старте Auto Import перестал бы находить
 * что-либо вообще.
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

const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const {
    WorkspaceModuleLoader
} = require("../server/out/indexing/workspaceModuleLoader");
const {
    extractCompactDeclarations
} = require("../server/out/analysis/declarationExtractor");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

/* Файлов заведомо больше прежнего предела сканирования. */
const FILES = 700;
const SCAN_LIMIT = 500;
/* Экспорт лежит далеко за пределом: по алфавиту это шестисотый файл. */
const EXPORTER = 600;

/**
 * Проект на диске: файлы читаются по-настоящему.
 *
 * Auto Import ходит к файлам через компактный сканер, и подставить его тут
 * нечем: проверяется именно то, дойдёт ли он до нужного файла.
 */
async function createProject() {
    const directory = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "rsl-auto-import-catalog-")
    );
    const files = [];

    for (let number = 0; number < FILES; number++) {
        const name = "mod" + String(number).padStart(4, "0") + ".mac";
        const file = path.join(directory, name);
        const source = number === EXPORTER
            ? "Macro FarAwaySymbol(value)\n  return value;\nEnd;\n"
            : "Macro Ordinary" + number + "()\nEnd;\n";

        await fs.promises.writeFile(file, source, "utf8");
        files.push({ file, source, uri: pathToFileURL(file).toString() });
    }

    return { directory, files };
}

/** Заполняет каталог так же, как это делает фоновая достройка. */
function fillCatalog(index, files, count) {
    for (const item of files.slice(0, count)) {
        const declarations = extractCompactDeclarations(item.source);

        index.catalog.recordDeclarations({
            uri: item.uri,
            version: 1,
            declarations: declarations.declarations,
            imports: declarations.imports
        });
    }
}

function createLoader(index) {
    return new WorkspaceModuleLoader(index, {
        log: () => undefined,
        onModuleLoaded: () => undefined,
        onModuleCountChanged: () => undefined
    });
}

test("экспорт за пределом сканирования находится через каталог", async () => {
    const project = await createProject();

    try {
        const index = new WorkspaceIndex();
        const loader = createLoader(index);

        loader.registerWorkspaceFiles(project.files.map(item => item.uri));
        /* Каталог достроен по всему проекту, как после фонового обхода. */
        fillCatalog(index, project.files, FILES);

        const found = await loader.findModulesExportingSymbol("FarAwaySymbol");

        assert.deepStrictEqual(
            found.map(module => module.uri),
            [project.files[EXPORTER].uri],
            "экспорт из файла номер " + EXPORTER + " обязан находиться"
        );

        /*
         * И читается при этом только он: каталог назвал подходящего, читать
         * остальные шестьсот незачем.
         */
        assert.strictEqual(
            index.size,
            1,
            "прочитан обязан быть только экспортирующий модуль, а не " +
                index.size
        );
    } finally {
        await fs.promises.rm(project.directory, {
            recursive: true,
            force: true
        });
    }
});

test("без каталога работает прежнее сканирование", async () => {
    const project = await createProject();

    try {
        const index = new WorkspaceIndex();
        const loader = createLoader(index);

        loader.registerWorkspaceFiles(project.files.map(item => item.uri));

        /* Каталог пуст: холодный старт, обход ещё не начинался. */
        const near = await loader.findModulesExportingSymbol("Ordinary10");

        assert.deepStrictEqual(
            near.map(module => module.uri),
            [project.files[10].uri],
            "то, что лежит в пределах сканирования, обязано находиться и так"
        );
    } finally {
        await fs.promises.rm(project.directory, {
            recursive: true,
            force: true
        });
    }
});

test("частично достроенный каталог не отменяет сканирование", async () => {
    const project = await createProject();

    try {
        const index = new WorkspaceIndex();
        const loader = createLoader(index);

        loader.registerWorkspaceFiles(project.files.map(item => item.uri));
        /* Обход дошёл до сотого файла: остальные каталогу пока неизвестны. */
        fillCatalog(index, project.files, 100);

        const found = await loader.findModulesExportingSymbol("Ordinary300");

        assert.deepStrictEqual(
            found.map(module => module.uri),
            [project.files[300].uri],
            "файл вне каталога обязан находиться сканированием"
        );
    } finally {
        await fs.promises.rm(project.directory, {
            recursive: true,
            force: true
        });
    }
});

test("ответ отменённого поиска не запоминается", async () => {
    const project = await createProject();

    try {
        const index = new WorkspaceIndex();
        const loader = createLoader(index);

        loader.registerWorkspaceFiles(project.files.map(item => item.uri));
        fillCatalog(index, project.files, FILES);

        const cancelled = await loader.findModulesExportingSymbol(
            "FarAwaySymbol",
            10,
            { isCancelled: () => true }
        );

        assert.deepStrictEqual(
            cancelled,
            [],
            "отменённый поиск ничего не находит"
        );

        const found = await loader.findModulesExportingSymbol("FarAwaySymbol");

        assert.deepStrictEqual(
            found.map(module => module.uri),
            [project.files[EXPORTER].uri],
            "следующий поиск не имеет права взять отменённый ответ за готовый"
        );
    } finally {
        await fs.promises.rm(project.directory, {
            recursive: true,
            force: true
        });
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

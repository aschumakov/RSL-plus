"use strict";

/**
 * Переход по Import настоящим путём обработчика, а не по кускам.
 *
 * Быстрый обработчик спрашивал каталог проекта напрямую, минуя resolver. Пока
 * каталог не построен, каталог молчал, запрос уходил дальше — строить полную
 * модель, — и тот же файл всё равно находился обходом диска, но уже в медленном
 * пути, где неоднозначность превращалась в молчание.
 *
 * Получалось: два одноимённых файла до построения каталога перехода не давали
 * вовсе, а после — давали оба. Проверки по отдельности этого не видели: они
 * либо звали разрешение имени, либо строили ответ, но не проходили путь целиком.
 *
 * Здесь путь проходится целиком, дважды: с пустым каталогом и с построенным, —
 * и ответы сравниваются между собой.
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
const { RslScopeResolver } = require("../server/out/scopeResolver");
const {
    WorkspaceModuleResolver,
    isExcludedRslDirectory
} = require("../server/out/indexing/workspaceModuleResolver");
const {
    createRslInteractiveHandlers
} = require("../server/out/features/interactiveHandlers");
const {
    RslDefinitionProvider
} = require("../server/out/features/definitionProvider");
const {
    createFastDocumentSnapshot
} = require("../server/out/services/fastDocumentSnapshot");
const {
    TextDocument
} = require("../server/node_modules/vscode-languageserver-textdocument");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const HELPER = "Macro Helper()\n  return 1;\nEnd;\n";

function scratch(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTree(directory) {
    fs.rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 25
    });
}

function put(root, relative, text = HELPER) {
    const file = path.join(root, relative.replace(/\//gu, path.sep));

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");

    return file;
}

/**
 * Стенд настоящего пути Definition.
 *
 * Собирается то же, что собирает сервер: индекс, resolver над ним, провайдер
 * определений и интерактивные обработчики. Ответ берётся у обработчика —
 * той самой функции, которую зовёт редактор.
 */
function stand(files, mainSource) {
    const directory = scratch("rsl-definition-path-");
    const written = new Map();

    for (const [relative, text] of Object.entries(files)) {
        written.set(relative, put(directory, relative, text));
    }

    const mainPath = put(directory, "main.mac", mainSource);
    const mainUri = pathToFileURL(mainPath).toString();
    const index = new WorkspaceIndex();

    /*
     * Каталог пуст: обход проекта ещё не проходил.
     *
     * Поштучная регистрация не помечает каталог построенным — это делает
     * только registerWorkspaceFiles, которым обход и заканчивается.
     */
    index.registerWorkspaceFile(mainUri);

    const resolverService = new WorkspaceModuleResolver({
        catalog: {
            resolveWorkspaceFile: name => index.resolveWorkspaceFile(name),
            registerWorkspaceFile: uri => index.registerWorkspaceFile(uri),
            workspaceFilesReady: () => index.workspaceFilesReady
        },
        roots: () => [directory],
        log: () => undefined
    });

    const documents = new Map();
    const document = TextDocument.create(mainUri, "rsl", 1, mainSource);

    documents.set(mainUri, document);

    const module = index.updateOpenModule(mainUri, mainSource, 1);
    /* Сколько раз запрос попросил полную модель: у Import таких просьб быть не должно. */
    let modelRequests = 0;
    const scopeResolver = new RslScopeResolver(index);
    const definitionProvider = new RslDefinitionProvider({
        getOpenDocument: uri => documents.get(uri),
        ensureDocumentParsed: async () => {
            modelRequests++;

            return module.symbolTree;
        },
        getLoadedModules: () => index.getModules(),
        getImportedModules: uri => index.getImportedModules(uri),
        findWorkspaceFileUri: name => index.findWorkspaceFileUri(name),
        resolveWorkspaceFileUri: name => index.resolveWorkspaceFile(name),
        resolveModuleFile: name => resolverService.resolve(name),
        invalidateModuleFiles: () => resolverService.invalidate(),
        log: () => undefined
    });
    const handlers = createRslInteractiveHandlers({
        documents: { get: uri => documents.get(uri) },
        index,
        resolver: scopeResolver,
        definitionProvider,
        getFastDocumentSnapshot: value => createFastDocumentSnapshot(value),
        getCurrentModule: () => module,
        ensureDocumentParsed: async () => {
            modelRequests++;

            return module.symbolTree;
        },
        resolveModuleFile: name => resolverService.resolve(name)
    });

    /* Обход проекта: тем же списком исключений, что и настоящий. */
    function collect(from, found = []) {
        for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
            const full = path.join(from, entry.name);

            if (entry.isDirectory()) {
                if (!isExcludedRslDirectory(entry.name)) {
                    collect(full, found);
                }
            } else if (/\.mac$/iu.test(entry.name)) {
                found.push(pathToFileURL(full).toString());
            }
        }

        return found;
    }

    return {
        directory,
        modelRequests: () => modelRequests,
        uriOf: relative => pathToFileURL(written.get(relative)).toString(),
        /** Ответ обработчика на Ctrl+Click в позиции имени модуля. */
        async definitionAt(name) {
            const at = mainSource.indexOf(name) + 2;

            return handlers.definition(
                {
                    textDocument: { uri: mainUri },
                    position: document.positionAt(at)
                },
                { isCancellationRequested: false }
            );
        },
        discover() {
            index.registerWorkspaceFiles(collect(directory));
            resolverService.invalidate();
        },
        dispose() {
            removeTree(directory);
        }
    };
}

/** Ответ в сравнимом виде: список URI. */
function urisOf(answer) {
    if (!answer) {
        return [];
    }

    return (Array.isArray(answer) ? answer : [answer])
        .map(item => item.uri)
        .sort();
}

test("два одноимённых файла: ответ одинаков до и после каталога", async () => {
    const board = stand(
        { "zeta/helper.mac": HELPER, "alpha/helper.mac": HELPER },
        'Import "helper.mac";\n\nMacro Run()\nEnd;\n'
    );

    try {
        const before = urisOf(await board.definitionAt("helper.mac"));

        assert.deepStrictEqual(
            before,
            [board.uriOf("alpha/helper.mac"), board.uriOf("zeta/helper.mac")],
            "с пустым каталогом обязаны показываться оба файла"
        );

        /*
         * И отвечает быстрый путь, а не полная модель.
         *
         * Имя модуля — это имя файла: его знает каталог, разбор для него не
         * нужен ни до, ни после. Пока быстрый путь спрашивал каталог напрямую,
         * с пустым каталогом он молчал, и запрос уходил строить модель зря.
         */
        assert.strictEqual(
            board.modelRequests(),
            0,
            "переход по Import не имеет права строить полную модель"
        );

        board.discover();

        const after = urisOf(await board.definitionAt("helper.mac"));

        assert.deepStrictEqual(
            after,
            before,
            "построение каталога не имеет права изменить ответ"
        );
    } finally {
        board.dispose();
    }
});

test("один файл: ответ одинаков до и после каталога", async () => {
    const board = stand(
        { "lib/single.mac": HELPER },
        'Import "single.mac";\n\nMacro Run()\nEnd;\n'
    );

    try {
        const before = urisOf(await board.definitionAt("single.mac"));

        assert.deepStrictEqual(
            before,
            [board.uriOf("lib/single.mac")],
            "с пустым каталогом переход обязан работать"
        );

        board.discover();

        assert.deepStrictEqual(
            urisOf(await board.definitionAt("single.mac")),
            before,
            "и не измениться после обхода"
        );
    } finally {
        board.dispose();
    }
});

test("обычное имя без кавычек ведёт себя так же", async () => {
    const board = stand(
        { "lib/plain.mac": HELPER },
        "Import plain;\n\nMacro Run()\nEnd;\n"
    );

    try {
        const before = urisOf(await board.definitionAt("plain;"));

        assert.deepStrictEqual(before, [board.uriOf("lib/plain.mac")]);

        board.discover();

        assert.deepStrictEqual(
            urisOf(await board.definitionAt("plain;")),
            before
        );
    } finally {
        board.dispose();
    }
});

test("несуществующий модуль молчит и до, и после каталога", async () => {
    const board = stand(
        { "lib/other.mac": HELPER },
        'Import "nosuchmodule.mac";\n\nMacro Run()\nEnd;\n'
    );

    try {
        assert.deepStrictEqual(
            urisOf(await board.definitionAt("nosuchmodule.mac")),
            [],
            "файла нет — перехода нет"
        );

        board.discover();

        assert.deepStrictEqual(
            urisOf(await board.definitionAt("nosuchmodule.mac")),
            []
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

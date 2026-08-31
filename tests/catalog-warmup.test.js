"use strict";

/**
 * Достройка каталога проекта.
 *
 * Каталог заполнялся по мере индексации, и в режиме activeImports ответы
 * Ctrl+T, Go to Implementation и переименования файла зависели от того, какие
 * файлы пользователь успел задеть. Здесь проверяется обратное: ответ один и тот
 * же независимо от того, что загружено.
 *
 * Проверяется и цена: чтение с разбором уходит в тот же компактный читатель,
 * что и фоновая индексация, а на основном потоке остаётся только запись в
 * каталог — с бюджетом на порцию.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

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
    RslCatalogWarmupService
} = require("../server/out/indexing/catalogWarmupService");
const {
    readCompactModule
} = require("../server/out/indexing/compactModuleReader");
const {
    GetMacroFileReferenceNamesFromTokens,
    GetMacroFileReferencesFromTokens
} = require("../server/out/execMacroDefinition");
const { lexRsl } = require("../server/out/lexer");
const {
    createRslVirtualClock
} = require("../server/out/core/clock");
const {
    buildRslFileRenameEdit
} = require("../server/out/features/fileRenameProvider");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const FILES = {
    "lib.mac": [
        "Macro LibraryHelper(document)",
        "  Var result = 1;",
        "  return result;",
        "End;",
        "Class Base",
        "  Var field;",
        "End;",
        ""
    ].join("\n"),
    "caller.mac": [
        "Macro Run()",
        "  ExecMacroFile(\"lib.mac\");",
        "  MsgBox(\"lib.mac\");",
        "End;",
        ""
    ].join("\n"),
    "other.mac": [
        "Class(Base) Derived",
        "  Macro Work()",
        "  End;",
        "End;",
        ""
    ].join("\n")
};

/** Настоящие файлы: читатель и переименование работают с диском. */
function createProject(files) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rsl-catalog-"));
    const uris = {};

    for (const [name, text] of Object.entries(files || FILES)) {
        fs.writeFileSync(path.join(directory, name), text, "utf8");
        uris[name] = "file:///" +
            path.join(directory, name).split(path.sep).join("/");
    }

    return { directory, uris, all: Object.values(uris) };
}

function createWarmup(project, options) {
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles(project.all);

    const reads = [];
    const service = new RslCatalogWarmupService({
        index,
        read: uri => {
            reads.push(uri);

            return readCompactModule({ id: reads.length, uri, generation: 0 });
        },
        ...(options || {})
    });

    return { index, service, reads };
}

test("каталог знает имена файлов, которые никогда не загружались", async () => {
    const project = createProject();
    const { index, service } = createWarmup(project);

    assert.strictEqual(
        index.catalog.find("LibraryHelper", 5).length,
        0,
        "до достройки каталог пуст"
    );

    service.add(project.all);

    const progress = await service.runToCompletion();

    assert.strictEqual(progress.done, 3, "прочитаны все файлы");
    assert.deepStrictEqual(
        index.catalog.find("LibraryHelper", 5).map(item => item.uri),
        [project.uris["lib.mac"]],
        "объявление из незагруженного файла попало в каталог"
    );
    assert.deepStrictEqual(
        index.catalog.implementationsOf("Base").map(item => item.name),
        ["Derived"],
        "наследник найден без загрузки модуля"
    );
    assert.strictEqual(
        index.getModule(project.uris["lib.mac"]),
        undefined,
        "достройка не загружает модель в хранилище"
    );

    fs.rmSync(project.directory, {
            recursive: true,
            force: true,
            /*
             * Повторы обязательны на Windows: rm падает с ENOTEMPTY, если
             * файл в каталоге создан только что — дескриптор ещё держится.
             */
            maxRetries: 20,
            retryDelay: 25
        });
});

test("позиция символа в каталоге — настоящая строка, а не первая", async () => {
    const project = createProject();
    const { index, service } = createWarmup(project);

    service.add(project.all);
    await service.runToCompletion();

    const [base] = index.catalog.findByName("Base");
    const [derived] = index.catalog.findByName("Derived");

    assert.ok(base, "класс Base в каталоге");
    assert.strictEqual(base.line, 4, "Class Base объявлен на пятой строке");
    assert.strictEqual(derived.line, 0, "Class Derived — на первой");

    const [field] = index.catalog.findByName("field");

    assert.strictEqual(field.line, 5, "поле класса — на шестой строке");
    assert.strictEqual(field.container, "Base", "владелец записан");

    fs.rmSync(project.directory, {
            recursive: true,
            force: true,
            /*
             * Повторы обязательны на Windows: rm падает с ENOTEMPTY, если
             * файл в каталоге создан только что — дескриптор ещё держится.
             */
            maxRetries: 20,
            retryDelay: 25
        });
});

test("у записи каталога есть устойчивое тождество", async () => {
    const project = createProject();
    const { index, service } = createWarmup(project);

    service.add(project.all);
    await service.runToCompletion();

    const [helper] = index.catalog.findByName("LibraryHelper");

    assert.ok(helper.symbolId, "идентификатор символа задан");

    /*
     * Тот же файл, загруженный подробной моделью, обязан дать тот же
     * идентификатор: иначе пара {uri, symbolId} не годится для сравнения
     * записей, пришедших разными путями.
     */
    index.updateExternalModule(
        project.uris["lib.mac"],
        FILES["lib.mac"],
        1
    );

    const [reloaded] = index.catalog.findByName("LibraryHelper");

    assert.strictEqual(
        reloaded.symbolId,
        helper.symbolId,
        "идентификатор не зависит от того, каким путём файл попал в каталог"
    );

    fs.rmSync(project.directory, {
            recursive: true,
            force: true,
            /*
             * Повторы обязательны на Windows: rm падает с ENOTEMPTY, если
             * файл в каталоге создан только что — дескриптор ещё держится.
             */
            maxRetries: 20,
            retryDelay: 25
        });
});

test("файл без строковых ссылок перечитывается, а прочитанный — нет", async () => {
    const project = createProject();
    const { index, service, reads } = createWarmup(project);

    /* Файл уже в каталоге из подробной модели, но ссылок в записи нет. */
    index.updateExternalModule(
        project.uris["caller.mac"],
        FILES["caller.mac"],
        1
    );
    assert.ok(index.catalog.has(project.uris["caller.mac"]));
    assert.ok(!index.catalog.hasFileReferences(project.uris["caller.mac"]));

    service.add(project.all);
    await service.runToCompletion();

    assert.ok(
        reads.includes(project.uris["caller.mac"]),
        "запись без ссылок обязана быть перечитана"
    );

    const readsBefore = reads.length;

    service.add(project.all);
    await service.runToCompletion();

    assert.strictEqual(
        reads.length,
        readsBefore,
        "второй раз те же файлы не читаются"
    );

    fs.rmSync(project.directory, {
            recursive: true,
            force: true,
            /*
             * Повторы обязательны на Windows: rm падает с ENOTEMPTY, если
             * файл в каталоге создан только что — дескриптор ещё держится.
             */
            maxRetries: 20,
            retryDelay: 25
        });
});

test("открытый файл фоновым чтением не перезаписывается", async () => {
    const project = createProject();
    const { index, service } = createWarmup(project);

    /* В редакторе файл правят: в нём появилось имя, которого нет на диске. */
    index.updateOpenModule(
        project.uris["lib.mac"],
        "Macro OnlyInEditor()\nEnd;\n",
        2
    );

    service.add(project.all);
    await service.runToCompletion();

    assert.deepStrictEqual(
        index.catalog.findByName("OnlyInEditor").map(item => item.uri),
        [project.uris["lib.mac"]],
        "сведения открытого файла остались"
    );
    assert.deepStrictEqual(
        index.catalog.findByName("LibraryHelper"),
        [],
        "версия с диска не вытеснила версию редактора"
    );

    fs.rmSync(project.directory, {
            recursive: true,
            force: true,
            /*
             * Повторы обязательны на Windows: rm падает с ENOTEMPTY, если
             * файл в каталоге создан только что — дескриптор ещё держится.
             */
            maxRetries: 20,
            retryDelay: 25
        });
});

/* ─── Строковые ссылки ───────────────────────────────────────────────────── */

test("ссылкой считается только первый аргумент ExecMacroFile", () => {
    const source = [
        "Macro Run()",
        "  ExecMacroFile(\"lib.mac\");",
        "  ExecMacroFile(\"sub/other.mac\", \"Target\");",
        "  MsgBox(\"lib.mac\");",
        "  Var text = \"report.mac\";",
        "End;",
        ""
    ].join("\n");
    const tokens = lexRsl(source, { includeTrivia: true }).tokens;

    assert.deepStrictEqual(
        GetMacroFileReferenceNamesFromTokens(tokens),
        ["lib.mac", "other.mac"],
        "MsgBox и обычное присваивание ссылками не являются"
    );
    assert.deepStrictEqual(
        GetMacroFileReferencesFromTokens(tokens).map(item => item.value),
        ["lib.mac", "sub/other.mac"],
        "путь сохраняется как написан"
    );
});

test("переименование правит ExecMacroFile и не трогает обычную строку", async () => {
    const project = createProject();
    const { index, service } = createWarmup(project);

    service.add(project.all);
    await service.runToCompletion();

    const environment = {
        index,
        getDocument: () => undefined,
        log: () => undefined
    };
    const renamed = "file:///" + path
        .join(project.directory, "library.mac")
        .split(path.sep)
        .join("/");
    const edits = buildRslFileRenameEdit(environment, [{
        oldUri: project.uris["lib.mac"],
        newUri: renamed
    }]);

    assert.ok(edits, "правки найдены");
    assert.deepStrictEqual(
        Object.keys(edits.changes),
        [project.uris["caller.mac"]],
        "правка в файле со строковой ссылкой"
    );

    const changes = edits.changes[project.uris["caller.mac"]];

    assert.strictEqual(changes.length, 1, "правка ровно одна: " +
        JSON.stringify(changes));
    assert.strictEqual(changes[0].newText, "\"library.mac\"");
    assert.strictEqual(
        changes[0].range.start.line,
        1,
        "правится строка ExecMacroFile, а не MsgBox"
    );

    fs.rmSync(project.directory, {
            recursive: true,
            force: true,
            /*
             * Повторы обязательны на Windows: rm падает с ENOTEMPTY, если
             * файл в каталоге создан только что — дескриптор ещё держится.
             */
            maxRetries: 20,
            retryDelay: 25
        });
});

test("путь в ссылке сохраняется при переименовании", async () => {
    const project = createProject({
        "lib.mac": "Macro Helper()\nEnd;\n",
        "caller.mac": [
            "Macro Run()",
            "  ExecMacroFile(\"sub\\\\lib.mac\", \"Helper\");",
            "End;",
            ""
        ].join("\n")
    });
    const { index, service } = createWarmup(project);

    service.add(project.all);
    await service.runToCompletion();

    const edits = buildRslFileRenameEdit(
        { index, getDocument: () => undefined, log: () => undefined },
        [{
            oldUri: project.uris["lib.mac"],
            newUri: "file:///" + path
                .join(project.directory, "library.mac")
                .split(path.sep)
                .join("/")
        }]
    );
    const changes = edits?.changes[project.uris["caller.mac"]] || [];

    assert.strictEqual(changes.length, 1);
    assert.strictEqual(
        changes[0].newText,
        "\"sub\\library.mac\"",
        "каталог в ссылке остался: " + JSON.stringify(changes[0].newText)
    );

    fs.rmSync(project.directory, {
            recursive: true,
            force: true,
            /*
             * Повторы обязательны на Windows: rm падает с ENOTEMPTY, если
             * файл в каталоге создан только что — дескриптор ещё держится.
             */
            maxRetries: 20,
            retryDelay: 25
        });
});

test("удалённый файл уходит из ссылок", async () => {
    const project = createProject();
    const { index, service } = createWarmup(project);

    service.add(project.all);
    await service.runToCompletion();

    assert.deepStrictEqual(
        index.catalog.modulesMentioningFile("lib.mac"),
        [project.uris["caller.mac"]]
    );

    index.catalog.remove(project.uris["caller.mac"]);

    assert.deepStrictEqual(
        index.catalog.modulesMentioningFile("lib.mac"),
        [],
        "запись ушла вместе с файлом"
    );

    fs.rmSync(project.directory, {
            recursive: true,
            force: true,
            /*
             * Повторы обязательны на Windows: rm падает с ENOTEMPTY, если
             * файл в каталоге создан только что — дескриптор ещё держится.
             */
            maxRetries: 20,
            retryDelay: 25
        });
});

test("смена проекта очищает каталог", async () => {
    const project = createProject();
    const { index, service } = createWarmup(project);

    service.add(project.all);
    await service.runToCompletion();

    assert.ok(index.catalog.stats.modules > 0);

    index.clear();

    assert.strictEqual(index.catalog.stats.modules, 0, "каталог очищен");
    assert.deepStrictEqual(index.catalog.findByName("LibraryHelper"), []);

    fs.rmSync(project.directory, {
            recursive: true,
            force: true,
            /*
             * Повторы обязательны на Windows: rm падает с ENOTEMPTY, если
             * файл в каталоге создан только что — дескриптор ещё держится.
             */
            maxRetries: 20,
            retryDelay: 25
        });
});

/* ─── Порционность и бюджет ──────────────────────────────────────────────── */

test("порция не занимает основной поток дольше бюджета", async () => {
    /*
     * Файлы крупные: раньше двенадцать таких читались и сканировались подряд
     * прямо на основном потоке, и одна порция занимала его больше секунды.
     */
    const files = {};

    for (let index = 0; index < 12; index++) {
        const lines = [];

        for (let macro = 0; macro < 2000; macro++) {
            lines.push(
                "Macro Process" + index + "_" + macro + "(document)",
                "  Var result = 0;",
                "  return result;",
                "End;",
                ""
            );
        }

        files["big" + index + ".mac"] = lines.join("\n");
    }

    const project = createProject(files);
    const { service } = createWarmup(project, { budgetMs: 10 });

    service.add(project.all);

    const durations = [];
    let previous = process.hrtime.bigint();

    /*
     * Между порциями поток свободен, и таймер обратного вызова успевает
     * сработать. Длительность непрерывной занятости меряется отрезками между
     * возвратами управления.
     */
    const interval = setInterval(() => {
        const now = process.hrtime.bigint();

        durations.push(Number(now - previous) / 1e6);
        previous = now;
    }, 1);

    await service.runToCompletion();
    clearInterval(interval);

    const longest = Math.max(...durations);

    console.log(
        "[METRIC] достройка каталога: 12 файлов по " +
        Math.round(Object.values(files)[0].length / 1024) +
        " КБ, самая долгая непрерывная занятость потока " +
        longest.toFixed(0) + " мс"
    );
    assert.ok(
        durations.length > 5,
        "поток возвращался управлению много раз: " + durations.length
    );
    /*
     * Порог с запасом: он отделяет порционную работу от прежней, когда
     * двенадцать файлов читались и сканировались одним куском и занимали поток
     * больше секунды. Точное значение зависит от диска и загрузки машины, и
     * ужимать его значило бы получать падения на ровном месте.
     */
    assert.ok(
        longest < 500,
        "непрерывная занятость потока: " + longest.toFixed(0) + " мс"
    );

    fs.rmSync(project.directory, {
            recursive: true,
            force: true,
            /*
             * Повторы обязательны на Windows: rm падает с ENOTEMPTY, если
             * файл в каталоге создан только что — дескриптор ещё держится.
             */
            maxRetries: 20,
            retryDelay: 25
        });
});

test("правка приостанавливает обход, тишина возвращает", async () => {
    const project = createProject();
    const clock = createRslVirtualClock(0);
    /*
     * Чтение отвечает готовым ответом, без диска: проверяется расписание, а
     * ждать в нём настоящий ввод-вывод значит проверять заодно скорость диска.
     */
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles(project.all);

    const service = new RslCatalogWarmupService({
        index,
        read: uri => Promise.resolve({
            id: 1,
            uri,
            generation: 0,
            status: "indexed",
            mtimeMs: 0,
            fingerprint: "x",
            sourceLength: 10,
            declarations: [],
            imports: [],
            fileReferences: [],
            reused: false
        }),
        clock,
        concurrency: 1,
        budgetMs: 0.0001,
        pauseMs: 10,
        idleMs: 100
    });

    service.add(project.all);
    service.suspend();

    await clock.advance(50);
    assert.strictEqual(
        service.progress.done,
        0,
        "приостановленный обход не работает"
    );

    /* Тишина: служба вернулась к работе сама. */
    await clock.advance(60);
    await clock.advance(20);

    assert.ok(
        service.progress.done > 0,
        "после тишины обход продолжился: " + service.progress.done
    );

    service.stop();
    fs.rmSync(project.directory, {
            recursive: true,
            force: true,
            /*
             * Повторы обязательны на Windows: rm падает с ENOTEMPTY, если
             * файл в каталоге создан только что — дескриптор ещё держится.
             */
            maxRetries: 20,
            retryDelay: 25
        });
});

(async () => {
    for (const item of tests) {
        try {
            await item.action();
            passed++;
            console.log(`[OK] ${item.name}`);
        } catch (error) {
            failed++;
            console.error(`[FAIL] ${item.name}`);
            console.error(error);
        }
    }

    console.log(
        failed === 0
            ? `\nПройдено: ${passed}`
            : `\nПройдено: ${passed}, провалено: ${failed}`
    );

    if (failed > 0) {
        process.exitCode = 1;
    }
})();

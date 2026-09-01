"use strict";

/**
 * Переименование файла: ссылки правит общий разбор Import.
 *
 * У File Rename была своя упрощённая машина состояний: «встретили слово
 * import — до точки с запятой правим совпавшие идентификаторы». Строковую
 * форму `Import "lib.mac";` она не видела вовсе, про пути не знала, а
 * поддерживаемый синтаксис Import с тех пор ушёл вперёд.
 *
 * Отдельно проверяется, что открытый и уже разобранный документ не лексируется
 * второй раз: его поток токенов уже лежит в модели.
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

const lexerModule = require("../server/out/lexer");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const {
    buildRslFileRenameEdit
} = require("../server/out/features/fileRenameProvider");
const {
    TextDocument
} = require("../server/node_modules/vscode-languageserver-textdocument");

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

const USER = "file:///d:/rename/user.mac";
const OLD = "file:///d:/rename/lib.mac";
const NEW = "file:///d:/rename/other.mac";

/** Правки в файле-пользователе при переименовании lib.mac -> other.mac. */
function renameWith(source, options = {}) {
    const counter = options.count;
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([USER, OLD]);
    index.updateExternalModule(OLD, "Macro LibOne()\nEnd;\n", 1);

    const documents = new Map();

    if (options.open) {
        documents.set(USER, TextDocument.create(USER, "rsl", 1, source));
    }

    /*
     * Модуль открытый: у внешней сводки нет потока токенов, а кандидатов
     * ищут в том числе по нему. Каталог наполняется отдельно — так же, как
     * это делает загрузчик.
     */
    const module = index.updateOpenModule(USER, source, 1);

    index.catalog.record(module);

    const stop = counter ? counter() : undefined;
    const edit = buildRslFileRenameEdit(
        {
            index,
            getDocument: uri => documents.get(uri),
            log: () => undefined
        },
        [{ oldUri: OLD, newUri: NEW }]
    );

    if (stop) {
        stop();
    }
    const edits = edit?.changes?.[USER] || [];

    return { edits, text: apply(source, edits) };
}

/** Применить правки к тексту: с конца, чтобы позиции не разъезжались. */
function apply(source, edits) {
    const lineStarts = lexerModule.lexRsl(source).lineStarts;
    const offsetAt = position =>
        lineStarts[position.line] + position.character;

    return [...edits]
        .sort((left, right) =>
            offsetAt(right.range.start) - offsetAt(left.range.start))
        .reduce(
            (text, item) =>
                text.slice(0, offsetAt(item.range.start)) +
                item.newText +
                text.slice(offsetAt(item.range.end)),
            source
        );
}

const TAIL = "\nMacro Run()\n  return LibOne();\nEnd;\n";

test("Import lib;", () => {
    assert.strictEqual(
        renameWith("Import lib;" + TAIL).text,
        "Import other;" + TAIL
    );
});

test('Import "lib.mac";', () => {
    /* Прежняя машина состояний строковую форму не видела вовсе. */
    assert.strictEqual(
        renameWith('Import "lib.mac";' + TAIL).text,
        'Import "other.mac";' + TAIL
    );
});

test("Import с путём", () => {
    assert.strictEqual(
        renameWith('Import "sub/lib.mac";' + TAIL).text,
        'Import "sub/other.mac";' + TAIL,
        "путь обязан сохраниться"
    );
});

test("несколько имён в одной директиве", () => {
    assert.strictEqual(
        renameWith("Import alpha, lib, beta;" + TAIL).text,
        "Import alpha, other, beta;" + TAIL,
        "соседние имена трогать нельзя"
    );
});

test("ExecMacroFile", () => {
    const source = 'Macro Run()\n  return ExecMacroFile("lib.mac", "Go");\nEnd;\n';

    assert.strictEqual(
        renameWith(source).text,
        'Macro Run()\n  return ExecMacroFile("other.mac", "Go");\nEnd;\n'
    );
});

test("обычная строка ссылкой не считается", () => {
    const source = 'Macro Run()\n  MsgBox("lib.mac");\nEnd;\n';

    assert.deepStrictEqual(
        renameWith(source).edits,
        [],
        "текст сообщения при переименовании файла не меняется"
    );
});

test("похожее имя не трогается", () => {
    const source = "Import library;" + TAIL;

    assert.deepStrictEqual(
        renameWith(source).edits,
        [],
        "library — другое имя"
    );
});

test("несохранённые правки открытого документа учитываются", () => {
    /*
     * В индексе одна версия текста, в редакторе другая: правки обязаны
     * считаться по той, что видит пользователь.
     */
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([USER, OLD]);
    index.updateExternalModule(OLD, "Macro LibOne()\nEnd;\n", 1);

    /* В индексе прежняя версия текста, в редакторе — со вставленной строкой. */
    const saved = 'Import "lib.mac";\n\nMacro Run()\nEnd;\n';

    index.catalog.record(index.updateOpenModule(USER, saved, 1));

    const unsaved = '// новая строка\n' + saved;
    const edit = buildRslFileRenameEdit(
        {
            index,
            getDocument: uri => uri === USER
                ? TextDocument.create(USER, "rsl", 2, unsaved)
                : undefined,
            log: () => undefined
        },
        [{ oldUri: OLD, newUri: NEW }]
    );

    assert.strictEqual(
        apply(unsaved, edit?.changes?.[USER] || []),
        '// новая строка\nImport "other.mac";\n\nMacro Run()\nEnd;\n',
        "правка считается по тексту редактора, а не по отставшей модели"
    );
});

test("разобранный документ не лексируется второй раз", () => {
    const source = 'Import "lib.mac";' + TAIL;
    let calls = 0;
    /* Считаются только вызовы ВНУТРИ построения правок. */
    const count = () => {
        const original = lexerModule.lexRsl;

        lexerModule.lexRsl = function (...args) {
            calls++;

            return original.apply(this, args);
        };

        return () => {
            lexerModule.lexRsl = original;
        };
    };
    const result = renameWith(source, { open: true, count });

    assert.strictEqual(
        result.text,
        'Import "other.mac";' + TAIL,
        "правка обязана получиться"
    );
    assert.strictEqual(
        calls,
        0,
        "токены той же версии уже есть: лексировать заново незачем"
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

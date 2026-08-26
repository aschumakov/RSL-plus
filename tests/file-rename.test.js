"use strict";

/**
 * Переименование macro-файла правит ссылки на него.
 *
 * Меняются только однозначные ссылки: имя модуля в `Import` и имя файла
 * строкой в `ExecMacroFile`. Похожие имена, комментарии и собранные из кусков
 * строки не трогаются — неверная правка здесь хуже отсутствующей.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const {
    buildRslFileRenameEdit
} = require("../server/out/features/fileRenameProvider");

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

/*
 * Файлы настоящие: внешние сводки не держат ни текста, ни токенов — их
 * содержимое читается с диска ровно в момент переименования, и проверять надо
 * именно этот путь.
 */
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rsl-rename-"));
const LIB = pathToFileURL(path.join(directory, "lib.mac")).toString();
const USER = pathToFileURL(path.join(directory, "user.mac")).toString();
const OTHER = pathToFileURL(path.join(directory, "other.mac")).toString();

const USER_SOURCE = [
    "Import lib;",
    "Import library;",
    "Macro Test()",
    '  /* lib.mac упоминается в комментарии */',
    '  ExecMacroFile("lib.mac", "Target");',
    '  ExecMacroFile("library.mac", "Other");',
    "  return Helper();",
    "End;",
    ""
].join("\n");

function environment() {
    const helper = ["Macro Helper()", "End;", ""].join("\n");
    const alone = ["Macro Alone()", "End;", ""].join("\n");

    fs.writeFileSync(path.join(directory, "lib.mac"), helper);
    fs.writeFileSync(path.join(directory, "user.mac"), USER_SOURCE);
    fs.writeFileSync(path.join(directory, "other.mac"), alone);

    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([LIB, USER, OTHER]);
    index.updateExternalModule(LIB, "Macro Helper()\nEnd;\n", 1);
    index.updateExternalModule(USER, USER_SOURCE, 1);
    index.updateExternalModule(OTHER, "Macro Alone()\nEnd;\n", 1);

    return {
        index,
        getDocument: () => undefined,
        log: () => undefined
    };
}

test("Import и строка с именем файла переименовываются", () => {
    const edit = buildRslFileRenameEdit(environment(), [{
        oldUri: LIB,
        newUri: "file:///d:/rename/helpers.mac"
    }]);

    assert.ok(edit, "правки обязаны быть");

    const edits = edit.changes[USER];

    assert.strictEqual(edits.length, 2, "ожидались две правки");
    assert.deepStrictEqual(
        edits.map(item => item.newText).sort(),
        ['"helpers.mac"', "helpers"]
    );

    /* Первая правка — имя модуля в Import на первой строке. */
    const importEdit = edits.find(item => item.newText === "helpers");
    assert.strictEqual(importEdit.range.start.line, 0);
});

test("похожее имя и комментарий не трогаются", () => {
    const edit = buildRslFileRenameEdit(environment(), [{
        oldUri: LIB,
        newUri: "file:///d:/rename/helpers.mac"
    }]);
    const lines = edit.changes[USER].map(item => item.range.start.line);

    assert.ok(
        !lines.includes(1),
        "Import library переименовывать нельзя"
    );
    assert.ok(
        !lines.includes(3),
        "упоминание в комментарии — не ссылка"
    );
    assert.ok(
        !lines.includes(5),
        "library.mac — другой файл"
    );
});

test("файл без ссылок правок не получает", () => {
    const edit = buildRslFileRenameEdit(environment(), [{
        oldUri: LIB,
        newUri: "file:///d:/rename/helpers.mac"
    }]);

    assert.ok(!edit.changes[OTHER], "в other.mac менять нечего");
});

test("переименование без смены имени ничего не меняет", () => {
    const edit = buildRslFileRenameEdit(environment(), [{
        oldUri: LIB,
        newUri: "file:///d:/rename/nested/lib.mac"
    }]);

    assert.strictEqual(edit, null, "имя модуля не изменилось");
});

if (failed > 0) {
    console.error(`\nПройдено: ${passed}\nОшибок: ${failed}`);
    process.exitCode = 1;
} else {
    console.log(`\nПройдено: ${passed}\nОшибок: ${failed}`);
}

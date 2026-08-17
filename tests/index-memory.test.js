"use strict";

/**
 * Учёт объёма внешних модулей в индексе.
 *
 * Сводки закрытых файлов вытесняются не только по их числу, но и по суммарному
 * объёму: 4000 сводок по 200 КБ и 4000 по 2 МБ — величины разного порядка.
 * Работает такое вытеснение лишь при честном учёте: каждый переход модуля
 * (появился, заменён, открыт, закрыт, удалён, сброс индекса) обязан двигать
 * сумму в нужную сторону. Достаточно одного перехода, где объём прибавляется и
 * не вычитается, чтобы сумма росла сама и вытеснение начало выбрасывать
 * нужные модули.
 *
 * Поэтому здесь проверяется каждый переход по отдельности, а не только итог.
 */

const assert = require("assert");

const { WorkspaceIndex } = require("../server/out/workspaceIndex");

let passed = 0;
let failed = 0;

function test(name, action) {
    try {
        action();
        passed++;
        console.log(`[OK] ${name}`);
    } catch (error) {
        failed++;
        console.error(`[FAIL] ${name}`);
        console.error(error);
    }
}

const SMALL = "Macro Small()\nEnd;";
const LARGE = `Macro Large()\n${"  msgbox(1);\n".repeat(40)}End;`;

function createIndex(options) {
    const index = new WorkspaceIndex(options);
    index.registerWorkspaceFiles(["file:///d:/a.mac", "file:///d:/b.mac"]);
    return index;
}

test("внешний модуль появился: объём прибавлен", () => {
    const index = createIndex();

    assert.strictEqual(index.externalModuleBytes, 0);
    index.updateExternalModule("file:///d:/a.mac", SMALL, 1);
    assert.strictEqual(index.externalModuleBytes, SMALL.length);
});

test("внешний модуль заменён: объём не удваивается", () => {
    const index = createIndex();
    index.updateExternalModule("file:///d:/a.mac", SMALL, 1);
    index.updateExternalModule("file:///d:/a.mac", LARGE, 2);

    /*
     * Именно здесь и была ошибка: прибавление без вычитания прежнего значения
     * давало SMALL + LARGE для одного файла.
     */
    assert.strictEqual(index.externalModuleBytes, LARGE.length);

    index.updateExternalModule("file:///d:/a.mac", SMALL, 3);
    assert.strictEqual(index.externalModuleBytes, SMALL.length);
});

test("файл открыли: объём снят с учёта", () => {
    const index = createIndex();
    index.updateExternalModule("file:///d:/a.mac", LARGE, 1);
    index.markOpen("file:///d:/a.mac");

    /* Открытый документ не вытесняется, значит и в сумме ему места нет. */
    assert.strictEqual(index.externalModuleBytes, 0);
});

test("модель открытого документа заменила внешнюю сводку", () => {
    const index = createIndex();
    index.updateExternalModule("file:///d:/a.mac", LARGE, 1);
    index.updateOpenModule("file:///d:/a.mac", LARGE, 2);
    assert.strictEqual(index.externalModuleBytes, 0);

    /* Повторные правки открытого файла сумму тоже не двигают. */
    index.updateOpenModule("file:///d:/a.mac", SMALL, 3);
    assert.strictEqual(index.externalModuleBytes, 0);
});

test("документ закрыли и сжали: объём снова на учёте", () => {
    const index = createIndex();
    index.updateOpenModule("file:///d:/a.mac", LARGE, 1);
    assert.strictEqual(index.externalModuleBytes, 0);

    index.compactModule("file:///d:/a.mac");
    assert.strictEqual(index.externalModuleBytes, LARGE.length);
});

test("модуль удалён: объём вычтен", () => {
    const index = createIndex();
    index.updateExternalModule("file:///d:/a.mac", SMALL, 1);
    index.updateExternalModule("file:///d:/b.mac", LARGE, 1);
    assert.strictEqual(
        index.externalModuleBytes,
        SMALL.length + LARGE.length
    );

    index.removeModule("file:///d:/b.mac");
    assert.strictEqual(index.externalModuleBytes, SMALL.length);

    index.removeModule("file:///d:/a.mac");
    assert.strictEqual(index.externalModuleBytes, 0);
});

test("сброс индекса обнуляет учёт", () => {
    const index = createIndex();
    index.updateExternalModule("file:///d:/a.mac", LARGE, 1);
    index.clear();
    assert.strictEqual(index.externalModuleBytes, 0);

    /* После сброса учёт начинается заново, а не продолжает прежнюю сумму. */
    index.registerWorkspaceFiles(["file:///d:/a.mac"]);
    index.updateExternalModule("file:///d:/a.mac", SMALL, 1);
    assert.strictEqual(index.externalModuleBytes, SMALL.length);
});

test("превышение объёма вытесняет самые старые сводки", () => {
    /* Лимита хватает на два больших модуля, но не на три. */
    const index = new WorkspaceIndex({
        maxExternalBytes: LARGE.length * 2 + 1
    });
    const uris = [
        "file:///d:/one.mac",
        "file:///d:/two.mac",
        "file:///d:/three.mac"
    ];
    index.registerWorkspaceFiles(uris);

    for (const uri of uris) {
        index.updateExternalModule(uri, LARGE, 1);
    }

    assert.strictEqual(
        index.getModule(uris[0]),
        undefined,
        "Самая старая сводка обязана быть вытеснена по объёму"
    );
    assert.ok(index.getModule(uris[2]), "Последняя загруженная обязана остаться");
    assert.ok(
        index.externalModuleBytes <= LARGE.length * 2 + 1,
        `Сумма ${index.externalModuleBytes} превысила лимит: вытеснение не ` +
            "довело сумму до предела"
    );
});

console.log(`\nПройдено: ${passed}, провалено: ${failed}`);

if (failed > 0) {
    process.exitCode = 1;
}

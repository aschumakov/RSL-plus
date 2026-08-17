"use strict";

/**
 * Разбиение документа на единицы: Import и верхний уровень, Macro, Class,
 * методы класса, обработчик ошибок модуля.
 *
 * Главное свойство — устойчивость идентификаторов. Правка в начале файла
 * сдвигает все последующие единицы, и если идентификатор зависит от смещения, то
 * «изменилась одна единица» превращается в «изменились все», а вся затея теряет
 * смысл. Поэтому проверяется не только состав, но и то, что сдвиг остаётся
 * сдвигом.
 */

const assert = require("assert");

const { lexRsl } = require("../server/out/lexer");
const {
    splitRslDocumentUnits,
    diffRslDocumentUnits
} = require("../server/out/analysis/documentUnits");

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

function split(source) {
    return splitRslDocumentUnits(source, lexRsl(source).tokens);
}

/** Разбиение до и после правки: что изменилось. */
function afterEdit(source, find, insert) {
    const at = source.indexOf(find);
    assert.notStrictEqual(at, -1, `в исходнике нет ${find}`);
    const next = source.slice(0, at) + insert + source.slice(at);
    return {
        next,
        diff: diffRslDocumentUnits(split(source), split(next))
    };
}

const SOURCE = [
    "Import utils, common;",
    "Var moduleVar = 1;",
    "",
    "Macro First(a)",
    "  Var x = 1;",
    "End;",
    "",
    "Class Doc",
    "  Var field: String;",
    "  Macro Save()",
    "    x = 1;",
    "  End;",
    "  Macro Load()",
    "  End;",
    "End;",
    "",
    "Macro Second()",
    "End;",
    "",
    "OnError",
    "  msgbox(err.Message);",
    "End;"
].join("\n");

test("файл разбирается на ожидаемые единицы", () => {
    const units = split(SOURCE);

    assert.deepStrictEqual(
        units.map(unit => unit.id),
        [
            "topLevel:module",
            "macro:first",
            "class:doc",
            "method:doc.save",
            "method:doc.load",
            "macro:second",
            "onError:module"
        ],
        "порядок и состав единиц"
    );

    /* Методы лежат внутри класса, а OnError модуля — вне всего. */
    const byId = new Map(units.map(unit => [unit.id, unit]));
    const doc = byId.get("class:doc");
    const save = byId.get("method:doc.save");
    assert.ok(
        save.start > doc.start && save.end < doc.end,
        "метод обязан лежать внутри своего класса"
    );

    const onError = byId.get("onError:module");
    for (const unit of units) {
        if (unit.kind === "macro" || unit.kind === "class") {
            assert.ok(
                unit.end <= onError.start,
                `${unit.id} не должен захватывать OnError модуля`
            );
        }
    }
});

test("одноимённые объявления получают разные идентификаторы", () => {
    const units = split([
        "Macro Same()",
        "End;",
        "Macro Same()",
        "End;"
    ].join("\n"));
    const ids = units.map(unit => unit.id);

    assert.deepStrictEqual(
        ids,
        ["topLevel:module", "macro:same", "macro:same#1"],
        "иначе две единицы получили бы один ключ"
    );
    assert.strictEqual(new Set(ids).size, ids.length);
});

test("правка внутри Macro делает грязным только его", () => {
    const { diff } = afterEdit(SOURCE, "  Var x = 1;", "  Var added = 2;\n");

    assert.deepStrictEqual(
        diff.changed.map(unit => unit.id),
        ["macro:first"],
        "пересчитать нужно ровно одну единицу"
    );
    assert.deepStrictEqual(diff.added, []);
    assert.deepStrictEqual(diff.removed, []);
    /* Остальным нужен только перенос смещений, а не анализ. */
    assert.ok(
        diff.shifted.some(unit => unit.id === "class:doc"),
        "последующие единицы обязаны попасть в сдвинутые, а не в изменённые"
    );
});

test("правка в теле метода не делает грязными соседние методы", () => {
    const { diff } = afterEdit(SOURCE, "    x = 1;", "    y = 2;\n");
    const changed = diff.changed.map(unit => unit.id).sort();

    /*
     * Класс тоже грязен: его текст включает тело метода. Но соседний метод —
     * нет, и именно это позволяет не разбирать его заново.
     */
    assert.deepStrictEqual(
        changed,
        ["class:doc", "method:doc.save"],
        "грязными обязаны стать метод и его класс, но не соседний метод"
    );
    assert.ok(
        diff.shifted.some(unit => unit.id === "method:doc.load"),
        "соседний метод обязан оказаться лишь сдвинутым"
    );
});

test("правка Import делает грязным верхний уровень", () => {
    const { diff } = afterEdit(SOURCE, "Import utils", "Import extra, ");

    assert.ok(
        diff.changed.some(unit => unit.id === "topLevel:module"),
        "Import относится к верхнему уровню"
    );
    assert.ok(
        !diff.changed.some(unit => unit.kind === "macro"),
        "и не делает грязными сами Macro"
    );
});

test("правка выше по файлу не меняет идентификаторы", () => {
    /*
     * То самое свойство, ради которого идентификатор не содержит смещения.
     * Правка в самом начале сдвигает всё, и без устойчивых ключей каждая
     * единица выглядела бы новой.
     */
    const { diff } = afterEdit(SOURCE, "Var moduleVar", "Var inserted = 0;\n");

    assert.deepStrictEqual(
        diff.added,
        [],
        "сдвиг не имеет права выглядеть появлением новых единиц"
    );
    assert.deepStrictEqual(
        diff.removed,
        [],
        "и исчезновением прежних"
    );
    assert.deepStrictEqual(
        diff.changed.map(unit => unit.id),
        ["topLevel:module"],
        "изменился только верхний уровень"
    );
    assert.strictEqual(
        diff.shifted.length + diff.unchanged.length,
        split(SOURCE).length - 1,
        "все остальные единицы обязаны переиспользоваться"
    );
});

test("переименование Macro — это исчезновение и появление", () => {
    const renamed = SOURCE.replace("Macro First(a)", "Macro Renamed(a)");
    const diff = diffRslDocumentUnits(split(SOURCE), split(renamed));

    assert.deepStrictEqual(
        diff.removed.map(unit => unit.id),
        ["macro:first"]
    );
    assert.deepStrictEqual(
        diff.added.map(unit => unit.id),
        ["macro:renamed"],
        "результаты прежней единицы нужно выбросить, а новую посчитать"
    );
});

test("единицы не пересекаются и покрывают объявления", () => {
    const units = split(SOURCE).filter(unit => unit.kind !== "topLevel");
    const blocks = units.filter(unit => unit.kind !== "method");

    /* Верхнеуровневые блоки не имеют права накладываться друг на друга. */
    const sorted = blocks.slice().sort((left, right) => left.start - right.start);
    for (let index = 1; index < sorted.length; index++) {
        assert.ok(
            sorted[index].start >= sorted[index - 1].end,
            `${sorted[index].id} пересекается с ${sorted[index - 1].id}`
        );
    }

    for (const unit of units) {
        assert.ok(unit.end > unit.start, `${unit.id}: пустой диапазон`);
        assert.ok(unit.hash.length > 0, `${unit.id}: нет хеша`);
    }
});

test("файл без Macro и Class — это один верхний уровень", () => {
    const units = split("Import utils;\nVar x = 1;\nmsgbox(x);");

    assert.deepStrictEqual(units.map(unit => unit.id), ["topLevel:module"]);
});

if (failed > 0) {
    console.error(`\nПройдено: ${passed}\nОшибок: ${failed}`);
    process.exitCode = 1;
} else {
    console.log(`\nПройдено: ${passed}\nОшибок: ${failed}`);
}

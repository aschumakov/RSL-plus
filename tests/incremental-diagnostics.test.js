"use strict";

/*
 * Инкрементальные диагностики против полного расчёта.
 *
 * Кэш по единицам документа имеет право экономить работу и не имеет права
 * менять ответ. Поэтому каждая правка проверяется так: тот же текст считается
 * второй раз с чистым кэшем — в другом файле, где прошлой версии нет, — и два
 * результата должны совпасть до последнего символа сообщения и позиции.
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
const { buildRslDiagnostics } = require("../server/out/diagnostics");
const {
    planRslUnitDiagnostics
} = require("../server/out/diagnostics/unitDiagnosticsCache");

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

const EDITED = "file:///edited.mac";

/** Диагностики документа в его текущей версии. */
function diagnose(index, uri, source, version) {
    const module = index.updateOpenModule(uri, source, version);

    return buildRslDiagnostics(module, index, {});
}

/** Сравнимый вид: без порядка и без ссылок на объекты. */
function normalize(diagnostics) {
    return diagnostics
        .map(item => JSON.stringify({
            code: item.code,
            severity: item.severity,
            message: item.message,
            range: item.range,
            data: item.data === undefined ? null : item.data,
            related: (item.relatedInformation || []).map(entry => ({
                message: entry.message,
                range: entry.location.range
            }))
        }))
        .sort();
}

/**
 * Полный расчёт того же текста.
 *
 * Считается в отдельном файле и отдельном индексе: у этого uri прошлой версии
 * нет, значит кэш единиц ничего не переиспользует, и ответ получается таким,
 * каким был бы при первом открытии.
 */
function fullDiagnostics(source, referenceUri) {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([referenceUri]);

    return diagnose(index, referenceUri, source, 1);
}

/**
 * Прогоняет цепочку правок и сверяет каждую версию с полным расчётом.
 *
 * Правки идут одна за другой в одном документе — именно так работает редактор,
 * и именно так накапливается ошибка кэша: неверно перенесённая запись живёт до
 * закрытия файла.
 */
function checkEdits(name, versions) {
    test(name, () => {
        const index = new WorkspaceIndex();
        index.registerWorkspaceFiles([EDITED]);

        versions.forEach((source, step) => {
            const incremental = normalize(
                diagnose(index, EDITED, source, step + 1)
            );
            /* Уникальный uri на шаг: иначе кэш эталона стал бы кэшем правок. */
            const full = normalize(
                fullDiagnostics(source, `file:///reference-${step}.mac`)
            );

            assert.deepStrictEqual(
                incremental,
                full,
                `шаг ${step + 1}: инкрементальный ответ расходится с полным`
            );
        });
    });
}

const BASE = [
    "Import lib;",
    "",
    "Macro First()",
    "  Var a: BtFileRef;",
    "  return a;",
    "End;",
    "",
    "Macro Second()",
    "  Var text = \"строка\";",
    "  return text;",
    "End;",
    "",
    "Macro Third()",
    "  DebugBreak;",
    "  return 1;",
    "End;",
    ""
].join("\n");

/** Тот же текст с заменой одной строки. */
function replaced(line, text) {
    const lines = BASE.split("\n");
    lines[line] = text;

    return lines.join("\n");
}

checkEdits("повторный расчёт без правок даёт тот же ответ", [BASE, BASE]);

checkEdits("находка появляется в теле Macro", [
    BASE,
    replaced(8, "  Var text = \"незакрытая;")
]);

checkEdits("находка исчезает из тела Macro", [
    replaced(8, "  Var text = \"незакрытая;"),
    BASE
]);

checkEdits("устаревшее объявление убрано правкой", [
    BASE,
    replaced(3, "  Var a: Tbfile;"),
    BASE
]);

checkEdits("отладочный BREAK убран и возвращён", [
    BASE,
    replaced(13, "  Var b = 1;"),
    BASE,
    replaced(13, "  DebugBreak;")
]);

checkEdits("правка выше по файлу сдвигает остальные единицы", [
    BASE,
    BASE.replace("Import lib;", "Import lib;\nImport other;\nImport third;"),
    BASE.replace("Import lib;", "")
]);

checkEdits("Macro добавлена и удалена", [
    BASE,
    BASE + "\nMacro Fourth()\n  Var c: StrucRef;\nEnd;\n",
    BASE
]);

checkEdits("Macro переименована", [
    BASE,
    BASE.replace("Macro Second()", "Macro Renamed()"),
    BASE
]);

checkEdits("правка на верхнем уровне", [
    BASE,
    BASE.replace("Import lib;", "Import lib;\nVar модуль: DbfFileRef;"),
    BASE
]);

checkEdits("класс: правка в методе и правка в самом классе", [
    [
        "Class Storage;",
        "  Var поле: ArrayRef;",
        "  Macro Save()",
        "    Var a: TxtFileRef;",
        "  End;",
        "  Macro Load()",
        "    return 1;",
        "  End;",
        "End;",
        ""
    ].join("\n"),
    [
        "Class Storage;",
        "  Var поле: ArrayRef;",
        "  Macro Save()",
        "    Var a: Tbfile;",
        "  End;",
        "  Macro Load()",
        "    return 1;",
        "  End;",
        "End;",
        ""
    ].join("\n"),
    [
        "Class Storage;",
        "  Var поле: Integer;",
        "  Macro Save()",
        "    Var a: Tbfile;",
        "  End;",
        "  Macro Load()",
        "    DebugBreak;",
        "  End;",
        "End;",
        ""
    ].join("\n")
]);

checkEdits("незавершённый текст в процессе набора", [
    BASE,
    replaced(4, "  return a"),
    replaced(4, "  return a."),
    replaced(4, "  return a.Name"),
    BASE
]);

test("правка одной Macro оставляет остальные единицы нетронутыми", () => {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([EDITED]);

    diagnose(index, EDITED, BASE, 1);
    const module = index.updateOpenModule(
        EDITED,
        replaced(14, "  return 2;"),
        2
    );
    /*
     * План строится по той же записи кэша, что и при расчёте: важно, что
     * пересчитывается ровно задетая единица, а не файл целиком.
     */
    const plan = planRslUnitDiagnostics(module, cachedEntry(module));

    assert.strictEqual(plan.full, false, "прошлая версия найдена");
    assert.deepStrictEqual(
        plan.stale.map(unit => unit.id),
        ["macro:third"],
        "пересчитывается только правленная Macro"
    );
    assert.ok(
        plan.keep.length >= 3,
        "остальные единицы переиспользуются: " + plan.keep.length
    );
});

test("правка не переносит находку из пересчитанной единицы", () => {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([EDITED]);

    diagnose(index, EDITED, BASE, 1);
    const fixed = diagnose(index, EDITED, replaced(3, "  Var a: Tbfile;"), 2);

    assert.strictEqual(
        fixed.filter(item => item.code === "deprecated-declaration").length,
        0,
        "исправленное объявление больше не отмечено"
    );
});

/**
 * Запись кэша для того же файла.
 *
 * Кэш внутренний, наружу его не выдают: план перестраивается по прошлому
 * разбиению того же документа — этого достаточно, чтобы проверить состав
 * пересчёта.
 */
function cachedEntry(module) {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([EDITED]);
    const previous = index.updateOpenModule(EDITED, BASE, 1);
    const plan = planRslUnitDiagnostics(previous, undefined);

    return {
        uri: module.uri,
        version: previous.version,
        source: previous.source,
        units: plan.units,
        byUnit: new Map()
    };
}

console.log(`\nПройдено: ${passed}, провалено: ${failed}`);

if (failed > 0) {
    process.exit(1);
}

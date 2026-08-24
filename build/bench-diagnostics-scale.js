"use strict";

/*
 * Как растёт диагностика с размером файла.
 *
 * Здесь проверяется не абсолютное время, а его РОСТ: три последних дефекта
 * подряд были квадратичностями, и каждая из них становилась видна только на
 * крупном файле — на тысяче элементов все они выглядели линейными.
 *
 * Сценарии выбраны по этим дефектам:
 *
 * 1. Области с VAR — проверка необъявленных имён включена по умолчанию.
 * 2. Обращения через точку — проверка состава классов идёт тем же обходом.
 * 3. Вызовы SetParm вне процедур — худший случай для поиска объемлющей
 *    процедуры: обходить назад приходится всё, что выше.
 *
 * Запуск:
 *   node --expose-gc build/bench-diagnostics-scale.js [максимальный размер]
 */

const path = require("path");

const outDir = path.join(__dirname, "..", "server", "out");
const { WorkspaceIndex } = require(path.join(outDir, "workspaceIndex"));
const {
    RslDiagnosticEngine
} = require(path.join(outDir, "diagnostics", "diagnosticEngine"));

const MAX = Number(process.argv[2] || 16000);
const URI = "file:///d:/bench/scale.mac";
/* Рост на удвоение: линейный ответ держится около двух. */
const TARGET_RATIO = 2.5;

const SCENARIOS = [
    {
        name: "области с VAR",
        lines: index => [
            "Macro Proc" + index + "(argument)",
            "  Var local" + index + " = argument;",
            "  implicit" + index + " = local" + index + ";",
            "  return implicit" + index + ";",
            "End;",
            ""
        ]
    },
    {
        name: "обращения через точку",
        prologue: [
            "Class TLocal()",
            "  Var Field;",
            "End;",
            "Macro Test()",
            "  Var thing: TLocal = TLocal();",
            "  Var total = 0;"
        ],
        lines: () => ["  total = total + thing.Field;"],
        epilogue: ["  return total;", "End;", ""]
    },
    {
        name: "SetParm вне процедур",
        lines: index => [
            "Macro Proc" + index + "(p0, p1, p2)",
            "  Var value = 1;",
            "  return value;",
            "End;",
            "SetParm(1, " + index + ");",
            ""
        ]
    }
];

function build(scenario, count) {
    const lines = [...(scenario.prologue || [])];

    for (let index = 0; index < count; index++) {
        lines.push(...scenario.lines(index));
    }

    lines.push(...(scenario.epilogue || []));

    return lines.join("\n");
}

function measure(scenario, count) {
    const source = build(scenario, count);
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([URI]);
    const module = index.updateOpenModule(URI, source, 1);
    const engine = new RslDiagnosticEngine();
    let best = Infinity;

    /*
     * Минимум из пяти замеров, и перед каждым — сборка мусора, если она
     * доступна (--expose-gc).
     *
     * Без этого в результат попадает уборка за предыдущим сценарием: файлы
     * здесь по мегабайту, и рост выглядит квадратичным там, где его нет.
     */
    for (let run = 0; run < 5; run++) {
        if (global.gc) {
            global.gc();
        }

        const started = process.hrtime.bigint();
        engine.buildLocal(module, index);
        best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
    }

    return { ms: best, chars: source.length };
}

const sizes = [];

for (let count = 2000; count <= MAX; count *= 2) {
    sizes.push(count);
}

for (const scenario of SCENARIOS) {
    console.log(scenario.name + ":");
    let previous = 0;
    let worstRatio = 0;

    for (const count of sizes) {
        const result = measure(scenario, count);
        const ratio = previous ? result.ms / previous : 0;
        worstRatio = Math.max(worstRatio, ratio);

        console.log(
            "  " + String(count).padStart(6) + " элементов, " +
            String(Math.round(result.chars / 1024)).padStart(4) + " КБ: " +
            result.ms.toFixed(0).padStart(5) + " мс" +
            (ratio ? "  рост ×" + ratio.toFixed(1) : "")
        );
        previous = result.ms;
    }

    console.log(
        "  худший рост ×" + worstRatio.toFixed(1) +
        "  (цель \u2264 " + TARGET_RATIO + " — " +
        (worstRatio <= TARGET_RATIO ? "да" : "НЕТ") + ")"
    );
}

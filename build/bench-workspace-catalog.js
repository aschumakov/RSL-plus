"use strict";

/*
 * Каталог проекта: время построения, память и стабильность ответа.
 *
 * Размер по умолчанию — 5800 файлов: столько .mac в рабочем проекте, ради
 * которого каталог и заводился. Прежний Ctrl+T видел только загруженные
 * подробные модели (их предел — четыре тысячи) и обрывал перебор на двухсотом
 * совпадении до сортировки.
 *
 *   node --expose-gc build/bench-workspace-catalog.js [файлов]
 */

const path = require("path");

const outDir = path.join(__dirname, "..", "server", "out");
const { WorkspaceIndex } = require(path.join(outDir, "workspaceIndex"));
const {
    findRslWorkspaceSymbols
} = require(path.join(outDir, "features", "workspaceSymbolProvider"));

const FILES = Number(process.argv[2] || 5800);

function source(index) {
    return [
        "Import common;",
        "Macro Process" + index + "(document, options)",
        "  Var result = 0;",
        "  return result;",
        "End;",
        "Macro Check" + index + "(value)",
        "  return value;",
        "End;",
        "Class Handler" + index,
        "  Var State;",
        "  Macro Run()",
        "    return State;",
        "  End;",
        "End;",
        ""
    ].join("\n");
}

function memoryMb() {
    if (global.gc) {
        global.gc();
    }

    return process.memoryUsage().heapUsed / (1024 * 1024);
}

function build(order) {
    const index = new WorkspaceIndex();
    const uris = [];

    for (let file = 0; file < FILES; file++) {
        uris.push(
            "file:///d:/project/module" + String(file).padStart(5, "0") + ".mac"
        );
    }

    index.registerWorkspaceFiles(uris);

    const started = process.hrtime.bigint();

    for (const position of order(FILES)) {
        index.updateExternalModule(uris[position], source(position), 1);
    }

    return {
        index,
        ms: Number(process.hrtime.bigint() - started) / 1e6
    };
}

const FORWARD = length => Array.from({ length }, (_, index) => index);
const BACKWARD = length => FORWARD(length).reverse();

const before = memoryMb();
const forward = build(FORWARD);
const after = memoryMb();
const stats = forward.index.catalog.stats;

console.log("файлов: " + FILES);
console.log(
    "  построение каталога вместе с разбором: " +
    forward.ms.toFixed(0) + " мс"
);
console.log(
    "  в каталоге: " + stats.modules + " модулей, " + stats.symbols +
    " символов, ~" + (stats.approximateBytes / (1024 * 1024)).toFixed(1) + " МБ"
);
console.log(
    "  куча после построения: " + after.toFixed(1) + " МБ (было " +
    before.toFixed(1) + " МБ)"
);
console.log(
    "  подробных моделей в памяти: " +
    forward.index.getIndexedModules().length
);

const queries = ["Process", "Handler42", "Check", "Run", "zzz"];

for (const query of queries) {
    let best = Number.POSITIVE_INFINITY;

    for (let run = 0; run < 5; run++) {
        const started = process.hrtime.bigint();
        findRslWorkspaceSymbols(forward.index, query);
        best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
    }

    console.log(
        "  Ctrl+T «" + query + "»: " + best.toFixed(1) + " мс, найдено " +
        findRslWorkspaceSymbols(forward.index, query).length
    );
}

/* Повторяемость: другой порядок загрузки — тот же ответ. */
const backward = build(BACKWARD);
const sameAnswer = queries.every(query => {
    const left = findRslWorkspaceSymbols(forward.index, query)
        .map(item => item.name + "@" + item.location.uri).join("|");
    const right = findRslWorkspaceSymbols(backward.index, query)
        .map(item => item.name + "@" + item.location.uri).join("|");

    return left === right;
});

console.log(
    "  ответ не зависит от порядка загрузки: " + (sameAnswer ? "да" : "НЕТ")
);

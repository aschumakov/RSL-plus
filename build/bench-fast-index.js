"use strict";

/*
 * Замер индекса версии: память и время построения.
 *
 * Индекс версии — то, чем сервер отвечает на подсказки, переходы и Hover, пока
 * разбор ещё идёт. Он строится на каждую версию текста, поэтому и цена его
 * построения, и объём памяти видны пользователю напрямую: первым запросом
 * после правки и общим расходом памяти на открытых файлах.
 *
 * Образец нарочно насыщен процедурами: именно на нём видно, во что обходится
 * хранение подписей.
 *
 * Запуск:
 *   node --expose-gc build/bench-fast-index.js [число-процедур]
 *
 * Без --expose-gc замер памяти приблизительный: heap не собран.
 */

const path = require("path");

const outDir = path.join(__dirname, "..", "server", "out");
const {
    getFastCompletionIndex,
    dropFastCompletionIndex
} = require(path.join(outDir, "features", "fastCompletionIndex"));
const {
    createFastDocumentSnapshot
} = require(path.join(outDir, "services", "fastDocumentSnapshot"));
const {
    TextDocument
} = require(path.join(
    __dirname,
    "..",
    "server",
    "node_modules",
    "vscode-languageserver-textdocument"
));

const COUNT = Number(process.argv[2] || 10000);
const RUNS = 21;
const URI = "file:///d:/bench/fast-index.mac";
/* Цель: индекс строится незаметно для первого запроса после правки. */
const TARGET_BUILD_MS = 60;

function sample(count) {
    const lines = ["Import lib;"];

    for (let index = 0; index < count; index++) {
        lines.push(
            "Macro P" + index + "(a: String, b): Integer",
            "  return b;",
            "End;",
            ""
        );
    }

    return lines.join("\n");
}

function heapUsedMib() {
    if (global.gc) {
        global.gc();
        global.gc();
    }

    return process.memoryUsage().heapUsed / (1024 * 1024);
}

function median(values) {
    const sorted = [...values].sort((left, right) => left - right);

    return sorted[Math.floor(sorted.length / 2)];
}

const source = sample(COUNT);
const document = TextDocument.create(URI, "rsl", 1, source);
const times = [];

for (let run = 0; run < RUNS; run++) {
    dropFastCompletionIndex(URI);
    const snapshot = createFastDocumentSnapshot(document);
    const started = process.hrtime.bigint();
    getFastCompletionIndex(snapshot);
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
}

/*
 * Память меряется как разница: снимок текста живёт своей жизнью, и его вес к
 * индексу отношения не имеет.
 */
dropFastCompletionIndex(URI);
const snapshot = createFastDocumentSnapshot(document);
getFastCompletionIndex(snapshot);
dropFastCompletionIndex(URI);
const withoutIndex = heapUsedMib();
const index = getFastCompletionIndex(snapshot);
const withIndex = heapUsedMib();
const build = median(times);

console.log(
    "образец " + Math.round(source.length / 1024) + " КБ, процедур " + COUNT
);
console.log(
    "построение: медиана " + build.toFixed(1) +
    " мс, минимум " + Math.min(...times).toFixed(1) +
    " мс, максимум " + Math.max(...times).toFixed(1) + " мс" +
    "  (цель \u2264 " + TARGET_BUILD_MS + " мс — " +
    (build <= TARGET_BUILD_MS ? "да" : "НЕТ") + ")"
);
console.log(
    "память индекса: " + (withIndex - withoutIndex).toFixed(2) + " МиБ" +
    (global.gc ? "" : " (без --expose-gc число приблизительное)")
);
console.log(
    "записей: подписей " + [...index.signatures.values()]
        .reduce((sum, list) => sum + list.length, 0) +
    ", объявлений по областям " + [...index.scopeBindings.values()]
        .reduce((sum, list) => sum + list.length, 0) +
    ", классов " + index.classes.size
);

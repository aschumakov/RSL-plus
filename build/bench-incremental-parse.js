"use strict";

/*
 * Правка большого файла: разбор и модель.
 *
 * Пользователь ждёт не разбора, а Problems и подсказок, поэтому мерится вся
 * цепочка: точечный lex, точечный разбор, объявления, дерево символов. Рядом —
 * то же самое полным путём, чтобы видеть, за что заплачено.
 *
 *   node --expose-gc build/bench-incremental-parse.js [процедур] [правок]
 */

const path = require("path");

const outDir = path.join(__dirname, "..", "server", "out");
const { lexRsl } = require(path.join(outDir, "lexer"));
const { parseRslSyntax } = require(path.join(outDir, "syntaxParser"));
const {
    tryIncrementalRelex
} = require(path.join(outDir, "services", "incrementalLex"));
const {
    createRslModelState,
    tryUpdateRslModelState
} = require(path.join(outDir, "services", "incrementalModel"));
const {
    createOpenModuleModel
} = require(path.join(outDir, "moduleModel"));

const PROCEDURES = Number(process.argv[2] || 2600);
const EDITS = Number(process.argv[3] || 60);

function sample(count) {
    const lines = ["Import common;", ""];

    for (let index = 0; index < count; index++) {
        lines.push(
            "Macro Process" + index + "(document, options)",
            "  Var result = 0;",
            "  Var total = 0;",
            "  if (options == 1)",
            "    result = document.Value + total;",
            "  end;",
            "  for (position = 0; position < 10; position = position + 1)",
            "    total = total + position;",
            "  end;",
            "  return result;",
            "End;",
            ""
        );
    }

    return lines.join("\n");
}

function percentile(values, fraction) {
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(
        sorted.length - 1,
        Math.floor(sorted.length * fraction)
    );

    return sorted[index];
}

function report(title, values) {
    console.log(
        "  " + title.padEnd(38) +
        "p50 " + percentile(values, 0.5).toFixed(1) +
        ", p95 " + percentile(values, 0.95).toFixed(1) +
        ", максимум " + Math.max(...values).toFixed(1) + " мс"
    );
}

function memoryMb() {
    if (global.gc) {
        global.gc();
    }

    return process.memoryUsage().heapUsed / (1024 * 1024);
}

const source = sample(PROCEDURES);

console.log(
    "файл " + Math.round(source.length / 1024) + " КБ, " + PROCEDURES +
    " процедур, правок " + EDITS
);

/* Точки правки: внутри тел процедур, равномерно по файлу. */
const anchors = [];
let searchFrom = source.indexOf("  total = total + position;");

while (anchors.length < EDITS && searchFrom > 0) {
    anchors.push(searchFrom);
    searchFrom = source.indexOf(
        "  total = total + position;",
        searchFrom + Math.floor(source.length / EDITS)
    );
}

const baseLex = lexRsl(source, { includeTrivia: true });
const baseParse = parseRslSyntax(source, baseLex, {
    buildExpressionTree: false
});
const baseState = createRslModelState(source, baseParse).state;

const incremental = { lex: [], parse: [], model: [], total: [] };
const full = { lex: [], parse: [], model: [], total: [] };
const reasons = new Map();
const parts = [];
const before = memoryMb();

for (const at of anchors) {
    const edited = source.slice(0, at) +
        "  total = total + position + 1;" +
        source.slice(at + "  total = total + position;".length);

    /* ── точечный путь ─────────────────────────────────────────────────── */
    let started = process.hrtime.bigint();
    const lex = tryIncrementalRelex(source, baseLex, edited) ||
        lexRsl(edited, { includeTrivia: true });
    const lexMs = Number(process.hrtime.bigint() - started) / 1e6;

    started = process.hrtime.bigint();
    let reason = "full";
    const update = tryUpdateRslModelState(
        baseState,
        edited,
        lex,
        decision => { reason = decision.reason; parts.push(decision); }
    );
    const parseMs = Number(process.hrtime.bigint() - started) / 1e6;

    started = process.hrtime.bigint();

    if (!update) {
        createOpenModuleModel(
            edited,
            parseRslSyntax(edited, lex, { buildExpressionTree: false })
        );
    }

    const modelMs = Number(process.hrtime.bigint() - started) / 1e6;

    reasons.set(reason, (reasons.get(reason) || 0) + 1);
    incremental.lex.push(lexMs);
    incremental.parse.push(parseMs);
    incremental.model.push(modelMs);
    incremental.total.push(lexMs + parseMs + modelMs);

    /* ── полный путь ──────────────────────────────────────────────────── */
    started = process.hrtime.bigint();
    const fullLex = lexRsl(edited, { includeTrivia: true });
    const fullLexMs = Number(process.hrtime.bigint() - started) / 1e6;

    started = process.hrtime.bigint();
    const fullParse = parseRslSyntax(edited, fullLex, {
        buildExpressionTree: false
    });
    const fullParseMs = Number(process.hrtime.bigint() - started) / 1e6;

    started = process.hrtime.bigint();
    createOpenModuleModel(edited, fullParse);
    const fullModelMs = Number(process.hrtime.bigint() - started) / 1e6;

    full.lex.push(fullLexMs);
    full.parse.push(fullParseMs);
    full.model.push(fullModelMs);
    full.total.push(fullLexMs + fullParseMs + fullModelMs);
}

const after = memoryMb();

console.log("точечный путь:");
report("lex", incremental.lex);
report("разбор и модель", incremental.parse);
report("добор полным путём", incremental.model);
report("итого до готовой модели", incremental.total);

console.log("полный путь:");
report("lex", full.lex);
report("разбор", full.parse);
report("модель (объявления и символы)", full.model);
report("итого до готовой модели", full.total);

console.log(
    "  причины: " + [...reasons.entries()]
        .map(([reason, count]) => reason + " " + count)
        .join(", ")
);
console.log(
    "  доля правок одной единицей: " +
    Math.round(((reasons.get("incremental") || 0) / anchors.length) * 100) + "%"
);
const numeric = key => parts.filter(item => typeof item[key] === "number").map(item => item[key]);
for (const key of ["unitParseMs", "shiftMs", "tokensMs"]) {
    const values = numeric(key);

    if (values.length > 0) {
        report("  из них " + key, values);
    }
}
console.log(
    "  куча: " + before.toFixed(1) + " -> " + after.toFixed(1) + " МБ"
);

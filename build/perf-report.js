"use strict";

/**
 * Сводка по журналу производительности.
 *
 * Журнал пишет по записи на операцию, без агрегации: так горячий путь не платит
 * за подсчёт персентилей. Считать их — работа этого отчёта.
 *
 *   node build/perf-report.js <путь-к-журналу>
 *   node build/perf-report.js <путь> --event analysis.full
 *
 * Что отвечает на что:
 *   p50/p95/max      — сколько операция стоит обычно и в худшем случае;
 *   блокировка       — сколько подряд поток не отвечал (blockingMs);
 *   повторный разбор — одна и та же версия файла разобрана дважды и более;
 *   причины lex      — почему правка пошла полным путём, а не точечным;
 *   ожидание очереди — сколько задача простояла до старта;
 *   память           — пик и рост за сессию.
 */

const fs = require("fs");

function percentile(sorted, fraction) {
    if (sorted.length === 0) {
        return 0;
    }

    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);

    if (lower === upper) {
        return sorted[lower];
    }

    return sorted[lower] +
        (sorted[upper] - sorted[lower]) * (position - lower);
}

function ms(value) {
    return `${value.toFixed(1)} мс`;
}

function mb(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

/** Разбор журнала: битые строки пропускаются, а не роняют отчёт. */
function readRecords(file) {
    const records = [];
    let skipped = 0;

    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) {
            continue;
        }

        try {
            records.push(JSON.parse(line));
        } catch (error) {
            skipped++;
        }
    }

    return { records, skipped };
}

function summarize(records, eventFilter) {
    const byEvent = new Map();
    const blocking = [];
    const queueWaits = [];
    const lexReasons = new Map();
    /* Ключ «файл@версия» -> сколько раз его разбирали. */
    const parsesByVersion = new Map();
    let peakRss = 0;
    let peakHeap = 0;
    let firstRss;
    let lastRss;

    for (const record of records) {
        const event = String(record.event || "");

        if (eventFilter && event !== eventFilter) {
            continue;
        }

        if (typeof record.durationMs === "number") {
            const list = byEvent.get(event) || [];
            list.push(record.durationMs);
            byEvent.set(event, list);
        }

        if (typeof record.blockingMs === "number") {
            blocking.push({ event, value: record.blockingMs });
        }

        if (typeof record.queueWaitMs === "number") {
            queueWaits.push(record.queueWaitMs);
        }

        if (record.lexReason) {
            const reason = String(record.lexReason);
            lexReasons.set(reason, (lexReasons.get(reason) || 0) + 1);
        }

        /*
         * Повторный разбор одной версии — это работа, которой не должно было
         * быть. Единицей пока служит файл: блоков в модели ещё нет, и когда они
         * появятся, здесь сменится только ключ.
         */
        if (
            event === "analysis.full" &&
            record.cancelled !== true &&
            record.uri !== undefined &&
            record.version !== undefined
        ) {
            const key = `${record.uri}@${record.version}`;
            parsesByVersion.set(key, (parsesByVersion.get(key) || 0) + 1);
        }

        for (const field of ["rssBytes", "rssAfterBytes"]) {
            if (typeof record[field] === "number") {
                peakRss = Math.max(peakRss, record[field]);
                if (firstRss === undefined) {
                    firstRss = record[field];
                }
                lastRss = record[field];
            }
        }

        for (const field of ["heapUsedBytes", "heapUsedAfterBytes"]) {
            if (typeof record[field] === "number") {
                peakHeap = Math.max(peakHeap, record[field]);
            }
        }
    }

    return {
        byEvent,
        blocking,
        queueWaits,
        lexReasons,
        parsesByVersion,
        peakRss,
        peakHeap,
        firstRss,
        lastRss
    };
}

function printReport(summary, records, skipped) {
    console.log(`Записей: ${records.length}` +
        (skipped > 0 ? `, нечитаемых пропущено: ${skipped}` : ""));

    const events = Array.from(summary.byEvent.entries())
        .map(([event, values]) => {
            const sorted = values.slice().sort((left, right) => left - right);
            return {
                event,
                count: values.length,
                p50: percentile(sorted, 0.5),
                p95: percentile(sorted, 0.95),
                max: sorted[sorted.length - 1],
                total: values.reduce((sum, value) => sum + value, 0)
            };
        })
        .sort((left, right) => right.total - left.total);

    if (events.length > 0) {
        console.log("\n=== длительности ===");
        console.log(
            "событие".padEnd(30) + "вызовов".padStart(9) +
            "p50".padStart(11) + "p95".padStart(11) + "max".padStart(11)
        );
        for (const row of events) {
            console.log(
                row.event.padEnd(30) +
                String(row.count).padStart(9) +
                ms(row.p50).padStart(11) +
                ms(row.p95).padStart(11) +
                ms(row.max).padStart(11)
            );
        }
    }

    if (summary.blocking.length > 0) {
        const sorted = summary.blocking
            .map(item => item.value)
            .sort((left, right) => left - right);
        const worst = summary.blocking.reduce(
            (best, item) => (item.value > best.value ? item : best)
        );
        console.log("\n=== непрерывная блокировка потока ===");
        console.log(
            `фаз: ${summary.blocking.length}, ` +
            `p50 ${ms(percentile(sorted, 0.5))}, ` +
            `p95 ${ms(percentile(sorted, 0.95))}, ` +
            `худшая ${ms(worst.value)} в ${worst.event}`
        );
    }

    if (summary.queueWaits.length > 0) {
        const sorted = summary.queueWaits.slice()
            .sort((left, right) => left - right);
        console.log("\n=== ожидание в очереди разбора ===");
        console.log(
            `задач: ${sorted.length}, ` +
            `p50 ${ms(percentile(sorted, 0.5))}, ` +
            `p95 ${ms(percentile(sorted, 0.95))}, ` +
            `худшее ${ms(sorted[sorted.length - 1])}`
        );
    }

    const repeated = Array.from(summary.parsesByVersion.entries())
        .filter(([, count]) => count > 1)
        .sort((left, right) => right[1] - left[1]);

    console.log("\n=== повторный разбор одной версии ===");
    if (repeated.length === 0) {
        console.log(
            `версий разобрано: ${summary.parsesByVersion.size}, ` +
            "повторов нет"
        );
    } else {
        const wasted = repeated.reduce(
            (sum, [, count]) => sum + count - 1,
            0
        );
        console.log(
            `версий разобрано: ${summary.parsesByVersion.size}, ` +
            `с повторами: ${repeated.length}, ` +
            `лишних разборов: ${wasted}`
        );
        for (const [key, count] of repeated.slice(0, 10)) {
            console.log(`  ${count}x ${key}`);
        }
    }

    if (summary.lexReasons.size > 0) {
        console.log("\n=== выбор пути лексирования ===");
        const total = Array.from(summary.lexReasons.values())
            .reduce((sum, value) => sum + value, 0);
        for (const [reason, count] of Array.from(summary.lexReasons.entries())
            .sort((left, right) => right[1] - left[1])) {
            const share = ((count / total) * 100).toFixed(0);
            console.log(`  ${reason.padEnd(20)} ${String(count).padStart(6)}` +
                ` (${share}%)`);
        }
    }

    if (summary.peakRss > 0) {
        console.log("\n=== память ===");
        console.log(
            `пик RSS ${mb(summary.peakRss)}, пик heap ${mb(summary.peakHeap)}` +
            (summary.firstRss !== undefined && summary.lastRss !== undefined
                ? `, рост за сессию ${mb(summary.lastRss - summary.firstRss)}`
                : "")
        );
    }
}

function main() {
    const file = process.argv[2];

    if (!file) {
        console.error(
            "Укажите журнал: node build/perf-report.js <файл> " +
            "[--event имя]"
        );
        process.exitCode = 1;
        return;
    }

    if (!fs.existsSync(file)) {
        console.error(`Журнал не найден: ${file}`);
        process.exitCode = 1;
        return;
    }

    const eventIndex = process.argv.indexOf("--event");
    const eventFilter = eventIndex > 0
        ? process.argv[eventIndex + 1]
        : undefined;

    const { records, skipped } = readRecords(file);
    printReport(summarize(records, eventFilter), records, skipped);
}

module.exports = { summarize, percentile, readRecords };

if (require.main === module) {
    main();
}

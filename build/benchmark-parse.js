"use strict";

/*
 * Воспроизводимый замер основного пути разбора: npm run bench
 *
 * Существует, чтобы решения о разборе опирались на числа, а не на память о
 * прошлых замерах. Меряет то, что реально ощущает пользователь:
 *
 *   1) стоимость одного полного разбора (lex + parse + модель) по размерам и
 *      формам исходника;
 *   2) блокировку event loop: сколько времени таймер не получает управления,
 *      пока идёт очередь валидаций DocumentAnalysisService. Это та величина,
 *      из-за которой ограничен размер порции очереди
 *      (MAX_VALIDATIONS_PER_TICK) и из-за которой был убран вынос parse в
 *      worker_threads: копия AST распаковывалась в основном потоке и стоила
 *      дороже самого разбора.
 *
 * Замер намеренно не входит в npm test: он занимает десятки секунд и его
 * числа зависят от машины.
 */

const path = require("path");
const { performance } = require("perf_hooks");

const OUT = path.join(__dirname, "..", "server", "out");
const { lexRsl } = require(OUT + "/lexer");
const { parseRslSyntax } = require(OUT + "/syntaxParser");
const { createOpenModuleModel } = require(OUT + "/moduleModel");
const { WorkspaceIndex } = require(OUT + "/workspaceIndex");
const {
    DocumentAnalysisService
} = require(OUT + "/services/documentAnalysisService");

const SIZES_KB = [150, 300, 550, 1100];

/* Формы исходника: разная плотность токенов на байт при том же размере. */
const SHAPES = {
    "плотный код": approxChars => {
        const line = 'Var x1 = Something.Method(a, "text", 42) + b;\n';
        return line.repeat(Math.ceil(approxChars / line.length));
    },
    "макросы и блоки": approxChars => {
        const chunks = [];
        let size = 0;
        let index = 0;
        while (size < approxChars) {
            const chunk = [
                `// обработчик ${index}`,
                `Macro Handler${index}(obj, cmd, id, key)`,
                `  Var value${index} = ${index}, total${index} = 0;`,
                `  if (value${index} >= 0 and cmd == "run")`,
                `    for (Var i = 0; i < 10; i++)`,
                `      total${index} = total${index} + obj.Field(i, "name");`,
                "    End;",
                "  else",
                `    Println("skip " + string(value${index}));`,
                "  End;",
                `  return total${index};`,
                "End;",
                ""
            ].join("\n");
            chunks.push(chunk);
            size += chunk.length;
            index++;
        }
        return chunks.join("\n");
    },
    "длинные строки": approxChars => {
        const filler = "y".repeat(300);
        const line = `Var s = "${filler}";\n`;
        return line.repeat(Math.ceil(approxChars / line.length));
    },
    "одно выражение": approxChars => {
        const parts = ["Var total = a"];
        let size = parts[0].length;
        while (size < approxChars) {
            parts.push("+a");
            size += 2;
        }
        parts.push(";");
        return parts.join("");
    }
};

function median(values) {
    const sorted = values.slice().sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
}

function createDocument(uri, source) {
    const lineStarts = [0];
    for (let index = 0; index < source.length; index++) {
        if (source[index] === "\n") {
            lineStarts.push(index + 1);
        }
    }
    return {
        uri,
        languageId: "rsl",
        version: 1,
        lineCount: lineStarts.length,
        getText: () => source,
        positionAt(offset) {
            const bounded = Math.max(0, Math.min(offset, source.length));
            let line = 0;
            while (
                line + 1 < lineStarts.length &&
                lineStarts[line + 1] <= bounded
            ) {
                line++;
            }
            return { line, character: bounded - lineStarts[line] };
        },
        offsetAt(position) {
            const line = Math.max(
                0,
                Math.min(position.line, lineStarts.length - 1)
            );
            return Math.min(
                source.length,
                lineStarts[line] + Math.max(0, position.character)
            );
        }
    };
}

/** Максимальный и p95 разрыв между срабатываниями таймера в 1 мс. */
class EventLoopLag {
    constructor() {
        this.gaps = [];
        this.last = performance.now();
        this.timer = setInterval(() => {
            const now = performance.now();
            this.gaps.push(now - this.last);
            this.last = now;
        }, 1);
    }
    reset() {
        this.gaps = [];
        this.last = performance.now();
    }
    stop() {
        clearInterval(this.timer);
    }
    report() {
        const sorted = this.gaps.slice().sort((left, right) => left - right);
        return {
            max: sorted[sorted.length - 1] || 0,
            p95: sorted[Math.floor(sorted.length * 0.95)] || 0
        };
    }
}

function measureSingleParse() {
    console.log("=== стоимость одного разбора (медиана из 5) ===");
    console.log(
        "форма".padEnd(18) + "размер".padStart(8) + "токенов".padStart(10) +
        "lex".padStart(9) + "parse".padStart(9) + "модель".padStart(9)
    );

    for (const [shapeName, build] of Object.entries(SHAPES)) {
        for (const kb of SIZES_KB) {
            const source = build(kb * 1024);
            const lex = lexRsl(source);
            /* прогрев */
            createOpenModuleModel(
                source,
                parseRslSyntax(source, lex, { buildExpressionTree: false })
            );

            const lexTimes = [];
            const parseTimes = [];
            const modelTimes = [];
            for (let run = 0; run < 5; run++) {
                let started = performance.now();
                lexRsl(source);
                lexTimes.push(performance.now() - started);

                started = performance.now();
                const syntax = parseRslSyntax(source, lex, {
                    buildExpressionTree: false
                });
                parseTimes.push(performance.now() - started);

                started = performance.now();
                createOpenModuleModel(source, syntax);
                modelTimes.push(performance.now() - started);
            }

            console.log(
                shapeName.padEnd(18) +
                `${kb}КБ`.padStart(8) +
                String(lex.tokens.length).padStart(10) +
                `${median(lexTimes).toFixed(1)}мс`.padStart(9) +
                `${median(parseTimes).toFixed(1)}мс`.padStart(9) +
                `${median(modelTimes).toFixed(1)}мс`.padStart(9)
            );
        }
    }
}

async function measureQueueLag() {
    console.log("\n=== блокировка event loop очередью валидаций ===");
    console.log(
        "файлов".padStart(7) + "размер".padStart(9) +
        "лаг max".padStart(10) + "лаг p95".padStart(10) +
        "всего".padStart(9)
    );

    const build = SHAPES["макросы и блоки"];
    const lag = new EventLoopLag();

    for (const kb of [150, 300]) {
        for (const count of [1, 2, 4, 8]) {
            const source = build(kb * 1024);
            const documentsByUri = new Map();
            for (let index = 0; index < count; index++) {
                const uri = `file:///bench-${kb}-${count}-${index}.mac`;
                documentsByUri.set(uri, createDocument(uri, source));
            }

            const service = new DocumentAnalysisService(
                { get: uri => documentsByUri.get(uri) },
                new WorkspaceIndex(),
                {
                    getAvailable: () => ({
                        imports: { enabled: false },
                        autoImport: { enabled: false },
                        analysis: { workspaceIndexing: "activeImports" },
                        semanticHighlighting: { maxFileSizeKb: 512 },
                        diagnostics: {}
                    })
                },
                {
                    log: () => undefined,
                    invalidateProviderCaches: () => undefined,
                    onParsed: () => undefined,
                    onImports: () => undefined,
                    initialParseDelayMs: 0,
                    inactiveParseDelayMs: 0,
                    maxConcurrentValidations: 2
                }
            );

            /* Прогрев JIT на отдельном документе того же размера. */
            const warmUri = `file:///bench-warm-${kb}-${count}.mac`;
            documentsByUri.set(warmUri, createDocument(warmUri, source));
            await service.ensureParsed(documentsByUri.get(warmUri));

            await new Promise(resolve => setTimeout(resolve, 50));
            lag.reset();
            const started = performance.now();
            await Promise.all(
                Array.from(documentsByUri.keys())
                    .filter(uri => uri !== warmUri)
                    .map(uri => service.ensureParsed(documentsByUri.get(uri)))
            );
            const total = performance.now() - started;
            await new Promise(resolve => setTimeout(resolve, 50));
            const report = lag.report();

            console.log(
                String(count).padStart(7) +
                `${kb}КБ`.padStart(9) +
                `${report.max.toFixed(1)}мс`.padStart(10) +
                `${report.p95.toFixed(1)}мс`.padStart(10) +
                `${total.toFixed(0)}мс`.padStart(9)
            );
        }
    }

    lag.stop();
}

async function main() {
    measureSingleParse();
    await measureQueueLag();
    console.log(
        "\nЛаг max — сколько подряд основной поток не отдавал управление: " +
        "именно столько ждут таймеры, LSP IPC и все интерактивные ответы."
    );
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

"use strict";

/*
 * Сколько памяти держит сервер на настоящем проекте.
 *
 *   node --expose-gc build/bench-project-memory.js --project <каталог> [ключи]
 *
 * Ключи:
 *   --project <путь>   каталог с .mac (обязателен);
 *   --version <путь>   корень другой сборки: мерить её код, а не этот;
 *   --open <N>         сколько крупнейших файлов открыть как вкладки (по умолчанию 8);
 *   --json             напечатать одну строку JSON вместо отчёта.
 *
 * Меряется удержанное, а не пиковое: heap после трёх сборок мусора. Пик
 * зависит от того, когда сборщик решил поработать, и сравнивать по нему две
 * сборки бессмысленно.
 *
 * Версии сравниваются РАЗНЫМИ процессами, в отличие от стенда скорости. Там
 * один процесс нужен ради общего прогрева JIT; здесь наоборот — чужие модули,
 * прогретый JIT и мусор предыдущей версии искажают именно то, что меряется.
 *
 * Замеряются три величины по отдельности, потому что растут они по разным
 * причинам: каталог всего проекта, подробные модели открытых файлов и
 * постоянное хранилище состава.
 */

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

function argumentValue(name, fallback) {
    const at = process.argv.indexOf(name);

    return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const PROJECT = argumentValue("--project", "");
const VERSION = argumentValue("--version", path.join(__dirname, ".."));
const OPEN = Number(argumentValue("--open", "8"));
const AS_JSON = process.argv.includes("--json");

if (!PROJECT) {
    console.error(
        "нужен каталог проекта:\n" +
        "  node --expose-gc build/bench-project-memory.js --project <каталог>"
    );
    process.exitCode = 2;

    return;
}

const out = path.join(path.resolve(VERSION), "server", "out");

/* Сервер тянет vscode-languageserver: в стенде он не нужен. */
const serverModulePath = require.resolve(path.join(out, "server"));

require.cache[serverModulePath] = {
    id: serverModulePath,
    filename: serverModulePath,
    loaded: true,
    exports: { getTree: () => [], GetFileByNameRequest: () => undefined }
};

const { WorkspaceIndex } = require(path.join(out, "workspaceIndex"));
const {
    extractCompactDeclarations
} = require(path.join(out, "analysis/declarationExtractor"));
const { decodeRslSourceText } = require(path.join(out, "core/textDecoding"));

function heap() {
    if (!global.gc) {
        throw new Error("стенд памяти требует --expose-gc");
    }

    global.gc();
    global.gc();
    global.gc();

    return process.memoryUsage().heapUsed;
}

function collectFiles(root) {
    const found = [];
    const stack = [path.resolve(root)];

    while (stack.length > 0) {
        const current = stack.pop();
        let entries;

        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const full = path.join(current, entry.name);

            if (entry.isDirectory()) {
                if (entry.name !== ".git") {
                    stack.push(full);
                }

                continue;
            }

            if (!/\.mac$/iu.test(entry.name)) {
                continue;
            }

            try {
                found.push({ full, size: fs.statSync(full).size });
            } catch {
                /* Файл исчез между обходом и stat: он нам и не нужен. */
            }
        }
    }

    return found.sort((left, right) => right.size - left.size);
}

function main() {
    const files = collectFiles(PROJECT);
    const uris = files.map(item => pathToFileURL(item.full).toString());
    const started = heap();
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles(uris);

    const afterRegister = heap();
    let declarations = 0;

    /* Каталог всего проекта: то, по чему отвечает Ctrl+T. */
    for (const item of files) {
        let text;

        try {
            text = decodeRslSourceText(fs.readFileSync(item.full));
        } catch {
            continue;
        }

        let compact;

        try {
            compact = extractCompactDeclarations(text);
        } catch {
            continue;
        }

        declarations += compact.declarations.length;
        index.catalog.recordDeclarations({
            uri: pathToFileURL(item.full).toString(),
            version: 0,
            declarations: compact.declarations,
            imports: compact.imports,
            fileReferences: new Set()
        });
    }

    const afterCatalog = heap();

    /* Подробные модели: столько вкладок, сколько попросили, с крупнейших. */
    for (const item of files.slice(0, OPEN)) {
        try {
            index.updateOpenModule(
                pathToFileURL(item.full).toString(),
                decodeRslSourceText(fs.readFileSync(item.full)),
                1
            );
        } catch {
            /* Нечитаемый файл вкладкой не станет. */
        }
    }

    const afterOpen = heap();
    const megabytes = value => Number((value / 1048576).toFixed(1));
    const report = {
        version: require(path.join(path.resolve(VERSION), "package.json"))
            .version,
        files: files.length,
        declarations,
        opened: Math.min(OPEN, files.length),
        registerMiB: megabytes(afterRegister - started),
        catalogMiB: megabytes(afterCatalog - afterRegister),
        openedMiB: megabytes(afterOpen - afterCatalog),
        totalMiB: megabytes(afterOpen - started)
    };

    if (AS_JSON) {
        console.log(JSON.stringify(report));

        return;
    }

    console.log(
        "RSL-plus " + report.version + ": файлов " + report.files +
        ", объявлений " + report.declarations +
        ", открыто " + report.opened
    );
    console.log("  список файлов проекта   " + report.registerMiB + " МиБ");
    console.log("  каталог всего проекта   " + report.catalogMiB + " МиБ");
    console.log("  подробные модели вкладок " + report.openedMiB + " МиБ");
    console.log("  всего удержано          " + report.totalMiB + " МиБ");
}

main();

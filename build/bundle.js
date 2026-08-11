"use strict";

/*
 * Сборка VSIX-варианта расширения: три bundle вместо ~350 отдельных файлов.
 *
 * Bundle пишется ПОВЕРХ entry-файлов tsc-сборки (client/out/extension.js,
 * server/out/server.js, server/out/indexing/compactModuleWorker.js). Так
 * package.json main, путь до сервера в client/src/extension.ts, вычисление
 * путей в server/src/paths.ts и конфигурация отладки (F5 + tsc -b -w)
 * остаются нетронутыми: раскладка на диске та же, просто entry-файлы теперь
 * несут в себе весь код и зависимости.
 *
 * Остальные файлы tsc (server/out/lexer.js и прочие) остаются на диске —
 * их требуют тесты, — но в VSIX не попадают, см. .vscodeignore.
 *
 * Запускать ПОСЛЕ tsc: npm run compile && npm run bundle. Порядок важен,
 * иначе tsc перезапишет bundle обычными модулями (npm test делает clean).
 */

const path = require("path");
const esbuild = require("esbuild");

const ROOT = path.join(__dirname, "..");

const TARGETS = [
    {
        name: "client",
        entry: "client/src/extension.ts",
        outfile: "client/out/extension.js",
        /* vscode предоставляется хостом расширений и в bundle не попадает. */
        external: ["vscode"]
    },
    {
        name: "server",
        entry: "server/src/server.ts",
        outfile: "server/out/server.js",
        external: []
    },
    /*
     * Worker компактной индексации — отдельный entry: он создаётся по пути в
     * runtime (new Worker), втянуть его внутрь bundle нельзя. Путь совпадает
     * с раскладкой tsc, поэтому resolveServerOutFile() в обеих сборках
     * указывает в одно место (см. server/src/paths.ts).
     */
    {
        name: "compact-worker",
        entry: "server/src/indexing/compactModuleWorker.ts",
        outfile: "server/out/indexing/compactModuleWorker.js",
        external: []
    }
];

async function build(target) {
    const result = await esbuild.build({
        entryPoints: [path.join(ROOT, target.entry)],
        outfile: path.join(ROOT, target.outfile),
        bundle: true,
        platform: "node",
        format: "cjs",
        /*
         * VS Code 1.90 работает на Node 20; node18 берётся с запасом, чтобы
         * bundle оставался пригодным для более старых сборок редактора.
         */
        target: "node18",
        /*
         * Идентификаторы намеренно НЕ сжимаются, а имена функций сохраняются:
         * сервер печатает stack trace в output-канал (см. errorToString), и
         * читаемые имена там важнее нескольких десятков килобайт. Source map
         * в VSIX не попадает, восстановить имена было бы нечем.
         */
        minifyWhitespace: true,
        minifySyntax: true,
        minifyIdentifiers: false,
        keepNames: true,
        sourcemap: false,
        legalComments: "none",
        external: target.external,
        metafile: true,
        logLevel: "warning"
    });

    const output = result.metafile.outputs[
        Object.keys(result.metafile.outputs).find(key =>
            key.endsWith(path.basename(target.outfile))
        )
    ];
    return { name: target.name, file: target.outfile, bytes: output.bytes };
}

async function main() {
    const built = [];
    for (const target of TARGETS) {
        built.push(await build(target));
    }

    let total = 0;
    for (const item of built) {
        total += item.bytes;
        console.log(
            `${String(Math.round(item.bytes / 1024)).padStart(5)} KB  ` +
            `${item.file}`
        );
    }
    console.log(`${String(Math.round(total / 1024)).padStart(5)} KB  всего`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

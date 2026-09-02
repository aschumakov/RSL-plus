"use strict";

/**
 * Инкрементальное состояние обязано совпадать с построенным с нуля.
 *
 * У сервера долгая жизнь: файлы открывают и закрывают, правят, зависимости
 * дочитываются в фоне, каталог достраивается, настройка проекта меняется,
 * папки рабочей области добавляют и убирают. Каждое из этих событий что-то
 * сбрасывает, а что-то намеренно НЕ сбрасывает — и именно во втором и живут
 * ошибки устаревшего состояния: они не воспроизводятся ни на одном отдельном
 * шаге и заметны только по расхождению ответа.
 *
 * Поэтому здесь проверяется не отдельный шаг, а РАВЕНСТВО. Одна сборка
 * проходит всю последовательность событий, вторая строится с нуля по тому же
 * текущему содержимому файлов, и ответы сравниваются целиком: разрешение
 * каждого идентификатора, тип каждого идентификатора, замыкание Import,
 * зависимые, экспортёры, объявления проекта, диапазоны переходов и Problems.
 *
 * Отдельно — два случая, ради которых заведён отпечаток интерфейса: правка
 * только тела импортированного модуля (зависимые сбрасываться не должны) и
 * правка, меняющая интерфейс (обязаны).
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
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { RslTypeEngine } = require("../server/out/analysis/typeEngine");
const {
    RslProjectIndexView
} = require("../server/out/indexing/projectIndexView");
const { buildRslDiagnostics } = require("../server/out/diagnostics");
const {
    extractCompactDeclarations
} = require("../server/out/analysis/declarationExtractor");

let passed = 0;
let failed = 0;

function test(name, action) {
    try {
        action();
        passed++;
        console.log("[OK] " + name);
    } catch (error) {
        failed++;
        console.error("[FAIL] " + name);
        console.error(error);
    }
}

const LIB = "file:///d:/equal/lib.mac";
const DEEP = "file:///d:/equal/deep.mac";
const MAIN = "file:///d:/equal/main.mac";
const OTHER = "file:///d:/equal/other.mac";
const LATE = "file:///d:/equal/late.mac";

const START = {
    [DEEP]: [
        "Class TDeep",
        "  Var Code: String;",
        "End;",
        "",
        "Macro MakeDeep(): TDeep",
        "  Var result: TDeep;",
        "  return result;",
        "End;",
        ""
    ].join("\n"),
    [LIB]: [
        "Import deep;",
        "",
        "Macro LibSend(value: String)",
        "  Var helper = MakeDeep();",
        "  return helper.Code;",
        "End;",
        ""
    ].join("\n"),
    [MAIN]: [
        "Import lib;",
        "",
        "Macro Run()",
        "  Var text: String;",
        "  LibSend(text);",
        "  Var made = MakeDeep();",
        "  return made.Code;",
        "End;",
        ""
    ].join("\n"),
    [OTHER]: [
        "Import lib;",
        "",
        "Macro OtherRun()",
        "  LibSend(\"a\");",
        "End;",
        ""
    ].join("\n"),
    [LATE]: [
        "Macro LateHelper()",
        "End;",
        ""
    ].join("\n")
};

/**
 * Сборка индекса: открытые документы и внешние сводки.
 *
 * `open` — какие файлы считаются открытыми: у них полная модель, и только по
 * ней есть токены, разрешение имён и Problems.
 */
function board(texts, open, files) {
    const index = new WorkspaceIndex({ maxExternalModules: 20000 });

    index.registerWorkspaceFiles(files);

    for (const uri of files) {
        if (texts[uri] === undefined) {
            continue;
        }

        if (open.includes(uri)) {
            index.updateOpenModule(uri, texts[uri], 1);
            index.markOpen(uri);
        } else {
            index.updateExternalModule(uri, texts[uri], 1);
        }
    }

    const resolver = new RslScopeResolver(index);

    return {
        index,
        resolver,
        engine: new RslTypeEngine(index, resolver),
        view: new RslProjectIndexView(index)
    };
}

/**
 * Все ответы сборки об этом состоянии проекта — одной строкой.
 *
 * Сравнивается именно слепок целиком: расхождение в любом ответе — это
 * устаревшее состояние, а какое именно, покажет diff.
 */
function snapshot(kit, texts, open, files) {
    const lines = [];

    for (const uri of [...files].sort()) {
        lines.push("файл " + uri);
        lines.push(
            "  замыкание " +
            [...kit.view.importClosureUris(uri)].sort().join(",")
        );
        lines.push(
            "  зависимые " +
            kit.view.dependentsOf(uri)
                .map(item => item.uri + (item.ambiguous ? "?" : ""))
                .join(",")
        );
        lines.push("  Import " + kit.view.importsOf(uri).sort().join(","));

        if (!open.includes(uri) || texts[uri] === undefined) {
            continue;
        }

        const module = kit.index.getModule(uri);

        if (!module) {
            lines.push("  модели нет");
            continue;
        }

        /* Разрешение и тип КАЖДОГО идентификатора файла. */
        for (const token of module.syntax.tokens) {
            if (token.kind !== "identifier") {
                continue;
            }

            const resolved = kit.resolver.resolveAt(
                uri,
                module.symbolTree,
                token.start
            );
            const range = resolved
                ? kit.index.getDefinitionRange(resolved.uri, resolved.symbol)
                : undefined;

            lines.push(
                "  " + token.value +
                " -> " + (resolved
                    ? resolved.uri + "#" + resolved.symbol.id
                    : "нет") +
                " тип " + kit.engine.typeOfSymbolAt(uri, token.start) +
                " ожидание " + kit.engine.expectedTypeAt(uri, token.start) +
                " место " + (range
                    ? range.start.line + ":" + range.start.character
                    : "нет")
            );
        }

        /* Problems: и локальные, и межфайловые. */
        for (const problem of buildRslDiagnostics(module, kit.index)) {
            lines.push(
                "  проблема " + problem.range.start.line + " " +
                problem.code + " " + problem.message
            );
        }

        /* Подсказка по подключённым и по неподключённым. */
        lines.push(
            "  подключённые " +
            kit.index.getImportedCompletionItems(uri)
                .map(item => String(item.label))
                .sort()
                .join(",")
        );
        lines.push(
            "  неподключённые " +
            kit.view.findUnimportedSymbols(uri, "l", 20).items
                .map(item => item.name)
                .join(",")
        );
    }

    for (const name of ["LibSend", "MakeDeep", "LateHelper", "TDeep"]) {
        lines.push(
            "экспортёры " + name + " " +
            kit.view.findExporters(name).sort().join(",")
        );
        lines.push(
            "объявления " + name + " " +
            kit.view.findSymbol(name)
                .map(item => item.ref.uri + "#" + item.ref.symbolId)
                .sort()
                .join(",")
        );
    }

    for (const query of ["Lib", "Make", "T"]) {
        lines.push(
            "Ctrl+T " + query + " " +
            kit.view.workspaceSymbols(query, 20)
                .map(item => item.ref.uri + "#" + item.ref.symbolId)
                .join(",")
        );
    }

    return lines.join("\n");
}

/**
 * Фоновая достройка каталога: она читает файл, не загружая его модель.
 *
 * Тем же компактным извлекателем, что и настоящая достройка: полная модель
 * закрытого файла в памяти не появляется.
 */
function warmCatalog(kit, uri, text) {
    const snapshot = extractCompactDeclarations(text);

    kit.index.catalog.recordDeclarations({
        uri,
        version: 1,
        declarations: snapshot.declarations,
        imports: snapshot.imports
    });
}

test("длинная последовательность событий равна сборке с нуля", () => {
    const texts = { ...START };
    const files = [DEEP, LIB, MAIN, OTHER, LATE];
    const open = [MAIN, OTHER];
    const kit = board(texts, open, files);

    /* 1. Открытие: главный файл спрашивают сразу. */
    snapshot(kit, texts, open, files);

    /* 2. Правка открытого файла. */
    texts[MAIN] = texts[MAIN].replace(
        "  return made.Code;",
        "  Var extra = 1;\n  return made.Code;"
    );
    kit.index.updateOpenModule(MAIN, texts[MAIN], 2);

    /* 3. Правка ТЕЛА зависимости: интерфейс тот же. */
    texts[LIB] = texts[LIB].replace(
        "  return helper.Code;",
        "  Var tmp = helper;\n  return tmp.Code;"
    );
    kit.index.updateExternalModule(LIB, texts[LIB], 2);

    /* 4. Правка ИНТЕРФЕЙСА зависимости: добавлено публичное объявление. */
    texts[LIB] += "Macro LibExtra(): String\n  return \"a\";\nEnd;\n";
    kit.index.updateExternalModule(LIB, texts[LIB], 3);

    /* 5. Фоновый результат достройки каталога по незагруженному файлу. */
    warmCatalog(kit, LATE, texts[LATE]);

    /* 6. Смена настройки проекта: состав собран по прежним правилам. */
    kit.index.resetWorkspaceFiles();
    kit.index.registerWorkspaceFiles(files);

    /* 7. Смена набора папок рабочей области: файл добавился. */
    const ADDED = "file:///d:/equal/added.mac";

    texts[ADDED] = "Macro AddedHelper()\nEnd;\n";
    files.push(ADDED);
    kit.index.registerWorkspaceFiles(files);
    kit.index.updateExternalModule(ADDED, texts[ADDED], 1);

    /* 8. Закрытие и повторное открытие. */
    kit.index.compactModule(OTHER);
    kit.index.markClosed(OTHER);
    kit.index.updateOpenModule(OTHER, texts[OTHER], 2);
    kit.index.markOpen(OTHER);

    /* 9. Ещё одна правка тела зависимости — после всего остального. */
    texts[DEEP] = texts[DEEP].replace(
        "  return result;",
        "  Var t = result;\n  return t;"
    );
    kit.index.updateExternalModule(DEEP, texts[DEEP], 2);

    const incremental = snapshot(kit, texts, open, files);
    const fresh = snapshot(
        board(texts, open, files),
        texts,
        open,
        files
    );

    if (incremental !== fresh) {
        const left = incremental.split("\n");
        const right = fresh.split("\n");

        for (let at = 0; at < Math.max(left.length, right.length); at++) {
            if (left[at] !== right[at]) {
                assert.fail(
                    "расхождение в строке " + at + ":\n" +
                    "  инкрементально: " + left[at] + "\n" +
                    "  с нуля:         " + right[at]
                );
            }
        }
    }

    assert.strictEqual(incremental, fresh);
});

test("правка только тела зависимости не сбрасывает зависимых", () => {
    const texts = { ...START };
    const files = [DEEP, LIB, MAIN, OTHER, LATE];
    const kit = board(texts, [MAIN, OTHER], files);

    kit.index.getSemanticRevision(MAIN);
    kit.index.getSemanticRevision(OTHER);

    const before = kit.index.interfaceCounters;
    const keyBefore = kit.index.getImportClosureKey(MAIN);

    kit.index.updateExternalModule(
        LIB,
        texts[LIB].replace(
            "  return helper.Code;",
            "  Var tmp = helper;\n  return tmp.Code;"
        ),
        2
    );

    const after = kit.index.interfaceCounters;

    assert.strictEqual(
        after.dependentInvalidations - before.dependentInvalidations,
        0,
        "интерфейс не изменился — сбрасывать нечего"
    );
    assert.strictEqual(
        kit.index.getImportClosureKey(MAIN),
        keyBefore,
        "и условия расчёта Problems остались те же"
    );
});

test("правка интерфейса зависимости сбрасывает зависимых", () => {
    const texts = { ...START };
    const files = [DEEP, LIB, MAIN, OTHER, LATE];
    const kit = board(texts, [MAIN, OTHER], files);

    kit.index.getSemanticRevision(MAIN);
    kit.index.getSemanticRevision(OTHER);

    const before = kit.index.interfaceCounters;
    const keyBefore = kit.index.getImportClosureKey(MAIN);

    kit.index.updateExternalModule(
        LIB,
        texts[LIB].replace(
            "Macro LibSend(value: String)",
            "Macro LibSend(value: Integer)"
        ),
        2
    );

    const after = kit.index.interfaceCounters;

    assert.ok(
        after.dependentInvalidations - before.dependentInvalidations >= 2,
        "оба зависимых обязаны быть сброшены"
    );
    assert.notStrictEqual(
        kit.index.getImportClosureKey(MAIN),
        keyBefore,
        "и условия расчёта Problems изменились"
    );
});

test("правка тела не меняет ни одного ответа зависимому", () => {
    /*
     * Обратная сторона отсечения: если сбрасывать нечего, то и отвечать
     * зависимый обязан ровно так же, как сборка с нуля по новому тексту.
     * Именно это утверждение отсечение и должно сохранять.
     */
    const texts = { ...START };
    const files = [DEEP, LIB, MAIN, OTHER, LATE];
    const open = [MAIN, OTHER];
    const kit = board(texts, open, files);

    snapshot(kit, texts, open, files);

    texts[LIB] = texts[LIB].replace(
        "  return helper.Code;",
        "  Var tmp = helper;\n  Var second = tmp;\n  return second.Code;"
    );
    kit.index.updateExternalModule(LIB, texts[LIB], 2);

    assert.strictEqual(
        snapshot(kit, texts, open, files),
        snapshot(board(texts, open, files), texts, open, files)
    );
});

test("удаление зависимости доходит до зависимых", () => {
    const texts = { ...START };
    const files = [DEEP, LIB, MAIN, OTHER, LATE];
    const open = [MAIN, OTHER];
    const kit = board(texts, open, files);

    snapshot(kit, texts, open, files);

    kit.index.removeModule(DEEP);
    kit.index.unregisterWorkspaceFile(DEEP);
    delete texts[DEEP];

    const remaining = files.filter(uri => uri !== DEEP);

    assert.strictEqual(
        snapshot(kit, texts, open, remaining),
        snapshot(board(texts, open, remaining), texts, open, remaining)
    );
});

test("порядок событий на ответ не влияет", () => {
    /*
     * Те же правки в другом порядке обязаны дать то же состояние. Иначе ответ
     * зависит от того, что успела прочитать фоновая индексация.
     */
    const files = [DEEP, LIB, MAIN, OTHER, LATE];
    const open = [MAIN, OTHER];
    const edited = { ...START };

    edited[LIB] = edited[LIB] +
        "Macro LibExtra(): String\n  return \"a\";\nEnd;\n";
    edited[MAIN] = edited[MAIN].replace(
        "  return made.Code;",
        "  Var extra = LibExtra();\n  return extra;"
    );

    const forward = board({ ...START }, open, files);

    forward.index.updateExternalModule(LIB, edited[LIB], 2);
    forward.index.updateOpenModule(MAIN, edited[MAIN], 2);

    const backward = board({ ...START }, open, files);

    backward.index.updateOpenModule(MAIN, edited[MAIN], 2);
    backward.index.updateExternalModule(LIB, edited[LIB], 2);

    assert.strictEqual(
        snapshot(forward, edited, open, files),
        snapshot(backward, edited, open, files)
    );
});

test("двести случайных событий равны сборке с нуля", () => {
    /*
     * Нагрузочная часть. Порядок событий задаётся воспроизводимым
     * генератором: провалившийся прогон обязан провалиться снова, иначе
     * разбирать его нечем.
     *
     * Равенство сверяется не в конце, а каждые двадцать событий: так видно,
     * ПОСЛЕ КАКОГО события состояние разошлось.
     */
    const files = [DEEP, LIB, MAIN, OTHER, LATE];
    const open = [MAIN, OTHER];
    const texts = { ...START };
    const kit = board(texts, open, files);
    const versions = { };

    files.forEach(uri => {
        versions[uri] = 1;
    });

    /* Линейный конгруэнтный генератор: воспроизводим и без зависимостей. */
    let seed = 20250902;
    const next = bound => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;

        return seed % bound;
    };

    for (let step = 1; step <= 200; step++) {
        const uri = files[next(files.length)];
        const kind = next(6);

        if (kind === 0) {
            /* Правка тела: интерфейс не меняется. */
            texts[uri] = texts[uri].replace(
                /End;\r?\n$/u,
                "  Var t" + step + " = 1;" + "\nEnd;\n"
            );
        } else if (kind === 1) {
            /* Правка интерфейса: новое публичное объявление. */
            texts[uri] += "Macro Added" + step + "(): String\n" +
                "  return \"a\";\nEnd;\n";
        } else if (kind === 2) {
            /* Фоновая достройка каталога по этому файлу. */
            warmCatalog(kit, uri, texts[uri]);
            continue;
        } else if (kind === 3) {
            /* Смена области поиска: состав забывается и собирается заново. */
            kit.index.resetWorkspaceFiles();
            kit.index.registerWorkspaceFiles(files);
            continue;
        } else if (kind === 4 && !open.includes(uri)) {
            /* Закрытие и повторное открытие внешнего модуля. */
            kit.index.compactModule(uri);
            kit.index.markClosed(uri);
            continue;
        }

        versions[uri]++;

        if (open.includes(uri)) {
            kit.index.updateOpenModule(uri, texts[uri], versions[uri]);
            kit.index.markOpen(uri);
        } else {
            kit.index.updateExternalModule(uri, texts[uri], versions[uri]);
        }

        if (step % 20 !== 0) {
            continue;
        }

        const incremental = snapshot(kit, texts, open, files);
        const fresh = snapshot(
            board(texts, open, files),
            texts,
            open,
            files
        );

        if (incremental !== fresh) {
            const left = incremental.split("\n");
            const right = fresh.split("\n");

            for (let at = 0; at < Math.max(left.length, right.length); at++) {
                if (left[at] !== right[at]) {
                    assert.fail(
                        "после события " + step + " расхождение:\n" +
                        "  инкрементально: " + left[at] + "\n" +
                        "  с нуля:         " + right[at]
                    );
                }
            }
        }

        assert.strictEqual(
            incremental,
            fresh,
            "расхождение после события " + step
        );
    }
});

console.log(
    failed === 0
        ? "\nПройдено: " + passed
        : "\nПройдено: " + passed + ", провалено: " + failed
);

if (failed > 0) {
    process.exitCode = 1;
}

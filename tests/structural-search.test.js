"use strict";

/**
 * Поиск по структуре кода.
 *
 * Регулярное выражение по коду хрупко: перенос строки, лишний пробел,
 * вложенный вызов в аргументе — и шаблон уже не совпадает. Здесь образец
 * описывает форму вызова, а совпадение ищется по токенам.
 *
 * Отдельно проверяются три правила, без которых такой поиск нельзя выпускать:
 * кандидаты отбираются заранее, обход уступает поток по бюджету времени и его
 * можно отменить.
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

const lexerModule = require("../server/out/lexer");
const { lexRsl } = lexerModule;
const {
    findRslStructuralMatches,
    parseRslStructuralPattern
} = require("../server/out/features/structuralSearch");
const {
    runRslStructuralSearch
} = require("../server/out/features/structuralSearchService");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

/** Совпадения образца в тексте. */
function search(patternText, source) {
    const parsed = parseRslStructuralPattern(
        patternText,
        text => lexRsl(text).tokens
    );

    assert.ok(parsed.pattern, "образец: " + parsed.problem);

    return findRslStructuralMatches(parsed.pattern, source, lexRsl(source).tokens)
        .map(match => ({
            text: source.slice(match.start, match.end),
            bindings: match.bindings
        }));
}

test("заполнитель забирает один аргумент", () => {
    const found = search(
        "ExecMacro($name)",
        'Macro Run()\n  ExecMacro("Handler");\nEnd;\n'
    );

    assert.strictEqual(found.length, 1);
    assert.deepStrictEqual(found[0].bindings, { name: '"Handler"' });
});

test("многоточие забирает остальные", () => {
    const found = search(
        "ExecMacroFile($file, $args...)",
        'Macro Run()\n  ExecMacroFile("lib.mac", "Go", 1);\nEnd;\n'
    );

    assert.deepStrictEqual(found[0].bindings, {
        file: '"lib.mac"',
        args: '"Go", 1'
    });
});

test("многоточие годится и на пустой хвост", () => {
    const found = search(
        "ExecMacroFile($file, $args...)",
        "Macro Run()\n  ExecMacroFile(name);\nEnd;\n"
    );

    assert.deepStrictEqual(found[0].bindings, { file: "name", args: "" });
});

test("вложенный вызов остаётся одним аргументом", () => {
    /* Ровно то, на чём ломается регулярное выражение. */
    const found = search(
        "ExecMacro($name)",
        "Macro Run()\n  ExecMacro(Choose(a, b));\nEnd;\n"
    );

    assert.strictEqual(found.length, 1);
    assert.deepStrictEqual(found[0].bindings, { name: "Choose(a, b)" });
});

test("переносы строк не мешают", () => {
    const found = search(
        "ExecMacroFile($file, $name)",
        'Macro Run()\n  ExecMacroFile(\n    "lib.mac",\n    "Go"\n  );\nEnd;\n'
    );

    assert.strictEqual(found.length, 1);
    assert.deepStrictEqual(found[0].bindings.name, '"Go"');
});

test("число аргументов обязано совпасть", () => {
    assert.deepStrictEqual(
        search(
            "ExecMacro($name)",
            'Macro Run()\n  ExecMacro("Handler", 1);\nEnd;\n'
        ),
        [],
        "два аргумента — не один"
    );
});

test("буквальный аргумент обязан совпасть", () => {
    const source = 'Macro Run()\n  Send(1, doc);\n  Send(2, doc);\nEnd;\n';

    assert.deepStrictEqual(
        search("Send(1, $target)", source).map(item => item.text),
        ["Send(1, doc)"]
    );
});

test("регистр имени значения не имеет", () => {
    const found = search(
        "execmacro($name)",
        'Macro Run()\n  ExecMacro("Handler");\nEnd;\n'
    );

    assert.strictEqual(found.length, 1);
});

test("негодный образец объясняется", () => {
    const parsed = parseRslStructuralPattern(
        "ExecMacro($args..., $tail)",
        text => lexRsl(text).tokens
    );

    assert.ok(!parsed.pattern);
    assert.ok(
        parsed.problem.includes("многоточием"),
        "сказано, что именно не так: " + parsed.problem
    );
});

/** Проект из готовых текстов; чтения с диска в стенде нет. */
function project(sources) {
    const index = new WorkspaceIndex();
    const uris = Object.keys(sources);

    index.registerWorkspaceFiles(uris);

    const reads = [];
    let clock = 0;

    return {
        index,
        reads,
        advance: value => {
            clock += value;
        },
        environment: {
            index,
            referenceIndex: {
                findCandidates: async (name, all) => all
                    .filter(uri => sources[uri]
                        .toLowerCase()
                        .includes(name.toLowerCase()))
                    .map(uri => ({ uri }))
            },
            yieldToInteractive: async () => undefined,
            now: () => clock,
            readSource: async uri => {
                reads.push(uri);

                return sources[uri];
            }
        }
    };
}

const WITH_CALL = 'Macro Run()\n  ExecMacro("Handler");\nEnd;\n';
const WITHOUT_CALL = "Macro Alone()\n  Var x = 1;\nEnd;\n";

test("читаются только кандидаты", async () => {
    const sources = { "file:///a.mac": WITH_CALL };

    for (let index = 0; index < 20; index++) {
        sources["file:///plain" + index + ".mac"] = WITHOUT_CALL;
    }

    const board = project(sources);
    const answer = await runRslStructuralSearch(
        board.environment,
        { pattern: "ExecMacro($name)" }
    );

    assert.strictEqual(answer.hits.length, 1);
    assert.deepStrictEqual(
        board.reads,
        ["file:///a.mac"],
        "остальные файлы отсеяны до чтения"
    );
    assert.strictEqual(answer.scannedFiles, 1);
    assert.strictEqual(answer.skippedFiles, 20);
});

test("поиск отменяется", async () => {
    const sources = {};

    for (let index = 0; index < 200; index++) {
        sources["file:///hit" + index + ".mac"] = WITH_CALL;
    }

    const board = project(sources);
    let calls = 0;
    const answer = await runRslStructuralSearch(
        board.environment,
        { pattern: "ExecMacro($name)" },
        () => ++calls > 30
    );

    assert.ok(answer.cancelled, "отмена обязана быть видна в ответе");
    assert.ok(
        board.reads.length < 200,
        "после отмены обход прекращается: прочитано " + board.reads.length
    );
});

test("предел ограничивает и работу, и ответ", async () => {
    const sources = {};

    for (let index = 0; index < 50; index++) {
        sources["file:///hit" + index + ".mac"] = WITH_CALL;
    }

    const board = project(sources);
    const answer = await runRslStructuralSearch(
        board.environment,
        { pattern: "ExecMacro($name)", limit: 5 }
    );

    assert.strictEqual(answer.hits.length, 5);
    assert.ok(answer.truncated, "показано не всё, и об этом сказано");
    assert.ok(
        board.reads.length <= 6,
        "лишние файлы не читаются: " + board.reads.length
    );
});

test("поток уступается по бюджету времени, а не по числу файлов", async () => {
    /*
     * Порция в фиксированное число файлов — неверная мерка: среди
     * кандидатов попадаются файлы по 700 КБ, и такая порция занимает поток
     * надолго. Часы стенда двигаются вручную: так проверяется само правило,
     * а не скорость машины.
     */
    const sources = {};

    for (let index = 0; index < 6; index++) {
        sources["file:///hit" + index + ".mac"] = WITH_CALL;
    }

    const board = project(sources);
    let yields = 0;

    board.environment.yieldToInteractive = async () => {
        yields++;
    };

    await runRslStructuralSearch(
        board.environment,
        { pattern: "ExecMacro($name)" }
    );

    assert.strictEqual(
        yields,
        0,
        "шесть мелких файлов бюджет не исчерпывают: уступать незачем"
    );

    /* Теперь каждый файл «занимает» больше бюджета. */
    const slow = project(sources);
    let slowYields = 0;

    slow.environment.yieldToInteractive = async () => {
        slowYields++;
    };
    slow.environment.readSource = async uri => {
        slow.advance(50);

        return sources[uri];
    };

    await runRslStructuralSearch(
        slow.environment,
        { pattern: "ExecMacro($name)" }
    );

    assert.strictEqual(
        slowYields,
        6,
        "после каждого долгого файла поток отдаётся сразу"
    );
});

test("файл лексируется один раз", async () => {
    const sources = {};

    for (let index = 0; index < 5; index++) {
        sources["file:///hit" + index + ".mac"] = WITH_CALL;
    }

    const board = project(sources);
    const original = lexerModule.lexRsl;
    let calls = 0;

    lexerModule.lexRsl = function (...args) {
        calls++;

        return original.apply(this, args);
    };

    try {
        await runRslStructuralSearch(
            board.environment,
            { pattern: "ExecMacro($name)" }
        );
    } finally {
        lexerModule.lexRsl = original;
    }

    /* Пять файлов и один разбор образца. */
    assert.strictEqual(
        calls,
        6,
        "второй разбор файла был только ради начал строк: " + calls
    );
});

(async () => {
    for (const item of tests) {
        try {
            await item.action();
            passed++;
            console.log("[OK] " + item.name);
        } catch (error) {
            failed++;
            console.error("[FAIL] " + item.name);
            console.error(error);
        }
    }

    console.log(
        failed === 0
            ? "\nПройдено: " + passed
            : "\nПройдено: " + passed + ", провалено: " + failed
    );

    if (failed > 0) {
        process.exitCode = 1;
    }
})();

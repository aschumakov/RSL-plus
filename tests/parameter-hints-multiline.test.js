"use strict";

/**
 * Имя параметра у аргумента, занявшего несколько строк.
 *
 * Перед аргументом подсказка хороша, пока аргумент короткий. Когда он занимает
 * несколько строк — склеенная строка запроса, вложенный вызов со своими
 * аргументами, — подсказка встаёт перед ПЕРВОЙ строкой и сдвигает вправо весь
 * код, который под ней:
 *
 *     execSql(
 *         query: "..." +
 *         "...",          <- и вот это уже не выровнено
 *
 * Поэтому у такого аргумента подсказка стоит после последнего его токена.
 * Текст файла при этом не меняется — меняется только место подсказки.
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
const { getDefaults } = require("../server/out/defaults");
const {
    buildRslParameterInlayHints
} = require("../server/out/features/parameterInlayHints");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, action) {
    tests.push({ name, action });
}

const URI = "file:///d:/hints/main.mac";
const DECLARATIONS = [
    "Macro execSql(query, params)",
    "End;",
    "Macro sqlParam(value)",
    "End;",
    "Macro makeArray(first, second)",
    "End;",
    "Macro send(document, silent)",
    "End;"
];

/** Подсказки всего файла вместе с текстом строки, к которой они встали. */
function hintsOf(body) {
    const source = [...DECLARATIONS, "Macro Test()", ...body, "End;", ""]
        .join("\n");
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles([URI]);

    const module = index.updateOpenModule(URI, source, 1);
    const resolver = new RslScopeResolver(index, getDefaults());
    const hints = buildRslParameterInlayHints(
        module,
        resolver,
        {
            start: { line: 0, character: 0 },
            end: { line: source.split("\n").length, character: 0 }
        }
    );
    const lines = source.split("\n");

    return {
        source,
        lines,
        items: hints.map(item => ({
            label: item.label,
            line: item.position.line,
            character: item.position.character,
            text: lines[item.position.line],
            paddingLeft: Boolean(item.paddingLeft),
            paddingRight: Boolean(item.paddingRight)
        }))
    };
}

function find(answer, label) {
    const found = answer.items.filter(item => item.label === label);

    assert.strictEqual(
        found.length,
        1,
        "ожидалась одна подсказка «" + label + "», а есть " +
            JSON.stringify(answer.items.map(item => item.label))
    );

    return found[0];
}

test("однострочный аргумент получает имя перед собой", () => {
    const answer = hintsOf(['  send("письмо", true);']);
    const document = find(answer, "document:");
    const silent = find(answer, "silent:");

    assert.strictEqual(
        answer.source.slice(
            answer.source.indexOf('send("письмо"') + 5,
            answer.source.indexOf('send("письмо"') + 13
        ),
        '"письмо"',
        "стенд собран верно"
    );
    assert.strictEqual(
        document.character,
        answer.lines[document.line].indexOf('"письмо"'),
        "подсказка стоит ровно перед аргументом"
    );
    assert.ok(document.paddingRight, "и отделена от него пробелом");
    assert.ok(!document.paddingLeft);
    assert.ok(silent.character > document.character);
});

test("многострочная строка получает имя в конце аргумента", () => {
    const answer = hintsOf([
        "  execSql(",
        '    "select 1 " +',
        '    "from dual",',
        "    parameters",
        "  );"
    ]);
    const query = find(answer, "\u2190 query");

    assert.strictEqual(
        answer.lines[query.line].trim(),
        '"from dual",',
        "подсказка обязана быть на последней строке аргумента, а не на первой"
    );
    assert.strictEqual(
        query.character,
        answer.lines[query.line].indexOf(",") ,
        "и ровно после последнего токена аргумента, до запятой"
    );
    assert.ok(query.paddingLeft, "отделена пробелом слева");
    assert.ok(!query.paddingRight);

    /* Второй аргумент однострочный — у него всё по-прежнему. */
    const parameters = find(answer, "params:");

    assert.strictEqual(parameters.text.trim(), "parameters");
    assert.strictEqual(
        parameters.character,
        answer.lines[parameters.line].indexOf("parameters")
    );
});

test("многострочный вложенный вызов получает имя после скобки", () => {
    const answer = hintsOf([
        "  execSql(",
        '    "select 1",',
        "    makeArray(",
        "      sqlParam(1),",
        "      sqlParam(2)",
        "    )",
        "  );"
    ]);
    const params = find(answer, "\u2190 params");

    assert.strictEqual(
        answer.lines[params.line].trim(),
        ")",
        "подсказка обязана стоять после закрывающей скобки вложенного вызова"
    );
    assert.strictEqual(
        params.character,
        answer.lines[params.line].indexOf(")") + 1,
        "ровно за скобкой"
    );

    /*
     * Вложенный вызов разбирается сам по себе: его аргументы однострочные, и
     * подсказки у них по-прежнему впереди.
     */
    const first = find(answer, "first:");
    const second = find(answer, "second:");

    assert.strictEqual(first.text.trim(), "sqlParam(1),");
    assert.strictEqual(
        first.character,
        answer.lines[first.line].indexOf("sqlParam")
    );
    assert.strictEqual(second.text.trim(), "sqlParam(2)");
    assert.strictEqual(
        answer.items.filter(item => item.label === "value:").length,
        2,
        "у каждого sqlParam своя подсказка"
    );
});

test("подсказки не двигают ни текста, ни отступов", () => {
    /*
     * Прямая проверка того, ради чего всё затевалось: слева от кода подсказок
     * нет вовсе, а сам текст файла не изменился ни на символ.
     */
    const body = [
        "  execSql(",
        '    "select 1 " +',
        '    "from dual",',
        "    makeArray(",
        "      sqlParam(1),",
        "      sqlParam(2)",
        "    )",
        "  );"
    ];
    const answer = hintsOf(body);

    assert.strictEqual(
        answer.source,
        [...DECLARATIONS, "Macro Test()", ...body, "End;", ""].join("\n"),
        "текст файла подсказки не трогают"
    );

    for (const item of answer.items) {
        const indent = answer.lines[item.line].length -
            answer.lines[item.line].trimStart().length;

        assert.ok(
            item.character >= indent,
            "подсказка «" + item.label + "» встала в отступ строки «" +
                answer.lines[item.line] + "»: символ " + item.character +
                " при отступе " + indent
        );
    }

    /* И ни одна подсказка не стоит на первой строке многострочного аргумента. */
    const trailing = answer.items.filter(item =>
        item.label.startsWith("\u2190"));

    assert.strictEqual(
        trailing.length,
        2,
        "многострочных аргумента здесь два: " +
            JSON.stringify(answer.items.map(item => item.label))
    );

    for (const item of trailing) {
        assert.strictEqual(
            item.character,
            answer.lines[item.line].trimEnd().length -
                (answer.lines[item.line].trimEnd().endsWith(",") ? 1 : 0),
            "подсказка «" + item.label + "» обязана стоять в конце строки «" +
                answer.lines[item.line] + "»"
        );
    }
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

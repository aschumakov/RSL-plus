"use strict";

/**
 * Недостижимый код, inlay hints с выведенным типом и проверка коллизий Rename.
 *
 * Все три сделаны без расширения парсера и без анализа значений, поэтому здесь
 * важнее всего границы: где проверка обязана молчать.
 */

const assert = require("assert");

const { buildRslDiagnostics } = require("../server/out/diagnostics");
const {
    buildRslInlayHints
} = require("../server/out/features/inlayHintProvider");
const {
    findRslRenameConflict
} = require("../server/out/features/renameProvider");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");

let passed = 0;
let failed = 0;

function test(name, action) {
    try {
        action();
        passed++;
        console.log(`[OK] ${name}`);
    } catch (error) {
        failed++;
        console.error(`[FAIL] ${name}`);
        console.error(error);
    }
}

const MAIN = "file:///main.mac";

function open(lines) {
    const source = Array.isArray(lines) ? lines.join("\n") : lines;
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([MAIN]);
    const module = index.updateOpenModule(MAIN, source, 1);
    return {
        index,
        module,
        source,
        resolver: new RslScopeResolver(index)
    };
}

/** Строки (с единицы), помеченные как недостижимые. */
function unreachableLines(lines) {
    const context = open(lines);
    return buildRslDiagnostics(context.module, context.index)
        .filter(item => item.code === "unreachable-code")
        .map(item => `${item.range.start.line + 1}-${item.range.end.line + 1}`);
}

/*
 * ─── Недостижимый код ───────────────────────────────────────────────────────
 */

test("код после RETURN, BREAK и CONTINUE недостижим", () => {
    assert.deepStrictEqual(
        unreachableLines([
            "Macro Test()",
            "  Return 1;",
            "  a = 2;",
            "End;"
        ]),
        ["3-3"]
    );
    assert.deepStrictEqual(
        unreachableLines([
            "Macro Test(c)",
            "  While (c)",
            "    Break;",
            "    a = 1;",
            "  End;",
            "End;"
        ]),
        ["4-4"]
    );
    assert.deepStrictEqual(
        unreachableLines([
            "Macro Test(c)",
            "  While (c)",
            "    Continue;",
            "    a = 1;",
            "  End;",
            "End;"
        ]),
        ["4-4"]
    );

    /* Диапазон охватывает всё недостижимое, а не только первый оператор. */
    assert.deepStrictEqual(
        unreachableLines([
            "Macro Test()",
            "  Return 1;",
            "  a = 2;",
            "  b = 3;",
            "End;"
        ]),
        ["3-4"]
    );
});

test("IF со всеми вышедшими ветками — сам выход", () => {
    assert.deepStrictEqual(
        unreachableLines([
            "Macro Test(c)",
            "  If (c)",
            "    Return 1;",
            "  Else",
            "    Return 2;",
            "  End;",
            "  a = 3;",
            "End;"
        ]),
        ["7-7"]
    );
    assert.deepStrictEqual(
        unreachableLines([
            "Macro Test(c)",
            "  If (c)",
            "    Return 1;",
            "  Elif (c)",
            "    Return 2;",
            "  Else",
            "    Return 3;",
            "  End;",
            "  a = 4;",
            "End;"
        ]),
        ["9-9"]
    );
});

test("недостижимым не считается то, что может исполниться", () => {
    const reachable = [
        [
            "IF без ELSE: ложное условие ведёт дальше",
            ["Macro T(c)", "  If (c)", "    Return 1;", "  End;", "  a = 2;", "End;"]
        ],
        [
            "ELSE не выходит",
            ["Macro T(c)", "  If (c)", "    Return 1;", "  Else", "    a = 2;",
                "  End;", "  b = 3;", "End;"]
        ],
        [
            "ELIF не выходит",
            ["Macro T(c)", "  If (c)", "    Return 1;", "  Elif (c)", "    a = 2;",
                "  Else", "    Return 3;", "  End;", "  b = 4;", "End;"]
        ],
        [
            "тело WHILE может не выполниться ни разу",
            ["Macro T(c)", "  While (c)", "    Return 1;", "  End;", "  a = 2;",
                "End;"]
        ],
        [
            "в ONERROR попадают по ошибке, а не по порядку",
            ["Macro T()", "  Return 1;", "OnError", "  a = 2;", "End;"]
        ],
        [
            "соседний Macro — своя последовательность",
            ["Macro A()", "  Return 1;", "End;", "Macro B()", "  a = 2;", "End;"]
        ],
        [
            "RETURN с переносом строки: значение — часть его оператора",
            ["Macro T()", "  Return", "    1;", "End;"]
        ],
        [
            "одинокая точка с запятой — не оператор",
            ["Macro T()", "  Return 1;", "  ;", "End;"]
        ],
        [
            "обычный код",
            ["Macro T()", "  a = 1;", "  Return 2;", "End;"]
        ]
    ];

    for (const [label, lines] of reachable) {
        assert.deepStrictEqual(unreachableLines(lines), [], label);
    }
});

test("вложенный недостижимый блок не удваивает сообщение", () => {
    /* Внешний диапазон уже накрыл содержимое: второй раз говорить незачем. */
    assert.deepStrictEqual(
        unreachableLines([
            "Macro Test(c)",
            "  Return 1;",
            "  If (c)",
            "    a = 2;",
            "  End;",
            "End;"
        ]),
        ["3-5"]
    );
});

/*
 * ─── Inlay hints ────────────────────────────────────────────────────────────
 */

test("выведенный тип показывается там, где типа в тексте нет", () => {
    const context = open([
        "Class Doc",
        "  Macro Save()",
        "  End;",
        "End;",
        "Macro Test()",
        "  Var doc = Doc();",
        "  Var typed: String;",
        "  Var plain;",
        "  Var count = 5;",
        "  other = Doc();",
        "End;"
    ]);
    const hints = buildRslInlayHints(
        context.module,
        context.resolver,
        { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } }
    );

    assert.deepStrictEqual(
        hints.map(hint => `${hint.position.line + 1}${hint.label}`),
        ["6: Doc", "9: Integer"],
        "Var typed: String — тип уже написан; Var plain — тип неизвестен; " +
            "other без объявления аннотировать нечем"
    );

    /* Подсказка обязана объяснять, что тип выведен, а не объявлен. */
    assert.ok(hints.every(hint => /выведен/.test(String(hint.tooltip))));
});

test("подсказка называет тип константы её типом", () => {
    const context = open([
        "Macro Test()",
        "  Var allSum = $0;",
        "  Var count = 2345;",
        "  Var rate = 4356.234;",
        "  Var mask = #F2;",
        "End;"
    ]);
    const hints = buildRslInlayHints(
        context.module,
        context.resolver,
        { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } }
    );

    assert.deepStrictEqual(
        hints.map(hint => hint.label),
        [": Money", ": Integer", ": Double", ": Integer"],
        "знак доллара задаёт денежную константу, а не целое"
    );
});

test("подсказка не зависит от размера файла", () => {
    /*
     * Подсказка стоит у объявления и говорит о его инициализаторе — значит
     * присваивания ниже по тексту ей не нужны. Общий вывод типа ради них
     * строил индекс присваиваний всего файла, и первый запрос после каждой
     * правки дорожал вместе с файлом: 11 мс на 54 КБ, 27 мс на 224 КБ. Здесь
     * проверяется не скорость, а её независимость от объёма.
     */
    const declarations = ["Class Doc", "End;", "Macro Test()", "  Var doc = Doc();"];
    const tail = [];

    for (let index = 0; index < 4000; index++) {
        tail.push(`  Var noise${index} = Doc();`);
        tail.push(`  noise${index} = Doc();`);
    }
    tail.push("End;");

    const visible = { start: { line: 3, character: 0 }, end: { line: 3, character: 99 } };
    /*
     * Медиана нескольких прогонов, а не один замер: единственная пауза
     * сборщика мусора на загруженной машине давала 25 мс и роняла проверку,
     * ничего при этом не найдя.
     */
    const measure = lines => {
        const context = open(lines);
        const times = [];
        let hints = [];

        for (let attempt = 0; attempt < 5; attempt++) {
            const started = process.hrtime.bigint();
            hints = buildRslInlayHints(context.module, context.resolver, visible);
            times.push(Number(process.hrtime.bigint() - started) / 1e6);
        }

        times.sort((left, right) => left - right);
        return { ms: times[2], hints };
    };

    const small = measure([...declarations, "End;"]);
    const large = measure([...declarations, ...tail]);

    assert.deepStrictEqual(
        large.hints.map(hint => hint.label),
        small.hints.map(hint => hint.label),
        "подсказка для видимой строки не зависит от того, что ниже"
    );
    /*
     * Сравнивается характер, а не абсолютная разница: обход всего файла даёт
     * рост в сотни раз, а шум измерения — единицы.
     */
    assert.ok(
        large.ms < Math.max(5, small.ms * 20),
        "запрос для одной видимой строки не имеет права сканировать весь файл; " +
            `${small.ms.toFixed(2)} мс против ${large.ms.toFixed(2)} мс на ` +
            `${tail.length} строк ниже`
    );
});

test("inlay hints считаются только для запрошенного диапазона", () => {
    const context = open([
        "Class Doc",
        "End;",
        "Macro Test()",
        "  Var first = Doc();",
        "  Var second = Doc();",
        "End;"
    ]);
    const inRange = buildRslInlayHints(
        context.module,
        context.resolver,
        { start: { line: 3, character: 0 }, end: { line: 3, character: 99 } }
    );

    assert.strictEqual(inRange.length, 1);
    assert.strictEqual(inRange[0].position.line, 3);
});

/*
 * ─── Коллизии Rename ────────────────────────────────────────────────────────
 */

test("Rename отказывается от имени, занятого в той же области", () => {
    const context = open([
        "Macro Test()",
        "  Var alpha;",
        "  Var beta;",
        "  alpha = 1;",
        "End;",
        "Macro Other()",
        "  Var alpha;",
        "End;"
    ]);
    const conflict = newName => findRslRenameConflict(
        context.module,
        context.resolver,
        context.source.indexOf("alpha = 1"),
        newName
    );

    assert.match(conflict("beta"), /уже объявлено имя beta/);
    assert.match(conflict("end"), /зарезервированное слово/);
    assert.match(conflict("1bad"), /не является допустимым именем/);
    assert.match(conflict("{curdate}"), /спецпеременной/);
});

test("Rename не мешает там, где конфликта нет", () => {
    const context = open([
        "Macro Test()",
        "  Var alpha;",
        "  alpha = 1;",
        "End;",
        "Macro Other()",
        "  Var beta;",
        "End;"
    ]);
    const conflict = newName => findRslRenameConflict(
        context.module,
        context.resolver,
        context.source.indexOf("alpha = 1"),
        newName
    );

    assert.strictEqual(conflict("gamma"), undefined);
    /* Другой Macro — другая область: RSL такие имена допускает. */
    assert.strictEqual(conflict("beta"), undefined);
    /* Macro модуля тоже в другой области. */
    assert.strictEqual(conflict("Other"), undefined);
    /* Переименование в себя с другим регистром — не конфликт. */
    assert.strictEqual(conflict("ALPHA"), undefined);
});

if (failed > 0) {
    console.error(`\nПройдено: ${passed}\nОшибок: ${failed}`);
    process.exitCode = 1;
} else {
    console.log(`\nПройдено: ${passed}\nОшибок: ${failed}`);
}

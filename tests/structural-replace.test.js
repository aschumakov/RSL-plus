"use strict";

/**
 * Замена по структуре кода.
 *
 * Продолжение структурного поиска: образец описывает форму вызова, шаблон — во
 * что его переписать, а то, что попало в заполнители, переносится дословно.
 *
 * Проверяется прежде всего то, чем такая команда опасна.
 *
 * Устаревшие диапазоны. Между подготовкой и применением пользователь читает
 * предпросмотр, и за это время файл могли поправить. Применить старый диапазон
 * значит молча испортить код, поэтому применение сверяет содержимое заново: у
 * открытого документа по версии, у закрытого по отпечатку.
 *
 * Наложение правок. `Foo(Foo(x))` даёт два совпадения — внешнее и внутреннее;
 * заменить оба значит наложить одну правку на другую, а такую правку редактор
 * отклоняет целиком, вместе с остальными в этом файле.
 *
 * BOM, CRLF и кодировка. Правки отдаются диапазонами, а не новым текстом файла:
 * тем, что решает пишущий, мы не распоряжаемся.
 *
 * И цена: второго разбора файла замена не делает — совпадения берутся тем же
 * разбором, что и у поиска.
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

const {
    applyRslReplacementTemplate,
    applyRslStructuralReplace,
    parseRslReplacementTemplate,
    prepareRslStructuralReplace,
    RslStructuralReplaceSession,
    withoutOverlaps
} = require("../server/out/features/structuralReplace");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const lexer = require("../server/out/lexer");

let passed = 0;
let failed = 0;
const planned = [];

function test(name, action) {
    planned.push({ name, action });
}

/**
 * Проект в памяти: файлы, чтение и счётчик разборов.
 *
 * Индекс ссылок подменяется: настоящий читает диск, а стенду нужен только
 * отбор кандидатов по имени вызова.
 */
function stand(files, options = {}) {
    const uris = Object.keys(files);
    const index = new WorkspaceIndex();

    index.registerWorkspaceFiles(uris);

    const state = { texts: { ...files }, reads: 0 };
    const environment = {
        index,
        referenceIndex: {
            findCandidates: async () => uris.map(uri => ({ uri }))
        },
        yieldToInteractive: () => Promise.resolve(),
        now: () => 0,
        documentVersion: uri => options.versions?.[uri],
        readSource: async uri => {
            state.reads++;

            return state.texts[uri];
        }
    };

    return { index, environment, state };
}

const MAIN = "file:///d:/replace/main.mac";
const OTHER = "file:///d:/replace/other.mac";

/* ─── Шаблон ─────────────────────────────────────────────────────────────── */

test("шаблон разбирается на куски и заполнители", () => {
    const parsed = parseRslReplacementTemplate("ExecMacro2($file, $args...)");

    assert.ok(parsed.template, parsed.problem);
    assert.deepStrictEqual(
        [...parsed.template.placeholders],
        ["file", "args"]
    );
    assert.strictEqual(
        applyRslReplacementTemplate(parsed.template, {
            file: "\"lib.mac\"",
            args: "1, 2"
        }),
        "ExecMacro2(\"lib.mac\", 1, 2)"
    );
});

test("двойной доллар — это сам знак", () => {
    /* В RSL доллар начинает литерал, и написать его в замене надо уметь. */
    const parsed = parseRslReplacementTemplate("Log($$100)");

    assert.ok(parsed.template, parsed.problem);
    assert.strictEqual(
        applyRslReplacementTemplate(parsed.template, {}),
        "Log($100)"
    );
});

test("пустой шаблон и доллар без имени не принимаются", () => {
    assert.ok(parseRslReplacementTemplate("   ").problem);
    assert.ok(parseRslReplacementTemplate("Foo($)").problem);
});

test("заполнитель, которого нет в образце, не принимается", async () => {
    /*
     * Молча подставить пустоту нельзя: это тихо испортило бы код во всех
     * найденных файлах сразу.
     */
    const board = stand({ [MAIN]: "Foo(1);\n" });
    const answer = await prepareRslStructuralReplace(board.environment, {
        pattern: "Foo($a)",
        replacement: "Bar($b)"
    });

    assert.ok(answer.problem, "ожидалась жалоба на $b");
    assert.ok(answer.problem.includes("$b"), answer.problem);
    assert.strictEqual(answer.replacements, 0);
});

/* ─── Подготовка ─────────────────────────────────────────────────────────── */

test("замена нескольких вызовов в одном файле", async () => {
    const board = stand({
        [MAIN]: [
            "Macro Run()",
            "    ExecMacroFile(\"a.mac\", 1);",
            "    ExecMacroFile(\"b.mac\", 2, 3);",
            "End;",
            ""
        ].join("\n")
    });
    const answer = await prepareRslStructuralReplace(board.environment, {
        pattern: "ExecMacroFile($file, $args...)",
        replacement: "ExecMacro2($file, $args...)"
    });

    assert.strictEqual(answer.problem, undefined);
    assert.strictEqual(answer.replacements, 2);
    assert.strictEqual(answer.files, 1);
    assert.deepStrictEqual(
        answer.previews.map(item => item.after),
        [
            "ExecMacro2(\"a.mac\", 1)",
            "ExecMacro2(\"b.mac\", 2, 3)"
        ]
    );
});

test("правки одного файла не пересекаются и идут по порядку", async () => {
    const board = stand({
        [MAIN]: "Foo(1);\nFoo(2);\nFoo(3);\n"
    });
    const answer = await prepareRslStructuralReplace(board.environment, {
        pattern: "Foo($a)",
        replacement: "Bar($a)"
    });
    const edits = answer.sources[0].edits;

    assert.strictEqual(edits.length, 3);

    for (let at = 1; at < edits.length; at++) {
        const previous = edits[at - 1].range.end;
        const current = edits[at].range.start;

        assert.ok(
            previous.line < current.line ||
                (previous.line === current.line &&
                    previous.character <= current.character),
            "правка " + at + " начинается раньше конца предыдущей"
        );
    }
});

test("вложенное совпадение не заменяется", async () => {
    /*
     * `Foo(Foo(x))` — два совпадения. Заменить оба значит наложить правки, а
     * такую правку редактор отклонит целиком.
     */
    const board = stand({ [MAIN]: "Foo(Foo(1));\n" });
    const answer = await prepareRslStructuralReplace(board.environment, {
        pattern: "Foo($a)",
        replacement: "Bar($a)"
    });

    assert.strictEqual(answer.replacements, 1);
    assert.strictEqual(answer.overlapping, 1, "вложенное посчитано");
    assert.strictEqual(
        answer.previews[0].after,
        "Bar(Foo(1))",
        "внутреннее переносится дословно вместе с аргументом"
    );
});

test("выбор внешнего совпадения не зависит от порядка", () => {
    const matches = [
        { start: 4, end: 12, bindings: {} },
        { start: 0, end: 14, bindings: {} },
        { start: 20, end: 25, bindings: {} }
    ];

    assert.deepStrictEqual(
        withoutOverlaps(matches).map(item => item.start),
        [0, 20]
    );
});

test("замена, ничего не меняющая, правкой не становится", async () => {
    const board = stand({ [MAIN]: "Foo(1);\n" });
    const answer = await prepareRslStructuralReplace(board.environment, {
        pattern: "Foo($a)",
        replacement: "Foo($a)"
    });

    assert.strictEqual(answer.replacements, 0);
    assert.strictEqual(answer.files, 0);
});

test("предел замен соблюдается", async () => {
    const board = stand({
        [MAIN]: "Foo(1);\nFoo(2);\nFoo(3);\nFoo(4);\n"
    });
    const answer = await prepareRslStructuralReplace(board.environment, {
        pattern: "Foo($a)",
        replacement: "Bar($a)",
        limit: 2
    });

    assert.strictEqual(answer.replacements, 2);
    assert.strictEqual(answer.truncated, true);
});

test("замена не разбирает файл второй раз", async () => {
    /*
     * Совпадения берутся тем же разбором, что и у поиска: второй полный lex
     * ради того же ответа — это цена, за которую ничего не куплено.
     */
    const source = "Foo(1);\nFoo(2);\n";
    const board = stand({ [MAIN]: source });
    const original = lexer.lexRsl;
    let calls = 0;

    lexer.lexRsl = (...args) => {
        calls++;

        return original(...args);
    };

    try {
        await prepareRslStructuralReplace(board.environment, {
            pattern: "Foo($a)",
            replacement: "Bar($a)"
        });
    } finally {
        lexer.lexRsl = original;
    }

    assert.strictEqual(
        calls,
        2,
        "один разбор образца и один разбор файла, получено " + calls
    );
});

/* ─── Применение ─────────────────────────────────────────────────────────── */

test("применение собирает правку по подготовленному", async () => {
    const board = stand({ [MAIN]: "Foo(1);\n", [OTHER]: "Foo(2);\n" });
    const prepared = await prepareRslStructuralReplace(board.environment, {
        pattern: "Foo($a)",
        replacement: "Bar($a)"
    });
    const applied = await applyRslStructuralReplace(
        board.environment,
        prepared.sources
    );

    assert.strictEqual(applied.files, 2);
    assert.strictEqual(applied.replacements, 2);
    assert.deepStrictEqual(applied.staleFiles, []);
    assert.strictEqual(applied.edit.documentChanges.length, 2);
});

test("изменившийся закрытый файл не правится", async () => {
    /* Тот самый случай: диапазоны, снятые до правки, указывают уже не туда. */
    const board = stand({ [MAIN]: "Foo(1);\n", [OTHER]: "Foo(2);\n" });
    const prepared = await prepareRslStructuralReplace(board.environment, {
        pattern: "Foo($a)",
        replacement: "Bar($a)"
    });

    /* Пока пользователь читал предпросмотр, файл поправили. */
    board.state.texts[MAIN] = "// комментарий\nFoo(1);\n";

    const applied = await applyRslStructuralReplace(
        board.environment,
        prepared.sources
    );

    assert.deepStrictEqual(
        applied.staleFiles,
        [MAIN],
        "файл изменился — его правки отброшены"
    );
    assert.strictEqual(applied.files, 1, "а остальные применяются");
    assert.strictEqual(
        applied.edit.documentChanges[0].textDocument.uri,
        OTHER
    );
});

test("исчезнувший файл не правится", async () => {
    const board = stand({ [MAIN]: "Foo(1);\n" });
    const prepared = await prepareRslStructuralReplace(board.environment, {
        pattern: "Foo($a)",
        replacement: "Bar($a)"
    });

    delete board.state.texts[MAIN];

    const applied = await applyRslStructuralReplace(
        board.environment,
        prepared.sources
    );

    assert.deepStrictEqual(applied.staleFiles, [MAIN]);
    assert.strictEqual(applied.edit, undefined);
});

test("версия открытого документа входит в правку", async () => {
    /*
     * У открытого документа опора — версия: правку для устаревшего документа
     * отклонит сам редактор, и делать это за него незачем.
     */
    const board = stand(
        { [MAIN]: "Foo(1);\n" },
        { versions: { [MAIN]: 7 } }
    );
    const prepared = await prepareRslStructuralReplace(board.environment, {
        pattern: "Foo($a)",
        replacement: "Bar($a)"
    });
    const applied = await applyRslStructuralReplace(
        board.environment,
        prepared.sources
    );

    assert.strictEqual(
        applied.edit.documentChanges[0].textDocument.version,
        7
    );
});

test("у закрытого файла версии нет", async () => {
    const board = stand({ [MAIN]: "Foo(1);\n" });
    const prepared = await prepareRslStructuralReplace(board.environment, {
        pattern: "Foo($a)",
        replacement: "Bar($a)"
    });
    const applied = await applyRslStructuralReplace(
        board.environment,
        prepared.sources
    );

    assert.strictEqual(
        applied.edit.documentChanges[0].textDocument.version,
        null,
        "null означает «версия не важна», и это не то же, что отсутствие поля"
    );
});

test("отмена доходит до применения", async () => {
    const board = stand({ [MAIN]: "Foo(1);\n" });
    const prepared = await prepareRslStructuralReplace(board.environment, {
        pattern: "Foo($a)",
        replacement: "Bar($a)"
    });
    const applied = await applyRslStructuralReplace(
        board.environment,
        prepared.sources,
        () => true
    );

    assert.ok(applied.problem, "отмена обязана быть названа");
    assert.strictEqual(applied.edit, undefined);
});

test("отмена доходит до подготовки", async () => {
    const board = stand({ [MAIN]: "Foo(1);\n" });
    const answer = await prepareRslStructuralReplace(
        board.environment,
        { pattern: "Foo($a)", replacement: "Bar($a)" },
        () => true
    );

    assert.strictEqual(answer.cancelled, true);
    assert.strictEqual(answer.replacements, 0);
});

/* ─── BOM, CRLF, кодировка ───────────────────────────────────────────────── */

test("правка не выходит за границы совпадения", async () => {
    /*
     * Отсюда и берётся сохранность BOM, CRLF и кодировки: мы отдаём диапазон
     * совпадения и текст замены, а не новый текст файла. Всё, что вокруг, —
     * включая признак BOM, переводы строк и байтовое представление —
     * остаётся тому, кто пишет файл.
     */
    const source = "\uFEFFMacro Run()\r\n    Foo(1);\r\nEnd;\r\n";
    const board = stand({ [MAIN]: source });
    const answer = await prepareRslStructuralReplace(board.environment, {
        pattern: "Foo($a)",
        replacement: "Bar($a)"
    });
    const edit = answer.sources[0].edits[0];

    assert.strictEqual(answer.replacements, 1);
    assert.strictEqual(edit.newText, "Bar(1)");
    assert.ok(
        !edit.newText.includes("\n") && !edit.newText.includes("\r"),
        "текст замены переводов строк не вносит"
    );
    assert.strictEqual(
        edit.range.start.line,
        1,
        "BOM строку не сдвигает"
    );
});

test("многострочный аргумент переносится вместе с переводами строк", async () => {
    const source = [
        "Foo(",
        "    1,",
        "    2",
        ");",
        ""
    ].join("\r\n");
    const board = stand({ [MAIN]: source });
    const answer = await prepareRslStructuralReplace(board.environment, {
        pattern: "Foo($a, $b)",
        replacement: "Bar($b, $a)"
    });

    assert.strictEqual(answer.replacements, 1);
    assert.strictEqual(
        answer.previews[0].after,
        "Bar(2, 1)",
        "перенесено дословно то, что стояло в аргументах"
    );
});

/* ─── Подмена подготовленной замены ──────────────────────────────────── */

test("применяется ровно то, что показали", async () => {
    /*
     * Тот самый случай, который сверка отпечатков поймать не может.
     *
     * Пользователь запускает замену A и читает предпросмотр. Пока он читает,
     * запускается замена B и вытесняет подготовленное A. Пользователь
     * нажимает «Применить» в окне A — и без номера применилась бы B: её
     * файлы не менялись, отпечатки верны, диапазоны верны. Неверно то, что
     * подтверждали не это.
     */
    const board = stand({
        [MAIN]: "Foo(1);\n",
        [OTHER]: "Old(2);\n"
    });
    const session = new RslStructuralReplaceSession();

    const first = await prepareRslStructuralReplace(board.environment, {
        pattern: "Foo($a)",
        replacement: "Bar($a)"
    });
    const firstId = session.remember(first.sources);

    const second = await prepareRslStructuralReplace(board.environment, {
        pattern: "Old($a)",
        replacement: "New($a)"
    });
    const secondId = session.remember(second.sources);

    assert.notStrictEqual(firstId, secondId, "номера обязаны различаться");
    assert.strictEqual(
        session.take(firstId),
        undefined,
        "первая подготовка вытеснена — применять её нечем"
    );

    const taken = session.take(secondId);

    assert.ok(taken, "вторая применяется");

    const applied = await applyRslStructuralReplace(
        board.environment,
        taken
    );

    assert.strictEqual(applied.files, 1);
    assert.strictEqual(
        applied.edit.documentChanges[0].textDocument.uri,
        OTHER,
        "правится файл ВТОРОЙ замены, и подтверждали именно её"
    );
    assert.strictEqual(
        applied.edit.documentChanges[0].edits[0].newText,
        "New(2)"
    );
});

test("порядок завершения подготовок ничего не подменяет", async () => {
    /*
     * A начинается, B начинается, B заканчивается первой, A — второй.
     * Побеждает та, что запомнилась последней, но применить чужую нельзя ни
     * в одну сторону.
     */
    const board = stand({
        [MAIN]: "Foo(1);\n",
        [OTHER]: "Old(2);\n"
    });
    const session = new RslStructuralReplaceSession();

    const slow = prepareRslStructuralReplace(board.environment, {
        pattern: "Foo($a)",
        replacement: "Bar($a)"
    });
    const quick = prepareRslStructuralReplace(board.environment, {
        pattern: "Old($a)",
        replacement: "New($a)"
    });

    const quickId = session.remember((await quick).sources);
    const slowId = session.remember((await slow).sources);

    assert.strictEqual(
        session.take(quickId),
        undefined,
        "закончившаяся раньше вытеснена и применению недоступна"
    );

    const taken = session.take(slowId);

    assert.ok(taken, "а последняя запомненная — доступна");

    const applied = await applyRslStructuralReplace(
        board.environment,
        taken
    );

    assert.strictEqual(
        applied.edit.documentChanges[0].textDocument.uri,
        MAIN
    );
});

test("подготовленное применяется один раз", async () => {
    /* Второе применение того же номера — повторная правка правленых файлов. */
    const board = stand({ [MAIN]: "Foo(1);\n" });
    const session = new RslStructuralReplaceSession();
    const prepared = await prepareRslStructuralReplace(board.environment, {
        pattern: "Foo($a)",
        replacement: "Bar($a)"
    });
    const id = session.remember(prepared.sources);

    assert.ok(session.take(id));
    assert.strictEqual(session.take(id), undefined);
    assert.strictEqual(session.hasPending, false);
});

test("пустой и чужой номер не принимаются", async () => {
    const board = stand({ [MAIN]: "Foo(1);\n" });
    const session = new RslStructuralReplaceSession();
    const prepared = await prepareRslStructuralReplace(board.environment, {
        pattern: "Foo($a)",
        replacement: "Bar($a)"
    });

    session.remember(prepared.sources);

    assert.strictEqual(session.take(""), undefined);
    assert.strictEqual(session.take("replace-999"), undefined);
    assert.strictEqual(
        session.hasPending,
        true,
        "чужой номер подготовленное не съедает"
    );
});

(async () => {
    for (const item of planned) {
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

"use strict";

/**
 * Настройки форматирования: отступ проекта, пробелы, выравнивание, регистр.
 *
 * Форматирование меняет файл целиком, поэтому важнее всего то, чего оно делать
 * не должно: менять содержимое строк и SQL, терять BOM, переводить CRLF в LF,
 * дописывать или убирать финальную пустую строку. Это проверяется при каждой
 * настройке, а не один раз.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { FormatCode } = require("../server/out/format");
const {
    applyRslKeywordCase,
    resolveRslFormatOptions
} = require("../server/out/features/formatOptions");
const {
    matchesPattern,
    parseEditorConfig,
    RslEditorConfigService
} = require("../server/out/services/editorConfigService");

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

const EDITOR = { tabSize: 4, insertSpaces: true };

/* ─── Пробелы вокруг операторов ──────────────────────────────────────────── */

test("пробелы вокруг операторов ставятся и не ставятся по настройке", () => {
    const source = [
        "Macro Test()",
        "Var a=1;",
        "a=a+1;",
        "End;",
        ""
    ].join("\n");

    assert.strictEqual(
        FormatCode(source, 4, { spaceAroundOperators: true }),
        [
            "Macro Test()",
            "    Var a = 1;",
            "    a = a+1;",
            "End;",
            ""
        ].join("\n"),
        "по умолчанию пробелы вокруг присваивания ставятся"
    );
    assert.strictEqual(
        FormatCode(source, 4, { spaceAroundOperators: false }),
        [
            "Macro Test()",
            "    Var a=1;",
            "    a=a+1;",
            "End;",
            ""
        ].join("\n"),
        "выключено — внутри строки остаётся написанное автором"
    );
});

test("выравнивание присваиваний выключается настройкой", () => {
    const source = [
        "Macro Test()",
        "alpha = 1;",
        "b = 2;",
        "End;",
        ""
    ].join("\n");
    const aligned = FormatCode(source, 4, { alignAssignments: true });
    const plain = FormatCode(source, 4, { alignAssignments: false });

    assert.ok(
        /b {5}= 2;/.test(aligned),
        "по умолчанию знаки равенства выровнены:\n" + aligned
    );
    assert.ok(
        /b = 2;/.test(plain) && !/b {2,}= 2;/.test(plain),
        "выключено — один пробел до знака:\n" + plain
    );
});

/* ─── Что форматирование сохраняет при любой настройке ───────────────────── */

test("BOM, CRLF, финальная строка и SQL сохраняются при любых настройках", () => {
    const source = "﻿" + [
        "Macro Test()",
        "Var q = [select *",
        "    from   table",
        "  where a=1];",
        "Var s = \"a=b,   c\";",
        "End;"
    ].join("\r\n");

    for (const options of [
        {},
        { spaceAroundOperators: false },
        { alignAssignments: false },
        { insertSpaces: false },
        { spaceAroundOperators: false, alignAssignments: false }
    ]) {
        const formatted = FormatCode(source, 4, options);
        const label = JSON.stringify(options);

        assert.ok(
            formatted.startsWith("﻿"),
            "BOM сохранён при " + label
        );
        assert.ok(
            formatted.includes("\r\n") && !/[^\r]\n/.test(formatted),
            "перевод строки остался CRLF при " + label
        );
        assert.ok(
            !formatted.endsWith("\r\n"),
            "финальной пустой строки не было — и не появилось: " + label
        );
        assert.ok(
            formatted.includes("    from   table"),
            "многострочный SQL сохранён байт-в-байт при " + label
        );
        assert.ok(
            formatted.includes("\"a=b,   c\""),
            "содержимое строки не тронуто при " + label
        );
    }
});

test("отступ табуляциями сохраняет символ отступа", () => {
    const formatted = FormatCode(
        "Macro Test()\nVar a = 1;\nEnd;\n",
        4,
        { insertSpaces: false }
    );

    assert.ok(
        formatted.includes("\tVar a = 1;"),
        "отступ табуляцией:\n" + JSON.stringify(formatted)
    );
});

/* ─── Источники настроек ─────────────────────────────────────────────────── */

test("editorconfig важнее настроек плагина, а те важнее редактора", () => {
    const fromEditor = resolveRslFormatOptions(EDITOR, undefined, undefined);

    assert.deepStrictEqual(
        { tabSize: fromEditor.tabSize, insertSpaces: fromEditor.insertSpaces },
        { tabSize: 4, insertSpaces: true },
        "нет ни того, ни другого — слушается редактор"
    );

    const fromSettings = resolveRslFormatOptions(
        EDITOR,
        { indentStyle: "tab", indentSize: 8 },
        undefined
    );

    assert.deepStrictEqual(
        {
            tabSize: fromSettings.tabSize,
            insertSpaces: fromSettings.insertSpaces
        },
        { tabSize: 8, insertSpaces: false },
        "настройки плагина важнее редактора"
    );

    const fromProject = resolveRslFormatOptions(
        EDITOR,
        { indentStyle: "tab", indentSize: 8 },
        { insertSpaces: true, tabSize: 2 }
    );

    assert.deepStrictEqual(
        {
            tabSize: fromProject.tabSize,
            insertSpaces: fromProject.insertSpaces
        },
        { tabSize: 2, insertSpaces: true },
        "editorconfig важнее настроек плагина"
    );

    const disabled = resolveRslFormatOptions(
        EDITOR,
        { useEditorConfig: false, indentStyle: "tab", indentSize: 8 },
        { insertSpaces: true, tabSize: 2 }
    );

    assert.strictEqual(
        disabled.tabSize,
        8,
        "выключенный editorconfig не читается"
    );
});

test("настройки проверок форматирования доходят до форматтера", () => {
    const options = resolveRslFormatOptions(
        EDITOR,
        { spaceAroundOperators: false, alignAssignments: false },
        undefined
    );

    assert.strictEqual(options.spaceAroundOperators, false);
    assert.strictEqual(options.alignAssignments, false);
});

/* ─── Чтение .editorconfig ───────────────────────────────────────────────── */

test("шаблон секции сверяется с именем файла", () => {
    assert.ok(matchesPattern("*", "module.mac"));
    assert.ok(matchesPattern("*.mac", "module.mac"));
    assert.ok(matchesPattern("*.{mac,rsm}", "module.rsm"));
    assert.ok(!matchesPattern("*.{mac,rsm}", "module.txt"));
    assert.ok(matchesPattern("module.?ac", "module.mac"));
});

test("root=true прекращает обход вверх", () => {
    const parsed = parseEditorConfig([
        "root = true",
        "",
        "[*]",
        "indent_style = tab",
        "indent_size = 3"
    ].join("\n"));

    assert.strictEqual(parsed.root, true);
    assert.strictEqual(parsed.sections.length, 1);
    assert.strictEqual(parsed.sections[0].values.get("indent_style"), "tab");
});

test("ближний .editorconfig важнее дальнего", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rsl-editorconfig-"));
    const nested = path.join(root, "nested");

    fs.mkdirSync(nested);
    fs.writeFileSync(
        path.join(root, ".editorconfig"),
        "root = true\n\n[*]\nindent_style = space\nindent_size = 8\n",
        "utf8"
    );
    fs.writeFileSync(
        path.join(nested, ".editorconfig"),
        "[*.mac]\nindent_style = tab\nindent_size = 3\n",
        "utf8"
    );

    const service = new RslEditorConfigService();
    const inner = service.resolve(
        "file:///" + nested.replace(/\\/g, "/") + "/module.mac"
    );
    const outer = service.resolve(
        "file:///" + root.replace(/\\/g, "/") + "/module.mac"
    );

    assert.deepStrictEqual(
        inner,
        { insertSpaces: false, tabSize: 3 },
        "секция ближнего файла победила"
    );
    assert.deepStrictEqual(
        outer,
        { insertSpaces: true, tabSize: 8 },
        "в корне действует корневая секция"
    );

    fs.rmSync(root, { recursive: true, force: true });
});

test("без .editorconfig ответ пустой, а не выдуманный", () => {
    const service = new RslEditorConfigService();
    const missing = service.resolve("file:///" + path.join(
        os.tmpdir(),
        "rsl-no-editorconfig-" + process.pid,
        "module.mac"
    ).replace(/\\/g, "/"));

    assert.deepStrictEqual(Object.keys(missing), []);
});

/* ─── Регистр вставляемых слов ───────────────────────────────────────────── */

test("регистр вставляемого слова следует настройке", () => {
    /*
     * По умолчанию — как плагин писал всегда: у каждого места своё привычное
     * написание, и появление настройки не меняет ни один файл само собой.
     */
    assert.strictEqual(applyRslKeywordCase("Var", undefined), "Var");
    assert.strictEqual(applyRslKeywordCase("Var", "asIs"), "Var");
    assert.strictEqual(applyRslKeywordCase("end;", undefined), "end;");
    assert.strictEqual(applyRslKeywordCase("Var", "lower"), "var");
    assert.strictEqual(applyRslKeywordCase("end;", "upper"), "END;");
    assert.strictEqual(applyRslKeywordCase("end;", "capitalize"), "End;");
});

if (failed > 0) {
    console.error(`\nПройдено: ${passed}\nОшибок: ${failed}`);
    process.exitCode = 1;
} else {
    console.log(`\nПройдено: ${passed}\nОшибок: ${failed}`);
}

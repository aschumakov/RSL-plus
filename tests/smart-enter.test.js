"use strict";

const assert = require("assert");
const {
    RSL_BLOCK_END
} = require("../client/out/rslBlockText");
const extensionManifest = require("../package.json");
const {
    createRslEnterTimings,
    buildRslSmartEnterSnippet,
    isRslBlockHeader,
    plainEnterIndent
} = require("../client/out/smartEnter");

assert.ok(
    extensionManifest.activationEvents.includes("onCommand:rsl.smartEnter"),
    "rsl.smartEnter должна явно активировать расширение"
);
assert.ok(
    extensionManifest.contributes.commands.some(item =>
        item.command === "rsl.smartEnter"
    ),
    "rsl.smartEnter должна быть объявлена в contributes.commands"
);

/*
 * Обычный Enter обрабатывает редактор.
 *
 * Раньше команда была привязана к Enter безусловно, и каждое нажатие уходило в
 * extension host: новая строка появлялась с задержкой, а `default:type` вставлял
 * перевод строки как текст, минуя обработку Enter, — отступ терялся. Настройка
 * completeBlocksOnEnter не спасала: она проверялась уже внутри команды.
 */
const enterBindings = extensionManifest.contributes.keybindings
    .filter(item => item.key === "enter");

assert.ok(
    enterBindings.every(item =>
        item.when.includes("config.rslPlus.editor.completeBlocksOnEnter")
    ),
    "привязка к Enter обязана зависеть от настройки, иначе её нельзя отключить"
);
assert.ok(
    extensionManifest.contributes.keybindings.some(item =>
        item.command === "rsl.smartEnter" && item.key === "shift+enter"
    ),
    "завершение блока обязано иметь собственное сочетание клавиш"
);
assert.strictEqual(
    extensionManifest.contributes.configuration.properties[
        "rslPlus.editor.completeBlocksOnEnter"
    ].default,
    false,
    "по умолчанию Enter не доходит до расширения"
);

/*
 * Отступы в snippet — только относительные.
 *
 * Отступ строки, в которой вставляется многострочный snippet, редактор
 * добавляет сам. Свой отступ поверх этого удваивал его: после каждого Enter
 * новая строка получала двойной отступ предыдущей.
 */
for (const indentUnit of ["    ", "\t"]) {
    const snippet = buildRslSmartEnterSnippet({
        beforeCursor: "        If (c)",
        afterCursor: "",
        indentUnit,
        eol: "\n"
    });

    assert.strictEqual(
        snippet,
        `\n${indentUnit}$0\n${RSL_BLOCK_END}`,
        "в snippet допустим только шаг отступа, но не отступ исходной строки"
    );
}

/* Отступ обычной новой строки, наоборот, абсолютный: там нет автоотступа. */
assert.strictEqual(plainEnterIndent("        x = 1;", 14), "        ");
assert.strictEqual(plainEnterIndent("x = 1;", 6), "");
assert.strictEqual(
    plainEnterIndent("        x = 1;", 4),
    "    ",
    "Enter из середины отступа не должен его удваивать"
);

/*
 * Блок целиком дают шаблоны — так это и делают другие расширения. Без них
 * выключенный перехват Enter означал бы, что закрытие писать руками.
 */
const snippets = require("../snippets/snippets.json");
const withEnd = Object.values(snippets)
    .filter(item => /\bend\s*;/i.test(
        Array.isArray(item.body) ? item.body.join("\n") : String(item.body)
    ))
    .map(item => String(item.prefix).toLowerCase());

for (const prefix of ["if", "while", "for", "macro"]) {
    assert.ok(
        withEnd.includes(prefix),
        `шаблон ${prefix} обязан создавать блок вместе с ${RSL_BLOCK_END}`
    );
}

/*
 * Отступ после Enter выполняет ядро редактора: правила декларативные, и
 * extension host в них не участвует. Это и есть замена перехвату Enter.
 */
const indentation = require("../language-configuration.json").indentationRules;
const increase = new RegExp(
    indentation.increaseIndentPattern.pattern,
    indentation.increaseIndentPattern.flags
);
const decrease = new RegExp(
    indentation.decreaseIndentPattern.pattern,
    indentation.decreaseIndentPattern.flags
);

for (const line of [
    "Macro Test()",
    "Private Macro Test()",
    "Class Doc",
    "  If (c)",
    "  While (x > 0)",
    "  For (i = 0; i < n; i = i + 1)",
    "  With (obj)",
    "  Else",
    "  Elif (c)",
    "  OnError"
]) {
    assert.ok(increase.test(line), `после ${line} нужен отступ`);
}

for (const line of ["  End;", "End;", "  Else", "  Elif (c)", "  OnError"]) {
    assert.ok(decrease.test(line), `${line} обязан выйти на уровень блока`);
}

for (const line of [
    "  If (c) x = 1; End;",
    "  x = 1;",
    "  iff(x);",
    "  Var endless = 1;",
    "  ends = 1;"
]) {
    assert.ok(!increase.test(line), `${line} не открывает блок`);
    assert.ok(!decrease.test(line), `${line} не закрывает блок`);
}

for (const header of [
    "If (1 == 1)",
    "If ()",
    "while()",
    "For ( )",
    "while (not rs.Eof)",
    "For (Var i, 0, 10, 1)",
    "With (document)",
    "Private Macro GetOrigin(value): Integer",
    "Class (BaseClass) Service(value)"
]) {
    assert.ok(isRslBlockHeader(header), `${header} должен открывать блок`);
}

for (const text of [
    "If (",
    "value = If(true)",
    "Else",
    "OnError()",
    "Return true;"
]) {
    assert.ok(!isRslBlockHeader(text), `${text} не должен открывать блок`);
}

assert.strictEqual(
    buildRslSmartEnterSnippet({
        beforeCursor: "    If ()",
        afterCursor: "",
        indentUnit: "    ",
        eol: "\n"
    }),
    `\n    $0\n${RSL_BLOCK_END}`
);

assert.strictEqual(
    buildRslSmartEnterSnippet({
        beforeCursor: "  If (1 == 1)",
        afterCursor: "",
        indentUnit: "    ",
        eol: "\n"
    }),
    `\n    $0\n${RSL_BLOCK_END}`
);

assert.strictEqual(
    buildRslSmartEnterSnippet({
        beforeCursor: "\tWhile (true)",
        afterCursor: "   ",
        indentUnit: "\t",
        eol: "\r\n",
        nextNonEmptyLine: "\tEnd;"
    }),
    "\r\n\t$0"
);

/*
 * Вложенный IF вставляется относительно уже существующего отступа строки.
 * VS Code самостоятельно добавит baseIndent к каждой новой строке snippet.
 */
assert.strictEqual(
    buildRslSmartEnterSnippet({
        beforeCursor: "        If (ready)",
        afterCursor: "",
        indentUnit: "    ",
        eol: "\n"
    }),
    `\n    $0\n${RSL_BLOCK_END}`
);

assert.strictEqual(
    buildRslSmartEnterSnippet({
        beforeCursor: "If (true)",
        afterCursor: " + other",
        indentUnit: "    ",
        eol: "\n"
    }),
    undefined
);

console.log("[OK] Smart Enter завершает только полные RSL-блоки");

/*
 * Регистр закрытия блока.
 *
 * Автоматически вставленный код обязан закрывать блок так же, как принято в
 * репозитории, — в нижнем регистре, и одинаково во всех источниках. Проверка
 * смотрит и на шаблоны: раньше `End;` возвращался именно через них.
 */
assert.strictEqual(RSL_BLOCK_END, "end;");

for (const [name, item] of Object.entries(snippets)) {
    const body = Array.isArray(item.body)
        ? item.body.join("\n")
        : String(item.body);

    assert.ok(
        !/\bEnd\s*;/.test(body),
        `шаблон ${name} обязан закрывать блок как ${RSL_BLOCK_END}`
    );
}

assert.ok(
    buildRslSmartEnterSnippet({
        beforeCursor: "Macro Test()",
        afterCursor: "",
        indentUnit: "    ",
        eol: "\n"
    }).endsWith(RSL_BLOCK_END),
    "Smart Enter закрывает блок из общего источника"
);

console.log("[OK] закрытие блока вставляется в нижнем регистре");

/* Сводка замеров Enter: этот файл проверяет утверждениями, без раннера. */
/*
 * Сводка — ответ на жалобу «курсор отстаёт»: по ней видно и полное
 * время нажатия, и отдельно правку документа.
 */
const timings = createRslEnterTimings(3);

assert.strictEqual(timings.summary(), undefined);

timings.record({ kind: "plain", totalMs: 1, editMs: 0.5 });
timings.record({ kind: "snippet", totalMs: 20, editMs: 18 });
timings.record({ kind: "plain", totalMs: 3, editMs: 1 });

const summary = timings.summary();

assert.ok(/нажатий 3/.test(summary), summary);
assert.ok(/завершено блоков 1/.test(summary), summary);
assert.ok(/максимум 20.0 мс/.test(summary), summary);

/* Хранится только последнее окно: старые нажатия вытесняются. */
timings.record({ kind: "plain", totalMs: 2, editMs: 1 });
timings.record({ kind: "plain", totalMs: 2, editMs: 1 });
timings.record({ kind: "plain", totalMs: 2, editMs: 1 });

assert.strictEqual(timings.count(), 3);
assert.ok(
    !/максимум 20.0 мс/.test(timings.summary()),
    "давние нажатия не держатся вечно: " + timings.summary()
);

console.log("[OK] сводка замеров Enter");

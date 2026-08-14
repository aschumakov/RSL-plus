"use strict";

const assert = require("assert");
const extensionManifest = require("../package.json");
const {
    buildRslPlainEnterSnippet,
    buildRslSmartEnterSnippet,
    isRslBlockHeader
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
/*
 * Перехват Enter включён: без него не добавляется `End;`, а вставить его
 * правилами отступа редактора нельзя — appendText в onEnterRules дописывает
 * текст к строке курсора, а не создаёт закрывающую строку ниже. Цена перехвата
 * снижена в другом месте: Enter больше не заставляет лексировать файл целиком.
 */
assert.strictEqual(
    extensionManifest.contributes.configuration.properties[
        "rslPlus.editor.completeBlocksOnEnter"
    ].default,
    true,
    "по умолчанию Enter завершает блок: иначе End; не появится"
);

/*
 * Отступы в snippet — только относительные.
 *
 * Отступ строки, в которой вставляется многострочный snippet, редактор
 * добавляет сам. Свой отступ поверх этого удваивал его: после каждого Enter
 * новая строка получала двойной отступ предыдущей. Правило одно на оба snippet,
 * поэтому проверяется на обоих.
 */
for (const eol of ["\n", "\r\n"]) {
    assert.strictEqual(
        buildRslPlainEnterSnippet(eol),
        `${eol}$0`,
        "обычный перевод строки не имеет права нести свой отступ"
    );
}

for (const indentUnit of ["    ", "\t"]) {
    const snippet = buildRslSmartEnterSnippet({
        beforeCursor: "        If (c)",
        afterCursor: "",
        indentUnit,
        eol: "\n"
    });

    assert.strictEqual(
        snippet,
        `\n${indentUnit}$0\nEnd;`,
        "в snippet допустим только шаг отступа, но не отступ исходной строки"
    );
}

/* Конфигурация языка не должна решать про отступ второй раз. */
assert.strictEqual(
    require("../language-configuration.json").indentationRules,
    undefined,
    "правила отступа складывались бы с отступом от snippet"
);

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
    "\n    $0\nEnd;"
);

assert.strictEqual(
    buildRslSmartEnterSnippet({
        beforeCursor: "  If (1 == 1)",
        afterCursor: "",
        indentUnit: "    ",
        eol: "\n"
    }),
    "\n    $0\nEnd;"
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
    "\n    $0\nEnd;"
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

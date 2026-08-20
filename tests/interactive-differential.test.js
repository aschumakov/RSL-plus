"use strict";

/*
 * Быстрый путь против полного: ответы обязаны совпадать целиком.
 *
 * Прежняя проверка сравнивала только URI и вообще не доходила до полного пути:
 * при готовой модели обработчик всё равно отвечал быстрым путём, и сравнение
 * шло сам с собой. Так и осталась незамеченной ошибка перехода по
 * ExecMacroFile — файл был верный, а строка нулевая.
 *
 * Здесь оба пути вызываются через настоящие обработчики LSP на одном и том же
 * стенде: сначала как есть, затем с отключёнными быстрыми ответами, — и
 * сравнивается весь результат: файл, диапазон, текст Hover, подпись.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const nodePath = require("path");
const { pathToFileURL } = require("url");

const {
    PlatformModuleCatalog
} = require("../server/out/builtins/platformModuleCatalog");
const {
    RslDefinitionProvider
} = require("../server/out/features/definitionProvider");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const interactive = require("../server/out/features/interactiveContext");
const {
    createCompletionRegistry,
    DEFAULT_SETTINGS
} = require("./completion-harness");

let passed = 0;
let failed = 0;
const planned = [];

function test(name, action) {
    planned.push({ name, action });
}

/*
 * Файлы стенда лежат на диске: полный путь перехода по имени модуля в
 * Import ищет файл в рабочей папке, и без него сравнивать было бы нечего.
 */
const WORKSPACE = fs.mkdtempSync(
    nodePath.join(os.tmpdir(), "rsl-diff-")
);
const MAIN = pathToFileURL(nodePath.join(WORKSPACE, "main.mac"))
    .toString();
const LIB = pathToFileURL(nodePath.join(WORKSPACE, "lib.mac"))
    .toString();

const LIB_SOURCE = [
    "Macro Header()",
    "  return 1;",
    "End;",
    "",
    "Macro Target(first, second)",
    "  return first;",
    "End;",
    ""
].join("\n");

const MAIN_SOURCE = [
    "Import lib;",
    "Macro Helper(alpha)",
    "  return alpha;",
    "End;",
    "Macro Test()",
    "  Var result = Target(1, 2);",
    "  ExecMacroFile(\"lib.mac\", \"Target\");",
    "  Var value = Helper(1);",
    "End;",
    ""
].join("\n");

fs.writeFileSync(nodePath.join(WORKSPACE, "lib.mac"), LIB_SOURCE, "utf8");
fs.writeFileSync(
    nodePath.join(WORKSPACE, "main.mac"),
    MAIN_SOURCE,
    "utf8"
);

const cancellation = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined })
};

/*
 * Быстрые ответы отключаются подменой экспортов модуля.
 *
 * Обработчик обращается к ним через объект модуля, поэтому подмена выключает
 * именно быстрый путь и не трогает остальную логику: запрос идёт туда, куда
 * шёл бы при неготовой модели наоборот — в полный разбор.
 */
const FAST_ANSWERS = [
    "findRslFastDefinition",
    "findRslFastTypeDefinition",
    "buildRslFastHover",
    "buildRslFastSignatureHelp"
];

async function withoutFastAnswers(action) {
    const saved = new Map();

    for (const name of FAST_ANSWERS) {
        saved.set(name, interactive[name]);
        interactive[name] = () => undefined;
    }

    try {
        return await action();
    } finally {
        for (const [name, value] of saved) {
            interactive[name] = value;
        }
    }
}

/** Стенд с настоящим провайдером определений и готовой моделью. */
function stand(platform) {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([MAIN, LIB]);
    index.updateExternalModule(LIB, LIB_SOURCE, 1);

    let current;
    const definitionProvider = new RslDefinitionProvider({
        getOpenDocument: uri => uri === MAIN ? current.document : undefined,
        ensureDocumentParsed: async () => current.module.symbolTree,
        getLoadedModules: () => index.getModules(),
        getImportedModules: uri => index.getImportedModules(uri),
        findWorkspaceFileUri: name => index.findWorkspaceFileUri(name),
        resolveWorkspaceFileUri: name => index.resolveWorkspaceFile(name),
        getDefinitionRange: (uri, symbol) =>
            index.getDefinitionRange(uri, symbol),
        log: () => undefined
    });

    current = createCompletionRegistry({
        uri: MAIN,
        source: MAIN_SOURCE,
        platform,
        modelReady: true,
        settings: DEFAULT_SETTINGS,
        index,
        definitionProvider
    });

    return current;
}

function positionAfter(current, marker) {
    const at = current.text.indexOf(marker);
    assert.ok(at >= 0, "в образце нет: " + marker);

    return current.document.positionAt(at + marker.length);
}

async function request(current, handler, marker, extra) {
    return current.handlers[handler]({
        textDocument: { uri: current.uri },
        position: positionAfter(current, marker),
        ...(extra || {})
    }, cancellation);
}

/** Весь ответ одной строкой: файл, диапазон, текст, подпись. */
function describe(answer) {
    if (!answer) {
        return "нет ответа";
    }

    const one = Array.isArray(answer) ? answer[0] : answer;

    if (!one) {
        return "нет ответа";
    }

    if (one.uri) {
        const range = one.range;

        return one.uri + " " + (range
            ? range.start.line + ":" + range.start.character + ".." +
                range.end.line + ":" + range.end.character
            : "без диапазона");
    }

    if (one.signatures) {
        return one.signatures
            .map(item => item.label + " (" +
                (item.parameters || []).map(p => p.label).join(", ") + ")")
            .join(" | ") + " активный " + one.activeParameter;
    }

    if (one.contents !== undefined) {
        return typeof one.contents === "string"
            ? one.contents
            : one.contents.value;
    }

    return JSON.stringify(one);
}

/* --- Оба пути на одном стенде --- */

const CASES = [
    {
        name: "переход к процедуре подключённого модуля",
        handler: "definition",
        marker: "  Var result = Targ"
    },
    {
        name: "переход по ExecMacroFile",
        handler: "definition",
        marker: "ExecMacroFile(\"lib.mac\", \"Targ"
    },
    {
        name: "переход по имени модуля в Import",
        handler: "definition",
        marker: "Import li"
    },
    {
        name: "Hover по процедуре подключённого модуля",
        handler: "hover",
        marker: "  Var result = Targ"
    },
    {
        name: "подсказка параметров локальной процедуры",
        handler: "signatureHelp",
        marker: "  Var value = Helper(",
        extra: { context: { triggerKind: 2, triggerCharacter: "(" } }
    },
    {
        name: "подсказка параметров процедуры модуля",
        handler: "signatureHelp",
        marker: "  Var result = Target(",
        extra: { context: { triggerKind: 2, triggerCharacter: "(" } }
    }
];

for (const item of CASES) {
    test(item.name + ": быстрый и полный путь дают один ответ", async () => {
        const platform = new PlatformModuleCatalog({ log: () => undefined });
        const current = stand(platform);
        const fast = await request(
            current,
            item.handler,
            item.marker,
            item.extra
        );
        const full = await withoutFastAnswers(() => request(
            stand(platform),
            item.handler,
            item.marker,
            item.extra
        ));

        assert.notStrictEqual(
            describe(full),
            "нет ответа",
            "полный путь обязан отвечать: иначе сравнивать нечего"
        );
        assert.strictEqual(describe(fast), describe(full));
    });
}

test("переход по ExecMacroFile ведёт на строку объявления", async () => {
    /*
     * Диапазон здесь и есть суть проверки: файл был верным и раньше, а строка
     * — нулевая, то есть Ctrl+Click открывал начало модуля вместо процедуры.
     */
    const platform = new PlatformModuleCatalog({ log: () => undefined });
    const current = stand(platform);
    const answer = await request(
        current,
        "definition",
        "ExecMacroFile(\"lib.mac\", \"Targ"
    );

    assert.ok(answer, "переход обязан быть");
    const target = Array.isArray(answer) ? answer[0] : answer;
    const expected = LIB_SOURCE
        .split("\n")
        .findIndex(line => line.startsWith("Macro Target"));

    assert.strictEqual(target.uri, LIB);
    assert.strictEqual(
        target.range.start.line,
        expected,
        "ожидалась строка объявления Macro Target"
    );
});

/* --- Свежесть данных быстрого пути --- */

const OLD_LIB = "file:///d:/diff/oldlib.mac";
const NEW_LIB = "file:///d:/diff/newlib.mac";

const OLD_LIB_SOURCE = [
    "Macro OldProc(value)",
    "  return value;",
    "End;",
    ""
].join("\n");

const NEW_LIB_SOURCE = [
    "Macro NewProc(value)",
    "  return value;",
    "End;",
    ""
].join("\n");

/** Стенд, где текст документа уже правлен, а модель — ещё от старого текста. */
function editedStand(modelText, editedText) {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([MAIN, OLD_LIB, NEW_LIB]);
    index.updateExternalModule(OLD_LIB, OLD_LIB_SOURCE, 1);
    index.updateExternalModule(NEW_LIB, NEW_LIB_SOURCE, 1);

    return createCompletionRegistry({
        uri: MAIN,
        source: modelText,
        editedSource: editedText,
        modelReady: false,
        settings: DEFAULT_SETTINGS,
        index
    });
}

test("после замены Import виден символ нового модуля", async () => {
    const before = [
        "Import oldlib;",
        "Macro Test()",
        "  Var a = OldProc(1);",
        "End;",
        ""
    ].join("\n");
    const after = [
        "Import newlib;",
        "Macro Test()",
        "  Var a = NewProc(1);",
        "End;",
        ""
    ].join("\n");
    const current = editedStand(before, after);
    const answer = await request(current, "definition", "  Var a = NewPr");

    assert.ok(answer, "переход обязан отвечать по текущему тексту");
    const target = Array.isArray(answer) ? answer[0] : answer;
    assert.strictEqual(
        target.uri,
        NEW_LIB,
        "искать нужно по Import текущего текста, а не по графу старой модели"
    );
});

test("после замены Import символ старого модуля не находится", async () => {
    const before = [
        "Import oldlib;",
        "Macro Test()",
        "  Var a = OldProc(1);",
        "End;",
        ""
    ].join("\n");
    const after = [
        "Import newlib;",
        "Macro Test()",
        "  Var a = OldProc(1);",
        "End;",
        ""
    ].join("\n");
    const current = editedStand(before, after);
    const answer = await request(current, "definition", "  Var a = OldPr");

    assert.strictEqual(
        describe(answer),
        "нет ответа",
        "модуль отключён — переход к его процедуре уводил бы не туда"
    );
});

test("после удаления Import символ модуля не находится", async () => {
    const before = [
        "Import newlib;",
        "Macro Test()",
        "  Var a = NewProc(1);",
        "End;",
        ""
    ].join("\n");
    const after = [
        "Macro Test()",
        "  Var a = NewProc(1);",
        "End;",
        ""
    ].join("\n");
    const current = editedStand(before, after);
    const answer = await request(current, "definition", "  Var a = NewPr");

    assert.strictEqual(
        describe(answer),
        "нет ответа",
        "Import убран — символ больше не виден"
    );
});

test("подсказка параметров показывает правленую подпись", async () => {
    const before = [
        "Macro Foo(oldParam)",
        "  return oldParam;",
        "End;",
        "Macro Test()",
        "  Var a = Foo(1);",
        "End;",
        ""
    ].join("\n");
    const after = [
        "Macro Foo(newParam, secondParam)",
        "  return newParam;",
        "End;",
        "Macro Test()",
        "  Var a = Foo(1);",
        "End;",
        ""
    ].join("\n");
    const current = editedStand(before, after);
    const answer = await request(
        current,
        "signatureHelp",
        "  Var a = Foo(",
        { context: { triggerKind: 2, triggerCharacter: "(" } }
    );

    assert.ok(answer, "подсказка обязана отвечать");
    const label = answer.signatures[0].label;

    assert.ok(
        /newParam/.test(label) && /secondParam/.test(label),
        "ожидались параметры текущего текста: " + label
    );
    assert.ok(
        !/oldParam/.test(label),
        "старая подпись показывала бы не те параметры: " + label
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

    fs.rmSync(WORKSPACE, { recursive: true, force: true });
    console.log("\nПройдено: " + passed + ", провалено: " + failed);

    if (failed > 0) {
        process.exitCode = 1;
    }
})();

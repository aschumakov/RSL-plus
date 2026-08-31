"use strict";

/*
 * Быстрый путь против готовой модели: ответы обязаны совпадать целиком.
 *
 * Стенда два, и различаются они только тем, догнал ли разбор текст документа.
 * Именно это различие и решает в сервере, кто отвечает: пока модели этой версии
 * нет — индекс версии, как только появилась — модель. Сравнивается весь
 * результат: файл, диапазон, текст Hover, подпись с параметрами и типом
 * результата.
 *
 * Прежняя проверка сравнивала только URI и вообще не доходила до модели, потому
 * что обработчик и при готовой модели отвечал быстрым путём. Так и осталась
 * незамеченной ошибка перехода по ExecMacroFile — файл верный, строка нулевая.
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
 * Файлы стенда лежат на диске: полный путь перехода по имени модуля в Import
 * ищет файл в рабочей папке, и без него сравнивать было бы нечего.
 */
const WORKSPACE = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rsl-diff-"));
const MAIN = pathToFileURL(nodePath.join(WORKSPACE, "main.mac")).toString();
const LIB = pathToFileURL(nodePath.join(WORKSPACE, "lib.mac")).toString();

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
    "Class TBase()",
    "  Macro BaseMethod(baseArg)",
    "    return baseArg;",
    "  End;",
    "End;",
    "Class (TBase) TLocal()",
    "  Var Field: String;",
    "  private Var Secret: String;",
    "  Macro Open(alpha, beta: String): Integer",
    "    Var inner = 1;",
    "    Var own = Hidden(inner);",
    "    return own;",
    "  End;",
    "  private Macro Hidden(gamma)",
    "    return gamma;",
    "  End;",
    "End;",
    "Macro Helper(alpha)",
    "  return alpha;",
    "End;",
    "Macro Test()",
    "  Var thing: TLocal = TLocal();",
    "  Var result = Target(1, 2);",
    "  ExecMacroFile(\"lib.mac\", \"Target\");",
    "  Var value = Helper(1);",
    "  thing.Open(1, \"x\");",
    "  Var field = thing.Field;",
    "  Var secret = thing.Secret;",
    "  thing.BaseMethod(1);",
    "  thing.Hidden(1);",
    "End;",
    ""
].join("\n");

fs.writeFileSync(nodePath.join(WORKSPACE, "lib.mac"), LIB_SOURCE, "utf8");
fs.writeFileSync(nodePath.join(WORKSPACE, "main.mac"), MAIN_SOURCE, "utf8");

const cancellation = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined })
};

/**
 * Стенд над одним и тем же текстом.
 *
 * `modelReady` — единственное различие: false означает, что документ ушёл
 * вперёд разбора, и отвечает индекс версии.
 */
function stand(platform, modelReady, options) {
    const source = (options && options.source) || MAIN_SOURCE;
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
        source,
        platform,
        modelReady,
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

/** Подпись ответа: то, что видит пользователь в подсказке. */
function signatureLabel(answer) {
    return answer && answer.signatures && answer.signatures.length > 0
        ? answer.signatures[0].label
        : "нет подписи";
}

function hoverText(answer) {
    if (!answer || answer.contents === undefined) {
        return "";
    }

    return typeof answer.contents === "string"
        ? answer.contents
        : answer.contents.value;
}

const CALL = { context: { triggerKind: 2, triggerCharacter: "(" } };

/* --- Переходы: быстрый путь и модель обязаны совпадать полностью --- */

const SAME = [
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
        name: "переход к типу локального класса",
        handler: "typeDefinition",
        marker: "  Var field = thin"
    },
    {
        name: "подсказка параметров локальной процедуры",
        handler: "signatureHelp",
        marker: "  Var value = Helper(",
        extra: CALL
    },
    {
        name: "подсказка параметров процедуры модуля",
        handler: "signatureHelp",
        marker: "  Var result = Target(",
        extra: CALL
    },
    {
        name: "подсказка параметров метода локального класса",
        handler: "signatureHelp",
        marker: "  thing.Open(",
        extra: CALL
    },
    {
        name: "подсказка параметров унаследованного метода",
        handler: "signatureHelp",
        marker: "  thing.BaseMethod(",
        extra: CALL
    },
    {
        name: "подсказка параметров приватного метода изнутри класса",
        handler: "signatureHelp",
        marker: "    Var own = Hidden(",
        extra: CALL
    }
];

for (const item of SAME) {
    test(item.name + ": до и после разбора один ответ", async () => {
        const platform = new PlatformModuleCatalog({ log: () => undefined });
        const fast = await request(
            stand(platform, false),
            item.handler,
            item.marker,
            item.extra
        );
        const full = await request(
            stand(platform, true),
            item.handler,
            item.marker,
            item.extra
        );

        assert.notStrictEqual(
            describe(full),
            "нет ответа",
            "готовая модель обязана отвечать: иначе сравнивать нечего"
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
    const answer = await request(
        stand(platform, false),
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

/* --- Локальные классы --- */

test("подпись метода несёт параметры и тип результата", async () => {
    const platform = new PlatformModuleCatalog({ log: () => undefined });

    for (const modelReady of [false, true]) {
        const answer = await request(
            stand(platform, modelReady),
            "signatureHelp",
            "  thing.Open(",
            CALL
        );
        const label = signatureLabel(answer);

        assert.ok(
            /^Open\(alpha, beta:\s*String\)/.test(label),
            "ожидались параметры как написаны: " + label
        );
        assert.ok(
            /Integer\s*$/.test(label),
            "ожидался объявленный тип результата: " + label
        );
    }
});

test("приватный метод класса снаружи не подсказывается", async () => {
    const platform = new PlatformModuleCatalog({ log: () => undefined });

    for (const modelReady of [false, true]) {
        const answer = await request(
            stand(platform, modelReady),
            "signatureHelp",
            "  thing.Hidden(",
            CALL
        );

        assert.strictEqual(
            describe(answer),
            "нет ответа",
            "приватный метод вне класса недоступен, подсказывать его нельзя " +
                "(модель готова: " + modelReady + ")"
        );
    }
});

test("приватное поле класса снаружи не описывается", async () => {
    const platform = new PlatformModuleCatalog({ log: () => undefined });

    for (const modelReady of [false, true]) {
        const answer = await request(
            stand(platform, modelReady),
            "hover",
            "  Var secret = thing.Secr"
        );

        assert.ok(
            !/Secret/.test(hoverText(answer)),
            "приватное поле вне класса недоступно: " + hoverText(answer) +
                " (модель готова: " + modelReady + ")"
        );
    }
});

test("открытое поле класса описывается на обоих путях", async () => {
    const platform = new PlatformModuleCatalog({ log: () => undefined });

    for (const modelReady of [false, true]) {
        const answer = await request(
            stand(platform, modelReady),
            "hover",
            "  Var field = thing.Fiel"
        );
        const text = hoverText(answer);

        assert.ok(
            /Field/.test(text) && /String/i.test(text),
            "ожидались имя и тип поля: " + text +
                " (модель готова: " + modelReady + ")"
        );
    }
});

test("Hover по локальной переменной знает её тип", async () => {
    const platform = new PlatformModuleCatalog({ log: () => undefined });

    for (const modelReady of [false, true]) {
        const answer = await request(
            stand(platform, modelReady),
            "hover",
            "  Var field = thin"
        );
        const text = hoverText(answer);

        assert.ok(
            /TLocal/.test(text),
            "ожидался объявленный тип переменной: " + text +
                " (модель готова: " + modelReady + ")"
        );
    }
});

/* --- Свежесть данных быстрого пути --- */

const OLD_LIB = pathToFileURL(nodePath.join(WORKSPACE, "oldlib.mac"))
    .toString();
const NEW_LIB = pathToFileURL(nodePath.join(WORKSPACE, "newlib.mac"))
    .toString();

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

fs.writeFileSync(
    nodePath.join(WORKSPACE, "oldlib.mac"),
    OLD_LIB_SOURCE,
    "utf8"
);
fs.writeFileSync(
    nodePath.join(WORKSPACE, "newlib.mac"),
    NEW_LIB_SOURCE,
    "utf8"
);

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
        CALL
    );

    assert.ok(answer, "подсказка обязана отвечать");
    const label = signatureLabel(answer);

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

    fs.rmSync(WORKSPACE, {
            recursive: true,
            force: true,
            /*
             * Повторы обязательны на Windows: rm падает с ENOTEMPTY, если
             * файл в каталоге создан только что — дескриптор ещё держится.
             */
            maxRetries: 20,
            retryDelay: 25
        });
    console.log("\nПройдено: " + passed + ", провалено: " + failed);

    if (failed > 0) {
        process.exitCode = 1;
    }
})();

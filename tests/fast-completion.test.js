"use strict";

/**
 * Автодополнение до готовности модели.
 *
 * Пока модель текущей версии текста строится, Completion отвечает по быстрому
 * снимку: пустой список пользователь читает как «в файле ничего нет». За это
 * приходится платить точностью, и именно здесь легко ошибиться в другую сторону
 * — предложить то, чего в этой точке не видно. Неверная подсказка хуже
 * отсутствующей: пользователь её выбирает, и получается код, который не
 * компилируется.
 *
 * Проверяется весь путь целиком — обработчик onCompletion на подставном
 * connection, как его вызывает клиент, — а не отдельная функция поиска типа.
 * Модель делается недоступной естественным способом: документ на версию впереди
 * индекса, ровно как сразу после правки.
 */

const assert = require("assert");
const {
    CompletionItemKind
} = require("../server/node_modules/vscode-languageserver");

const {
    RslLanguageFeatureRegistry
} = require("../server/out/features/languageFeatureRegistry");
const {
    createFastDocumentSnapshot
} = require("../server/out/services/fastDocumentSnapshot");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { getDefaults } = require("../server/out/defaults");
const {
    PlatformModuleCatalog
} = require("../server/out/builtins/platformModuleCatalog");

let passed = 0;
let failed = 0;
/* Проверки собираются, затем выполняются по порядку: они асинхронные. */
const suite = [];

function test(name, action) {
    suite.push([name, action]);
}

async function run() {
    for (const [name, action] of suite) {
        try {
            await action();
            passed++;
            console.log(`[OK] ${name}`);
        } catch (error) {
            failed++;
            console.error(`[FAIL] ${name}`);
            console.error(error);
        }
    }
}

const defaults = {
    language: { dialect: "rsBank" },
    imports: { enabled: true },
    autoImport: { enabled: false },
    analysis: { workspaceIndexing: "activeImports" },
    semanticHighlighting: { maxFileSizeKb: 512 },
    inlayHints: { variableTypes: true },
    diagnostics: {}
};

const MAIN = "file:///d:/fast/main.mac";

function createDocument(uri, version, text) {
    const lineStarts = [0];

    for (let index = 0; index < text.length; index++) {
        if (text[index] === "\n") {
            lineStarts.push(index + 1);
        }
    }

    return {
        uri,
        languageId: "rsl",
        version,
        get lineCount() {
            return lineStarts.length;
        },
        getText: () => text,
        positionAt(offset) {
            const bounded = Math.max(0, Math.min(offset, text.length));
            let line = 0;

            while (
                line + 1 < lineStarts.length &&
                lineStarts[line + 1] <= bounded
            ) {
                line++;
            }

            return { line, character: bounded - lineStarts[line] };
        },
        offsetAt(position) {
            const line = Math.max(
                0,
                Math.min(position.line, lineStarts.length - 1)
            );

            return Math.min(
                text.length,
                lineStarts[line] + Math.max(0, position.character)
            );
        }
    };
}

function createConnection(handlers) {
    const register = name => callback => {
        handlers[name] = callback;
    };

    return {
        onCompletion: register("completion"),
        onCompletionResolve: register("completionResolve"),
        onSignatureHelp: register("signatureHelp"),
        onHover: register("hover"),
        onDocumentHighlight: register("documentHighlight"),
        onDefinition: register("definition"),
        onReferences: register("references"),
        onWorkspaceSymbol: register("workspaceSymbol"),
        onCodeAction: register("codeAction"),
        onSelectionRanges: register("selectionRanges"),
        onExecuteCommand: register("executeCommand"),
        onPrepareRename: register("prepareRename"),
        onRenameRequest: register("rename"),
        onRequest: (method, callback) => {
            handlers[method] = callback;
        },
        onDocumentSymbol: register("documentSymbol"),
        onFoldingRanges: register("foldingRanges"),
        onDocumentFormatting: register("documentFormatting"),
        onDocumentRangeFormatting: register("documentRangeFormatting"),
        sendRequest: async () => undefined,
        languages: {
            callHierarchy: {
                onPrepare: register("callHierarchyPrepare"),
                onIncomingCalls: register("callHierarchyIncoming"),
                onOutgoingCalls: register("callHierarchyOutgoing")
            },
            semanticTokens: {
                on: register("semanticTokens"),
                onDelta: register("semanticTokensDelta"),
                onRange: register("semanticTokensRange"),
                refresh: () => undefined
            },
            inlayHint: {
                on: register("inlayHint"),
                refresh: () => undefined
            }
        }
    };
}

/**
 * Реестр, у которого модели текущей версии заведомо нет.
 *
 * Документ отдаётся версией 2, а в индексе лежит версия 1: именно это состояние
 * возникает сразу после правки, и именно в нём работает быстрый путь.
 */
function createRegistry({ source, others = {}, platform }) {
    const index = new WorkspaceIndex();
    const uris = [MAIN, ...Object.keys(others)];
    index.registerWorkspaceFiles(uris);
    index.updateOpenModule(MAIN, source, 1);

    for (const [uri, text] of Object.entries(others)) {
        index.updateExternalModule(uri, text, 1);
    }

    const document = createDocument(MAIN, 2, source);
    const handlers = {};

    const registry = new RslLanguageFeatureRegistry({
        connection: createConnection(handlers),
        documents: {
            get: uri => uri === MAIN ? document : undefined,
            all: () => [document]
        },
        index,
        resolver: new RslScopeResolver(index, getDefaults(), platform),
        definitionProvider: {
            findImportDefinition: async () => undefined,
            findDynamicDefinition: async () => undefined,
            createObjectLocationByUri: () => ({ uri: MAIN, range: null })
        },
        getFastDocumentSnapshot: () => createFastDocumentSnapshot(document),
        /* Разбор идёт своим ходом и до конца запроса не успевает. */
        ensureDocumentParsed: async () => undefined,
        requestDocumentParse: () => undefined,
        getSettings: () => defaults,
        supportsRefresh: () => false,
        log: () => undefined
    });
    registry.register();

    return { handlers, index, document };
}

/** Список от обработчика: курсор ставится сразу после указанной точки. */
async function completeAfterDot(registry, marker) {
    const source = registry.document.getText();
    const at = source.indexOf(marker);
    assert.ok(at >= 0, `В образце нет «${marker}»`);
    const offset = at + marker.length;

    const response = await registry.handlers.completion(
        {
            textDocument: { uri: MAIN },
            position: registry.document.positionAt(offset),
            context: { triggerKind: 2, triggerCharacter: "." }
        },
        { isCancellationRequested: false, onCancellationRequested: () => ({
            dispose: () => undefined
        }) }
    );

    return (response.items || []).map(item => item.label);
}

/** Те же элементы целиком: видами отличаются поле и метод. */
async function completeItems(registry, marker) {
    const source = registry.document.getText();
    const at = source.indexOf(marker);
    assert.ok(at >= 0, "В образце нет: " + marker);

    const response = await registry.handlers.completion(
        {
            textDocument: { uri: MAIN },
            position: registry.document.positionAt(at + marker.length),
            context: { triggerKind: 2, triggerCharacter: "." }
        },
        {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose: () => undefined })
        }
    );

    return response.items || [];
}

const LOCAL_CLASS = [
    "Class Ledger",
    "  Var Balance: Double;",
    "  Macro PostEntry()",
    "  End;",
    "End;"
].join("\n");

/* --- тип получателя из ближайшего объявления или присваивания ------------- */

const RECEIVER_CASES = {
    "написанный тип": "  Var acc: Ledger;\n  acc.",
    "присвоено имя класса": "  Var acc = Ledger;\n  acc.",
    "присвоен вызов конструктора": "  Var acc = Ledger();\n  acc."
};

for (const [name, body] of Object.entries(RECEIVER_CASES)) {
    test(`члены объекта до готовности модели: ${name}`, async () => {
        const registry = createRegistry({
            source: `${LOCAL_CLASS}\nMacro Work()\n${body}\nEnd;`
        });
        const labels = await completeAfterDot(registry, "acc.");

        assert.deepStrictEqual(
            labels.slice().sort(),
            ["Balance", "PostEntry"],
            "Обязаны прийти ровно члены класса, а не общий список имён"
        );
    });
}

test("тип не переносится между Macro", async () => {
    /*
     * Переменная другого Macro в этой точке невидима. Пока поиск шёл назад по
     * всему файлу, на `acc.` во втором Macro предлагались члены класса,
     * присвоенного в первом, — подсказка, которой в этом месте нет в языке.
     */
    const registry = createRegistry({
        source: [
            LOCAL_CLASS,
            "Macro First()",
            "  Var acc = Ledger();",
            "End;",
            "Macro Second()",
            "  acc.",
            "End;"
        ].join("\n")
    });
    const labels = await completeAfterDot(registry, "  acc.");

    assert.ok(
        !labels.includes("Balance") && !labels.includes("PostEntry"),
        `Члены чужого Macro не должны предлагаться: ${labels.join(", ")}`
    );
    assert.ok(
        labels.includes("MsgBox"),
        "Вместо членов обязан прийти обычный приблизительный список, " +
            "а не пустой ответ"
    );
});

test("переменная модуля видна внутри Macro", async () => {
    /*
     * Область видимости — не только текущий Macro. Ограничение поиска его
     * заголовком убирало утечку между макросами, но заодно отрезало верхний
     * уровень модуля: объявление выше первого Macro перестало давать подсказку.
     */
    const registry = createRegistry({
        source: [
            LOCAL_CLASS,
            "Var MessageText: Ledger;",
            "Macro Work()",
            "  MessageText.",
            "End;"
        ].join("\n")
    });
    const labels = await completeAfterDot(registry, "  MessageText.");

    assert.deepStrictEqual(
        labels.slice().sort(),
        ["Balance", "PostEntry"],
        "Переменная верхнего уровня обязана быть видна из Macro"
    );
});

test("поле класса видно внутри его метода", async () => {
    const registry = createRegistry({
        source: [
            "Class Ledger",
            "  Var Balance: Double;",
            "  Macro PostEntry()",
            "  End;",
            "End;",
            "Class Journal",
            "  Var Entry: Ledger;",
            "  Macro Add()",
            "    Entry.",
            "  End;",
            "End;"
        ].join("\n")
    });
    const labels = await completeAfterDot(registry, "    Entry.");

    assert.deepStrictEqual(
        labels.slice().sort(),
        ["Balance", "PostEntry"],
        "Поле класса обязано быть видно в методе того же класса"
    );
});

test("одинаковые имена в разных Macro не смешиваются", async () => {
    /* В каждом Macro своя переменная с одним именем, но разного типа. */
    const registry = createRegistry({
        source: [
            "Class Ledger",
            "  Var Balance: Double;",
            "End;",
            "Class Journal",
            "  Var Total: Double;",
            "End;",
            "Macro First()",
            "  Var item: Ledger;",
            "  item.",
            "End;",
            "Macro Second()",
            "  Var item: Journal;",
            "  item.",
            "End;"
        ].join("\n")
    });

    assert.deepStrictEqual(
        (await completeAfterDot(registry, "  item.")).slice().sort(),
        ["Balance"],
        "В First обязан быть тип из First"
    );
    assert.deepStrictEqual(
        (await completeAfterDot(registry, "Var item: Journal;\n  item."))
            .slice().sort(),
        ["Total"],
        "Во Second обязан быть тип из Second"
    );
});

test("приватное поле своего класса видно только внутри класса", async () => {
    const source = [
        "Class Ledger",
        "  Var Balance: Double;",
        "  Private Var SecretKey: String;",
        "  Macro PostEntry()",
        "    Var self: Ledger;",
        "    self.",
        "  End;",
        "End;",
        "Macro Work()",
        "  Var acc: Ledger;",
        "  acc.",
        "End;"
    ].join("\n");

    const inside = await completeAfterDot(
        createRegistry({ source }),
        "    self."
    );
    assert.ok(
        inside.includes("SecretKey"),
        `Внутри своего класса приватное поле обязано быть: ${
            inside.join(", ")}`
    );

    const outside = await completeAfterDot(
        createRegistry({ source }),
        "  acc."
    );
    assert.ok(
        outside.includes("Balance"),
        `Открытое поле обязано быть и снаружи: ${outside.join(", ")}`
    );
    assert.ok(
        !outside.includes("SecretKey"),
        "Приватное поле вне своего класса недоступно и предлагаться не должно"
    );
});

test("вложенный блок не мешает найти тип в своём Macro", async () => {
    const registry = createRegistry({
        source: [
            LOCAL_CLASS,
            "Macro Work()",
            "  Var acc = Ledger();",
            "  If (1 = 1)",
            "    acc.",
            "  End;",
            "End;"
        ].join("\n")
    });
    const labels = await completeAfterDot(registry, "    acc.");

    assert.deepStrictEqual(
        labels.slice().sort(),
        ["Balance", "PostEntry"],
        "END вложенного блока не должен обрывать поиск объявления"
    );
});

/* --- классы подключённых модулей ----------------------------------------- */

const REMOTE = "file:///d:/fast/lib.mac";
const REMOTE_SOURCE = [
    "Class Account",
    "  Var AccountNumber: String;",
    "  Private Var SecretKey: String;",
    "  Macro CloseAccount()",
    "  End;",
    "End;"
].join("\n");

test("класс подключённого модуля: приватные члены не предлагаются", async () => {
    const registry = createRegistry({
        source: [
            "Import lib;",
            "Macro Work()",
            "  Var a: Account;",
            "  a.",
            "End;"
        ].join("\n"),
        others: { [REMOTE]: REMOTE_SOURCE }
    });
    const labels = await completeAfterDot(registry, "  a.");

    assert.ok(
        labels.includes("AccountNumber") && labels.includes("CloseAccount"),
        `Открытые члены обязаны прийти: ${labels.join(", ")}`
    );
    assert.ok(
        !labels.includes("SecretKey"),
        "Приватный член чужого модуля недоступен и предлагаться не должен"
    );
});

test("только что добавленный Import уже действует", async () => {
    /*
     * Список Import берётся из снимка текущего текста. Прежде он брался из
     * модели предыдущей версии, и строка Import, набранная только что,
     * не действовала до конца разбора — то есть ровно там, где нужна.
     */
    const registry = createRegistry({
        source: [
            "Import lib;",
            "Macro Work()",
            "  Var a: Account;",
            "  a.",
            "End;"
        ].join("\n"),
        others: { [REMOTE]: REMOTE_SOURCE }
    });
    /* В индексе лежит версия 1 без Import: он есть только в тексте документа. */
    registry.index.updateOpenModule(
        MAIN,
        "Macro Work()\n  Var a: Account;\n  a.\nEnd;",
        1
    );
    const labels = await completeAfterDot(registry, "  a.");

    assert.ok(
        labels.includes("AccountNumber"),
        `Новый Import обязан действовать сразу: ${labels.join(", ")}`
    );
});

test("удалённый Import перестаёт действовать", async () => {
    const registry = createRegistry({
        source: [
            "Macro Work()",
            "  Var a: Account;",
            "  a.",
            "End;"
        ].join("\n"),
        others: { [REMOTE]: REMOTE_SOURCE }
    });
    /* В индексе Import ещё есть, в тексте его уже нет. */
    registry.index.updateOpenModule(
        MAIN,
        `Import lib;\nMacro Work()\n  Var a: Account;\n  a.\nEnd;`,
        1
    );
    const labels = await completeAfterDot(registry, "  a.");

    assert.ok(
        !labels.includes("AccountNumber") && !labels.includes("CloseAccount"),
        `Без Import класс невидим: ${labels.join(", ")}`
    );
});

test("класс виден через цепочку Import", async () => {
    /* В RSL подключение даёт доступ ко всей рекурсивной цепочке Import. */
    const middle = "file:///d:/fast/middle.mac";
    const registry = createRegistry({
        source: [
            "Import middle;",
            "Macro Work()",
            "  Var a: Account;",
            "  a.",
            "End;"
        ].join("\n"),
        others: {
            [middle]: "Import lib;\nMacro Bridge()\nEnd;",
            [REMOTE]: REMOTE_SOURCE
        }
    });
    const labels = await completeAfterDot(registry, "  a.");

    assert.ok(
        labels.includes("AccountNumber"),
        `Транзитивный Import обязан учитываться: ${labels.join(", ")}`
    );
});

test("нетипизированный параметр затеняет внешнее имя", async () => {
    /*
     * Параметр объявлен без типа, и тип внешней переменной к этой точке
     * отношения не имеет. Поиск, идущий по тексту назад до первого объявления
     * с типом, проходил сквозь затенение и предлагал члены чужого объекта.
     */
    const registry = createRegistry({
        source: [
            LOCAL_CLASS,
            "Var x: Ledger;",
            "Macro Work(x)",
            "  x.",
            "End;"
        ].join("\n")
    });
    const labels = await completeAfterDot(registry, "  x.");

    assert.ok(
        !labels.includes("Balance") && !labels.includes("PostEntry"),
        `Параметр затеняет внешнее имя: ${labels.join(", ")}`
    );
    assert.ok(
        labels.includes("MsgBox"),
        "Вместо членов обязан прийти обычный приблизительный список"
    );
});

test("нетипизированная локальная переменная затеняет внешнее имя", async () => {
    const registry = createRegistry({
        source: [
            LOCAL_CLASS,
            "Var x: Ledger;",
            "Macro Work()",
            "  Var x;",
            "  x.",
            "End;"
        ].join("\n")
    });
    const labels = await completeAfterDot(registry, "  x.");

    assert.ok(
        !labels.includes("Balance") && !labels.includes("PostEntry"),
        `Локальная переменная затеняет внешнее имя: ${labels.join(", ")}`
    );
});

test("одноимённые классы разных Import членов не дают", async () => {
    /*
     * Какой из двух классов выберет компилятор, без полной модели неизвестно.
     * Показать члены первого попавшегося значит подсказать наугад.
     */
    const second = "file:///d:/fast/lib2.mac";
    const registry = createRegistry({
        source: [
            "Import lib;",
            "Import lib2;",
            "Macro Work()",
            "  Var a: Account;",
            "  a.",
            "End;"
        ].join("\n"),
        others: {
            [REMOTE]: REMOTE_SOURCE,
            [second]: [
                "Class Account",
                "  Var OtherField: String;",
                "End;"
            ].join("\n")
        }
    });
    const labels = await completeAfterDot(registry, "  a.");

    assert.ok(
        !labels.includes("AccountNumber") && !labels.includes("OtherField"),
        `При неоднозначности члены не показываются: ${labels.join(", ")}`
    );
});

test("встроенный класс даёт члены без готовой модели", async () => {
    /*
     * Форма из ревью: тип написан на верхнем уровне, обращение — внутри Macro.
     * Встроенные классы видны всегда и от Import не зависят, поэтому оставлять
     * их полной модели незачем.
     */
    const registry = createRegistry({
        source: [
            "Var Handle: TBFile;",
            "Macro Work()",
            "  Handle.",
            "End;"
        ].join("\n")
    });
    const labels = await completeAfterDot(registry, "  Handle.");

    assert.ok(
        labels.includes("AddFilter") && labels.includes("GetFldInfo"),
        `Обязаны прийти члены TBFile: ${labels.slice(0, 12).join(", ")}`
    );
    assert.ok(
        !labels.includes("MsgBox"),
        "Это должен быть список членов, а не общий приблизительный список"
    );
});

test("наследование локальных классов", async () => {
    const registry = createRegistry({
        source: [
            "Class Base",
            "  Var BaseField: String;",
            "  Macro BaseMethod()",
            "  End;",
            "End;",
            "Class (Base) Derived",
            "  Var OwnField: String;",
            "End;",
            "Macro Work()",
            "  Var item: Derived;",
            "  item.",
            "End;"
        ].join("\n")
    });
    const labels = await completeAfterDot(registry, "  item.");

    assert.deepStrictEqual(
        labels.slice().sort(),
        ["BaseField", "BaseMethod", "OwnField"],
        "унаследованные члены обязаны быть в списке"
    );
});

test("член производного класса перекрывает одноимённый член базы", async () => {
    const registry = createRegistry({
        source: [
            "Class Base",
            "  Var Shared: String;",
            "End;",
            "Class (Base) Derived",
            "  Var Shared: Double;",
            "End;",
            "Macro Work()",
            "  Var item: Derived;",
            "  item.",
            "End;"
        ].join("\n")
    });
    const items = await completeAfterDot(registry, "  item.");

    assert.deepStrictEqual(items, ["Shared"], "член обязан быть один");
});

test("класс, наследующий сам себя, не зацикливает подсказку", async () => {
    const registry = createRegistry({
        source: [
            "Class (Loop) Loop",
            "  Var Field: String;",
            "End;",
            "Macro Work()",
            "  Var item: Loop;",
            "  item.",
            "End;"
        ].join("\n")
    });

    assert.deepStrictEqual(
        await completeAfterDot(registry, "  item."),
        ["Field"]
    );
});

test("класс прикладного модуля: своё поле и унаследованный метод", async () => {
    /*
     * Контрольный пример: TRsbLabel из RsbFormsInter объявляет поле text, а
     * метод getPosition достаётся ему от TRsbVisualComponent. Быстрый путь
     * обязан показать оба и с теми же видами элементов, что и полный.
     */
    const platform = new PlatformModuleCatalog({ log: () => undefined });
    await platform.ensureModules(["RsbFormsInter"]);
    assert.ok(platform.ready, "каталог прикладных модулей не прочитан");

    const registry = createRegistry({
        source: [
            "Import RsbFormsInter;",
            "Macro Test()",
            "  Var label: TRsbLabel;",
            "  label.",
            "End;"
        ].join("\n"),
        platform
    });
    const response = await completeItems(registry, "  label.");
    const byName = new Map(response.map(item => [item.label, item.kind]));

    assert.ok(byName.has("text"), "своё поле обязано быть: " +
        Array.from(byName.keys()).join(", "));
    assert.ok(byName.has("getPosition"),
        "унаследованный метод обязан быть: " +
        Array.from(byName.keys()).join(", "));
    /*
     * Виды берутся из того же каталога, что и у полного пути: text описан
     * там свойством, getPosition — методом. Здесь и проверяется, что
     * быстрый путь их не подменяет своими.
     */
    assert.strictEqual(byName.get("text"), CompletionItemKind.Property);
    assert.strictEqual(byName.get("getPosition"), CompletionItemKind.Method);
});

test("одноимённая процедура членов не имеет", async () => {
    /*
     * Проверяется именно класс. Выдать «члены» процедуры значило бы выдумать
     * их: у неё их нет.
     */
    const registry = createRegistry({
        source: [
            "Macro Account()",
            "End;",
            "Macro Work()",
            "  Var a: Account;",
            "  a.",
            "End;"
        ].join("\n")
    });
    const labels = await completeAfterDot(registry, "  a.");

    assert.ok(
        !labels.includes("AccountNumber"),
        `Членов у процедуры нет: ${labels.join(", ")}`
    );
});

run().then(() => {
    console.log(`\nПройдено: ${passed}, провалено: ${failed}`);

    if (failed > 0) {
        process.exitCode = 1;
    }
});

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

/** Стенд над MAIN: общий для всех тестов Completion, см. harness. */
function createRegistry({ source, others = {}, platform }) {
    return createCompletionRegistry({
        uri: MAIN,
        source,
        platform,
        /* Документ на версию впереди модели: отвечает быстрый путь. */
        modelReady: false,
        settings: defaults,
        workspace: Object.entries(others).map(([uri, text]) => ({
            uri,
            text
        }))
    });
}
const {
    CompletionItemKind
} = require("../server/node_modules/vscode-languageserver");

const {
    createCompletionRegistry
} = require("./completion-harness");
/* Один тест сверяет ответ полной модели напрямую, минуя обработчик. */
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

test("локальный класс не подменяет базу импортированного", async () => {
    /*
     * У Derived из подключённого модуля база Base объявлена в том же модуле.
     * Одноимённый класс текущего файла к этой иерархии отношения не имеет:
     * обход базы обязан идти в контексте владельца, а не активного документа.
     */
    const lib = "file:///d:/fast/inh.mac";
    const registry = createRegistry({
        source: [
            "Import inh;",
            "Class Base",
            "  Var WrongLocalBase: String;",
            "End;",
            "Macro Work()",
            "  Var d: Derived;",
            "  d.",
            "End;"
        ].join("\n"),
        others: {
            [lib]: [
                "Class Base",
                "  Var RightImportedBase: String;",
                "End;",
                "Class (Base) Derived",
                "  Var OwnDerived: String;",
                "End;"
            ].join("\n")
        }
    });
    const labels = await completeAfterDot(registry, "  d.");

    assert.deepStrictEqual(
        labels.slice().sort(),
        ["OwnDerived", "RightImportedBase"],
        "база обязана прийти из модуля Derived: " + labels.join(", ")
    );
});

test("локальный класс не подменяет базу прикладного", async () => {
    const platform = new PlatformModuleCatalog({ log: () => undefined });
    await platform.ensureModules(["RsbFormsInter"]);
    const registry = createRegistry({
        source: [
            "Import RsbFormsInter;",
            "Class TRsbVisualComponent",
            "  Var WrongLocal: String;",
            "End;",
            "Macro Test()",
            "  Var label: TRsbLabel;",
            "  label.",
            "End;"
        ].join("\n"),
        platform
    });
    const labels = await completeAfterDot(registry, "  label.");

    assert.ok(
        labels.includes("getPosition") && !labels.includes("WrongLocal"),
        "база обязана прийти из прикладного модуля: " + labels.join(", ")
    );
});

test("полный путь даёт те же члены TRsbLabel", async () => {
    /*
     * Быстрый и полный ответы обязаны совпадать по составу и видам: иначе
     * список менялся бы у пользователя на глазах по готовности модели.
     */
    const platform = new PlatformModuleCatalog({ log: () => undefined });
    await platform.ensureModules(["RsbFormsInter"]);
    const source = [
        "Import RsbFormsInter;",
        "Macro Test()",
        "  Var label: TRsbLabel;",
        "  label.",
        "End;"
    ].join("\n");
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([MAIN]);
    const module = index.updateOpenModule(MAIN, source, 1);
    const resolver = new RslScopeResolver(index, getDefaults(), platform);
    const members = resolver.getCompletions(
        MAIN,
        module.symbolTree,
        source.indexOf("  label.") + 8
    );

    assert.ok(Array.isArray(members), "полный путь обязан отдать список");
    const byName = new Map(members.map(item => [item.label, item.kind]));
    assert.strictEqual(byName.get("text"), CompletionItemKind.Property);
    assert.strictEqual(byName.get("getPosition"), CompletionItemKind.Method);
});

test("холодный каталог: члены появляются без предварительной загрузки", async () => {
    /*
     * Каталог прикладных модулей читается асинхронно. Пока он не прочитан,
     * членов нет — и это правильно; проверяется, что после чтения они
     * появляются без всякой дополнительной подготовки.
     */
    const platform = new PlatformModuleCatalog({ log: () => undefined });
    /*
     * Registry один на оба запроса: проверяется, что УЖЕ созданный сервер
     * начинает видеть прочитанный каталог, а не что его помогла увидеть
     * пересборка.
     */
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

    const cold = await completeAfterDot(registry, "  label.");
    assert.ok(
        !cold.includes("getPosition"),
        "до чтения каталога членов взяться неоткуда"
    );

    await platform.ensureModules(["RsbFormsInter"]);
    const warm = await completeAfterDot(registry, "  label.");
    assert.ok(
        warm.includes("text") && warm.includes("getPosition"),
        "после чтения каталога обязаны прийти оба члена: " + warm.join(", ")
    );
});

test("импортированный класс наследует встроенный", async () => {
    /*
     * Переход между источниками обязан работать в обе стороны: класс модуля
     * workspace вполне наследует встроенный. Пока база искалась только в самом
     * модуле и его Import, у такого класса оставались одни собственные члены.
     */
    const lib = "file:///d:/fast/derived.mac";
    const registry = createRegistry({
        source: [
            "Import derived;",
            "Macro Work()",
            "  Var d: DerivedFile;",
            "  d.",
            "End;"
        ].join("\n"),
        others: {
            [lib]: [
                "Class (TBFile) DerivedFile",
                "  Var OwnDerived: String;",
                "End;"
            ].join("\n")
        }
    });
    const labels = await completeAfterDot(registry, "  d.");

    assert.ok(labels.includes("OwnDerived"), "свой член обязан быть");
    assert.ok(
        labels.includes("AddFilter") && labels.includes("GetFldInfo"),
        "члены встроенной базы обязаны быть: " + labels.join(", ")
    );
});

test("импортированный класс наследует прикладной", async () => {
    const platform = new PlatformModuleCatalog({ log: () => undefined });
    await platform.ensureModules(["RsbFormsInter"]);
    const lib = "file:///d:/fast/label.mac";
    const registry = createRegistry({
        source: [
            "Import label;",
            "Macro Work()",
            "  Var d: MyLabel;",
            "  d.",
            "End;"
        ].join("\n"),
        others: {
            [lib]: [
                "Import RsbFormsInter;",
                "Class (TRsbLabel) MyLabel",
                "  Var OwnField: String;",
                "End;"
            ].join("\n")
        },
        platform
    });
    const labels = await completeAfterDot(registry, "  d.");

    assert.ok(labels.includes("OwnField"), "свой член обязан быть");
    assert.ok(
        labels.includes("text") && labels.includes("getPosition"),
        "члены прикладной базы и её базы обязаны быть: " + labels.join(", ")
    );
});

const EDIT_CLASS = [
    "Class TEdit",
    "  Macro setNeighbours()",
    "  End;",
    "  Macro getNeighbours()",
    "  End;",
    "End;"
].join("\n");

for (const tail of ["Field7.", "Field7.s", "Field7.set", "Field7 . set"]) {
    test("объектный список после набранного члена: " + tail, async () => {
        /*
         * obj. и obj.set — одно и то же обращение. Прежде учитывался только
         * первый случай, и на набранных буквах быстрый путь отдавал общий
         * список: пользователь ждал полного разбора именно там, где нажал
         * Ctrl+Space.
         */
        const registry = createRegistry({
            source: [
                EDIT_CLASS,
                "Macro Work()",
                "  Var Field7: TEdit;",
                "  " + tail,
                "End;"
            ].join("\n")
        });
        const labels = await completeAfterDot(registry, "  " + tail);

        assert.ok(
            labels.includes("setNeighbours"),
            "член обязан быть в списке: " + labels.slice(0, 8).join(", ")
        );
        assert.ok(
            !labels.includes("MsgBox"),
            "это обязан быть список членов, а не общий приблизительный"
        );
    });
}

test("перевод строки обрывает обращение к члену", async () => {
    const registry = createRegistry({
        source: [
            EDIT_CLASS,
            "Macro Work()",
            "  Var Field7: TEdit;",
            "  Field7.",
            "  setNeighbours",
            "End;"
        ].join("\n")
    });
    const labels = await completeAfterDot(registry, "  setNeighbours");

    assert.ok(
        labels.includes("MsgBox"),
        "имя с новой строки к прошлой точке не относится"
    );
});

test("локальный цикл не переходит в Import", async () => {
    /*
     * Класс наследует сам себя: иерархия на этом кончается. Одноимённый класс
     * из Import её продолжать не должен — полный resolver так тоже не делает.
     */
    const lib = "file:///d:/fast/loop.mac";
    const registry = createRegistry({
        source: [
            "Import loop;",
            "Class (Loop) Loop",
            "  Var Own: String;",
            "End;",
            "Macro Work()",
            "  Var item: Loop;",
            "  item.",
            "End;"
        ].join("\n"),
        others: {
            [lib]: [
                "Class Loop",
                "  Var Imported: String;",
                "End;"
            ].join("\n")
        }
    });

    assert.deepStrictEqual(
        await completeAfterDot(registry, "  item."),
        ["Own"]
    );
});

test("цикл из двух классов завершается", async () => {
    const registry = createRegistry({
        source: [
            "Class (B) A",
            "  Var FieldA: String;",
            "End;",
            "Class (A) B",
            "  Var FieldB: String;",
            "End;",
            "Macro Work()",
            "  Var item: A;",
            "  item.",
            "End;"
        ].join("\n")
    });

    assert.deepStrictEqual(
        (await completeAfterDot(registry, "  item.")).slice().sort(),
        ["FieldA", "FieldB"]
    );
});

test("две одноимённые базы из разных Import членов не дают", async () => {
    /*
     * У модуля производного класса два подключения с одинаковым Class Base.
     * Собственные члены остаются, члены неизвестной базы — нет.
     */
    const derived = "file:///d:/fast/der.mac";
    const first = "file:///d:/fast/base1.mac";
    const second = "file:///d:/fast/base2.mac";
    const registry = createRegistry({
        source: [
            "Import der;",
            "Macro Work()",
            "  Var d: Derived;",
            "  d.",
            "End;"
        ].join("\n"),
        others: {
            [derived]: [
                "Import base1;",
                "Import base2;",
                "Class (Base) Derived",
                "  Var OwnDerived: String;",
                "End;"
            ].join("\n"),
            [first]: "Class Base" + "\n" + "  Var FromFirst: String;" + "\n" + "End;",
            [second]: "Class Base" + "\n" + "  Var FromSecond: String;" + "\n" + "End;"
        }
    });
    const labels = await completeAfterDot(registry, "  d.");

    assert.deepStrictEqual(labels, ["OwnDerived"],
        "при неоднозначной базе её члены не показываются: " + labels.join(", "));
});

test("TRsbEditField: унаследованный setNeighbours после набранного set", async () => {
    /*
     * Контрольный пример ревью целиком: тип из конструктора, модель этой версии
     * намеренно не готова, курсор после набранных букв. Метод достаётся из
     * TRsbControl — то есть работают и цепочка наследования, и префикс.
     */
    const platform = new PlatformModuleCatalog({ log: () => undefined });
    await platform.ensureModules(["RsbFormsInter"]);
    const registry = createRegistry({
        source: [
            "Import RsbFormsInter;",
            "Macro Test()",
            "  Var Field7 = TRsbEditField();",
            "  Field7.set",
            "End;"
        ].join("\n"),
        platform
    });
    const items = await completeItems(registry, "  Field7.set");
    const byName = new Map(items.map(item => [item.label, item.kind]));

    assert.ok(
        byName.has("setNeighbours"),
        "унаследованный метод обязан быть: " +
            Array.from(byName.keys()).slice(0, 10).join(", ")
    );
    assert.strictEqual(byName.get("setNeighbours"), CompletionItemKind.Method);
    assert.ok(
        !byName.has("MsgBox"),
        "это обязан быть список членов, а не общий приблизительный"
    );
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

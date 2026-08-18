"use strict";

/**
 * Компактный индекс быстрого автодополнения.
 *
 * Индекс строится своим проходом по токенам: общий извлекатель объявлений не
 * даёт ни локальных переменных Macro, ни типов параметров. Цена такого прохода
 * — необходимость самому соблюдать те же правила языка, что соблюдает
 * извлекатель: ключевое слово ключевое не везде, END закрывает не всякий блок,
 * а запятая не всегда разделяет объявления.
 *
 * Здесь проверяются ровно те границы, на которых первая версия ошибалась.
 */

const assert = require("assert");

const {
    TextDocument
} = require("../server/node_modules/vscode-languageserver-textdocument");
const {
    createFastDocumentSnapshot
} = require("../server/out/services/fastDocumentSnapshot");
const {
    dropFastCompletionIndex,
    getFastCompletionIndex,
    lookupFastName,
    visibleFastItems
} = require("../server/out/features/fastCompletionIndex");
const {
    extractCompactDeclarations
} = require("../server/out/analysis/declarationExtractor");

let passed = 0;
let failed = 0;
let counter = 0;

function test(name, action) {
    try {
        action();
        passed++;
        console.log("[OK] " + name);
    } catch (error) {
        failed++;
        console.error("[FAIL] " + name);
        console.error(error);
    }
}

/** Индекс для образца; каждый раз свой URI, чтобы кэш не мешал. */
function indexOf(source) {
    counter++;
    const document = TextDocument.create(
        "file:///d:/index-case-" + counter + ".mac",
        "rsl",
        1,
        source
    );
    return getFastCompletionIndex(createFastDocumentSnapshot(document));
}

function classMembers(index, name) {
    const list = index.classes.get(name.toLowerCase()) || [];
    return list.length === 1 ? list[0].members : [];
}

/* --- блоки без собственной области ---------------------------------------- */

for (const keyword of ["If", "While", "For", "With"]) {
    test("верхнеуровневый " + keyword + " не ломает построение", () => {
        /*
         * Такой блок закрывается END, но своей области не вводит. Пока он
         * запоминал чужую область, его END обращался к области с номером -1 и
         * построение падало исключением прямо в обработчике Completion.
         */
        const index = indexOf(keyword + " (flag)\n  flag = 1;\nEnd;\n");
        assert.deepStrictEqual(index.scopes, []);
    });
}

test("If внутри Macro не закрывает её раньше времени", () => {
    const source = [
        "Class Ledger",
        "  Var Balance: Double;",
        "End;",
        "Macro Work()",
        "  If (a)",
        "  End;",
        "  Var y: Ledger;",
        "  y.",
        "End;"
    ].join("\n");
    const index = indexOf(source);

    assert.deepStrictEqual(
        lookupFastName(index, "y", source.indexOf("  y.") + 4),
        { declared: true, typeName: "Ledger" }
    );
});

/* --- ключевые слова после точки ------------------------------------------- */

for (const field of ["End", "Var", "Class", "Import", "Private"]) {
    test("поле с именем " + field + " не считается ключевым словом", () => {
        const source = [
            "Class Ledger",
            "  Var Balance: Double;",
            "End;",
            "Macro Work()",
            "  Var x: Ledger;",
            "  obj." + field + ";",
            "  x.",
            "End;"
        ].join("\n");
        const index = indexOf(source);

        assert.deepStrictEqual(
            lookupFastName(index, "x", source.indexOf("  x.") + 4),
            { declared: true, typeName: "Ledger" }
        );
    });
}

test("точка в конце строки не превращает END в имя поля", () => {
    /*
     * Именно это состояние и есть обычный вызов подсказки: пользователь набрал
     * точку и ждёт список. Признак «после точки» не должен переживать перевод
     * строки, иначе следующее END не закроет блок.
     */
    const source = [
        "Class Ledger",
        "  Private Var SecretKey: String;",
        "  Macro PostEntry()",
        "    Var self: Ledger;",
        "    self.",
        "  End;",
        "End;",
        "Macro Work()",
        "End;"
    ].join("\n");
    const own = indexOf(source).classes.get("ledger");

    assert.strictEqual(own.length, 1);
    assert.ok(
        own[0].end < source.indexOf("Macro Work"),
        "класс обязан закрыться своим END, а не концом файла"
    );
});

test("END в конце строки закрывает блок", () => {
    /*
     * Такая запись обычна в реальном коде: if (...) return X end; — здесь
     * END не начинает инструкцию, но блок закрывает. Строгая проверка начала
     * инструкции его пропускала, и Macro оставалась открытой до конца файла.
     */
    const source = [
        "Macro First()",
        "  if ( a ) return 1 end;",
        "End;",
        "Macro Second()",
        "End;"
    ].join("\n");
    const index = indexOf(source);

    assert.strictEqual(
        index.scopes.filter(scope => scope.parent === -1).length,
        2,
        "обе процедуры обязаны остаться на верхнем уровне"
    );
});

test("объявление без точки с запятой не поглощает END", () => {
    /*
     * Var A = 1, B = 2 end; — точку с запятой в конце ставят не всегда.
     * Пока список объявлений искал только запятую или точку с запятой, ему
     * доставалось само END, и класс не закрывался.
     */
    const source = [
        "Class Styles",
        "  Var DOUBL = 1,",
        "      UNARY = 2",
        "end;",
        "Macro After()",
        "End;"
    ].join("\n");
    const index = indexOf(source);

    assert.strictEqual(
        index.scopes.filter(scope => scope.parent === -1).length,
        2
    );
    assert.deepStrictEqual(
        classMembers(index, "Styles").map(member => member.name),
        ["DOUBL", "UNARY"]
    );
});

/* --- Import --------------------------------------------------------------- */

test("Import из нескольких имён даёт несколько модулей", () => {
    assert.deepStrictEqual(indexOf("Import lib, lib2;\n").imports, [
        "lib",
        "lib2"
    ]);
});

test("состав Import совпадает с общим извлекателем", () => {
    /*
     * Список Import уходит в разрешение модулей, поэтому форма обязана быть та
     * же, что у полного пути: иначе один и тот же файл разрешался бы по-разному
     * в зависимости от готовности модели.
     */
    const samples = [
        "Import lib;\n",
        "Import lib, lib2;\n",
        "Import common, \"folder" + String.fromCharCode(92) + "cards.mac\";\n",
        "Import lib.mac;\n",
        "Import a;\nImport b;\n",
        "Macro T()\n  obj.Import;\nEnd;\n"
    ];

    for (const source of samples) {
        assert.deepStrictEqual(
            indexOf(source).imports,
            extractCompactDeclarations(source, { includePrivate: true }).imports,
            "состав Import разошёлся на образце " + JSON.stringify(source)
        );
    }
});

test("foo.mac и fooxmac — разные модули", () => {
    /*
     * Точка в шаблоне расширения обязана быть литеральной. С точкой-заменителем
     * fooxmac попадал под .mac и считался повтором foo.mac.
     */
    assert.deepStrictEqual(indexOf("Import foo.mac, fooxmac;").imports, [
        "foo.mac",
        "fooxmac"
    ]);
});

test("Import без точки с запятой не поглощает следующую инструкцию", () => {
    /*
     * Точку с запятой ещё не набрали — а подсказка нужна именно сейчас. Прежде
     * весь остаток файла становился одним именем модуля, и ни одной области не
     * находилось.
     */
    const index = indexOf("Import lib" + "\n" + "Macro Work()" + "\n" + "End;" + "\n");

    assert.deepStrictEqual(index.imports, ["lib"]);
    assert.deepStrictEqual(
        index.globalItems.map(item => item.label),
        ["Work"]
    );
});

test("ключевое слово после точки внутри Var не заканчивает объявление", () => {
    /*
     * Var x = obj.End; — здесь End это имя поля. Проверка после точки была
     * только в главном цикле, и разбор объявления заканчивался на нём: слово
     * доставалось главному циклу и закрывало Macro посреди себя.
     */
    const source = [
        "Class Ledger",
        "  Var Balance: Double;",
        "End;",
        "Macro Work()",
        "  Var x = obj.End;",
        "  Var y: Ledger;",
        "  y.",
        "End;"
    ].join("\n");
    const index = indexOf(source);

    assert.strictEqual(
        index.scopes.filter(scope => scope.parent === -1).length,
        2
    );
    assert.deepStrictEqual(
        lookupFastName(index, "y", source.indexOf("  y.") + 4),
        { declared: true, typeName: "Ledger" }
    );
});

test("obj.Class в объявлении не открывает класс", () => {
    const index = indexOf(
        "Macro Work()" + "\n" + "  Var x = obj.Class;" + "\n" + "End;" + "\n"
    );

    assert.strictEqual(index.classes.size, 0);
    assert.strictEqual(index.scopes.length, 1);
});

test("базовый класс запоминается", () => {
    const index = indexOf(
        "Class Base" + "\n" + "End;" + "\n" +
        "Class (Base) Derived" + "\n" + "End;" + "\n"
    );

    assert.strictEqual(index.classes.get("derived")[0].baseName, "Base");
    assert.strictEqual(index.classes.get("base")[0].baseName, "");
});

/* --- объявления ----------------------------------------------------------- */

test("запятая внутри вызова не создаёт объявление", () => {
    const index = indexOf("Macro Work()\n  Var x = Make(a, phantom);\nEnd;\n");

    assert.ok(index.bindings.has("x"), "сама переменная обязана найтись");
    assert.ok(
        !index.bindings.has("phantom"),
        "аргумент вызова объявлением не является"
    );
});

test("объявления через запятую находятся оба", () => {
    const index = indexOf("Macro Work()\n  Var a: TFile, b: TStream;\nEnd;\n");

    assert.strictEqual(index.bindings.get("a")[0].typeName, "TFile");
    assert.strictEqual(index.bindings.get("b")[0].typeName, "TStream");
});

test("тип параметра по ссылке читается", () => {
    const source = "Macro Work(p:@Ledger)\n  p.\nEnd;\n";

    assert.strictEqual(
        lookupFastName(indexOf(source), "p", source.indexOf("  p.") + 4)
            .typeName,
        "Ledger"
    );
});

/* --- вложенность и приватность -------------------------------------------- */

test("вложенная Macro не попадает в общий список", () => {
    const index = indexOf("Macro Outer()\n  Macro Inner()\n  End;\nEnd;\n");

    assert.deepStrictEqual(
        index.globalItems.map(item => item.label),
        ["Outer"],
        "локальная процедура видна только в объемлющей"
    );
});

test("вложенная Macro внутри метода не становится членом класса", () => {
    const index = indexOf([
        "Class C",
        "  Macro M()",
        "    Macro Inner()",
        "    End;",
        "  End;",
        "End;"
    ].join("\n"));

    assert.deepStrictEqual(
        classMembers(index, "C").map(member => member.name),
        ["M"]
    );
});

test("приватность метода сохраняется", () => {
    const index = indexOf([
        "Class C",
        "  Private Macro Secret()",
        "  End;",
        "  Macro Open()",
        "  End;",
        "End;"
    ].join("\n"));

    assert.deepStrictEqual(
        classMembers(index, "C").map(
            member => member.name + ":" + member.isPrivate
        ),
        ["Secret:true", "Open:false"]
    );
});

/* --- кэш ------------------------------------------------------------------ */

test("та же версия другого содержимого не отдаёт прежний индекс", () => {
    /*
     * Номер версии начинается заново, когда файл закрыли и открыли снова.
     * Ключом служит сам поток токенов, поэтому подмены содержимого достаточно.
     */
    const uri = "file:///d:/reopened.mac";
    const first = getFastCompletionIndex(createFastDocumentSnapshot(
        TextDocument.create(uri, "rsl", 1, "Macro First()\nEnd;\n")
    ));
    const second = getFastCompletionIndex(createFastDocumentSnapshot(
        TextDocument.create(uri, "rsl", 1, "Macro Second()\nEnd;\n")
    ));

    assert.deepStrictEqual(
        first.globalItems.map(item => item.label),
        ["First"]
    );
    assert.deepStrictEqual(
        second.globalItems.map(item => item.label),
        ["Second"]
    );
});

test("освобождение индекса заставляет построить его заново", () => {
    const uri = "file:///d:/dropped.mac";
    const snapshot = createFastDocumentSnapshot(
        TextDocument.create(uri, "rsl", 1, "Macro Only()\nEnd;\n")
    );
    const first = getFastCompletionIndex(snapshot);

    assert.strictEqual(getFastCompletionIndex(snapshot), first);
    dropFastCompletionIndex(uri);
    assert.notStrictEqual(
        getFastCompletionIndex(snapshot),
        first,
        "после освобождения обязан появиться новый индекс"
    );
});

test("видимые имена не включают чужие области", () => {
    const source = [
        "Var moduleVar: TFile;",
        "Macro First()",
        "  Var onlyFirst: TFile;",
        "End;",
        "Macro Second()",
        "  Var onlySecond: TFile;",
        "End;"
    ].join("\n");
    const labels = visibleFastItems(
        indexOf(source),
        source.indexOf("  Var onlySecond") + 4
    ).map(item => item.label);

    assert.ok(labels.includes("moduleVar"), "переменная модуля видна");
    assert.ok(labels.includes("onlySecond"), "своя переменная видна");
    assert.ok(!labels.includes("onlyFirst"), "чужая локальная не видна");
});

test("активный индекс не вытесняется, пока им пользуются", () => {
    /*
     * Порядок обязан быть по давности обращения, а не создания. С простой
     * очередью активный файл оставался самым давним и вытеснялся, хотя запросы
     * шли именно к нему — то есть индекс строился заново на каждое нажатие.
     */
    const blocks = [];

    for (let macro = 0; macro < 3000; macro++) {
        blocks.push("Macro Handler" + macro + "(a, b)" + "\n" +
            "  Var value" + macro + ": Integer;" + "\n" + "End;");
    }

    const big = blocks.join("\n");
    const active = createFastDocumentSnapshot(
        TextDocument.create("file:///d:/lru-active.mac", "rsl", 1, big)
    );
    const first = getFastCompletionIndex(active);

    for (let extra = 0; extra < 6; extra++) {
        getFastCompletionIndex(createFastDocumentSnapshot(
            TextDocument.create(
                "file:///d:/lru-" + extra + ".mac",
                "rsl",
                1,
                big
            )
        ));
        /* Обращение к активному между чужими: он не должен стареть. */
        assert.strictEqual(
            getFastCompletionIndex(active),
            first,
            "индекс активного файла обязан переживать чужие обращения"
        );
    }
});

test("крупные индексы вытесняются по объёму", () => {
    /*
     * Ограничение считается по объёму, а не по числу файлов: индекс держит и
     * поток токенов, поэтому один большой файл весит больше десятка малых.
     */
    const blocks = [];

    for (let macro = 0; macro < 4000; macro++) {
        blocks.push("Macro Handler" + macro + "(a, b)" + "\n" +
            "  Var value" + macro + ": Integer;" + "\n" + "End;");
    }

    const big = blocks.join("\n");
    const first = "file:///d:/evict-first.mac";
    const firstSnapshot = createFastDocumentSnapshot(
        TextDocument.create(first, "rsl", 1, big)
    );
    const firstIndex = getFastCompletionIndex(firstSnapshot);

    /*
     * Каждый такой файл — около девяноста тысяч токенов, и нескольких хватает,
     * чтобы бюджет был исчерпан и самый давний индекс ушёл.
     */
    for (let extra = 0; extra < 6; extra++) {
        getFastCompletionIndex(createFastDocumentSnapshot(
            TextDocument.create(
                "file:///d:/evict-" + extra + ".mac",
                "rsl",
                1,
                big
            )
        ));
    }

    assert.notStrictEqual(
        getFastCompletionIndex(firstSnapshot),
        firstIndex,
        "давний индекс обязан быть вытеснен, а не жить рядом с новыми"
    );
});

console.log("\nПройдено: " + passed + ", провалено: " + failed);

if (failed > 0) {
    process.exitCode = 1;
}

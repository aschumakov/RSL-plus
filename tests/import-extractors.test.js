"use strict";

/**
 * Пять извлекателей Import на одном корпусе.
 *
 * Директивы Import достаются из файла пятью независимыми способами, и это
 * сделано намеренно: одним нужен точный текст с комментариями и диапазонами,
 * другим — дешёвая сводка без разбора. Объединять их нельзя, а расходиться в
 * ответе они не имеют права.
 *
 *   синтаксическое дерево          getImportNamesFromSyntax
 *   компактные объявления          extractCompactDeclarations
 *   сканер ссылок                  GetImportedMacroFiles
 *   быстрый индекс подсказок       getFastCompletionIndex
 *   модель Organize Imports        collectRslImports
 *
 * Один из них уже расходился молча: сканер ссылок получал не тот поток токенов
 * и склеивал имена файлов из чужих токенов, а заметили это только по неработающему
 * Ctrl+Click. Проверка на один случай такого класса не ловит — ловит общий корпус.
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

const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { parseRslSyntax, getImportNamesFromSyntax } =
    require("../server/out/syntaxParser");
const { extractCompactDeclarations } =
    require("../server/out/analysis/declarationExtractor");
const { GetImportedMacroFiles } = require("../server/out/execMacroDefinition");
const { getFastCompletionIndex } =
    require("../server/out/features/fastCompletionIndex");
const { createFastDocumentSnapshot } =
    require("../server/out/services/fastDocumentSnapshot");
const { collectRslImports } = require("../server/out/features/importModel");
const {
    TextDocument
} = require("../server/node_modules/vscode-languageserver-textdocument");

let passed = 0;
let failed = 0;

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

const URI = "file:///d:/project/main.mac";

/**
 * Общий вид имени модуля.
 *
 * Сравниваются не написания, а модули: кавычки, обратный слеш, регистр и
 * расширение .mac в RSL не значимы. Именно это и должно совпадать у всех пяти —
 * каждый отдаёт написание в своём виде, и это нормально.
 */
function moduleOf(value) {
    return String(value || "")
        .trim()
        .replace(/^["']|["']$/gu, "")
        .replace(/\\/gu, "/")
        .replace(/\.mac$/iu, "")
        .toLowerCase();
}

function unique(values) {
    return [...new Set(values.map(moduleOf).filter(Boolean))];
}

/** Ответ каждого извлекателя на один и тот же текст. */
function extractAll(source) {
    const index = new WorkspaceIndex();
    const module = index.updateOpenModule(URI, source, 1);
    const document = TextDocument.create(URI, "rsl", 1, source);
    const snapshot = createFastDocumentSnapshot(document);

    return {
        "синтаксическое дерево": unique(
            getImportNamesFromSyntax(parseRslSyntax(source).root)
        ),
        "компактные объявления": unique(
            extractCompactDeclarations(source).imports
        ),
        "сканер ссылок": unique(GetImportedMacroFiles(source)),
        "быстрый индекс": unique(getFastCompletionIndex(snapshot).imports),
        "модель Organize Imports": unique(
            collectRslImports(module)
                .flatMap(declaration => declaration.items)
                .map(item => item.name)
        )
    };
}

/** Все пятеро обязаны назвать одни и те же модули. */
function assertAgree(source, expected, what) {
    const answers = extractAll(source);
    const wrong = [];

    for (const [who, names] of Object.entries(answers)) {
        try {
            assert.deepStrictEqual([...names].sort(), [...expected].sort());
        } catch {
            wrong.push(who + ": " + JSON.stringify(names));
        }
    }

    assert.deepStrictEqual(
        wrong,
        [],
        what + "\nожидалось: " + JSON.stringify(expected) +
        "\nразошлись:\n  " + wrong.join("\n  ")
    );
}

const TAIL = "\nMacro Run()\nEnd;\n";

test("обычные имена, в том числе списком", () => {
    assertAgree(
        "Import alpha, bravo, charlie;" + TAIL,
        ["alpha", "bravo", "charlie"],
        "список имён в одной директиве"
    );
});

test("строковая форма и расширение .mac", () => {
    assertAgree(
        'Import "checkaml.mac";\nImport plain;\nImport "quoted";' + TAIL,
        ["checkaml", "plain", "quoted"],
        "кавычки и .mac — то же имя модуля"
    );
});

test("путь и обратный слеш", () => {
    assertAgree(
        'Import "sub/lib.mac";\nImport "other\\deep.mac";' + TAIL,
        ["sub/lib", "other/deep"],
        "разделитель пути не значим"
    );
});

test("регистр слова Import и имени", () => {
    assertAgree(
        "import Alpha;\nIMPORT bravo;\nImport CHARLIE;" + TAIL,
        ["alpha", "bravo", "charlie"],
        "регистр не значим"
    );
});

test("список, разложенный по строкам", () => {
    assertAgree(
        "Import alpha,\n    bravo,\n    charlie;" + TAIL,
        ["alpha", "bravo", "charlie"],
        "многострочная директива"
    );
});

test("комментарии внутри директивы", () => {
    assertAgree(
        "Import alpha, /* так надо */ bravo; // и всё\nImport charlie;" + TAIL,
        ["alpha", "bravo", "charlie"],
        "комментарии в имя не входят"
    );
});

test("директива не в первой строке", () => {
    assertAgree(
        "/* шапка\n   в две строки */\n\n// пояснение\nImport alpha;\n" +
        'Import "bravo.mac";' + TAIL,
        ["alpha", "bravo"],
        "перед директивой может быть что угодно"
    );
});

test("Import после кода", () => {
    assertAgree(
        "Import alpha;\nMacro First()\nEnd;\n\nImport bravo;" + TAIL,
        ["alpha", "bravo"],
        "вторая директива ниже по файлу"
    );
});

test("незакрытая директива не роняет извлекателей", () => {
    /*
     * Договориться об ответе тут нельзя: у дерева и у сканера разные права на
     * догадку о том, где кончается незакрытая директива. Обязательно другое —
     * никто не падает, и найденное до неё не теряется.
     */
    const answers = extractAll("Import alpha;\nImport bravo\n");

    for (const [who, names] of Object.entries(answers)) {
        assert.ok(
            names.includes("alpha"),
            who + " обязан сохранить директиву до незакрытой: " +
            JSON.stringify(names)
        );
    }
});

test("слово Import внутри строки директивой не становится", () => {
    /*
     * Текст сообщения — не директива. Это разделяют все пятеро: строка для
     * лексера один токен, и внутрь него никто не заглядывает.
     */
    assertAgree(
        'Macro Run()\n  MsgBox("Import alpha;");\nEnd;\n',
        [],
        "Import как текст сообщения"
    );
});

test("слово Import опознаётся директивой везде, где стоит", () => {
    /*
     * Правило намеренно широкое: директивой считается слово Import в любом
     * месте, а не только в начале предложения.
     *
     * Проверено на проекте из 6166 файлов: слово import встречается 10952 раза,
     * и лишь 4 раза не в начале предложения — все четыре настоящие директивы,
     * перед которыми стоит ":" или ".". Требование «только в начале
     * предложения» сломало бы эти четыре файла, а взамен защитило бы от
     * `Var Import = 1;`, которого в проекте нет ни разу.
     *
     * Здесь это закреплено, чтобы правило не ужесточили «для порядка»:
     * извлекатели, работающие по дереву, такую директиву видят, и остальные
     * обязаны видеть тоже.
     */
    assertAgree(
        "Macro First()\nEnd;\n. import alpha;" + TAIL,
        ["alpha"],
        "директива после точки: так написаны 4 настоящих файла проекта"
    );

    assertAgree(
        "Macro First()\nEnd;\n: import bravo;" + TAIL,
        ["bravo"],
        "директива после двоеточия"
    );
});

test("Import как имя переменной директивой не становится", () => {
    /*
     * Обратная сторона того же правила. Слово Import внутри выражения — это
     * имя, а не директива, и это обязаны понимать все пятеро: иначе Organize
     * Imports удалял бы чужой код, а разрешение модулей искало бы файл `=1`.
     */
    assertAgree(
        "Macro Run()\n  Var Import = 1;\n  Import = Import + 1;\nEnd;\n",
        [],
        "Import слева и справа от знака равенства"
    );
});

test("повтор одного модуля разными написаниями", () => {
    assertAgree(
        'Import checkaml;\nImport "checkaml.mac";\nImport CheckAml;' + TAIL,
        ["checkaml"],
        "три написания одного модуля"
    );
});

console.log(
    failed === 0
        ? "\nПройдено: " + passed
        : "\nПройдено: " + passed + ", провалено: " + failed
);

if (failed > 0) {
    process.exitCode = 1;
}

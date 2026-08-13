"use strict";

/**
 * Генерация словарных частей TextMate-грамматики из справочника языка.
 *
 * Грамматика — восьмая копия одних и тех же списков, и раньше она расходилась с
 * остальными: PUBLIC подсвечивался как модификатор в редакторе и не был им ни в
 * parser-е, ни в компиляторе; APPEND среди спецификаторов FILE отсутствовал;
 * V_MONEYL и V_GENOBJ были в подсветке, но не в каталоге констант.
 *
 * Генерируются ТОЛЬКО словарные узлы — те, что целиком состоят из перечисления
 * слов. Всё остальное (строки, комментарии, квадратные блоки, печатные формы)
 * остаётся написанным руками: там правила, а не списки.
 *
 *   node build/generate-grammar.js          — проверить синхронность
 *   node build/generate-grammar.js --write  — записать грамматику
 */

const fs = require("fs");
const path = require("path");

const GRAMMAR_FILE = path.join(
    __dirname,
    "..",
    "syntaxes",
    "rsl.tmLanguage.json"
);

function reference() {
    /* eslint-disable-next-line global-require */
    return require("../server/out/language/rslLanguageReference");
}

/** Слова в regex-альтернативу; длинные раньше коротких, чтобы \b не срезал. */
function alternation(words) {
    return Array.from(new Set(words.map(word => word.toLowerCase())))
        .sort((left, right) => right.length - left.length ||
            left.localeCompare(right))
        .join("|");
}

function wordPattern(words) {
    return `(?i)\\b(${alternation(words)})\\b`;
}

/**
 * Узлы грамматики, которые владеет справочник.
 *
 * Ключ — путь для сообщения об ошибке, значение — как найти узел и что в него
 * положить.
 */
function generatedNodes(language) {
    const {
        BLOCK_BOUNDARY_KEYWORDS,
        DECLARATION_MODIFIERS,
        FILE_RECORD_SPECIFIERS,
        LITERAL_KEYWORDS,
        PRIMITIVE_TYPES,
        STATEMENT_KEYWORDS,
        VALUE_TYPE_CONSTANTS,
        WORD_OPERATORS
    } = language;

    /*
     * Управляющие конструкции: операторы и границы блоков, без объявлений и
     * модификаторов — те подсвечиваются как storage.
     *
     * DEBUGBREAK не ключевое слово языка, а отладочная процедура платформы, но
     * подсвечивать её как обычный вызов бессмысленно: диагностика отдельно
     * предупреждает об оставленном DEBUGBREAK, и видеть его надо сразу.
     */
    const control = [
        ...STATEMENT_KEYWORDS.filter(word =>
            !DECLARATION_MODIFIERS.includes(word) &&
            !["var", "const", "array", "file", "record", "macro", "class"]
                .includes(word)
        ),
        ...BLOCK_BOUNDARY_KEYWORDS,
        "debugbreak"
    ];

    return [
        {
            path: "patterns[keyword.control.rsl]",
            find: grammar => grammar.patterns.find(item =>
                item.name === "keyword.control.rsl"
            ),
            apply: node => {
                node.match = wordPattern(control);
            }
        },
        {
            path: "patterns[support.constant.valtype.rsl]",
            find: grammar => grammar.patterns.find(item =>
                /^storage\.type\.|^support\.constant\./.test(item.name || "") &&
                /v_integer/i.test(item.match || "")
            ),
            apply: node => {
                node.match = wordPattern(VALUE_TYPE_CONSTANTS);
            }
        },
        {
            path: "repository.modificators",
            find: grammar => grammar.repository.modificators,
            apply: node => {
                /* CONST и KEY — не модификаторы видимости, но пишутся там же. */
                node.match = wordPattern([
                    ...DECLARATION_MODIFIERS,
                    "const",
                    ...FILE_RECORD_SPECIFIERS
                ]);
            }
        },
        {
            path: "repository.logical_operations",
            find: grammar => grammar.repository.logical_operations,
            apply: node => {
                node.match = wordPattern(WORD_OPERATORS);
            }
        },
        {
            path: "repository.logical_types",
            find: grammar => grammar.repository.logical_types.patterns[0],
            apply: node => {
                node.match = wordPattern([...LITERAL_KEYWORDS, "this"]);
            }
        },
        {
            path: "repository.storage_types",
            find: grammar => grammar.repository.storage_types.patterns[0],
            apply: node => {
                /*
                 * Примитивы языка, встроенные классы-контейнеры и ключевые
                 * слова объявления данных: ARRAY, FILE и RECORD в RSL — и
                 * объявление, и тип объекта, поэтому подсвечиваются как
                 * storage.type, а не как управляющая конструкция.
                 */
                node.match = wordPattern([
                    ...PRIMITIVE_TYPES,
                    ...language.DECLARATION_KEYWORDS.filter(word =>
                        word !== "macro" && word !== "class"
                    ),
                    "tarray",
                    "tbfile",
                    "tbfilelog"
                ]);
            }
        }
    ];
}

function generate(grammar, language) {
    const missing = [];

    for (const node of generatedNodes(language)) {
        const target = node.find(grammar);

        if (!target) {
            missing.push(node.path);
            continue;
        }
        node.apply(target);
    }

    if (missing.length > 0) {
        throw new Error(
            `В грамматике нет узлов: ${missing.join(", ")}. ` +
            "Генератор владеет ими по имени scope, а не по индексу — " +
            "переименование scope нужно отразить в build/generate-grammar.js"
        );
    }

    return grammar;
}

function readGrammar() {
    return JSON.parse(fs.readFileSync(GRAMMAR_FILE, "utf8"));
}

/*
 * Формат файла сохраняется как был: отступ в три пробела и CRLF. Иначе первая
 * же генерация даёт diff во весь файл, в котором смысловую правку не видно.
 */
function serialize(grammar) {
    return `${JSON.stringify(grammar, null, 3)}\n`.replace(/\r?\n/g, "\r\n");
}

function main() {
    const write = process.argv.includes("--write");
    const current = serialize(readGrammar());
    const generated = serialize(generate(readGrammar(), reference()));

    if (write) {
        fs.writeFileSync(GRAMMAR_FILE, generated, "utf8");
        console.log(current === generated
            ? "rsl.tmLanguage.json: без изменений"
            : "rsl.tmLanguage.json: обновлена из справочника языка");
        return;
    }

    if (current === generated) {
        console.log("rsl.tmLanguage.json синхронна со справочником языка");
        return;
    }

    console.error(
        "rsl.tmLanguage.json разошлась со справочником языка. " +
        "Запустите: node build/generate-grammar.js --write"
    );
    process.exitCode = 1;
}

module.exports = { generate, readGrammar, serialize };

if (require.main === module) {
    main();
}

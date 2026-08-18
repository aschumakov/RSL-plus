"use strict";

/**
 * Быстрый индекс на заведомо незавершённом тексте.
 *
 * Именно с таким текстом он и работает: пользователь набирает строку, точку с
 * запятой ещё не поставил, END не написал. Сравнение на корректных файлах этого
 * состояния не проверяет — там всё закрыто.
 *
 * Проверка направленная: срез делается сразу после значимых мест — точки, слова
 * Import, END, заголовка Macro и Class, — потому что все найденные ошибки индекса
 * были именно на этих границах. Образцы генерируются, чтобы проверка не зависела
 * от наличия репозитория макросов; при указанном каталоге берутся и реальные
 * файлы.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
    TextDocument
} = require("../server/node_modules/vscode-languageserver-textdocument");
const {
    createFastDocumentSnapshot
} = require("../server/out/services/fastDocumentSnapshot");
const {
    getFastCompletionIndex
} = require("../server/out/features/fastCompletionIndex");
const {
    decodeRslSourceText
} = require("../server/out/core/textDecoding");

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

/* Места, на которых индекс ошибался: после них и делается срез. */
const ANCHORS = [
    { name: "точка", pattern: /\./g },
    { name: "Import", pattern: /\bimport\b/gi },
    { name: "End", pattern: /\bend\b/gi },
    { name: "Macro", pattern: /\bmacro\b/gi },
    { name: "Class", pattern: /\bclass\b/gi },
    { name: "двоеточие", pattern: /:/g },
    { name: "запятая", pattern: /,/g }
];

/** Смещения сразу после вхождений якоря; не больше limit штук. */
function anchorOffsets(source, pattern, limit) {
    const result = [];
    let match;
    pattern.lastIndex = 0;

    while ((match = pattern.exec(source)) !== null) {
        result.push(match.index + match[0].length);

        if (result.length >= limit) {
            break;
        }

        if (match[0].length === 0) {
            pattern.lastIndex++;
        }
    }

    return result;
}

/**
 * Строит индекс на каждом срезе и требует, чтобы ни один не упал.
 *
 * Возвращает число проверенных состояний: по нему видно, что проверка правда
 * что-то делала, а не молча нашла нуль якорей.
 */
function checkMutations(label, source) {
    let states = 0;

    for (const anchor of ANCHORS) {
        for (const at of anchorOffsets(source, anchor.pattern, 40)) {
            counter++;
            states++;
            const cut = source.slice(0, at);

            try {
                getFastCompletionIndex(createFastDocumentSnapshot(
                    TextDocument.create(
                        "file:///d:/mutation-" + counter + ".mac",
                        "rsl",
                        1,
                        cut
                    )
                ));
            } catch (error) {
                throw new Error(
                    label + ": срез после «" + anchor.name + "» на " + at +
                    " уронил построение — " + error.message
                );
            }
        }
    }

    return states;
}

const SAMPLES = {
    "класс с базой и методами": [
        "Import lib, \"folder" + String.fromCharCode(92) + "cards.mac\";",
        "Class Base",
        "  Var BaseField: String;",
        "  Private Macro Hidden()",
        "  End;",
        "End;",
        "Class (Base) Derived",
        "  Var Own: TFile;",
        "  Macro Post( value: Integer, ref:@TFile )",
        "    Var local = Make(a, b);",
        "    If (value > 0)",
        "      local.Write(0);",
        "    End;",
        "  End;",
        "End;"
    ].join("\n"),
    "процедуры и вложенность": [
        "Var moduleVar: Ledger;",
        "Macro Outer(param)",
        "  Var inner = TStringList();",
        "  Macro Nested()",
        "    Var deep;",
        "  End;",
        "  While (inner.Count > 0)",
        "    inner.Del(0);",
        "  End;",
        "End;",
        "Macro Second()",
        "  obj.End;",
        "  Var after: Ledger;",
        "End;"
    ].join("\n"),
    "обращения к членам": [
        "Macro Work()",
        "  Var doc: TBFile;",
        "  doc.AddFilter(1);",
        "  doc.",
        "End;"
    ].join("\n")
};

for (const [name, source] of Object.entries(SAMPLES)) {
    test("незавершённый текст: " + name, () => {
        const states = checkMutations(name, source);
        assert.ok(states > 3, "проверено слишком мало состояний: " + states);
    });
}

/*
 * Реальные файлы — по желанию: путь задаётся переменной среды, чтобы набор
 * тестов оставался самодостаточным.
 */
const REAL = process.env.RSL_MUTATION_ROOT;

if (REAL && fs.existsSync(REAL)) {
    test("незавершённый текст: реальные файлы", () => {
        const files = [];
        const visit = entry => {
            if (files.length >= 40) {
                return;
            }

            let stat;

            try {
                stat = fs.statSync(entry);
            } catch (error) {
                return;
            }

            if (stat.isDirectory()) {
                if (path.basename(entry) !== ".git") {
                    fs.readdirSync(entry).forEach(name =>
                        visit(path.join(entry, name))
                    );
                }
                return;
            }

            if (/\.mac$/iu.test(entry) && stat.size > 2048) {
                files.push(entry);
            }
        };
        visit(REAL);
        let states = 0;

        for (const file of files) {
            states += checkMutations(
                path.basename(file),
                decodeRslSourceText(fs.readFileSync(file))
            );
        }

        console.log("[METRIC] реальных состояний проверено: " + states);
        assert.ok(states > 0, "подходящих файлов не найдено");
    });
}

console.log("\nПройдено: " + passed + ", провалено: " + failed);
console.log("[METRIC] всего состояний: " + counter);

if (failed > 0) {
    process.exitCode = 1;
}

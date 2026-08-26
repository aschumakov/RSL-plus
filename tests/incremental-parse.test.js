"use strict";

/**
 * Инкрементальный разбор против полного.
 *
 * Путь берётся только там, где ответ обязан совпасть с полным разбором до
 * последнего смещения: дерево, диагностики, токены. Поэтому проверка
 * дифференциальная — на настоящих правках и на направленных мутациях, — а не
 * «работает ли вообще».
 */

const assert = require("assert");

const {
    fullRslParse
} = require("../server/out/services/incrementalParse");
const {
    createRslModelState,
    tryUpdateRslModelState
} = require("../server/out/services/incrementalModel");
const { lexRsl } = require("../server/out/lexer");
const {
    extractDeclarationsFromSyntax
} = require("../server/out/analysis/declarationExtractor");

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

/** Файл из count процедур: больше порога инкрементального пути. */
function sample(count) {
    const lines = ["Import common;", ""];

    for (let index = 0; index < count; index++) {
        lines.push(
            "Macro Process" + index + "(document, options)",
            "  Var result = 0;",
            "  Var total = 0;",
            "  if (options == 1)",
            "    result = document.Value + total;",
            "  end;",
            "  for (position = 0; position < 10; position = position + 1)",
            "    total = total + position;",
            "  end;",
            "  return result;",
            "End;",
            ""
        );
    }

    return lines.join("\n");
}

/**
 * Подпись дерева: вид, границы, имя, служебные смещения и токены узла.
 *
 * Токены узла обязательны: их сдвиг идёт отдельным путём — поиском в новом
 * потоке, — и один промах даёт узел с чужими смещениями при верных границах.
 */
function treeSignature(node) {
    const parts = [];

    const walk = current => {
        parts.push([
            current.kind,
            current.start,
            current.end,
            current.name || "",
            current.parameterListStart ?? "",
            current.parameterListEnd ?? "",
            current.typeName || "",
            current.baseClassName || "",
            current.tokens.map(token =>
                token.kind + "@" + token.start + "-" + token.end +
                "/" + token.line).join(" ")
        ].join(":"));

        for (const child of current.children) {
            walk(child);
        }
    };

    walk(node);

    return parts.join("|");
}

function tokenSignature(tokens) {
    return tokens
        .map(token => [
            token.kind, token.start, token.end, token.line, token.character
        ].join(":"))
        .join("|");
}

function declarationSignature(text, parse) {
    const snapshot = extractDeclarationsFromSyntax(text, parse);
    const parts = [];

    const walk = list => {
        for (const item of list) {
            parts.push([
                item.kind,
                item.name,
                item.start,
                item.end,
                item.selectionStart,
                item.selectionEnd,
                item.startLine,
                item.startCharacter
            ].join(":"));
            walk(item.children || []);
        }
    };

    walk(snapshot.declarations);

    return snapshot.imports.join(",") + "#" + parts.join("|");
}

/**
 * Подпись дерева символов: то, из чего живут навигация и подсветка.
 *
 * Разбор совпал — это ещё не значит, что совпала модель: объявления
 * неизменившихся единиц берутся у прошлой версии со сдвигом, и ошибка
 * сдвига видна только здесь.
 */
function symbolSignature(model) {
    const parts = [];

    const walk = symbol => {
        const range = model.definitionRanges.get(symbol);

        parts.push([
            symbol.id,
            symbol.name,
            symbol.kind,
            symbol.range.start,
            symbol.range.end,
            symbol.selectionRange?.start ?? "",
            symbol.selectionRange?.end ?? "",
            symbol.typeName || "",
            symbol.typeVariant ? "variant" : "",
            symbol.visibility || "",
            symbol.value || "",
            symbol.parameterText || "",
            symbol.baseClassName || "",
            range ? range.start.line + "," + range.start.character : "",
            range ? range.end.line + "," + range.end.character : ""
        ].join(":"));

        for (const child of symbol.children) {
            walk(child);
        }
    };

    walk(model.symbolTree);

    return model.imports.join(",") + "#" + parts.join("|");
}

/**
 * Сравнение подписей с показом первого расхождения.
 *
 * Подпись большого файла — сотни тысяч символов; целиком в отчёте она
 * бесполезна. Нужен один узел, на котором пути разошлись.
 */
function assertSameSignature(left, right, what) {
    if (left === right) {
        return;
    }

    const leftParts = left.split("|");
    const rightParts = right.split("|");

    for (
        let index = 0;
        index < Math.max(leftParts.length, rightParts.length);
        index++
    ) {
        if (leftParts[index] !== rightParts[index]) {
            assert.fail(
                what + ": расхождение на элементе " + index + " из " +
                    leftParts.length + "/" + rightParts.length +
                    "\n  точечно:  " + (leftParts[index] || "(нет)") +
                    "\n  полностью: " + (rightParts[index] || "(нет)")
            );
        }
    }

    assert.fail(what + ": подписи различаются длиной");
}

/** Точечное обновление модели и сверка с полным путём. */
function compare(previousText, nextText) {
    const previousState = createRslModelState(
        previousText,
        fullRslParse(previousText)
    ).state;
    const nextLex = lexRsl(nextText, { includeTrivia: true });
    let decision;
    const update = tryUpdateRslModelState(
        previousState,
        nextText,
        nextLex,
        value => { decision = value; }
    );

    if (!update) {
        return { decision, applied: false };
    }

    const incremental = update.state.parse;
    const full = fullRslParse(nextText);
    const fullModel = createRslModelState(nextText, full).model;

    assertSameSignature(
        treeSignature(incremental.root),
        treeSignature(full.root),
        "дерево"
    );
    assertSameSignature(
        tokenSignature(incremental.tokens),
        tokenSignature(full.tokens),
        "токены"
    );
    assert.deepStrictEqual(
        incremental.diagnostics,
        full.diagnostics,
        "диагностики разбора обязаны совпасть"
    );
    assertSameSignature(
        declarationSignature(nextText, incremental),
        declarationSignature(nextText, full),
        "объявления"
    );
    assertSameSignature(
        symbolSignature(update.model),
        symbolSignature(fullModel),
        "дерево символов"
    );

    return { decision, applied: true };
}

const BASE = sample(400);

test("правка внутри тела процедуры разбирается точечно", () => {
    const at = BASE.indexOf("  total = total + position;", BASE.length / 2);
    const next = BASE.slice(0, at) +
        "  total = total + position + 1;" +
        BASE.slice(at + "  total = total + position;".length);
    const result = compare(BASE, next);

    assert.ok(result.applied, "путь обязан примениться: " + result.decision?.reason);
    assert.strictEqual(result.decision.reason, "incremental");
    assert.strictEqual(result.decision.unitKind, "MacroDeclaration");
});

test("вставка строки в тело процедуры сдвигает хвост правильно", () => {
    const at = BASE.indexOf("  return result;", BASE.length / 3);
    const next = BASE.slice(0, at) +
        "  Var extra = 1;\n" +
        BASE.slice(at);
    const result = compare(BASE, next);

    assert.ok(result.applied, "путь обязан примениться: " + result.decision?.reason);
});

test("удаление строки внутри процедуры тоже точечное", () => {
    const at = BASE.indexOf("  Var total = 0;\n", BASE.length / 2);
    const next = BASE.slice(0, at) +
        BASE.slice(at + "  Var total = 0;\n".length);
    const result = compare(BASE, next);

    assert.ok(result.applied, "путь обязан примениться: " + result.decision?.reason);
});

test("правка Import уходит на полный разбор", () => {
    const next = BASE.replace("Import common;", "Import commonInter;");
    const result = compare(BASE, next);

    assert.strictEqual(result.applied, false);
    assert.ok(
        ["importTouched", "noUnit", "multipleUnits", "unsupportedUnit"]
            .includes(result.decision.reason),
        "причина: " + result.decision.reason
    );
});

test("незакрытый блок уходит на полный разбор", () => {
    const at = BASE.indexOf("  end;\n", BASE.length / 2);
    const next = BASE.slice(0, at) + BASE.slice(at + "  end;\n".length);
    const result = compare(BASE, next);

    assert.strictEqual(
        result.applied,
        false,
        "потеря END меняет деление файла на единицы"
    );
});

test("правка на границе процедуры уходит на полный разбор", () => {
    const at = BASE.indexOf("End;\n", BASE.length / 2);
    const next = BASE.slice(0, at) + "End;;\n" + BASE.slice(at + "End;\n".length);
    const result = compare(BASE, next);

    assert.strictEqual(result.applied, false);
});

test("маленький файл идёт полным путём", () => {
    const small = sample(3);
    const next = small.replace("Var result = 0;", "Var result = 1;");
    const result = compare(small, next);

    assert.strictEqual(result.applied, false);
    assert.strictEqual(result.decision.reason, "smallFile");
});

/*
 * Направленные мутации: сто правок в разные места файла. Каждая, если пошла
 * точечным путём, обязана дать в точности то же, что полный разбор.
 */
test("сто мутаций совпадают с полным разбором", () => {
    let applied = 0;
    let refused = 0;
    const inserts = [" ", "\n", "  Var extra = 1;\n", "+ 1", "0", "  "];
    /* Своя «случайность»: тест обязан быть повторяемым. */
    let seed = 12345;
    const random = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;

        return seed / 0x7fffffff;
    };

    for (let attempt = 0; attempt < 100; attempt++) {
        const at = Math.floor(
            BASE.length * 0.2 + random() * BASE.length * 0.7
        );
        const insert = inserts[Math.floor(random() * inserts.length)];
        const removeCount = Math.floor(random() * 6);
        const next = BASE.slice(0, at) + insert +
            BASE.slice(at + removeCount);
        const result = compare(BASE, next);

        if (result.applied) {
            applied++;
        } else {
            refused++;
        }
    }

    console.log(
        `[METRIC] мутации: точечно ${applied}, полным путём ${refused}`
    );
    assert.ok(
        applied > 0,
        "хотя бы часть правок обязана идти точечным путём"
    );
});

if (failed > 0) {
    console.error(`\nПройдено: ${passed}\nОшибок: ${failed}`);
    process.exitCode = 1;
} else {
    console.log(`\nПройдено: ${passed}\nОшибок: ${failed}`);
}

"use strict";

/**
 * Каталог проекта в натуральную величину: сто тысяч символов.
 *
 * Ctrl+T опрашивает каталог целиком, поэтому цена ответа на большом проекте —
 * это цена самого запроса, а не время загрузки. Прежде совпадения собирались в
 * один список и сортировались полностью: запрос по короткому популярному
 * префиксу стоил на реальном проекте в 97 тысяч символов около 20 мс, потому
 * что десятки тысяч заведомо лишних записей сортировались ради двухсот
 * верхних.
 *
 * Здесь проверяется и то, и другое: ответ обязан совпадать с полной
 * сортировкой запись в запись, а стоить — как выдача, а не как проект.
 */

const assert = require("assert");

const { WorkspaceCatalog } = require("../server/out/indexing/workspaceCatalog");
const { normalizeIdentifier } = require("../server/out/lexer");
const { isFullTestRun } = require("./test-mode");

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

const MODULES = 2000;
const PER_MODULE = 50;
const SYMBOLS = MODULES * PER_MODULE;
/* Обычный лимит Ctrl+T. */
const LIMIT = 200;

/*
 * Имена как в проекте: горстка популярных основ и хвост своеобразных.
 *
 * Популярная основа нужна нарочно — именно на ней прежний отбор разворачивал
 * полную сортировку десятков тысяч совпадений.
 */
const STEMS = [
    "Check", "CheckDocument", "CheckAccount", "CheckLimit",
    "Print", "PrintForm", "Calc", "CalcRate",
    "Document", "Account", "Journal", "Balance",
    "Send", "Load", "Save", "Build",
    "OnBeforeWrite", "OnAfterWrite", "Handle", "Resolve"
];

/** Имя символа по его порядковому номеру: одно и то же в любом прогоне. */
function symbolName(module, position) {
    const serial = module * PER_MODULE + position;
    const stem = STEMS[serial % STEMS.length];

    /*
     * Каждая тридцать седьмая запись — точное имя основы, остальные с
     * суффиксом. Так у запроса есть и точное совпадение, и тысячи
     * однокоренных. Тридцать семь и двадцать взаимно просты: точные имена
     * достаются всем основам, а не одной первой.
     */
    return serial % 37 === 0 ? stem : stem + String(serial);
}

function moduleUri(module) {
    return "file:///d:/project/module" + String(module).padStart(5, "0") +
        ".mac";
}

function declarationsOf(module) {
    const declarations = [];

    for (let position = 0; position < PER_MODULE; position++) {
        const start = position * 100;

        declarations.push({
            kind: "macro",
            name: symbolName(module, position),
            visibility: "public",
            children: [],
            start,
            end: start + 90,
            selectionStart: start + 6,
            selectionEnd: start + 40,
            startLine: position,
            startCharacter: 0,
            endLine: position,
            endCharacter: 90
        });
    }

    return declarations;
}

/** Каталог из MODULES файлов, заполненный в заданном порядке. */
function buildCatalog(order) {
    const catalog = new WorkspaceCatalog();

    for (const module of order) {
        catalog.recordDeclarations({
            uri: moduleUri(module),
            version: 1,
            declarations: declarationsOf(module),
            imports: []
        });
    }

    return catalog;
}

const FORWARD = Array.from({ length: MODULES }, (_, index) => index);
const BACKWARD = [...FORWARD].reverse();

/* Плоский список всех символов: основа для эталонного ответа. */
const ALL = [];

for (const module of FORWARD) {
    for (let position = 0; position < PER_MODULE; position++) {
        const name = symbolName(module, position);

        ALL.push({
            name,
            normalized: normalizeIdentifier(name),
            uri: moduleUri(module),
            /* Каталог хранит начало имени, а не начало объявления. */
            start: position * 100 + 6
        });
    }
}

/** Подпоследовательность: буквы запроса встречаются по порядку. */
function isSubsequence(query, candidate) {
    if (query.length === 0) {
        return true;
    }

    let at = 0;

    for (const letter of candidate) {
        if (letter === query[at]) {
            at++;

            if (at === query.length) {
                return true;
            }
        }
    }

    return false;
}

/** Ранг совпадения: точное, начало, вхождение, подпоследовательность. */
function rankOf(candidate, query) {
    if (!query) {
        return 2;
    }

    if (candidate === query) {
        return 0;
    }

    if (candidate.startsWith(query)) {
        return 1;
    }

    if (candidate.includes(query)) {
        return 2;
    }

    return isSubsequence(query, candidate) ? 3 : -1;
}

function compare(left, right) {
    return left < right ? -1 : (left > right ? 1 : 0);
}

/**
 * Эталон: прежний отбор — все совпадения в один список и полная сортировка.
 *
 * Медленный нарочно: он и есть то, с чем сверяется быстрый.
 */
function referenceFind(query, limit) {
    const normalized = normalizeIdentifier(query.trim());
    const matches = [];

    for (const symbol of ALL) {
        const rank = rankOf(symbol.normalized, normalized);

        if (rank >= 0) {
            matches.push({ rank, symbol });
        }
    }

    matches.sort((left, right) =>
        left.rank - right.rank ||
        compare(left.symbol.normalized, right.symbol.normalized) ||
        compare(left.symbol.uri, right.symbol.uri) ||
        (left.symbol.start - right.symbol.start));

    return matches.slice(0, Math.max(0, limit)).map(item => item.symbol);
}

/** Запись в сравнимом виде: имя, файл и место. */
function signature(symbol) {
    return symbol.name + "@" + symbol.uri + ":" + symbol.start;
}

function signatures(symbols) {
    return symbols.map(signature);
}

/** Лучшее время из нескольких прогонов: шум планировщика не в счёт. */
function best(rounds, action) {
    let result = Infinity;

    for (let round = 0; round < rounds; round++) {
        const at = process.hrtime.bigint();

        action();
        result = Math.min(result, Number(process.hrtime.bigint() - at) / 1e6);
    }

    return result;
}

const catalog = buildCatalog(FORWARD);

test("каталог собран целиком", () => {
    assert.strictEqual(
        catalog.stats.symbols,
        SYMBOLS,
        "в каталоге обязаны быть все символы проекта"
    );
});

test("пустой запрос совпадает с полной сортировкой", () => {
    assert.deepStrictEqual(
        signatures(catalog.find("", LIMIT)),
        signatures(referenceFind("", LIMIT)),
        "ответ на пустой запрос обязан совпадать с полной сортировкой"
    );
});

test("короткий популярный префикс совпадает с полной сортировкой", () => {
    assert.deepStrictEqual(
        signatures(catalog.find("Check", LIMIT)),
        signatures(referenceFind("Check", LIMIT)),
        "популярный префикс обязан отбираться так же, как полной сортировкой"
    );
});

test("точное имя идёт первым и совпадает с полной сортировкой", () => {
    const found = catalog.find("CalcRate", LIMIT);

    assert.ok(found.length > 0, "ответ обязан быть непустым");
    assert.strictEqual(
        found[0].name,
        "CalcRate",
        "точное имя обязано идти первым: " + found[0].name
    );
    assert.deepStrictEqual(
        signatures(found),
        signatures(referenceFind("CalcRate", LIMIT)),
        "точный запрос обязан совпадать с полной сортировкой"
    );
});

test("поиск подпоследовательностью совпадает с полной сортировкой", () => {
    /* Ни точного совпадения, ни вхождения: буквы разбросаны по слову. */
    const query = "jnl";
    const found = catalog.find(query, 50);

    assert.ok(
        found.length > 0 && found.every(item => /Journal/u.test(item.name)),
        "подпоследовательность обязана находиться: " +
            found.slice(0, 3).map(item => item.name).join(", ")
    );
    assert.deepStrictEqual(
        signatures(found),
        signatures(referenceFind(query, 50)),
        "подпоследовательность обязана отбираться в том же порядке"
    );
});

test("нулевой лимит: пустой ответ без обхода каталога", () => {
    assert.deepStrictEqual(catalog.find("Check", 0), []);
    assert.deepStrictEqual(catalog.find("", 0), []);
    assert.deepStrictEqual(catalog.find("Check", -5), []);

    /*
     * Обход ста тысяч символов заметен даже на быстрой машине: если он всё же
     * происходит, миллисекунды хватит, чтобы это увидеть.
     */
    const spent = best(20, () => catalog.find("Check", 0));

    assert.ok(
        spent < 1,
        "нулевой лимит не имеет права обходить каталог: " +
            spent.toFixed(3) + " мс"
    );
});

test("порядок заполнения каталога не меняет ответ", () => {
    const backward = buildCatalog(BACKWARD);

    for (const query of ["", "Check", "CalcRate", "jnl"]) {
        assert.deepStrictEqual(
            signatures(backward.find(query, LIMIT)),
            signatures(catalog.find(query, LIMIT)),
            "обратный порядок заполнения не меняет ответ на запрос: " + query
        );
    }
});

test("готовый ответ на пустой запрос отменяется изменением каталога", () => {
    const changing = buildCatalog(FORWARD.slice(0, 50));
    const before = signatures(changing.find("", 10));
    const added = "file:///d:/project/aaa.mac";

    changing.recordDeclarations({
        uri: added,
        version: 1,
        declarations: [{
            kind: "macro",
            name: "Aaaaa",
            visibility: "public",
            children: [],
            start: 0,
            end: 10,
            selectionStart: 6,
            selectionEnd: 11,
            startLine: 0,
            startCharacter: 0,
            endLine: 0,
            endCharacter: 10
        }],
        imports: []
    });

    const after = signatures(changing.find("", 10));

    assert.strictEqual(
        after[0],
        "Aaaaa@" + added + ":6",
        "новое имя обязано встать на своё место по алфавиту: " + after[0]
    );

    changing.remove(added);

    assert.deepStrictEqual(
        signatures(changing.find("", 10)),
        before,
        "удаление файла обязано вернуть прежний ответ"
    );
});

/*
 * Замер времени — только в полном наборе: в быстром рядом идут другие
 * процессы, и цена запроса превращается в лотерею. Проверки состава и
 * порядка от набора не зависят и идут всегда.
 */
const timed = isFullTestRun() ? test : (name => {
    console.log("[SKIP] " + name + " (быстрый набор)");
});

timed("цена запроса определяется выдачей, а не размером проекта", () => {
    /*
     * Пороги мягкие: на занятой машине сборки цифры плавают в разы. Но
     * возврата к полной сортировке они не переживут — прежний отбор сортировал
     * по этим запросам десятки тысяч записей и стоил на порядок больше.
     */
    const popular = best(20, () => catalog.find("Check", LIMIT));
    const empty = best(20, () => catalog.find("", LIMIT));
    const reference = best(3, () => referenceFind("Check", LIMIT));

    console.log(
        "[METRIC] Ctrl+T на " + SYMBOLS + " символах: популярный префикс " +
        popular.toFixed(2) + " мс, пустой запрос " + empty.toFixed(2) +
        " мс, полная сортировка " + reference.toFixed(2) + " мс"
    );

    assert.ok(
        popular < 40,
        "популярный префикс обязан стоить как выдача: " +
            popular.toFixed(2) + " мс"
    );
    assert.ok(
        empty < 2,
        "готовый ответ на пустой запрос обязан отдаваться сразу: " +
            empty.toFixed(2) + " мс"
    );
    assert.ok(
        popular < reference * 0.7,
        "отбор обязан быть заметно дешевле полной сортировки: " +
            popular.toFixed(2) + " против " + reference.toFixed(2) + " мс"
    );
});

if (failed > 0) {
    console.error("\nПройдено: " + passed + "\nОшибок: " + failed);
    process.exitCode = 1;
} else {
    console.log("\nПройдено: " + passed + "\nОшибок: " + failed);
}

"use strict";

/**
 * Протокол Completion и устойчивость списка.
 *
 * Контракт `CompletionList.isIncomplete` означает «перезапроси провайдер на
 * каждую следующую букву». Раньше флаг ставился по превышению предела в 180
 * элементов и на любой ответ до готовности модели, поэтому обычный набор текста
 * заставлял сервер считать список заново — с другим составом и порядком.
 *
 * Здесь проверяется новое правило: обычный список отдаётся полным и
 * помечается полным, поиск по проекту — ограниченным и неполным, а повторный
 * запрос при том же состоянии документа берётся из сеанса.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
    CompletionTransport
} = require("../server/out/features/completionTransport");
const {
    CompletionSessionCache,
    completionSessionKey
} = require("../server/out/features/completionSession");
const {
    rankCompletionItemsForPrefix
} = require("../server/out/features/completionRanking");

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

function items(count) {
    return Array.from({ length: count }, (ignored, index) => ({
        label: "Name" + index,
        kind: 6,
        detail: "модуль",
        documentation: "описание " + index
    }));
}

test("длинный список не помечается неполным", () => {
    const transport = new CompletionTransport();
    const list = transport.prepare(items(500));

    assert.strictEqual(list.items.length, 500, "список отдаётся целиком");
    assert.strictEqual(
        list.isIncomplete,
        false,
        "полный список обязан быть помечен полным: иначе редактор " +
            "перезапрашивает его на каждую букву"
    );
});

test("поиск по проекту ограничивается и помечается неполным", () => {
    const transport = new CompletionTransport();
    const list = transport.prepare(items(500), { limit: 100, incomplete: true });

    assert.strictEqual(list.items.length, 100);
    assert.strictEqual(list.isIncomplete, true);
});

test("тяжёлые поля уходят в resolve, а ключ не зависит от номера запроса", () => {
    const transport = new CompletionTransport();
    const source = items(3);
    const first = transport.prepare(source);

    assert.strictEqual(first.items[0].documentation, undefined);
    assert.strictEqual(first.items[0].detail, undefined);

    const resolved = transport.resolve(first.items[0]);
    assert.strictEqual(resolved.documentation, "описание 0");
    assert.strictEqual(resolved.detail, "модуль");

    /* Тот же элемент в другом запросе получает тот же ключ. */
    const second = transport.prepare(source);
    assert.strictEqual(
        second.items[0].data.rslCompletionKey,
        first.items[0].data.rslCompletionKey
    );
    /* И элемент из прошлого списка по-прежнему разрешается. */
    assert.strictEqual(
        transport.resolve(first.items[0]).documentation,
        "описание 0"
    );
});

test("одноимённые элементы из разных модулей не путаются в resolve", () => {
    const transport = new CompletionTransport();
    const prepared = transport.prepare([
        { label: "Post", kind: 2, detail: "PaymInter", documentation: "первый" },
        { label: "Post", kind: 2, detail: "BankInter", documentation: "второй" }
    ]);

    assert.strictEqual(
        transport.resolve(prepared.items[0]).documentation,
        "первый"
    );
    assert.strictEqual(
        transport.resolve(prepared.items[1]).documentation,
        "второй"
    );
});

test("ключ сеанса различает состояние, от которого зависит состав", () => {
    const base = {
        uri: "file:///m.mac",
        version: 7,
        receiver: "Field7",
        wordStart: 42,
        knowledge: "lib.mac@1 | 3"
    };
    const same = completionSessionKey({ ...base, receiver: "field7" });

    assert.strictEqual(
        same,
        completionSessionKey(base),
        "регистр имени получателя состав не меняет"
    );

    /*
     * Источник в ключ не входит: готовность модели наступает сама собой, и по
     * тому же тексту список обязан остаться прежним.
     */
    assert.strictEqual(
        completionSessionKey({ ...base, source: "model" }),
        completionSessionKey({ ...base, source: "fast" }),
        "готовность модели сама по себе не начинает новый сеанс"
    );

    for (const changed of [
        { version: 8 },
        { receiver: "Other" },
        { wordStart: 43 },
        { knowledge: "lib.mac@2 | 3" }
    ]) {
        assert.notStrictEqual(
            completionSessionKey({ ...base, ...changed }),
            completionSessionKey(base),
            "изменение " + Object.keys(changed)[0] + " обязано дать новый сеанс"
        );
    }
});

test("повторный запрос берётся из сеанса и меняет только порядок", () => {
    const sessions = new CompletionSessionCache();
    const key = {
        uri: "file:///m.mac",
        version: 1,
        source: "fastMembers",
        receiver: "Field7",
        wordStart: 10,
        knowledge: "1:0"
    };
    const candidates = [
        { label: "getText", kind: 2 },
        { label: "setText", kind: 2 },
        { label: "setNeighbours", kind: 2 }
    ];
    sessions.set(key, candidates, false);

    const session = sessions.get(key);
    assert.ok(session, "сеанс обязан находиться по тому же ключу");
    assert.strictEqual(session.candidates.length, 3);

    /* Набранное «setNei» меняет порядок, но не состав. */
    const ranked = rankCompletionItemsForPrefix(session.candidates, "setNei");
    assert.strictEqual(ranked.length, 3, "состав сеанса не урезается");
    assert.strictEqual(
        [...ranked]
            .sort((first, second) =>
                String(first.sortText).localeCompare(String(second.sortText))
            )[0].label,
        "setNeighbours"
    );

    sessions.forget("file:///m.mac");
    assert.strictEqual(
        sessions.get(key),
        undefined,
        "после правки файла сеанс обязан пропасть"
    );
});

test("порядок не зависит от порядка сборки кандидатов", () => {
    const collected = [
        { label: "Post", kind: 2, detail: "BankInter" },
        { label: "Post", kind: 2, detail: "PaymInter" },
        { label: "PostAll", kind: 3, detail: "PaymInter" }
    ];
    const order = list => rankCompletionItemsForPrefix(list, "post")
        .sort((first, second) =>
            String(first.sortText).localeCompare(String(second.sortText))
        )
        .map(item => [item.label, item.detail].join(" "));

    assert.deepStrictEqual(
        order(collected),
        order([...collected].reverse()),
        "одинаковый снимок обязан давать одинаковый порядок"
    );
});

test("замена набранного отдаётся редактору и совпадает со словом языка", () => {
    /*
     * Своего textEdit элементы не несут: диапазон замены редактор считает сам
     * по wordPattern языка. Значит правильность диапазона — это правильность
     * wordPattern, и проверяется именно она.
     */
    const transport = new CompletionTransport();
    const prepared = transport.prepare([
        { label: "setNeighbours", kind: 2 },
        { label: "{curdate}", kind: 6 }
    ]);

    for (const item of prepared.items) {
        assert.strictEqual(
            item.textEdit,
            undefined,
            "свой диапазон замены сервер не навязывает"
        );
        assert.strictEqual(item.additionalTextEdits, undefined);
    }

    const configuration = JSON.parse(
        fs.readFileSync(
            path.join(__dirname, "..", "language-configuration.json"),
            "utf8"
        )
    );
    const wordPattern = new RegExp(configuration.wordPattern, "gu");
    const wordAt = (text, offset) => {
        wordPattern.lastIndex = 0;
        let found = "";
        let match;

        while ((match = wordPattern.exec(text)) !== null) {
            const start = match.index;
            const end = start + match[0].length;

            if (start <= offset && offset <= end) {
                found = match[0];
            }
        }

        return found;
    };

    /* Член после точки: заменяется только набранное имя, без точки. */
    const member = "  Field7.set";
    assert.strictEqual(wordAt(member, member.length), "set");

    /* Спецпеременная: заменяется имя вместе со скобками. */
    const special = "  x = {cur";
    assert.strictEqual(wordAt(special, special.length), "{cur");

    const closed = "  x = {curdate}";
    assert.strictEqual(wordAt(closed, closed.length), "{curdate}");
});

console.log("\nПройдено: " + passed + ", провалено: " + failed);

if (failed > 0) {
    process.exitCode = 1;
}

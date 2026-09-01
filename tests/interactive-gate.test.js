"use strict";

/**
 * Окно тишины после действия пользователя.
 *
 * Правило было выписано трижды — у обхода проекта, у загрузчика модулей и у
 * службы разбора документа, — и у каждого свой счётчик и свой способ узнать
 * время. Проверить его можно было только там, где часы внедряются; в обходе
 * проекта время бралось прямо из Date.now(), и поведение оставалось на
 * внимательности.
 *
 * Теперь правило одно, и здесь проверяется именно оно.
 */

const assert = require("assert");

const {
    InteractiveActivityGate
} = require("../server/out/core/interactiveActivityGate");

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

/** Часы, которые идут только когда их просят. */
function fakeClock(start = 1000) {
    let value = start;

    return {
        now: () => value,
        setTimeout: () => undefined,
        clearTimeout: () => undefined,
        advance: (ms) => {
            value += ms;
        }
    };
}

test("до первой отметки фоновой работе никто не мешает", () => {
    const gate = new InteractiveActivityGate(500, fakeClock());

    assert.strictEqual(gate.isBusy(), false);
    assert.strictEqual(gate.remainingMs(), 0);
});

test("отметка открывает окно ровно на паузу", () => {
    const clock = fakeClock();
    const gate = new InteractiveActivityGate(500, clock);

    gate.note();

    assert.strictEqual(gate.isBusy(), true);
    assert.strictEqual(gate.remainingMs(), 500);

    clock.advance(499);

    assert.strictEqual(gate.isBusy(), true, "за миг до конца окно ещё идёт");
    assert.strictEqual(gate.remainingMs(), 1);

    clock.advance(1);

    assert.strictEqual(gate.isBusy(), false, "в момент конца окно закрыто");
    assert.strictEqual(gate.remainingMs(), 0);
});

test("повторная отметка отодвигает конец окна", () => {
    const clock = fakeClock();
    const gate = new InteractiveActivityGate(500, clock);

    gate.note();
    clock.advance(400);

    assert.strictEqual(gate.remainingMs(), 100);

    gate.note();

    assert.strictEqual(
        gate.remainingMs(),
        500,
        "вторая отметка считает паузу заново"
    );
});

test("отметка никогда не укорачивает окно", () => {
    /*
     * Обход проекта раньше писал Math.max(прежнее, сейчас + пауза) — на случай,
     * если новая граница окажется раньше старой. При постоянной паузе время идёт
     * только вперёд, поэтому такого не бывает; проверка это и закрепляет.
     */
    const clock = fakeClock();
    const gate = new InteractiveActivityGate(500, clock);

    gate.note();

    const first = gate.remainingMs();

    clock.advance(1);
    gate.note();

    assert.ok(
        gate.remainingMs() >= first - 1,
        "окно не может стать короче: " + gate.remainingMs() + " < " + first
    );
});

test("нулевая пауза окна не открывает", () => {
    const gate = new InteractiveActivityGate(0, fakeClock());

    gate.note();

    assert.strictEqual(gate.isBusy(), false);
});

test("отрицательная пауза считается нулевой", () => {
    const gate = new InteractiveActivityGate(-100, fakeClock());

    gate.note();

    assert.strictEqual(gate.isBusy(), false);
    assert.strictEqual(gate.remainingMs(), 0);
});

test("сброс закрывает окно немедленно", () => {
    const gate = new InteractiveActivityGate(500, fakeClock());

    gate.note();
    gate.reset();

    assert.strictEqual(gate.isBusy(), false);
});

test("по умолчанию берутся системные часы", () => {
    const gate = new InteractiveActivityGate(50);

    gate.note();

    assert.strictEqual(
        gate.isBusy(),
        true,
        "без внедрённых часов шлюз обязан работать так же"
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

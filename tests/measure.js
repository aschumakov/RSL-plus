"use strict";

/**
 * Замеры в тестах: сравнимые условия для обоих размеров.
 *
 * Проверка роста отвечает на один вопрос: удвоение входа удваивает время или
 * возводит его в квадрат. Отвечать на него оказалось неожиданно трудно.
 *
 * Настенное время в общем прогоне гуляет: рядом работают другие тестовые
 * процессы, операционная система занимает ядро, уборка мусора вклинивается в
 * середину замера. Одна и та же проверка давала то ×1,7, то ×30.
 *
 * Процессорное время своего процесса от соседей не зависит, но на Windows его
 * счётчик тикает примерно раз в 15 мс. Замер на 16 мс — это один тик, и
 * отношение «один тик к одиннадцати» не значит ничего: те же данные давали то
 * ×2,0, то ×10,7.
 *
 * Поэтому здесь настенное время — и три условия, которые делают его пригодным.
 * Первое: файлы с такими проверками идут в тихой части прогона, по одному
 * (см. tests/run-all.js). Второе: замер накапливается повторами до величины,
 * заметно большей планировочной дрожи. Третье: размеры меряются вперемешку, а
 * из повторов берётся минимум — помеха может замер только замедлить.
 *
 * Абсолютные величины по-прежнему меряются бенчмарками (build/bench-*.js) с
 * управляемой уборкой памяти: там нужны настоящие миллисекунды.
 */

/** Ниже этого замер сравнивать нельзя: планировочная дрожь того же порядка. */
const MINIMUM_SAMPLE_MS = 50;
const MAXIMUM_ITERATIONS = 4096;

/*
 * Сколько раз мерить каждый размер.
 *
 * Берётся минимум: помеха может только замедлить замер, но не ускорить его.
 */
const ROUNDS = 4;

/** Суммарное время iterations вызовов, в миллисекундах. */
function elapsed(action, iterations) {
    const started = process.hrtime.bigint();

    for (let index = 0; index < iterations; index++) {
        action();
    }

    return Number(process.hrtime.bigint() - started) / 1e6;
}

/** Суммарное процессорное время iterations вызовов, в миллисекундах. */
function cpuTotal(action, iterations) {
    const started = process.cpuUsage();

    for (let index = 0; index < iterations; index++) {
        action();
    }

    const spent = process.cpuUsage(started);

    return (spent.user + spent.system) / 1000;
}

/** Время одного вызова: повторы подбираются автоматически. */
function cpuMillis(action, minimumSampleMs = MINIMUM_SAMPLE_MS) {
    action();

    let iterations = 1;

    for (;;) {
        const total = elapsed(action, iterations);

        if (total >= minimumSampleMs || iterations >= MAXIMUM_ITERATIONS) {
            return total / iterations;
        }

        iterations *= 2;
    }
}

/**
 * Рост времени линейный, а не квадратичный.
 *
 * Оба размера прогреваются и меряются одним и тем же числом повторов: иначе
 * сравниваются не алгоритмы, а степень прогрева. Порог отличает линейное от
 * квадратичного — при квадратичности удвоение даёт ×4, а учетверение ×16.
 */
function assertLinearGrowth(
    assert,
    measure,
    smallCount,
    largeCount,
    label
) {
    /* Прогрев обоих размеров: дальше замеры сопоставимы. */
    measure(smallCount);
    measure(largeCount);

    let iterations = 1;
    let small = elapsed(() => measure(smallCount), iterations);

    while (small < MINIMUM_SAMPLE_MS && iterations < MAXIMUM_ITERATIONS) {
        iterations *= 2;
        small = elapsed(() => measure(smallCount), iterations);
    }

    let large = elapsed(() => measure(largeCount), iterations);

    /*
     * Замеры чередуются, а не идут блоками: помеха длится дольше одного
     * замера и блоками попадала бы целиком в один размер.
     */
    for (let round = 1; round < ROUNDS; round++) {
        small = Math.min(small, elapsed(
            () => measure(smallCount),
            iterations
        ));
        large = Math.min(large, elapsed(
            () => measure(largeCount),
            iterations
        ));
    }

    const factor = largeCount / smallCount;
    const ratio = large / Math.max(small, 0.001);
    /* Линейному росту позволяется полуторный запас от идеального. */
    const limit = factor * 1.5;

    assert.ok(
        ratio < limit,
        `${label}: ${small.toFixed(1)} -> ${large.toFixed(1)} мс за ` +
            `${iterations} повторов (×${ratio.toFixed(1)}, ` +
            `предел ×${limit.toFixed(1)})`
    );

    return { small, large, ratio, iterations };
}

module.exports = { cpuMillis, cpuTotal, elapsed, assertLinearGrowth };

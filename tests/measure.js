"use strict";

/**
 * Замеры в тестах: процессорное время, одинаковые условия для обоих размеров.
 *
 * Настенное время в общем прогоне гуляет: рядом работают другие тестовые
 * процессы, операционная система занимает ядро, уборка мусора вклинивается в
 * середину замера. Одна и та же проверка роста давала то ×1,7, то ×30 — и
 * падала не из-за регрессии.
 *
 * Процессорное время своего процесса от соседей почти не зависит, но у него
 * две тонкости. Первая: на Windows счётчик тикает примерно раз в 15 мс, и
 * короткое действие показывает ноль — поэтому замер накапливается повторами.
 * Вторая: если маленький размер повторить двадцать раз, а большой один, то
 * маленький окажется вдесятеро «быстрее» просто из-за прогрева JIT. Поэтому
 * число повторов подбирается по маленькому размеру и применяется к обоим.
 *
 * Абсолютные величины по-прежнему меряются бенчмарками (build/bench-*.js) с
 * управляемой уборкой памяти: там нужны настоящие миллисекунды.
 */

/** Гранулярность счётчика на Windows: ниже этого замер бессмыслен. */
const MINIMUM_SAMPLE_MS = 60;
const MAXIMUM_ITERATIONS = 256;

/** Суммарное процессорное время iterations вызовов, в миллисекундах. */
function cpuTotal(action, iterations) {
    const started = process.cpuUsage();

    for (let index = 0; index < iterations; index++) {
        action();
    }

    const spent = process.cpuUsage(started);

    return (spent.user + spent.system) / 1000;
}

/** Процессорное время одного вызова: повторы подбираются автоматически. */
function cpuMillis(action, minimumSampleMs = MINIMUM_SAMPLE_MS) {
    action();

    let iterations = 1;

    for (;;) {
        const total = cpuTotal(action, iterations);

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
    let small = cpuTotal(() => measure(smallCount), iterations);

    while (small < MINIMUM_SAMPLE_MS && iterations < MAXIMUM_ITERATIONS) {
        iterations *= 2;
        small = cpuTotal(() => measure(smallCount), iterations);
    }

    const large = cpuTotal(() => measure(largeCount), iterations);
    const factor = largeCount / smallCount;
    const ratio = large / Math.max(small, 0.001);
    /* Линейному росту позволяется полуторный запас от идеального. */
    const limit = factor * 1.5;

    assert.ok(
        ratio < limit,
        `${label}: ${small.toFixed(1)} -> ${large.toFixed(1)} мс CPU за ` +
            `${iterations} повторов (×${ratio.toFixed(1)}, ` +
            `предел ×${limit.toFixed(1)})`
    );

    return { small, large, ratio, iterations };
}

module.exports = { cpuMillis, cpuTotal, assertLinearGrowth };

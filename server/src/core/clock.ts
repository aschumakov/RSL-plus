/**
 * Часы и таймеры служб — за интерфейсом.
 *
 * Планирование в языковом сервере состоит из задержек: склейка правок,
 * пауза фоновой работы, отложенная публикация Problems. Проверять их
 * настоящими `setTimeout` дорого: набор тестов расписания занимал 35 секунд
 * из ста, и почти всё это время процесс просто ждал.
 *
 * Виртуальные часы дают тестам ровно то же поведение без ожидания: время
 * двигает сам тест, а порядок срабатывания таймеров сохраняется — сначала
 * ближайший по сроку, при равном сроке — тот, что поставлен раньше.
 */
export interface IRslClock {
    now(): number;
    setTimeout(handler: () => void, delayMs: number): IRslTimerHandle;
    clearTimeout(handle: IRslTimerHandle | undefined): void;
}

export type IRslTimerHandle = unknown;

export const systemRslClock: IRslClock = {
    now: () => Date.now(),
    setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
    clearTimeout: handle => {
        if (handle !== undefined) {
            clearTimeout(handle as NodeJS.Timeout);
        }
    }
};

export interface IRslVirtualClock extends IRslClock {
    /**
     * Двигает время вперёд, выполняя сработавшие таймеры.
     *
     * Между таймерами отдаётся управление микрозадачам: службы между
     * задержками делают `await`, и без этого продолжение не успело бы
     * выполниться до следующего шага времени.
     */
    advance(deltaMs: number): Promise<void>;
    /** Сколько таймеров ещё ждут: тест видит незавершённую работу. */
    readonly pending: number;
}

/**
 * Сколько настоящих тиков цикла событий даётся асинхронной работе.
 *
 * Службы между шагами уходят в setImmediate, в чтение файлов и в
 * порционный расчёт. Без настоящих тиков виртуальное время «обгоняет»
 * работу, и тест видит незавершённый результат.
 */
const QUIET_TICKS = 4;

async function pump(ticks: number): Promise<void> {
    for (let index = 0; index < ticks; index++) {
        await Promise.resolve();
        await new Promise(resolve => setImmediate(resolve));
    }
}

interface IVirtualTimer {
    at: number;
    order: number;
    handler: () => void;
    cancelled: boolean;
}

export function createRslVirtualClock(startMs = 0): IRslVirtualClock {
    let current = startMs;
    let order = 0;
    const timers: IVirtualTimer[] = [];

    /* Ближайший таймер, срок которого не позже границы шага. */
    const earliest = (until: number): IVirtualTimer | undefined => {
        let best: IVirtualTimer | undefined;

        for (const timer of timers) {
            if (timer.cancelled || timer.at > until) {
                continue;
            }

            if (
                !best ||
                timer.at < best.at ||
                (timer.at === best.at && timer.order < best.order)
            ) {
                best = timer;
            }
        }

        return best;
    };

    const remove = (timer: IVirtualTimer): void => {
        const index = timers.indexOf(timer);

        if (index >= 0) {
            timers.splice(index, 1);
        }
    };

    return {
        now: () => current,
        setTimeout(handler, delayMs) {
            const timer: IVirtualTimer = {
                at: current + Math.max(0, delayMs),
                order: order++,
                handler,
                cancelled: false
            };
            timers.push(timer);

            return timer;
        },
        clearTimeout(handle) {
            const timer = handle as IVirtualTimer | undefined;

            if (timer) {
                timer.cancelled = true;
                remove(timer);
            }
        },
        get pending() {
            return timers.filter(timer => !timer.cancelled).length;
        },
        async advance(deltaMs) {
            const until = current + Math.max(0, deltaMs);

            for (;;) {
                const next = earliest(until);

                if (next) {
                    current = Math.max(current, next.at);
                    remove(next);
                    next.handler();
                    await pump(1);
                    continue;
                }

                /*
                 * Таймеров на этот отрезок больше нет, но работа могла
                 * уйти в асинхронную цепочку — разбор, чтение файла,
                 * порционный расчёт, — которая потом ставит новый таймер.
                 * Даём ей несколько настоящих тиков и смотрим снова.
                 */
                await pump(QUIET_TICKS);

                if (!earliest(until)) {
                    break;
                }
            }

            current = Math.max(current, until);
            await pump(QUIET_TICKS);
        }
    };
}

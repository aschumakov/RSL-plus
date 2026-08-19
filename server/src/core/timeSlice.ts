/**
 * Порции работы с возвратом управления event loop.
 *
 * Тяжёлый расчёт, идущий одним куском, отменить нельзя: пока он не закончится,
 * до сервера не доходят ни новые сообщения от редактора, ни уведомление о смене
 * активной вкладки, ни отмена запроса — то есть проверять их бессмысленно, они
 * ещё не пришли. Отменяемость требует именно паузы в расчёте.
 *
 * Пауза — setImmediate, а не Promise.resolve: microtask отдаёт управление только
 * другим microtask-ам, а сообщения транспорта и таймеры остаются за ними в
 * очереди. Уже поставленный setImmediate выполняется раньше нашего продолжения,
 * поэтому переключение вкладки, назначенное через setImmediate, действительно
 * успевает до следующей порции.
 */
export interface IRslWorkSlice {
    /** Пора ли вернуть управление: бюджет порции израсходован. */
    shouldYield(): boolean;
    /** Отдаёт управление event loop и начинает новую порцию. */
    yieldNow(): Promise<void>;
    /** Отдаёт управление, только если бюджет израсходован. */
    yieldIfNeeded(): Promise<void>;
    /** Сколько раз расчёт возвращал управление: для тестов и профиля. */
    readonly yieldCount: number;
}

/**
 * Бюджет одной порции.
 *
 * 8 мс — середина требуемого диапазона 5–10 мс: при 60 кадрах в секунду это
 * половина кадра, то есть пауза не успевает стать заметной, а расчёт не
 * распадается на слишком мелкие куски, у каждого из которых своя цена.
 */
const DEFAULT_BUDGET_MS = 8;

/**
 * Часы порции — монотонные и с высоким разрешением.
 *
 * Date.now() на Windows идёт шагом системного таймера, около 16 мс: внутри
 * одного шага он показывает нулевую разницу, поэтому бюджет 8 мс не срабатывал
 * до следующего тика, и порция занимала поток до 18 мс. Ещё Date.now() умеет
 * идти назад при переводе часов.
 */
export function monotonicMs(): number {
    return performance.now();
}

export function createWorkSlice(budgetMs = DEFAULT_BUDGET_MS): IRslWorkSlice {
    const budget = Math.max(1, budgetMs);
    let startedAt = monotonicMs();
    let yields = 0;

    return {
        shouldYield(): boolean {
            return monotonicMs() - startedAt >= budget;
        },
        async yieldNow(): Promise<void> {
            yields++;
            await new Promise<void>(resolve => setImmediate(resolve));
            startedAt = monotonicMs();
        },
        async yieldIfNeeded(): Promise<void> {
            if (this.shouldYield()) {
                await this.yieldNow();
            }
        },
        get yieldCount(): number {
            return yields;
        }
    };
}

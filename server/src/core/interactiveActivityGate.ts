import { systemRslClock, type IRslClock } from "./clock";

/**
 * Окно тишины после действия пользователя.
 *
 * Фоновые работы — обход проекта, загрузка модулей, разбор соседних файлов —
 * обязаны уступать поток тому, что человек делает прямо сейчас. Правило у всех
 * одно: после запроса от редактора не начинать новую порцию, пока не пройдёт
 * пауза.
 *
 * Правило было выписано трижды: у обхода проекта, у загрузчика модулей и у
 * службы разбора документа. Три копии одного счётчика, три своих способа
 * узнать время — где Date.now() напрямую, где внедрённые часы. Проверить такое
 * поведение можно только там, где часы внедряются, а совпадение правил
 * держалось на внимательности.
 */
export class InteractiveActivityGate {
    private busyUntil = 0;
    private readonly pauseMs: number;
    private readonly clock: IRslClock;

    constructor(pauseMs: number, clock: IRslClock = systemRslClock) {
        this.pauseMs = Math.max(0, pauseMs);
        this.clock = clock;
    }

    /**
     * Пользователь что-то сделал: окно тишины начинается заново.
     *
     * Повторные отметки только отодвигают конец окна: время идёт вперёд,
     * поэтому новая граница всегда не раньше прежней.
     */
    note(): void {
        this.busyUntil = this.clock.now() + this.pauseMs;
    }

    /** Идёт ли сейчас окно тишины. */
    isBusy(): boolean {
        return this.clock.now() < this.busyUntil;
    }

    /** Сколько осталось ждать; 0 — можно работать. */
    remainingMs(): number {
        return Math.max(0, this.busyUntil - this.clock.now());
    }

    /** Окно тишины кончилось: фоновой работе больше никто не мешает. */
    reset(): void {
        this.busyUntil = 0;
    }
}

/**
 * Текст, которым закрывается блок RSL.
 *
 * Один источник на всё, что вставляет код за пользователя: Smart Enter,
 * сниппеты и Quick Fix. Раньше каждое место писало закрытие само, и в файле
 * оказывалась смесь `End;` и `end;` — в одном блоке одно, в соседнем другое.
 *
 * Нижний регистр — значение по умолчанию; проект может выбрать другое
 * настройкой rslPlus.format.keywordCase. Уже написанное пользователем не
 * меняется ни при каком значении: регистр в его коде — его дело.
 */
export const RSL_BLOCK_END = "end;";

export type RslKeywordCase = "lower" | "upper" | "capitalize";

/** Закрытие блока в том регистре, который выбран настройкой. */
export function rslBlockEnd(keywordCase?: string): string {
    if (keywordCase === "upper") {
        return RSL_BLOCK_END.toUpperCase();
    }

    if (keywordCase === "capitalize") {
        return RSL_BLOCK_END.charAt(0).toUpperCase() +
            RSL_BLOCK_END.slice(1);
    }

    return RSL_BLOCK_END;
}

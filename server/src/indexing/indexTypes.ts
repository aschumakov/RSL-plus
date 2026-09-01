import type { IRslModuleModel } from "../moduleModel";
import type { RslSymbol, SymbolId } from "../symbols/rslSymbol";

export interface IIndexedModule extends IRslModuleModel {
    uri: string;
    version: number;
    isOpen: boolean;
    /**
     * Отпечаток содержимого на диске; только у внешних модулей.
     *
     * Хранится на модуле, а не отдельной картой в загрузчике: удаление модуля
     * из индекса обязано уносить отпечаток вместе с ним, иначе следующая
     * загрузка сослалась бы на снимок, которого в индексе уже нет.
     */
    fingerprint?: string;
    /**
     * Отпечаток внешнего интерфейса: Import и публичные объявления.
     *
     * Правка тела Macro его не меняет — см. moduleInterface.
     */
    interfaceFingerprint: string;
    /**
     * Номер, меняющийся ровно тогда, когда изменился интерфейс.
     *
     * Версия модуля растёт от любой правки, и ключи, собранные из неё,
     * устаревали у соседних файлов от чужого набора текста. Здесь номер
     * переживает правку тела и меняется от подписи, Import, класса и
     * видимости.
     */
    interfaceRevision: number;
}

export interface IIndexedSymbol {
    uri: string;
    symbolId: SymbolId;
    symbol: RslSymbol;
    /**
     * Ключ прикладного модуля-владельца — только у символов platform-каталога.
     *
     * Без него базовый класс такого символа искать негде: uri у всех символов
     * каталога общий (rsl-builtin:), а имя базы имеет смысл только внутри
     * модуля-владельца и его объявленных зависимостей.
     */
    platformModule?: string;
}

export type ModuleResolution<T> =
    | { kind: "resolved"; value: T }
    | { kind: "ambiguous"; candidates: T[] }
    | { kind: "missing" };

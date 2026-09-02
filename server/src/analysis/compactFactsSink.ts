import type { ICompactModuleResponse } from "../indexing/compactModuleProtocol";
import type { ReferenceIndex } from "./referenceIndex";

/**
 * Куда попадают факты одного настоящего компактного чтения файла.
 *
 * Читают файл двое: загрузчик Import и достройка каталога. Обоим отвечает один
 * worker и оба получают ответ целиком — с объявлениями, Import, строковыми
 * ссылками и хэшами идентификаторов. Хэши брал только загрузчик; ответ
 * достройки их выбрасывал, и индекс ссылок позже добывал то же самое сам,
 * читая тот же файл второй раз.
 *
 * Приёмник один на обоих потребителей. Инвариант простой: одно настоящее
 * сканирование закрытого файла кормит всех, кому эти факты нужны.
 *
 * Он намеренно не знает ни про загрузчик, ни про достройку — только про сам
 * ответ. И наоборот: ни один из них не знает про устройство индекса ссылок.
 */
export interface IRslCompactFactsCounters {
    /** Сколько настоящих сканирований принесли факты. */
    scans: number;
    /** Сколько записей принял индекс ссылок. */
    accepted: number;
    /**
     * Сколько раз хэши пришли, но были отброшены.
     *
     * В нормальном сценарии ноль. Не ноль значит, что кто-то снова считает их
     * впустую.
     */
    discarded: number;
    /**
     * Ответы без хэшей: поднятые из дискового кэша и unchanged.
     *
     * Это не потеря — сканирования там не было вовсе, и считать заново нечего.
     */
    withoutHashes: number;
}

export class RslCompactFactsSink {
    private readonly counters: IRslCompactFactsCounters = {
        scans: 0,
        accepted: 0,
        discarded: 0,
        withoutHashes: 0
    };

    constructor(private readonly referenceIndex: ReferenceIndex) {}

    /** Принять факты ответа; вызывается обоими потребителями чтения. */
    accept(response: ICompactModuleResponse): void {
        if (response.status === "unchanged") {
            /*
             * Файл прочитан, но не сканирован: содержимое то же, и запись
             * индекса ссылок к нему по-прежнему относится.
             */
            this.counters.withoutHashes++;

            return;
        }

        if (response.status !== "indexed") {
            return;
        }

        if (!response.identifierHashes) {
            /*
             * Ответ из дискового кэша или unchanged: файл не сканировался, и
             * хэшей в нём нет по устройству. Запись индекса ссылок остаётся
             * прежней — она и не устарела.
             */
            this.counters.withoutHashes++;

            return;
        }

        this.counters.scans++;

        const before = this.referenceIndex.acceptedScannedFacts;

        this.referenceIndex.acceptScannedFacts(
            response.uri,
            response.fingerprint,
            response.identifierHashes,
            response.imports
        );

        if (this.referenceIndex.acceptedScannedFacts > before) {
            this.counters.accepted++;

            return;
        }

        /*
         * Запись уже была сверена тем же отпечатком: это не потеря, а
         * повторный ответ про тот же файл.
         */
        this.counters.discarded++;
    }

    get stats(): IRslCompactFactsCounters {
        return { ...this.counters };
    }
}

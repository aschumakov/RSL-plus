import * as fs from "fs";
import { fileURLToPath } from "url";

import { decodeRslSourceText } from "../core/textDecoding";
import { contentFingerprint } from "./contentFingerprint";

/**
 * Прочитанное за один запрос: чтобы один файл не читался дважды.
 *
 * Записи о ссылках и индекс References проверяют актуальность каждый сам:
 * записи сверяют отпечаток восстановленной записи, индекс — свой. В холодной
 * сессии оба проверяют одни и те же файлы, и один файл читался, декодировался
 * и хешировался по два раза за один запрос References.
 *
 * На проверенном проекте популярное имя даёт 2533 файла-кандидата на 66 МБ —
 * лишним оказывался второй проход по тем же 66 МБ.
 *
 * Кэш живёт ровно один запрос и ограничен по объёму: постоянного хранилища
 * исходников всего проекта здесь заводить нельзя, память дороже. За пределом
 * чтение работает по-прежнему, просто не запоминается.
 */

export interface IRslReadSource {
    source: string;
    fingerprint: string;
}

/** 16 МБ: хватает на типичный набор кандидатов, но не на весь проект. */
const DEFAULT_LIMIT_BYTES = 16 * 1024 * 1024;

export class RslRequestSourceCache {
    private readonly entries = new Map<string, IRslReadSource>();
    private bytes = 0;
    private readsValue = 0;

    constructor(private readonly limitBytes: number = DEFAULT_LIMIT_BYTES) {}

    /** Сколько раз пришлось обратиться к диску. */
    get reads(): number {
        return this.readsValue;
    }

    /**
     * Текст файла и его отпечаток; undefined — файл не читается.
     *
     * Отпечаток считается вместе с чтением: обоим потребителям он нужен, а
     * считать его дважды по одному и тому же тексту незачем.
     */
    async read(uri: string): Promise<IRslReadSource | undefined> {
        const known = this.entries.get(uri);

        if (known) {
            return known;
        }

        let filePath: string;

        try {
            filePath = fileURLToPath(uri);
        } catch (_error) {
            return undefined;
        }

        let source: string;

        try {
            this.readsValue++;
            source = decodeRslSourceText(await fs.promises.readFile(filePath));
        } catch (_error) {
            return undefined;
        }

        const entry: IRslReadSource = {
            source,
            fingerprint: contentFingerprint(source)
        };

        if (this.bytes + source.length <= this.limitBytes) {
            this.bytes += source.length;
            this.entries.set(uri, entry);
        }

        return entry;
    }
}

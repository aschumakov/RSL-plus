/** Небольшой ограниченный LRU-кэш без фоновых таймеров. */
export class LruCache<K, V> {
    private values = new Map<K, V>();

    constructor(private maxEntries: number) {
        this.maxEntries = Math.max(0, Math.floor(maxEntries));
    }

    /** Ключ наименее недавно использованного элемента, без изменения порядка. */
    peekOldest(): K | undefined {
        const oldest = this.values.keys().next();
        return oldest.done ? undefined : oldest.value;
    }

    get(key: K): V | undefined {
        const value = this.values.get(key);

        if (value === undefined) {
            return undefined;
        }

        this.values.delete(key);
        this.values.set(key, value);
        return value;
    }

    /**
     * Кладёт значение и ВОЗВРАЩАЕТ вытесненное.
     *
     * Вытеснение по числу записей кэш делает сам, и молча: владелец, который
     * вёл собственный счёт занятого объёма, об этом не узнавал — его счётчик
     * оставался завышенным, и дальше он вытеснял полезные записи, считая себя
     * переполненным. Поэтому вытесненные пары возвращаются наружу.
     */
    set(key: K, value: V): Array<[K, V]> {
        if (this.maxEntries === 0) {
            return [];
        }

        const evicted: Array<[K, V]> = [];
        this.values.delete(key);
        this.values.set(key, value);

        while (this.values.size > this.maxEntries) {
            const oldest = this.values.keys().next();

            if (oldest.done) {
                break;
            }

            const value = this.values.get(oldest.value);
            this.values.delete(oldest.value);

            if (value !== undefined) {
                evicted.push([oldest.value, value]);
            }
        }

        return evicted;
    }

    delete(key: K): void {
        this.values.delete(key);
    }

    /** Ключи от давних к недавним; порядок использования при этом не меняется. */
    keys(): IterableIterator<K> {
        return this.values.keys();
    }

    clear(): void {
        this.values.clear();
    }

    get size(): number {
        return this.values.size;
    }
}

/** Небольшой ограниченный LRU-кэш без фоновых таймеров. */
export class LruCache<K, V> {
    private values = new Map<K, V>();

    constructor(private maxEntries: number) {
        this.maxEntries = Math.max(0, Math.floor(maxEntries));
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

    set(key: K, value: V): void {
        if (this.maxEntries === 0) {
            return;
        }

        this.values.delete(key);
        this.values.set(key, value);

        while (this.values.size > this.maxEntries) {
            const oldest = this.values.keys().next();

            if (oldest.done) {
                break;
            }

            this.values.delete(oldest.value);
        }
    }

    delete(key: K): void {
        this.values.delete(key);
    }

    clear(): void {
        this.values.clear();
    }

    get size(): number {
        return this.values.size;
    }
}

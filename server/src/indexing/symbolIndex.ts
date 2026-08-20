import { normalizeIdentifier } from "../lexer";
import type { IIndexedModule, IIndexedSymbol } from "./indexTypes";

/** Инвертированный индекс только верхнеуровневых символов. */
export class SymbolIndex {
    private byName = new Map<string, IIndexedSymbol[]>();
    /**
     * Символы, упорядоченные по имени: поиск по началу имени идёт двоичным.
     *
     * Строится лениво и сбрасывается при любом изменении индекса. Нужен
     * Auto Import: он ищет среди неподключённых символов ВСЕГО проекта на
     * каждую нажатую букву, и перебор десяти тысяч символов там стоил дороже
     * самой подсказки.
     */
    private sorted: Array<{ name: string; value: IIndexedSymbol }> | undefined;

    add(module: IIndexedModule): void {
        this.sorted = undefined;
        for (const symbol of module.symbolTree.children) {
            const key = normalizeIdentifier(symbol.name);
            if (!key) continue;
            const values = this.byName.get(key) || [];
            values.push({ uri: module.uri, symbolId: symbol.id, symbol });
            this.byName.set(key, values);
        }
    }

    remove(module: IIndexedModule): void {
        this.sorted = undefined;
        for (const symbol of module.symbolTree.children) {
            const key = normalizeIdentifier(symbol.name);
            const values = this.byName.get(key);
            if (!values) continue;
            const filtered = values.filter(value => value.uri !== module.uri);
            if (filtered.length > 0) this.byName.set(key, filtered);
            else this.byName.delete(key);
        }
    }

    find(name: string): IIndexedSymbol[] {
        return (this.byName.get(normalizeIdentifier(name)) || []).slice();
    }

    all(): IIndexedSymbol[] {
        return Array.from(this.byName.values()).flat();
    }

    /**
     * Символы, чьё имя начинается с prefix, в порядке имени, файла и символа.
     *
     * Порядок задаётся ключом, а не порядком индексации: одноимённые символы
     * из разных файлов обязаны идти всегда одинаково.
     */
    findByPrefix(prefix: string, limit: number): IIndexedSymbol[] {
        const normalized = normalizeIdentifier(prefix);

        if (!normalized || limit <= 0) {
            return [];
        }

        const entries = this.ensureSorted();
        let low = 0;
        let high = entries.length;

        while (low < high) {
            const middle = (low + high) >>> 1;

            if (entries[middle].name < normalized) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }

        const result: IIndexedSymbol[] = [];

        for (
            let index = low;
            index < entries.length && result.length < limit;
            index++
        ) {
            if (!entries[index].name.startsWith(normalized)) {
                break;
            }

            result.push(entries[index].value);
        }

        return result;
    }

    /**
     * Порядок: имя, затем файл и идентификатор символа.
     *
     * Сравниваются поля, а не склеенный ключ: склейка означала бы строку на
     * каждый символ проекта, а их десятки тысяч, и строится этот список заново
     * после каждого изменения индекса.
     */
    private ensureSorted(): Array<{ name: string; value: IIndexedSymbol }> {
        if (this.sorted) {
            return this.sorted;
        }

        const entries: Array<{ name: string; value: IIndexedSymbol }> = [];

        for (const [name, values] of this.byName) {
            for (const value of values) {
                entries.push({ name, value });
            }
        }

        entries.sort((left, right) => {
            if (left.name !== right.name) {
                return left.name < right.name ? -1 : 1;
            }

            if (left.value.uri !== right.value.uri) {
                return left.value.uri < right.value.uri ? -1 : 1;
            }

            if (left.value.symbolId === right.value.symbolId) {
                return 0;
            }

            return left.value.symbolId < right.value.symbolId ? -1 : 1;
        });
        this.sorted = entries;

        return entries;
    }

    clear(): void {
        this.byName.clear();
        this.sorted = undefined;
    }
}

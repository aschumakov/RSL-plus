import { normalizeIdentifier } from "../lexer";
import type { IIndexedModule, IIndexedSymbol } from "./indexTypes";

/** Инвертированный индекс только верхнеуровневых символов. */
export class SymbolIndex {
    private byName = new Map<string, IIndexedSymbol[]>();

    add(module: IIndexedModule): void {
        for (const symbol of module.symbolTree.children) {
            const key = normalizeIdentifier(symbol.name);
            if (!key) continue;
            const values = this.byName.get(key) || [];
            values.push({ uri: module.uri, symbolId: symbol.id, symbol });
            this.byName.set(key, values);
        }
    }

    remove(module: IIndexedModule): void {
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

    clear(): void { this.byName.clear(); }
}

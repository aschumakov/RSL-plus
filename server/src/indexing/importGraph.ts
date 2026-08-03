import * as path from "path";

import type { IIndexedModule } from "./indexTypes";
import { normalizeModuleName, normalizeUriPath } from "./moduleNames";

/** Обратные рёбра Import; не владеет модулями и символами. */
export class ImportGraph {
    private reverse = new Map<string, Set<string>>();

    add(module: IIndexedModule): void {
        for (const importName of module.imports) {
            const normalized = normalizeModuleName(importName);
            for (const alias of [normalized, path.posix.basename(normalized)]) {
                const values = this.reverse.get(alias) || new Set<string>();
                values.add(module.uri);
                this.reverse.set(alias, values);
            }
        }
    }

    remove(module: IIndexedModule): void {
        for (const importName of module.imports) {
            const normalized = normalizeModuleName(importName);
            for (const alias of [normalized, path.posix.basename(normalized)]) {
                const values = this.reverse.get(alias);
                if (!values) continue;
                values.delete(module.uri);
                if (values.size === 0) this.reverse.delete(alias);
            }
        }
    }

    dependents(uri: string): string[] {
        const normalized = normalizeUriPath(uri);
        const result = new Set<string>();
        for (const alias of [normalized, path.posix.basename(normalized)]) {
            this.reverse.get(alias)?.forEach(value => result.add(value));
        }
        result.delete(uri);
        return Array.from(result);
    }

    clear(): void { this.reverse.clear(); }
}

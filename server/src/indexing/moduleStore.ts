import type { IIndexedModule, ModuleResolution } from "./indexTypes";
import {
    addUriAlias,
    removeUriAlias,
    resolveByModuleName
} from "./moduleNames";

/** Владение module model и разрешение имени модуля. */
export class ModuleStore {
    private modules = new Map<string, IIndexedModule>();
    private byBaseName = new Map<string, Set<string>>();

    get(uri: string): IIndexedModule | undefined { return this.modules.get(uri); }
    values(): IIndexedModule[] { return Array.from(this.modules.values()); }
    set(module: IIndexedModule): void {
        if (!this.modules.has(module.uri)) addUriAlias(this.byBaseName, module.uri);
        this.modules.set(module.uri, module);
    }
    delete(uri: string): IIndexedModule | undefined {
        const previous = this.modules.get(uri);
        if (previous) {
            this.modules.delete(uri);
            removeUriAlias(this.byBaseName, uri);
        }
        return previous;
    }
    clear(): void { this.modules.clear(); this.byBaseName.clear(); }
    resolve(name: string): ModuleResolution<IIndexedModule> {
        return resolveByModuleName(name, this.byBaseName, uri => this.modules.get(uri));
    }
    get size(): number { return this.modules.size; }
}

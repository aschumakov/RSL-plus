import type {
    IIndexedModule,
    ModuleResolution
} from "./indexTypes";

import {
    addUriAlias,
    getUriIdentity,
    removeUriAlias,
    resolveByModuleName
} from "./moduleNames";

/** Владение module model и разрешение имени модуля. */
export class ModuleStore {
    /**
     * Ключ — нормализованная идентичность файла.
     * Значение сохраняет исходный URI для LSP-переходов.
     */
    private modules = new Map<string, IIndexedModule>();
    private byBaseName = new Map<string, Set<string>>();

    get(uri: string): IIndexedModule | undefined {
        return this.modules.get(getUriIdentity(uri));
    }

    values(): IIndexedModule[] {
        return Array.from(this.modules.values());
    }

    set(module: IIndexedModule): void {
        const key = getUriIdentity(module.uri);
        const previous = this.modules.get(key);

        /*
         * Один физический файл мог прийти с другим регистром URI.
         * Убираем старый URI из индекса имён и сохраняем актуальный.
         */
        if (previous && previous.uri !== module.uri) {
            removeUriAlias(this.byBaseName, previous.uri);
        }

        if (!previous || previous.uri !== module.uri) {
            addUriAlias(this.byBaseName, module.uri);
        }

        this.modules.set(key, module);
    }

    delete(uri: string): IIndexedModule | undefined {
        const key = getUriIdentity(uri);
        const previous = this.modules.get(key);

        if (previous) {
            this.modules.delete(key);
            removeUriAlias(this.byBaseName, previous.uri);
        }

        return previous;
    }

    clear(): void {
        this.modules.clear();
        this.byBaseName.clear();
    }

    resolve(name: string): ModuleResolution<IIndexedModule> {
        return resolveByModuleName(
            name,
            this.byBaseName,
            uri => this.get(uri)
        );
    }

    get size(): number {
        return this.modules.size;
    }
}
import type {
    CompletionItem,
    CompletionList
} from "vscode-languageserver";

import { LruCache } from "../core/lruCache";

export interface ICompletionTransportOptions {
    maxItems?: number;
    cacheEntries?: number;
}

interface ICompletionData {
    rslCompletionKey?: string;
    [name: string]: unknown;
}

/**
 * Ограничивает LSP payload и переносит документацию/detail в resolve.
 * VS Code получает ранжированные labels немедленно, тяжёлые поля — только для
 * выбранной строки списка.
 */
export class CompletionTransport {
    private readonly maxItems: number;
    private readonly cache: LruCache<string, CompletionItem>;
    private sequence = 0;

    constructor(options: ICompletionTransportOptions = {}) {
        this.maxItems = Math.max(1, options.maxItems ?? 180);
        this.cache = new LruCache(
            Math.max(this.maxItems, options.cacheEntries ?? 720)
        );
    }

    prepare(items: readonly CompletionItem[]): CompletionList {
        const selected = items.slice(0, this.maxItems);
        const prepared = selected.map(item => {
            const key = `c${++this.sequence}`;
            this.cache.set(key, item);
            return {
                ...item,
                detail: undefined,
                documentation: undefined,
                data: {
                    ...asData(item.data),
                    rslCompletionKey: key
                }
            };
        });
        return {
            isIncomplete: items.length > selected.length,
            items: prepared
        };
    }

    resolve(item: CompletionItem): CompletionItem {
        const key = asData(item.data).rslCompletionKey;
        const full = key ? this.cache.get(key) : undefined;
        return full
            ? {
                ...full,
                data: item.data
            }
            : item;
    }
}

function asData(value: unknown): ICompletionData {
    return value && typeof value === "object"
        ? value as ICompletionData
        : {};
}

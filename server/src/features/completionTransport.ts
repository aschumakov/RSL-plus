import type {
    CompletionItem,
    CompletionList
} from "vscode-languageserver";

import { LruCache } from "../core/lruCache";

export interface ICompletionTransportOptions {
    /**
     * Предел на список, который возвращается помеченным неполным.
     *
     * Обычный список — переменные, параметры, члены объекта, имена файла и
     * подключённых модулей — отдаётся целиком: предел применяется только к
     * поиску по всему проекту, где число кандидатов ничем не ограничено.
     */
    searchLimit?: number;
    cacheEntries?: number;
}

export interface ICompletionPrepareOptions {
    /**
     * Список неполон: клиент обязан перезапросить его при дальнейшем вводе.
     *
     * По контракту CompletionList это значит именно повторный вызов провайдера
     * на каждую букву, а не «результатов больше, чем показано». Прежде флаг
     * ставился по превышению предела в 180 элементов, и обычный набор текста
     * заставлял сервер пересчитывать список заново — вместо того чтобы
     * редактор фильтровал уже полученный.
     */
    incomplete?: boolean;
    /** Ограничить число элементов; без него список отдаётся целиком. */
    limit?: number;
}

interface ICompletionData {
    rslCompletionKey?: string;
    [name: string]: unknown;
}

/**
 * Отдаёт список клиенту: облегчает элементы и переносит документацию в resolve.
 *
 * VS Code получает labels и порядок немедленно, тяжёлые поля — только для
 * выбранной строки списка.
 */
export class CompletionTransport {
    private readonly searchLimit: number;
    private readonly cache: LruCache<string, CompletionItem>;

    constructor(options: ICompletionTransportOptions = {}) {
        this.searchLimit = Math.max(1, options.searchLimit ?? 180);
        this.cache = new LruCache(
            Math.max(this.searchLimit, options.cacheEntries ?? 2000)
        );
    }

    /** Предел для поиска по проекту: обычный список его не использует. */
    get limitForSearch(): number {
        return this.searchLimit;
    }

    prepare(
        items: readonly CompletionItem[],
        options: ICompletionPrepareOptions = {}
    ): CompletionList {
        const limit = options.limit;
        const selected = limit === undefined
            ? items
            : items.slice(0, Math.max(1, limit));
        const prepared = selected.map(item => {
            /*
             * Разрешать нечего — элемент уходит как есть.
             *
             * У локальных переменных и параметров нет ни подписи, ни описания:
             * копировать их и писать в кэш resolve значит на каждый запрос
             * создавать тысячи объектов и столько же записей в кэш ради
             * ничего.
             */
            if (item.detail === undefined && item.documentation === undefined) {
                return item;
            }

            const key = resolveKey(item);
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
            isIncomplete: options.incomplete === true,
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

/**
 * Ключ элемента для resolve.
 *
 * Ключ выводится из самого символа, а не из счётчика запросов: с номером
 * `c1, c2, …` один и тот же член получал новый ключ на каждый запрос, кэш
 * заполнялся копиями, а элемент из прошлого списка перестал бы разрешаться.
 * Вид и detail входят в ключ потому, что одноимённые имена приходят из разных
 * модулей и различаются как раз ими.
 */
function resolveKey(item: CompletionItem): string {
    const detail = typeof item.detail === "string" ? item.detail : "";

    /* Разделитель, которого не бывает в имени: иначе ключи склеились бы. */
    return [
        String(item.label),
        String(item.kind ?? ""),
        detail.slice(0, 120)
    ].join("\u0000");
}

function asData(value: unknown): ICompletionData {
    return value && typeof value === "object"
        ? value as ICompletionData
        : {};
}

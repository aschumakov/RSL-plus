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
    /** Сколько списков держать разрешаемыми одновременно. */
    sessions?: number;
    /** Верхняя граница на число удерживаемых элементов. */
    maxItems?: number;
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
    /**
     * Кому принадлежит список.
     *
     * Разрешение документации ищется в пределах своего списка, а не в общем
     * кэше элементов: одноимённые кандидаты из разных модулей отличаются
     * происхождением, а список из тысяч элементов не должен вытеснять сам
     * себя, пока пользователь по нему идёт.
     */
    sessionId?: string;
}

interface ICompletionData {
    rslCompletionKey?: string;
    rslCompletionSession?: string;
    [name: string]: unknown;
}

/** Разрешаемые элементы одного списка. */
interface ICompletionResolveSession {
    id: string;
    items: Map<string, CompletionItem>;
}

/** Сколько списков остаются разрешаемыми: открытый и несколько прошлых. */
const DEFAULT_SESSIONS = 4;

/**
 * Верхняя граница удерживаемых элементов.
 *
 * Список из тысяч кандидатов удерживается целиком — иначе первый элемент
 * оказывается вытеснен к тому моменту, когда пользователь до него доберётся.
 * Граница нужна, чтобы несколько таких списков подряд не накапливались.
 */
const DEFAULT_MAX_ITEMS = 20000;

/**
 * Отдаёт список клиенту: облегчает элементы и переносит документацию в resolve.
 *
 * VS Code получает labels и порядок немедленно, тяжёлые поля — только для
 * выбранной строки списка.
 */
export class CompletionTransport {
    private readonly searchLimit: number;
    private readonly maxItems: number;
    private readonly sessions: LruCache<string, ICompletionResolveSession>;
    private heldItems = 0;
    private nextSessionNumber = 0;

    constructor(options: ICompletionTransportOptions = {}) {
        this.searchLimit = Math.max(1, options.searchLimit ?? 180);
        this.sessions = new LruCache(
            Math.max(1, options.sessions ?? DEFAULT_SESSIONS)
        );
        this.maxItems = Math.max(1, options.maxItems ?? DEFAULT_MAX_ITEMS);
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
        const sessionId = options.sessionId ??
            `list-${++this.nextSessionNumber}`;
        const session: ICompletionResolveSession = {
            id: sessionId,
            items: new Map()
        };
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

            const key = uniqueKey(session.items, resolveKey(item));
            session.items.set(key, item);

            return {
                ...item,
                detail: undefined,
                documentation: undefined,
                data: {
                    ...asData(item.data),
                    rslCompletionSession: sessionId,
                    rslCompletionKey: key
                }
            };
        });

        this.remember(session);

        return {
            isIncomplete: options.incomplete === true,
            items: prepared
        };
    }

    resolve(item: CompletionItem): CompletionItem {
        const data = asData(item.data);
        const session = data.rslCompletionSession
            ? this.sessions.get(data.rslCompletionSession)
            : undefined;
        const full = session && data.rslCompletionKey
            ? session.items.get(data.rslCompletionKey)
            : undefined;

        return full
            ? {
                ...full,
                data: item.data
            }
            : item;
    }

    /** Сколько элементов удерживается ради resolve: для тестов и профиля. */
    get retainedItems(): number {
        return this.heldItems;
    }

    private remember(session: ICompletionResolveSession): void {
        const previous = this.sessions.get(session.id);

        if (previous) {
            this.heldItems -= previous.items.size;
        }

        this.sessions.set(session.id, session);
        this.heldItems += session.items.size;
        this.evictWhileOverLimit(session.id);
    }

    /**
     * Освободить место: уходят самые давние списки, кроме текущего.
     *
     * Текущий список удерживается целиком даже если он один превышает границу:
     * иначе разрешение документации перестало бы работать ровно там, где
     * элементов много, — а это и есть случай, ради которого resolve нужен.
     */
    private evictWhileOverLimit(keep: string): void {
        while (this.heldItems > this.maxItems && this.sessions.size > 1) {
            const oldest = this.sessions.peekOldest();

            if (oldest === undefined || oldest === keep) {
                return;
            }

            const evicted = this.sessions.get(oldest);
            this.sessions.delete(oldest);
            this.heldItems -= evicted ? evicted.items.size : 0;
        }
    }
}

/**
 * Ключ элемента для resolve.
 *
 * Ключ выводится из происхождения символа, а не из счётчика запросов: с номером
 * `c1, c2, …` один и тот же член получал новый ключ на каждый запрос, кэш
 * заполнялся копиями, а элемент из прошлого списка перестал бы разрешаться.
 *
 * Имени, вида и подписи мало: два кандидата с одинаковыми label, kind и detail
 * приходят из разных модулей и получали один ключ — оба разрешались в описание
 * последнего. Поэтому в ключ входит и то, что различает их источник: файл и
 * идентификатор символа, если они известны.
 */
function resolveKey(item: CompletionItem): string {
    const data = asData(item.data);
    const detail = typeof item.detail === "string" ? item.detail : "";
    const uri = typeof data.uri === "string"
        ? data.uri
        : typeof data.rslAutoImportUri === "string"
            ? data.rslAutoImportUri
            : "";

    /* Разделитель, которого не бывает в тексте: иначе части склеились бы. */
    return [
        String(item.label),
        String(item.kind ?? ""),
        detail,
        uri,
        typeof data.symbolId === "string" ? data.symbolId : ""
    ].join("\u0000");
}

/**
 * Ключ, свободный в этом списке.
 *
 * Два элемента, совпадающие вплоть до происхождения, взаимозаменяемы: описание
 * у них одно и то же. Порядковый номер нужен только чтобы второй такой элемент
 * не затирал первый в карте разрешения.
 */
function uniqueKey(
    items: Map<string, CompletionItem>,
    key: string
): string {
    if (!items.has(key)) {
        return key;
    }

    let ordinal = 2;

    while (items.has(`${key}\u0000#${ordinal}`)) {
        ordinal++;
    }

    return `${key}\u0000#${ordinal}`;
}

function asData(value: unknown): ICompletionData {
    return value && typeof value === "object"
        ? value as ICompletionData
        : {};
}

import {
    CompletionItem,
    CompletionList,
    CompletionParams,
    Connection,
    CancellationToken
} from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

import { getDefaults } from "../defaults";
import { normalizeIdentifier, tokenAtOffset } from "../lexer";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";
import type { IRslFastClass } from "../scopeResolver";
import type { RslSymbol } from "../symbols/rslSymbol";
import {
    buildRslFastCompletions,
    buildRslFastMemberCompletions,
    buildRslFastOwnClassMembers,
    findReceiverBeforeDot
} from "./fastCompletionProvider";
import {
    findFastClass,
    getFastCompletionIndex,
    type IFastCompletionIndex
} from "./fastCompletionIndex";
import {
    getFastDocumentImports,
    type IFastDocumentSnapshot
} from "../services/fastDocumentSnapshot";
import { buildKnownAutoImportCompletions } from "./autoImportProvider";
import {
    buildRslContextCompletions,
    buildRslImportContextCompletions
} from "./contextCompletionProvider";
import {
    completionPrefixAt,
    rankCompletionItemsForPrefix
} from "./completionRanking";
import {
    collectRslCompletionCandidates,
    deduplicateCompletionItems,
    type IRslCompletionFacts
} from "./completionCandidates";
import { CompletionTransport } from "./completionTransport";
import {
    CompletionSessionCache,
    type ICompletionSessionKey
} from "./completionSession";
import type {
    IRslLanguageFeatureEnvironment
} from "./languageFeatureRegistry";
import {
    completionTrigger,
    errorText,
    isBlockedToken,
    requestIsStale
} from "./requestHelpers";

/**
 * Completion: сбор списка, сеанс открытого списка и разрешение элемента.
 *
 * Вынесен из общего реестра: это единственная возможность со своим
 * состоянием на версию документа — сеансом списка и разрешаемыми
 * элементами — и со своими правилами, общими для быстрого индекса и полной
 * модели. Среди двух десятков обработчиков реестра они терялись.
 */
export class RslCompletionProvider {
    private defaultCompletionItems = getDefaults().completionItems;
    private completionTransport = new CompletionTransport();
    private completionSessions = new CompletionSessionCache();

    constructor(
        private environment: IRslLanguageFeatureEnvironment,
        /** Модель ровно той версии, к которой относится запрос. */
        private getRequestModule: (
            document: TextDocument
        ) => IIndexedModule | undefined
    ) {}

    register(connection: Connection): void {
        const { documents, ensureDocumentParsed } = this.environment;

        connection.onCompletion(async (
            params: CompletionParams,
            cancellationToken: CancellationToken
        ) => {
            const document = documents.get(params.textDocument.uri);

            if (!document) {
                return { isIncomplete: false, items: [] };
            }

            this.environment.noteInteractiveActivity?.();
            const version = document.version;
            const offset = document.offsetAt(params.position);
            /*
             * Разбор Completion больше не назначает принудительно.
             *
             * Прежде Ctrl+Space и точка требовали разбор в режиме force, то
             * есть впереди очереди. Список при этом всё равно собирался из
             * быстрого индекса, а начатый разбор задерживал следующую клавишу.
             * Теперь источник Completion — быстрый индекс, а полный разбор
             * идёт обычной склейкой правок.
             */
            const span = this.environment.performance?.enabled
                ? this.environment.performance.start("completion", {
                    uri: document.uri,
                    version,
                    trigger: completionTrigger(params)
                })
                : undefined;
            const finish = <T>(
                result: T,
                fields: Record<string, string | number | boolean>
            ): T => {
                if (span) {
                    this.environment.performance!.end(span, fields);
                }
                return result;
            };
            const contextStarted = performance.now();
            const module = this.getRequestModule(document);

            if (!module) {
                ensureDocumentParsed(document, "scheduled").catch(error =>
                    this.environment.log(
                        `Completion: разбор не удался; ${errorText(error)}`
                    )
                );
            }

            if (requestIsStale(document, version, cancellationToken)) {
                return finish(
                    { isIncomplete: false, items: [] },
                    { cancelled: true, items: 0 }
                );
            }

            /*
             * Отсюда и до возврата поток занят непрерывно: именно это
             * пользователь видит как задержку следующей клавиши.
             */
            const blockingStarted = performance.now();
            const prepared = this.buildCompletionList(
                document,
                module,
                offset,
                contextStarted
            );

            return finish(prepared.list, {
                ...prepared.fields,
                blockingMs: performance.now() - blockingStarted,
                items: prepared.list.items.length
            });
        });

        connection.onCompletionResolve(item =>
            this.completionTransport.resolve(item)
        );
    }

    /** Текст изменился или файл закрыт: сеансы этой версии не годятся. */
    forget(uri: string): void {
        this.completionSessions.forget(uri);
    }

    /**
     * Экспортируемые имена уже прочитанных Import.
     *
     * Не зависят от модели текущего файла: модули из Import разобраны отдельно
     * и лежат в индексе. Поэтому в приблизительном ответе они законны — в
     * отличие от локальных областей видимости, которых без модели нет.
     */
    /**
     * Члены класса по имени, без полной модели.
     *
     * Класс ищется там, где он может быть виден без анализа: объявления самого
     * файла из быстрого снимка, затем прочитанные модули Import. Встроенные и
     * прикладные классы остаются полной модели — их разрешение зависит от
     * Import-контекста, а он здесь ещё не построен.
     */
    /**
     * Члены класса вместе с унаследованными, без полной модели.
     *
     * Цепочка обходится от производного к базовому, член производного
     * перекрывает одноимённый член базы. Каждый следующий уровень разрешает
     * resolver — он же делает это для полного пути, поэтому правила видимости
     * не раздваиваются: класс модуля workspace может наследовать класс своего
     * модуля, класс его Import, встроенный или прикладной, а класс прикладного
     * модуля — только в контексте своего владельца.
     */
    private findFastClassMembers(
        document: TextDocument,
        className: string,
        fastIndex: IFastCompletionIndex,
        offset: number
    ): CompletionItem[] | undefined {
        const items: CompletionItem[] = [];
        const taken = new Set<string>();
        /* Цикл узнаётся по самому классу, а не по имени: имена повторяются. */
        const visited = new Set<string>();
        const resolver = this.environment.resolver;
        let found = false;
        let wanted = className;

        /* Пока база объявлена в этом же файле, её даёт индекс версии. */
        for (;;) {
            const key = "local:" + normalizeIdentifier(wanted);

            if (visited.has(key)) {
                /*
                 * Локальный цикл: класс наследует сам себя или пару выше по
                 * цепочке. Иерархия на этом кончается, и продолжать её
                 * одноимённым классом из Import нельзя — полный resolver так
                 * тоже не делает.
                 */
                return items;
            }

            const own = findFastClass(fastIndex, wanted, offset);

            if (!own) {
                break;
            }

            visited.add(key);
            found = true;
            addUnique(
                items,
                taken,
                buildRslFastOwnClassMembers(fastIndex, wanted, offset) || []
            );

            if (!own.baseName) {
                return items;
            }
            wanted = own.baseName;
        }

        /*
         * Дальше цепочку ведёт resolver: он же ведёт её для полного пути, и
         * правила видимости не раздваиваются. Класс модуля workspace может
         * наследовать класс своего модуля, класс его Import, встроенный или
         * прикладной; класс прикладного модуля разрешает базу только через
         * своего владельца.
         */
        let current = resolver.findFastClass(
            document.uri,
            wanted,
            fastIndex.imports
        );

        while (current && !visited.has(fastClassKey(current))) {
            visited.add(fastClassKey(current));
            found = true;
            addUnique(items, taken, publicMembers(current.symbol));
            current = resolver.findFastBaseClass(
                current,
                current.symbol.baseClassName || "",
                fastIndex.imports
            );
        }

        return found ? items : undefined;
    }

    /**
     * Что сервер успел прочитать помимо самого документа.
     *
     * Import-замыкание файла и ревизия прикладного каталога. Обе величины
     * растут по мере фонового чтения, и пока они те же — новых сведений нет, а
     * значит и пересобирать открытый список не из чего.
     */
    private knowledgeRevision(uri: string): string {
        const { index, resolver } = this.environment;

        return index.getImportedClosureKey(uri) + " " + resolver.catalogRevision;
    }

    /**
     * Модули, видимые из документа по Import текущей версии текста, включая
     * транзитивные.
     *
     * Список Import берётся из быстрого снимка этой версии, а замыкание
     * достраивается по Import уже прочитанных модулей: в RSL подключение даёт
     * доступ ко всей рекурсивной цепочке. Прежний вариант брал готовый список
     * модели предыдущей версии и лишь фильтровал его по basename — из-за этого
     * только что добавленный Import не появлялся, транзитивные отбрасывались, а
     * Import с путём не совпадал с именем файла.
     */
    private importClosure(document: TextDocument): IIndexedModule[] {
        const { index } = this.environment;

        if (!index.areImportsEnabled) {
            return [];
        }

        const wanted = getFastDocumentImports(
            this.environment.getFastDocumentSnapshot(document)
        );
        const result: IIndexedModule[] = [];
        const seen = new Set<string>([document.uri]);
        const queue: string[] = [];

        for (const name of wanted) {
            const uri = resolvedUri(index.resolveWorkspaceFile(name));

            if (uri) {
                queue.push(uri);
            }
        }

        while (queue.length > 0) {
            const uri = queue.shift()!;

            if (seen.has(uri)) {
                continue;
            }
            seen.add(uri);

            const module = index.getModule(uri);

            if (!module) {
                continue;
            }

            result.push(module);

            /* Транзитивная цепочка: Import подключённого модуля тоже видны. */
            for (const name of module.imports) {
                const next = resolvedUri(index.resolveWorkspaceFile(name));

                if (next && !seen.has(next)) {
                    queue.push(next);
                }
            }
        }

        return result;
    }

    /**
     * Список Completion для одного состояния документа.
     *
     * Состав кандидатов не зависит от набранного префикса: префикс только
     * фильтрует и ранжирует. Поэтому набор запоминается сеансом, и повторный
     * запрос при том же состоянии не считает ничего заново — он лишь фильтрует
     * готовый набор.
     */
    private buildCompletionList(
        document: TextDocument,
        module: IIndexedModule | undefined,
        offset: number,
        contextStartedMs: number
    ): {
        list: CompletionList;
        fields: Record<string, string | number | boolean>;
    } {
        /*
         * Снимок берётся только когда модели нет: у готовой модели есть
         * и текст, и токены, а лишнее обращение к снимку — это шанс
         * пересобрать его на горячем пути.
         */
        const snapshot = module
            ? undefined
            : this.environment.getFastDocumentSnapshot(document);
        const source = module ? module.source : snapshot!.text;
        const tokens = module ? module.lex.tokens : snapshot!.lex.tokens;
        const prefix = completionPrefixAt(source, offset);
        const receiver = findReceiverBeforeDot(tokens, offset);
        const sessionSource = module ? "model" : "fast";
        const sessionKey: ICompletionSessionKey = {
            uri: document.uri,
            version: document.version,
            receiver: receiver ? receiver.name : "",
            wordStart: offset - prefix.length,
            knowledge: this.knowledgeRevision(document.uri)
        };
        const contextMs = performance.now() - contextStartedMs;
        const cached = this.completionSessions.get(sessionKey);

        if (cached) {
            return {
                list: this.completionTransport.prepare(
                    rankCompletionItemsForPrefix(cached.candidates, prefix),
                    { incomplete: cached.incomplete, sessionId: cached.key }
                ),
                fields: {
                    source: cached.source,
                    cacheHit: true,
                    incomplete: cached.incomplete,
                    candidates: cached.candidates.length,
                    requests: cached.requests,
                    contextMs
                }
            };
        }

        const collectStartedMs = performance.now();
        /*
         * Блокировка по лексике одна для обоих путей.
         *
         * Внутри строки, комментария и квадратного блока подсказок нет — это
         * не код. Раньше проверка делалась только по готовой модели, и до её
         * готовности быстрый путь предлагал имена посреди комментария, а потом
         * список молча становился пустым.
         */
        const blocked = isBlockedToken(tokenAtOffset(tokens, offset, true));

        if (blocked) {
            return {
                list: { isIncomplete: false, items: [] },
                fields: { blocked: true, items: 0, contextMs }
            };
        }

        const collected = collectRslCompletionCandidates(
            module
                ? this.modelFacts(
                    document,
                    module,
                    offset,
                    prefix,
                    sessionKey.receiver
                )
                : this.fastFacts(document, snapshot!, offset)
        );

        const session = this.completionSessions.set(
            sessionKey,
            collected.candidates,
            collected.incomplete,
            sessionSource
        );

        return {
            list: this.completionTransport.prepare(
                rankCompletionItemsForPrefix(session.candidates, prefix),
                { incomplete: session.incomplete, sessionId: session.key }
            ),
            fields: {
                source: collected.source,
                cacheHit: false,
                incomplete: session.incomplete,
                candidates: session.candidates.length,
                requests: session.requests,
                contextMs,
                collectMs: performance.now() - collectStartedMs
            }
        };
    }

    /**
     * Факты готовой модели.
     *
     * Метод отвечает только на вопрос «что известно об этой точке». Что из
     * этого показать — решают общие правила в collectRslCompletionCandidates,
     * одни и те же для модели и для быстрого индекса.
     */
    private modelFacts(
        document: TextDocument,
        module: IIndexedModule,
        offset: number,
        prefix: string,
        receiver: string
    ): IRslCompletionFacts {
        const { index, resolver } = this.environment;
        const names = (): readonly CompletionItem[] => module.symbolTree
            ? resolver.getCompletions(document.uri, module.symbolTree, offset)
            : [];

        return {
            name: "model",
            contextCandidates: () => buildRslContextCompletions(
                module,
                index,
                offset,
                resolver
            ),
            /*
             * Модель разрешает получателя сама: в позиции после точки её
             * getCompletions возвращает именно члены. Признак обращения нужен,
             * чтобы к ним не добавились общие имена.
             */
            memberCandidates: () => receiver ? names() : undefined,
            visibleCandidates: names,
            ambientCandidates: () => deduplicateCompletionItems(
                this.defaultCompletionItems,
                this.knownImportCompletions(document)
            ),
            searchCandidates: () => this.workspaceSearchCandidates(
                document,
                module,
                prefix
            )
        };
    }

    /** Факты компактного индекса версии: модель этой версии ещё считается. */
    private fastFacts(
        document: TextDocument,
        snapshot: IFastDocumentSnapshot,
        offset: number
    ): IRslCompletionFacts {
        const fastIndex = getFastCompletionIndex(snapshot);

        return {
            name: "fast",
            /*
             * Имя модуля в Import считается по токенам, поэтому доступно и до
             * готовности модели: иначе в `Import ` предлагались бы обычные
             * имена области видимости. Путь в строке остаётся за моделью —
             * внутри строки подсказок и так нет (см. isBlockedToken).
             */
            contextCandidates: () => buildRslImportContextCompletions(
                { uri: document.uri, source: snapshot.text },
                snapshot.lex.tokens,
                this.environment.index,
                offset
            ),
            memberCandidates: () => buildRslFastMemberCompletions(
                snapshot,
                offset,
                name => this.findFastClassMembers(
                    document,
                    name,
                    fastIndex,
                    offset
                ),
                fastIndex
            ),
            visibleCandidates: () => buildRslFastCompletions(
                snapshot,
                offset,
                fastIndex
            ),
            ambientCandidates: () => deduplicateCompletionItems(
                this.defaultCompletionItems,
                this.knownImportCompletions(document)
            ),
            /*
             * Поиск по проекту требует модели файла: правка Import считается по
             * ней. До её готовности предлагается то, что уже известно.
             */
            searchCandidates: () => ({ items: [], truncated: false })
        };
    }

    /**
     * Поиск по всему проекту — отдельно от обычного списка.
     *
     * Обычные кандидаты — имена файла, области, встроенные и символы
     * подключённых модулей — известны заранее и отдаются целиком. Auto Import
     * ищет среди неподключённых символов проекта, и их число ничем не
     * ограничено: такой поиск ведётся только по осмысленному префиксу и
     * ограничен по числу, а ограничение честно помечает список неполным.
     */
    private workspaceSearchCandidates(
        document: TextDocument,
        module: IIndexedModule,
        prefix: string
    ): { items: readonly CompletionItem[]; truncated: boolean } {
        const settings = this.environment.getSettings(document.uri);

        if (!settings.autoImport.enabled || prefix.length < 2) {
            return { items: [], truncated: false };
        }

        /*
 * Предел передаётся внутрь: правка Import строится только для тех
 * кандидатов, что попали в список.
         */
        return buildKnownAutoImportCompletions(
            module,
            this.environment.index,
            prefix,
            this.completionTransport.limitForSearch
        );
    }

    private knownImportCompletions(document: TextDocument): CompletionItem[] {
        const { index } = this.environment;

        if (!index.areImportsEnabled) {
            return [];
        }

        const items: CompletionItem[] = [];

        for (const imported of this.importClosure(document)) {
            const from = imported.uri.replace(/^.*[/\\]/, "");

            for (const symbol of imported.symbolTree.children) {
                if (symbol.visibility === "private") {
                    continue;
                }

                items.push({
                    label: symbol.name,
                    kind: symbol.kind,
                    detail: from
                });
            }
        }

        return items;
    }
}


/**
 * Список открыт действием пользователя, а не набором текста.
 *
 * Ctrl+Space и trigger-символ означают, что он ждёт подсказку сейчас. Отсутствие
 * context — старый клиент; там безопаснее считать запрос явным, иначе подсказка
 * молчала бы до конца склейки правок.
 */
/** Ключ класса для защиты от цикла: источник плюс сам символ. */
function fastClassKey(value: IRslFastClass): string {
    return (value.moduleUri || value.owner?.moduleKey || "builtin") +
        "#" + value.symbol.id;
}

/** Открытые члены символа класса: приватные чужого модуля недоступны. */
function publicMembers(symbol: RslSymbol): CompletionItem[] {
    return symbol.children
        .filter(member => member.visibility !== "private")
        .map(member => ({
            label: member.name,
            kind: member.kind,
            detail: member.typeName || undefined
        }));
}

/** Добавляет члены, не перекрывая уже добавленные производным классом. */
function addUnique(
    items: CompletionItem[],
    taken: Set<string>,
    members: readonly CompletionItem[]
): void {
    for (const member of members) {
        const key = normalizeIdentifier(member.label);

        if (!taken.has(key)) {
            taken.add(key);
            items.push(member);
        }
    }
}

/** URI из разрешения имени модуля; неоднозначное и отсутствующее пропускаем. */
function resolvedUri(
    resolution: ReturnType<WorkspaceIndex["resolveWorkspaceFile"]>
): string | undefined {
    return resolution.kind === "resolved" ? resolution.value : undefined;
}

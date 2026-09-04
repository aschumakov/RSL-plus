import { findRslChainDot } from "../analysis/accessChain";
import {
    getRslMemberSet,
    rslMemberSetCompletions
} from "../analysis/memberSet";
import {
    RSL_NOT_MEMBER_ACCESS,
    RSL_UNRESOLVED_MEMBER_ACCESS,
    type IRslMemberCompletionState
} from "./completionCandidates";
import {
    collectRslImportClosure
} from "../indexing/importClosure";
import {
    CompletionItem,
    CompletionList,
    CompletionParams,
    Connection,
    CancellationToken
} from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

import { getDefaults } from "../defaults";
import { tokenAtOffset } from "../lexer";
import type { IIndexedModule } from "../workspaceIndex";
import {
    buildRslFastCompletions,
    buildRslFastMemberCompletions,
    findReceiverBeforeDot
} from "./fastCompletionProvider";
import {
    getFastCompletionIndex,
    type IFastCompletionIndex
} from "./fastCompletionIndex";
import { collectRslClassMembers } from "./fastClassChain";
import {
    getFastDocumentImports,
    type IFastDocumentSnapshot
} from "../services/fastDocumentSnapshot";
import {
    buildKnownAutoImportCompletions,
    resolveAutoImportEdit
} from "./autoImportProvider";
import {
    buildRslContextCompletions,
    buildRslImportContextCompletions
} from "./contextCompletionProvider";
import { RslTypeEngine } from "../analysis/typeEngine";
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
    completionSessionKey,
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
/**
 * От чего зависит то, что подсказка знает О ДРУГИХ ФАЙЛАХ.
 *
 * Своего документа здесь нет вовсе — ни текста, ни написанных в нём Import.
 * И то и другое входит в ключ сессии отдельной составляющей: его версией.
 * Взять их и здесь значило бы, что готовность модели меняет ключ — модели ещё
 * нет, и написанные Import индексу неизвестны, — а уже открытый список от
 * готовности модели меняться не вправе: пользователь видел бы, как состав и
 * порядок прыгают под курсором.
 *
 * По той же причине здесь нет ни состава проекта, ни ревизии его каталога.
 * Достройка каталога идёт всё время, пока пользователь набирает текст, и она
 * обязана попасть в СЛЕДУЮЩИЙ сеанс подсказки, а не переписать открытый.
 */
const COMPLETION_KNOWLEDGE_DEPENDS = {
    closure: true,
    platform: true
} as const;

export class RslCompletionProvider {
    private defaultCompletionItems = getDefaults().completionItems;
    private completionTransport = new CompletionTransport();
    private completionSessions = new CompletionSessionCache();
    /**
     * Слой типов: заводится один раз и ничего не считает заранее.
     *
     * Ответы он запоминает на объект модуля, поэтому общий экземпляр
     * устаревших данных не отдаёт.
     */
    private typeEngineValue: RslTypeEngine | undefined;

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
            this.resolveItem(item)
        );
    }

    /**
     * Выбранная строка списка: описание и, для Auto Import, правка Import.
     *
     * Правка строится здесь, а не при сборке списка: пользователь выбирает из
     * списка одну строку, а построение правки проходит по объявлениям Import
     * файла и разрешает имя модуля.
     */
    private resolveItem(item: CompletionItem): CompletionItem {
        const resolved = this.completionTransport.resolve(item);
        const data = resolved.data && typeof resolved.data === "object"
            ? resolved.data as Record<string, unknown>
            : {};
        const targetUri = typeof data.rslAutoImportUri === "string"
            ? data.rslAutoImportUri
            : undefined;
        const fromUri = typeof data.rslAutoImportFrom === "string"
            ? data.rslAutoImportFrom
            : undefined;

        if (!targetUri || !fromUri || resolved.additionalTextEdits) {
            return resolved;
        }

        const document = this.environment.documents.get(fromUri);
        const module = document
            ? this.getRequestModule(document) ||
                this.environment.index.getModule(fromUri)
            : this.environment.index.getModule(fromUri);

        if (!module) {
            return resolved;
        }

        const edit = resolveAutoImportEdit(
            module,
            this.environment.index,
            targetUri
        );

        return edit
            ? { ...resolved, additionalTextEdits: [edit] }
            : resolved;
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
        /*
         * Обход иерархии общий с переходом, Hover и подсказкой параметров:
         * правила видимости и защита от цикла обязаны совпадать. Раньше
         * каждый обходил цепочку сам, и они расходились.
         */
        return collectRslClassMembers(className, {
            resolver: this.environment.resolver,
            uri: document.uri,
            imports: fastIndex.imports,
            fastIndex,
            offset
        });
    }

    /**
     * Что сервер успел прочитать помимо самого документа.
     *
     * Import-замыкание файла и ревизия прикладного каталога. Обе величины
     * растут по мере фонового чтения, и пока они те же — новых сведений нет, а
     * значит и пересобирать открытый список не из чего.
     */
    /**
     * Состав класса, к которому привела цепочка обращений.
     *
     * Своего разбора звеньев здесь нет: тип получателя даёт слой типов, а
     * состав — тот же общий набор, которым отвечают Hover, переход и
     * проверка состава. Пусто — значит тип пока неизвестен, и после точки
     * не показывается ничего.
     */
    private chainMembers(
        uri: string,
        offset: number
    ): CompletionItem[] | undefined {
        const engine = this.typeEngine();
        const type = engine.resolveReceiverType(uri, offset);

        if (type.kind !== "class") {
            return undefined;
        }

        const options = engine.memberOptions(uri, offset);
        const set = getRslMemberSet(type.name, options);

        if (!set.resolved) {
            return undefined;
        }

        const members = rslMemberSetCompletions(set, options);

        return members.length > 0 ? members : undefined;
    }

    private typeEngine(): RslTypeEngine {
        if (!this.typeEngineValue) {
            this.typeEngineValue = new RslTypeEngine(
                this.environment.index,
                this.environment.resolver
            );
        }

        return this.typeEngineValue;
    }

    /**
     * Что сервер знает об окружении документа — одной строкой.
     *
     * Набор состояний объявлен, а не собран здесь по месту: подсказка
     * зависит от интерфейсов замыкания, состава проекта и каталога
     * платформы, но НЕ от собственного текста документа — его она
     * перечитывает всякий раз заново.
     */
    private knowledgeRevision(uri: string): string {
        return this.environment.resolver.captureSemanticStamp(
            uri,
            COMPLETION_KNOWLEDGE_DEPENDS
        ).key;
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
        /*
         * Обход общий: см. collectRslImportClosure.
         *
         * Import берутся из текста текущей версии, а не из модели — она на
         * быстром пути отстаёт. Для этого и существует seedImports.
         */
        return collectRslImportClosure(index, document.uri, {
            seedImports: wanted
        }).modules;
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
        /*
         * Ожидаемый тип — только там, где есть полная модель.
         *
         * Быстрый путь работает по снимку без резолвера, и ждать модель
         * ради порядка списка нельзя: подсказка обязана ответить сразу.
         * Без типа порядок остаётся прежним.
         */
        const expectedType = module
            ? this.typeEngine().expectedTypeAt(document.uri, offset)
            : "";
        const contextMs = performance.now() - contextStartedMs;
        const cached = this.completionSessions.get(sessionKey);

        if (cached) {
            return {
                list: this.completionTransport.prepare(
                    rankCompletionItemsForPrefix(
                        cached.candidates,
                        prefix,
                        { expectedType }
                    ),
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
         * Блокировка по лексике одна для обоих путей, но она НЕ первая:
         * сначала спрашивается контекстный список. Внутри строки подсказки
         * бывают — имя процедуры в `ExecMacro("…")`, имя файла в
         * `ExecMacroFile("…")`, — и проверка, стоявшая раньше контекста, их
         * отключала. См. collectRslCompletionCandidates.
         */
        const blocked = isBlockedToken(tokenAtOffset(tokens, offset, true));
        const collected = collectRslCompletionCandidates(
            module
                ? this.modelFacts(
                    document,
                    module,
                    offset,
                    prefix,
                    sessionKey.receiver,
                    blocked
                )
                : this.fastFacts(document, snapshot!, offset, blocked)
        );

        /*
         * Приблизительный ответ сеансом не запоминается.
         *
         * Внутри строки контекстный список умеет строить только модель: ему
         * нужны объявления самого файла. Запомнить пустой ответ значило бы
         * оставить список пустым и после того, как модель достроится, — до
         * следующей правки текста.
         */
        const session = collected.provisional
            ? undefined
            : this.completionSessions.set(
                sessionKey,
                collected.candidates,
                collected.incomplete,
                sessionSource
            );
        const candidates = session ? session.candidates : collected.candidates;
        const incomplete = session ? session.incomplete : collected.incomplete;

        return {
            list: this.completionTransport.prepare(
                rankCompletionItemsForPrefix(candidates, prefix, { expectedType }),
                {
                    incomplete,
                    sessionId: session
                        ? session.key
                        : completionSessionKey(sessionKey) + " предварительный"
                }
            ),
            fields: {
                source: collected.source,
                cacheHit: false,
                blocked,
                provisional: collected.provisional,
                incomplete,
                candidates: candidates.length,
                requests: session ? session.requests : 1,
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
        receiver: string,
        blocked: boolean
    ): IRslCompletionFacts {
        const { index, resolver } = this.environment;
        const names = (): readonly CompletionItem[] => module.symbolTree
            ? resolver.getCompletions(document.uri, module.symbolTree, offset)
            : [];

        return {
            name: "model",
            /* Модель знает и объявления файла: контекст ей доступен весь. */
            blockedPosition: () => blocked,
            contextCandidates: () => buildRslContextCompletions(
                module,
                index,
                offset,
                resolver
            ),
            /*
             * Модель разрешает получателя сама: в позиции после точки её
             * getCompletions возвращает именно члены и ничего кроме них.
             *
             * Пустой ответ при найденном получателе — это «тип пока не
             * определён», а не «членов нет»: замыкание Import ещё
             * дочитывается, и спросить стоит заново. Общих имён здесь не
             * появляется ни в том, ни в другом случае.
             */
            memberCandidates: (): IRslMemberCompletionState => {
                const dot = findRslChainDot(module.syntax.tokens, offset);

                if (!receiver && dot < 0) {
                    return RSL_NOT_MEMBER_ACCESS;
                }

                const items = names();

                if (items.length > 0) {
                    return { kind: "resolved-members", items };
                }

                /*
                 * Резолвер простого получателя не нашёл — значит слева
                 * цепочка. Её тип знает слой типов, а состав по типу даёт
                 * тот же общий набор, что видят Hover и переход.
                 */
                const chained = this.chainMembers(document.uri, offset);

                return chained
                    ? { kind: "resolved-members", items: chained }
                    : RSL_UNRESOLVED_MEMBER_ACCESS;
            },
            visibleCandidates: names,
            /*
             * Только встроенные значения: импортированные приходят из resolver.
             *
             * getCompletions уже добавляет getImportedCompletionItems, а
             * visibleCandidates идёт первым — значит одноимённые элементы
             * второго сбора всё равно отбрасывались дедупликацией. Работа при
             * этом делалась полностью: второй обход цепочки Import, второй
             * проход по публичным символам каждого модуля и создание элементов,
             * которые тут же выбрасывались.
             *
             * Быстрому пути этот сбор по-прежнему нужен: там полной модели
             * текущей версии ещё нет, и брать импортированные символы неоткуда.
             */
            ambientCandidates: () => this.defaultCompletionItems,
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
        offset: number,
        blocked: boolean
    ): IRslCompletionFacts {
        const fastIndex = getFastCompletionIndex(snapshot);

        return {
            name: "fast",
            blockedPosition: () => blocked,
            /*
             * Внутри строки контекстный список этому источнику не построить:
             * имена процедур для `ExecMacro` берутся из объявлений файла, а их
             * даёт модель. Поэтому пустой ответ здесь помечается
             * приблизительным и не запоминается сеансом.
             */
            blockedNeedsModel: true,
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


/** URI из разрешения имени модуля; неоднозначное и отсутствующее пропускаем. */

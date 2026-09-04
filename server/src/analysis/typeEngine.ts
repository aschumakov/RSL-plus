import { CompletionItemKind } from "vscode-languageserver";

import { canonicalTypeName } from "../language/rslLanguageReference";
import {
    extractParameterLabels,
    findRslCallContext
} from "../features/signatureHelpProvider";
import type { IIndexedModule, IIndexedSymbol } from "../workspaceIndex";
import { normalizeIdentifier, type IRslToken } from "../lexer";
import type { RslScopeResolver } from "../scopeResolver";
import {
    sameRslHotStamp,
    type IRslHotStamp
} from "./semanticState";
import type { RslSymbol } from "../symbols/rslSymbol";
import type { WorkspaceIndex } from "../workspaceIndex";
import {
    findRslChainDot,
    readRslAccessChain,
    type IRslAccessSegment
} from "./accessChain";
import {
    findRslMemberSetMember,
    getRslMemberSet,
    type IRslMemberSet,
    type IRslMemberSetOptions
} from "./memberSet";
import {
    isRslClassType,
    rslTypeFromName,
    rslUnknownType,
    type IRslResolvedType
} from "./resolvedType";

/**
 * Семантика выражений: типы отдельно от разрешения имён.
 *
 * Resolver отвечает на вопрос «какой символ здесь имеется в виду» — области
 * видимости, Import, наследование. Всё, что про ТИПЫ, накапливалось там же и
 * растворялось среди правил видимости. Здесь оно собрано отдельно и работает
 * поверх resolver, а не вместо него.
 *
 * Слой ленивый по устройству. Он ничего не считает заранее, не запускает
 * анализ проекта и не держит второй копии дерева или текста: всё берётся у
 * индекса и resolver в момент вопроса. Ответы запоминаются на текущую версию
 * документа и выбрасываются вместе с ней.
 *
 * Чего он НЕ делает — не задерживает интерактивные ответы. Подсказка, которой
 * тип ещё не известен, обязана ответить без него: см. rankByExpectedType.
 */
export interface IRslCallTargetInfo {
    uri: string;
    symbol: RslSymbol;
    /** Номер аргумента под курсором, если вопрос был про место в вызове. */
    argumentIndex?: number;
}

export class RslTypeEngine {
    /**
     * Ответы на текущее состояние документа И его окружения.
     *
     * Объекта модуля мало. Он меняется вместе с текстом самого файла, и
     * этого достаточно, пока речь о своих объявлениях. Но тип аргумента
     * берётся из ПОДКЛЮЧЁННОГО модуля: правка подписи в lib.mac не
     * трогает main.mac, объект его модели остаётся тем же — и ответ
     * отдавался бы прежний, уже неверный.
     *
     * Поэтому рядом лежит ревизия окружения документа. Она меняется
     * ровно тогда, когда изменилось то, от чего зависит разрешение имён
     * в этом файле, и не меняется от чужого модуля: сброс идёт по
     * обратным рёбрам Import-графа — см. getSemanticRevision. Весь слой
     * из-за правки в постороннем файле не обнуляется.
     */
    private readonly byModule = new WeakMap<
        IIndexedModule,
        { stamp: IRslHotStamp; values: Map<string, string> }
    >();

    /**
     * Попадания, промахи и сбросы.
     *
     * Нужны стенду отменённой работы. Разницу здесь видно не
     * секундомером, а тем, сколько ответов НЕ пришлось считать заново:
     * правка тела импортированного модуля обязана давать ноль сбросов.
     */
    private hitCount = 0;
    private missCount = 0;
    private resetCount = 0;

    constructor(
        private readonly index: WorkspaceIndex,
        private readonly resolver: RslScopeResolver
    ) {}

    /** Счётчики запомненных ответов; для стендов и лога. */
    get cacheCounters(): {
        hits: number;
        misses: number;
        resets: number;
    } {
        return {
            hits: this.hitCount,
            misses: this.missCount,
            resets: this.resetCount
        };
    }

    /**
     * Тип объявления.
     *
     * У переменной это записанный или выведенный тип, у процедуры — тип
     * результата. Приводится к каноническому виду, чтобы `STRING` и `String`
     * не считались разными.
     */
    typeOfSymbol(symbol: RslSymbol | undefined): string {
        if (!symbol) {
            return "";
        }

        if (isCallableKind(symbol.kind)) {
            return canonicalTypeName(symbol.typeName || "");
        }

        if (symbol.kind === CompletionItemKind.Class) {
            /* Имя класса — это и есть тип его экземпляров. */
            return canonicalTypeName(symbol.name);
        }

        return canonicalTypeName(symbol.typeName || "");
    }

    /**
     * Тип символа, на котором стоит курсор.
     *
     * Сначала ОБЪЯВЛЕННЫЙ тип: по руководству декларация — это приведение,
     * и присваивание её не меняет. `Var sql: String` держит строку, чем бы
     * её потом ни присваивали.
     *
     * Если декларации нет — переменная эквивалентна Variant, и тип задаёт
     * присваивание. Выводить его умеет resolver: с учётом достижимости, с
     * типом результата вызова, вызова члена и голого класса справа. Умел он
     * это для одного потребителя — разрешения члена получателя, — а здесь
     * отдавался только объявленный тип. Из-за этого подсказка после
     * присваивания, Hover и подсказка параметров не знали типа переменной,
     * который переход к определению в том же месте показывал.
     *
     * На 400 настоящих файлах объявленного типа не хватало у трёх четвертей
     * получателей, и почти треть таких случаев — именно присваивание из
     * вызова, вызова члена или другого имени: см. audit-type-coverage.
     */
    typeOfSymbolAt(uri: string, offset: number): string {
        return this.cached(uri, "symbol:" + offset, () => {
            const module = this.index.getModule(uri);

            if (!module) {
                return "";
            }

            const resolved = this.resolver.resolveAt(
                uri,
                module.symbolTree,
                offset
            );
            /*
             * Объявленный ответ считается как прежде: у процедуры это тип
             * результата, у класса — он сам, и присваивания к ним отношения
             * не имеют.
             */
            const declared = this.typeOfSymbol(resolved?.symbol);

            if (declared && declared !== "variant") {
                return declared;
            }

            /*
             * Декларации нет — значит Variant, и тип задаёт присваивание.
             *
             * Тот же расчёт, что у подсказки и у обращения к членам:
             * объявленный тип сильнее присваивания, а из присваиваний берётся
             * только достижимое и только подтверждённое — имя неразрешённого
             * вызова типом не считается.
             *
             * Спрашивается ПО ТОЧКЕ, а не по символу: в RSL переменная
             * возникает и просто от присваивания, и такого имени в дереве
             * символов нет вовсе.
             */
            const inferred = canonicalTypeName(
                this.resolver.effectiveTypeNameAt(
                    uri,
                    module.symbolTree,
                    offset
                )
            );

            /*
             * Вывод ничего не добавил — остаётся прежний ответ. Он бывает
             * `variant`, и это не то же самое, что пусто: пусто значит «имени
             * здесь нет вовсе».
             */
            return inferred === "variant" ? declared : inferred || declared;
        });
    }

    /**
     * Тип выражения.
     *
     * Пока распознаётся то, что распознаётся дёшево и без догадок: имя,
     * обращение к члену и вызов. Всё остальное — пусто, и это честный ответ:
     * «не знаю» лучше выдуманного типа.
     */
    typeOfExpression(uri: string, start: number, end: number): string {
        return this.cached(uri, "expr:" + start + ":" + end, () => {
            const module = this.index.getModule(uri);

            if (!module) {
                return "";
            }

            const tokens = significantTokensWithin(module, start, end);

            if (tokens.length === 0) {
                return "";
            }

            /* Вызов: тип — это тип результата вызываемого. */
            const last = tokens[tokens.length - 1];

            if (last.kind === "symbol" && last.raw === ")") {
                const call = this.resolveCall(uri, last.start);

                return call ? this.typeOfSymbol(call.symbol) : "";
            }

            return this.typeOfSymbolAt(uri, tokens[tokens.length - 1].start);
        });
    }

    /**
     * Какое объявление вызывается в этом месте.
     *
     * Место может быть и внутри списка аргументов: тогда возвращается ещё и
     * номер аргумента, на котором стоит курсор.
     */
    resolveCall(uri: string, offset: number): IRslCallTargetInfo | undefined {
        const module = this.index.getModule(uri);

        if (!module) {
            return undefined;
        }

        const context = findRslCallContext(module.syntax.tokens, offset);

        if (!context) {
            return undefined;
        }

        const resolved = this.resolver.resolveAt(
            uri,
            module.symbolTree,
            context.callee.start
        );

        if (!resolved || !isCallableKind(resolved.symbol.kind)) {
            return undefined;
        }

        return {
            uri: resolved.uri,
            symbol: resolved.symbol,
            argumentIndex: context.activeParameter
        };
    }

    /** Тип результата вызова в этом месте. */
    returnTypeOfCall(uri: string, offset: number): string {
        const call = this.resolveCall(uri, offset);

        return call ? this.typeOfSymbol(call.symbol) : "";
    }

    /** Член получателя: делегируется resolver, где живёт наследование. */
    resolveMember(
        uri: string,
        receiverOffset: number,
        memberName: string
    ): IIndexedSymbol | undefined {
        const module = this.index.getModule(uri);

        if (!module) {
            return undefined;
        }

        return this.resolver.resolveMemberReference(
            uri,
            module.symbolTree,
            receiverOffset,
            memberName
        );
    }

    /**
     * Какой тип здесь уместен.
     *
     * Два случая, оба дешёвые и оба без догадок: справа от присваивания
     * переменной с известным типом и на месте аргумента вызова, у параметра
     * которого тип написан. Всё прочее — пусто.
     */
    expectedTypeAt(uri: string, offset: number): string {
        return this.cached(uri, "expected:" + offset, () => {
            const module = this.index.getModule(uri);

            if (!module) {
                return "";
            }

            const call = this.resolveCall(uri, offset);

            if (call && call.argumentIndex !== undefined) {
                const written = parameterTypeAt(
                    call.symbol,
                    call.argumentIndex
                );

                if (written) {
                    return written;
                }
            }

            return this.assignmentTargetType(module, offset);
        });
    }

    /**
     * Тип переменной слева от присваивания, если курсор справа от него.
     *
     * Тип берётся выведенный, а не только объявленный. Ранжирование по нему
     * не проверка типов, а догадка о том, чего хочет пользователь: если
     * переменной уже присваивали TBFile, кандидаты, дающие TBFile, уместно
     * показать первыми. Ничего допустимого это не прячет — совпадение по типу
     * ПОДНИМАЕТ кандидата, а не отбрасывает остальных (см. typeRank).
     */
    /**
     * Тип символа в этой позиции — значением, а не строкой.
     *
     * Строка несла одно сведение, имя; всё прочее каждый потребитель
     * добывал сам и приходил к разным выводам. См. IRslResolvedType.
     */
    resolveTypeAt(uri: string, offset: number): IRslResolvedType {
        return this.withSource(
            uri,
            this.typed(this.typeOfSymbolAt(uri, offset)),
            offset
        );
    }

    /** Тип выражения в этих границах — значением. */
    resolveExpressionType(
        uri: string,
        start: number,
        end: number
    ): IRslResolvedType {
        return this.typed(this.typeOfExpression(uri, start, end));
    }

    /**
     * Тип получателя перед точкой, включая цепочки.
     *
     * `command.Execute().MoveNext` разбирается по звеньям слева
     * направо: тип первого даёт разрешение имени, тип каждого
     * следующего — член предыдущего класса. Считается по требованию и
     * только вокруг позиции: полной проверки типов файла здесь нет.
     */
    resolveReceiverType(
        uri: string,
        offset: number
    ): IRslResolvedType {
        return this.cachedType(uri, "receiver:" + offset, () => {
            const module = this.index.getModule(uri);

            if (!module) {
                return rslUnknownType();
            }

            const tokens = module.syntax.tokens;
            const dot = findRslChainDot(tokens, offset);

            if (dot < 0) {
                return rslUnknownType();
            }

            const chain = readRslAccessChain(tokens, dot);

            return chain.length === 0
                ? rslUnknownType()
                : this.typeOfChain(uri, chain);
        });
    }

    /**
     * Состав класса вместе с полнотой — один ответ на всех.
     *
     * Тот же набор, что видят подсказка, переход, Hover и проверка
     * «такого члена нет»: разным его видеть нельзя.
     */
    getMemberSet(
        uri: string,
        className: string,
        offset: number
    ): IRslMemberSet {
        return getRslMemberSet(className, this.memberOptions(uri, offset));
    }

    /** Класс, который представляет этот тип; пусто у не-классов. */
    resolveClass(
        uri: string,
        value: IRslResolvedType,
        offset: number
    ): IRslMemberSet | undefined {
        return isRslClassType(value)
            ? this.getMemberSet(uri, value.name, offset)
            : undefined;
    }

    /** Настройки обхода состава: собираются здесь, а не у каждого. */
    memberOptions(uri: string, offset: number): IRslMemberSetOptions {
        const module = this.index.getModule(uri);

        return {
            resolver: this.resolver,
            uri,
            imports: module?.imports || [],
            offset,
            platformMembersComplete: key =>
                this.resolver.platformModuleCatalog
                    ?.membersComplete(key) === true,
            isLibraryUri: item => this.index.isLibraryFile(item),
            ownClass: className => {
                if (!module) {
                    return undefined;
                }

                const found = this.resolver.resolveTypeName(
                    uri,
                    module.symbolTree,
                    className
                );

                return found && found.uri === uri
                    ? { symbol: found.symbol, moduleUri: uri }
                    : undefined;
            }
        };
    }

    /**
     * Тип цепочки: звено за звеном слева направо.
     *
     * Первое звено разрешается как обычное имя, каждое следующее — как
     * член класса предыдущего. Как только тип перестал быть классом,
     * дальше идти некуда: у примитива и у variant членов нет.
     */
    private typeOfChain(
        uri: string,
        chain: readonly IRslAccessSegment[]
    ): IRslResolvedType {
        let current = chain[0].call
            ? this.typed(this.returnTypeOfCall(
                uri,
                chain[0].insideCall ?? chain[0].start
            ))
            : this.resolveTypeAt(uri, chain[0].start);

        for (let at = 1; at < chain.length; at++) {
            if (!isRslClassType(current)) {
                return current.kind === "unknown"
                    ? rslUnknownType()
                    : current;
            }

            const segment = chain[at];
            const options = this.memberOptions(uri, segment.start);
            const set = getRslMemberSet(current.name, options);
            const member = findRslMemberSetMember(
                set,
                segment.name,
                options
            );

            if (!member) {
                return rslUnknownType();
            }

            current = this.typed(member.typeName);
        }

        return this.withSource(
            uri,
            current,
            chain[chain.length - 1].start
        );
    }

    /**
     * Проставить источник класса.
     *
     * Имя типа источника не несёт: одно и то же `TStream` бывает и
     * встроенным, и объявленным рядом. Отвечает на это состав — он же
     * отвечает и всем остальным, так что второго мнения не возникает.
     */
    private withSource(
        uri: string,
        value: IRslResolvedType,
        offset: number
    ): IRslResolvedType {
        if (!isRslClassType(value)) {
            return value;
        }

        const set = this.getMemberSet(uri, value.name, offset);

        return set.resolved
            ? { ...value, source: set.source }
            : value;
    }

    /** Строка типа — в значение; единственное место такого перевода. */
    private typed(name: string): IRslResolvedType {
        return rslTypeFromName(canonicalTypeName(name) || name);
    }

    /**
     * Тот же кэш, что и у остальных ответов: по семантическому состоянию.
     *
     * Хранится строкой «вид|имя|источник» — общая запись документа держит
     * строки, и заводить рядом вторую с теми же правилами сброса значило бы
     * получить два кэша, устаревающих порознь.
     */
    private cachedType(
        uri: string,
        key: string,
        build: () => IRslResolvedType
    ): IRslResolvedType {
        const packed = this.cached(uri, key, () => {
            const value = build();

            return value.kind + "|" + value.name + "|" + value.source;
        });
        const parts = packed.split("|");

        return parts.length === 3 && parts[0]
            ? {
                kind: parts[0] as IRslResolvedType["kind"],
                name: parts[1],
                source: parts[2] as IRslResolvedType["source"]
            }
            : rslUnknownType();
    }

    private assignmentTargetType(
        module: IIndexedModule,
        offset: number
    ): string {
        const tokens = module.syntax.tokens;
        let index = lastSignificantBefore(tokens, offset);

        /*
         * Между `=` и курсором может стоять уже набранное начало имени:
         * `doc = Get|`. Оно пропускается, дальше проверяется само `=`.
         */
        if (index >= 0 && tokens[index].kind === "identifier") {
            index--;
        }

        const operator = index >= 0 ? tokens[index] : undefined;

        if (
            !operator ||
            operator.kind !== "symbol" ||
            operator.raw !== "="
        ) {
            return "";
        }

        const target = previousSignificant(tokens, index);

        return target && target.kind === "identifier"
            ? this.typeOfSymbolAt(module.uri, target.start)
            : "";
    }

    private cached(
        uri: string,
        key: string,
        compute: () => string
    ): string {
        const module = this.index.getModule(uri);

        if (!module) {
            return "";
        }

        const stamp = this.resolver.semanticState.hotStamp(uri);
        let entry = this.byModule.get(module);

        if (!entry || !sameRslHotStamp(entry.stamp, stamp)) {
            /*
             * Окружение изменилось: прежние ответы к нему не относятся.
             * Сбрасывается запись ЭТОГО документа, а не весь слой.
             */
            if (entry) {
                this.resetCount++;
            }

            entry = { stamp, values: new Map() };
            this.byModule.set(module, entry);
        }

        const known = entry.values.get(key);

        if (known !== undefined) {
            this.hitCount++;

            return known;
        }

        this.missCount++;

        const value = compute();

        entry.values.set(key, value);

        return value;
    }
}

/**
 * Тип параметра под этим номером, если он написан.
 *
 * Подпись берётся у самого символа. Прежде она добывалась из `detail` элемента
 * подсказки, а тот — геттер: на каждый вопрос собирался целый CompletionItem с
 * заготовкой параметров, только чтобы прочитать из него строку. Заводить
 * элемент подсказки ради вывода типа незачем.
 *
 * Разбор `detail` остался запасным путём: у встроенных имён своя подпись живёт
 * там, а не в parameterText.
 */
export function parameterTypeAt(
    symbol: RslSymbol,
    argumentIndex: number
): string {
    const labels = symbol.parameterText
        ? splitParameterText(symbol.parameterText)
        : extractParameterLabels(symbol);
    const label = labels[argumentIndex];

    if (!label) {
        return "";
    }

    const colon = label.indexOf(":");

    return colon < 0
        ? ""
        : canonicalTypeName(label.substring(colon + 1).trim());
}

/**
 * Параметры из подписи объявления: `(a: String, b)` -> два элемента.
 *
 * Запятые внутри вложенных скобок не разделяют параметры.
 */
function splitParameterText(text: string): string[] {
    const open = text.indexOf("(");
    const close = text.lastIndexOf(")");

    if (open < 0 || close <= open) {
        return [];
    }

    const result: string[] = [];
    let current = "";
    let depth = 0;

    for (let at = open + 1; at < close; at++) {
        const character = text.charAt(at);

        if (character === "(" || character === "[") {
            depth++;
        } else if (character === ")" || character === "]") {
            depth = Math.max(0, depth - 1);
        }

        if (character === "," && depth === 0) {
            result.push(current.trim());
            current = "";
            continue;
        }

        current += character;
    }

    if (current.trim()) {
        result.push(current.trim());
    }

    return result;
}

function isCallableKind(kind: CompletionItemKind): boolean {
    return kind === CompletionItemKind.Function ||
        kind === CompletionItemKind.Method ||
        kind === CompletionItemKind.Constructor;
}

function isMeaningful(token: IRslToken): boolean {
    return token.kind !== "whitespace" &&
        token.kind !== "newline" &&
        token.kind !== "comment" &&
        token.kind !== "bom";
}

function significantTokensWithin(
    module: IIndexedModule,
    start: number,
    end: number
): IRslToken[] {
    const result: IRslToken[] = [];

    for (const token of module.syntax.tokens) {
        if (token.end <= start) {
            continue;
        }

        if (token.start >= end) {
            break;
        }

        if (isMeaningful(token)) {
            result.push(token);
        }
    }

    return result;
}

function lastSignificantBefore(
    tokens: readonly IRslToken[],
    offset: number
): number {
    for (let index = tokens.length - 1; index >= 0; index--) {
        const token = tokens[index];

        if (token.end <= offset && isMeaningful(token)) {
            return index;
        }
    }

    return -1;
}

function previousSignificant(
    tokens: readonly IRslToken[],
    index: number
): IRslToken | undefined {
    for (let at = index - 1; at >= 0; at--) {
        if (isMeaningful(tokens[at])) {
            return tokens[at];
        }
    }

    return undefined;
}

/** Нормализованное имя типа: для сравнения, а не для показа. */
export function sameRslType(left: string, right: string): boolean {
    return !!left && !!right &&
        normalizeIdentifier(left) === normalizeIdentifier(right);
}

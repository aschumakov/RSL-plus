import { CompletionItemKind } from "vscode-languageserver";

import { normalizeIdentifier, type IRslToken } from "../lexer";
import {
    findRslImportedSymbols
} from "../analysis/importedSymbolLookup";
import type { RslScopeResolver } from "../scopeResolver";
import type { IIndexedSymbol, WorkspaceIndex } from "../workspaceIndex";
import {
    findFastClass,
    lookupFastName,
    scopeChainAt,
    type IFastCompletionIndex,
    type IFastSignature
} from "./fastCompletionIndex";
import {
    findRslClassMember,
    walkRslClassChain,
    type IRslClassMember
} from "./fastClassChain";
import type { IRslInteractiveContext } from "./interactiveContext";

/**
 * Что удалось узнать об имени под курсором до готовности полной модели.
 *
 * Ответ явный, а не «нашлось или undefined»: разница между «символа нет» и
 * «данных не хватает» — это разница между мгновенным ответом и ожиданием
 * разбора. Раньше оба случая выглядели одинаково, и каждый обработчик решал
 * сам, ждать ли модель; правила при этом расходились между Hover, подсказкой
 * параметров и переходом.
 */
export type IRslReferenceOutcome =
    /** Строка, комментарий, SQL-блок: отвечать здесь нечем и не нужно. */
    | { kind: "blocked" }
    /** Доказано, что такого имени нет: ждать разбор незачем. */
    | { kind: "not-found" }
    /** Кандидатов несколько; выбирать наугад нельзя. */
    | { kind: "ambiguous" }
    /** Быстрых данных недостаточно — и только здесь уместно ждать модель. */
    | { kind: "needs-model" }
    | { kind: "resolved"; reference: IRslReference };

export interface IRslReference {
    /**
     * Откуда символ:
     * member — член класса получателя перед точкой;
     * own — объявление этого файла;
     * imported — объявление подключённого модуля.
     */
    origin: "member" | "own" | "imported";
    token: IRslToken;
    name: string;
    /** Тип символа: пусто, если неизвестен. */
    typeName: string;
    /** Место объявления в этом файле; -1 — неизвестно. */
    declarationStart: number;
    /** Процедура или метод: только для них уместна подсказка параметров. */
    isCallable: boolean;
    member?: IRslClassMember;
    imported?: IIndexedSymbol;
    signature?: IFastSignature;
}

/**
 * Разрешает имя под курсором по данным текущей версии текста.
 *
 * Правила собраны здесь целиком, потому что раньше каждый обработчик применял
 * их по-своему: после точки поиск продолжался по объявлениям файла, локальное
 * имя проигрывало импортированному, а несуществующий член класса подменялся
 * одноимённой процедурой из подключённого модуля.
 */
export function resolveRslReference(
    context: IRslInteractiveContext,
    index: WorkspaceIndex,
    resolver: RslScopeResolver,
    /** Имя, которое разрешаем; по умолчанию — под курсором. */
    wanted?: IRslToken
): IRslReferenceOutcome {
    const token = wanted || context.token;

    if (!token || token.kind !== "identifier") {
        return { kind: "blocked" };
    }

    const receiver = findRslReceiverBefore(context.tokens, token);

    return receiver
        ? resolveMember(context, resolver, token, receiver)
        : resolveName(context, index, token);
}

/** Имя перед точкой, стоящей непосредственно перед токеном. */
export function findRslReceiverBefore(
    tokens: readonly IRslToken[],
    member: IRslToken
): IRslToken | undefined {
    /*
     * Обход идёт назад от самого токена, а не по всему файлу с начала: на
     * модуле 700 КБ полный проход — сотни тысяч токенов на каждый Hover.
     */
    let index = lastTokenIndexBefore(tokens, member.start);
    const skip = (): void => {
        while (index >= 0 && isTrivia(tokens[index])) {
            index--;
        }
    };

    skip();

    const dot = tokens[index];

    if (!dot || dot.kind !== "symbol" || dot.raw !== ".") {
        return undefined;
    }

    index--;
    skip();

    const receiver = tokens[index];

    return receiver && receiver.kind === "identifier" ? receiver : undefined;
}

/** Член класса получателя: искать что-то другое здесь нельзя. */
function resolveMember(
    context: IRslInteractiveContext,
    resolver: RslScopeResolver,
    token: IRslToken,
    receiver: IRslToken
): IRslReferenceOutcome {
    const typeName = lookupFastName(
        context.fastIndex,
        receiver.value,
        context.offset
    ).typeName;

    if (!typeName) {
        /* Тип получателя мог быть выведен из присваивания: это знает модель. */
        return { kind: "needs-model" };
    }

    const options = chainOptions(context, resolver);
    const member = findRslClassMember(typeName, token.value, options);

    if (member) {
        return {
            kind: "resolved",
            reference: {
                origin: "member",
                token,
                name: member.name,
                typeName: member.typeName,
                declarationStart: -1,
                isCallable: member.signature !== undefined ||
                    isCallableSymbolKind(member.symbol?.kind),
                member,
                signature: member.signature
            }
        };
    }

    /*
     * Члена нет. Это окончательный ответ только тогда, когда класс известен
     * целиком: иначе он мог прийти из модуля, который сервер ещё не прочитал.
     */
    return classChainIsKnown(typeName, options)
        ? { kind: "not-found" }
        : { kind: "needs-model" };
}

/** Имя без получателя: файл, затем подключённые модули. */
function resolveName(
    context: IRslInteractiveContext,
    index: WorkspaceIndex,
    token: IRslToken
): IRslReferenceOutcome {
    const declared = lookupFastName(
        context.fastIndex,
        token.value,
        context.offset
    );

    /*
     * Объявление этого файла перекрывает всё остальное. Прежде быстрый путь
     * шёл дальше в подключённые модули, и локальная процедура подменялась
     * одноимённой чужой.
     */
    if (declared.declared) {
        return {
            kind: "resolved",
            reference: {
                origin: "own",
                token,
                name: token.value,
                typeName: declared.typeName,
                declarationStart: declared.declarationStart ?? -1,
                isCallable: false
            }
        };
    }

    const key = normalizeIdentifier(token.value);
    const signatures = context.fastIndex.signatures.get(key) || [];
    const visible = visibleSignature(context, signatures);

    if (visible) {
        return {
            kind: "resolved",
            reference: {
                origin: "own",
                token,
                name: visible.name,
                typeName: "",
                declarationStart: visible.nameStart,
                isCallable: true,
                signature: visible
            }
        };
    }

    const global = signatures.filter(item => item.scope === -1 &&
        !item.isMethod);

    if (global.length > 1) {
        /* Два одноимённых объявления файла: выбирать между ними нельзя. */
        return { kind: "ambiguous" };
    }

    if (context.fastIndex.classes.has(key)) {
        /* Класс этого файла: место объявления знает индекс версии. */
        const info = findFastClass(context.fastIndex, token.value,
            context.offset);

        return {
            kind: "resolved",
            reference: {
                origin: "own",
                token,
                name: token.value,
                typeName: token.value,
                declarationStart: info ? info.nameStart : -1,
                isCallable: false
            }
        };
    }

    const found = findRslImportedSymbols(
        index,
        context.uri,
        context.imports,
        token.value
    );

    if (found.length === 1) {
        const symbol = found[0];

        return {
            kind: "resolved",
            reference: {
                origin: "imported",
                token,
                name: symbol.symbol.name,
                typeName: symbol.symbol.typeName || "",
                declarationStart: -1,
                isCallable: isCallableSymbolKind(symbol.symbol.kind),
                imported: symbol
            }
        };
    }

    if (found.length > 1) {
        return { kind: "ambiguous" };
    }

    /*
     * Имени нет ни среди объявлений файла, ни в подключённых модулях — но это
     * ещё не доказательство. В RSL переменная возникает от самого
     * присваивания, без VAR, и таких имён индекс версии не знает: их видит
     * только полная модель. Доказуемое отсутствие есть у члена класса —
     * см. resolveMember.
     */
    return { kind: "needs-model" };
}

/** Подпись, видимая из точки запроса: своя область, затем объемлющие. */
function visibleSignature(
    context: IRslInteractiveContext,
    candidates: readonly IFastSignature[]
): IFastSignature | undefined {
    if (candidates.length === 0) {
        return undefined;
    }

    for (const scope of scopeChainAt(context.fastIndex, context.offset)) {
        const found = candidates.find(item => item.scope === scope);

        if (found) {
            return found;
        }
    }

    const global = candidates.filter(item => item.scope === -1 &&
        !item.isMethod);

    return global.length === 1 ? global[0] : undefined;
}

/** Известна ли иерархия класса целиком: только тогда «члена нет» доказуемо. */
function classChainIsKnown(
    className: string,
    options: ReturnType<typeof chainOptions>
): boolean {
    let levels = 0;
    let pending = "";

    for (const level of walkRslClassChain(className, options)) {
        levels++;
        pending = level.kind === "own"
            ? level.info.baseName
            : level.value.symbol.baseClassName || "";
    }

    /*
     * Цепочка оборвалась на классе, база которого не найдена: состав класса
     * неполон, и отсутствие члена ничего не доказывает.
     */
    return levels > 0 && !pending;
}


function isCallableSymbolKind(kind: CompletionItemKind | undefined): boolean {
    return kind === CompletionItemKind.Function ||
        kind === CompletionItemKind.Method;
}

export function chainOptions(
    context: IRslInteractiveContext,
    resolver: RslScopeResolver
): {
    resolver: RslScopeResolver;
    uri: string;
    imports: readonly string[];
    fastIndex: IFastCompletionIndex;
    offset: number;
} {
    return {
        resolver,
        uri: context.uri,
        imports: context.imports,
        fastIndex: context.fastIndex,
        offset: context.offset
    };
}

function isTrivia(token: IRslToken): boolean {
    return token.kind === "whitespace" ||
        token.kind === "comment" ||
        token.kind === "bom";
}

/** Индекс последнего токена, начинающегося раньше позиции. */
function lastTokenIndexBefore(
    tokens: readonly IRslToken[],
    offset: number
): number {
    let low = 0;
    let high = tokens.length;

    while (low < high) {
        const middle = (low + high) >>> 1;

        if (tokens[middle].start < offset) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    return low - 1;
}

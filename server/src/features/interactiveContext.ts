import {
    Hover,
    Location,
    SignatureHelp
} from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

import {
    GetDynamicDefinitionTargetFromTokens,
    GetImportDefinitionTargetFromTokens
} from "../execMacroDefinition";
import { normalizeIdentifier, tokenAtOffset, type IRslToken } from "../lexer";
import type { RslSymbol } from "../symbols/rslSymbol";
import type { RslScopeResolver } from "../scopeResolver";
import type {
    IIndexedModule,
    IIndexedSymbol,
    WorkspaceIndex
} from "../workspaceIndex";
import type {
    IFastDocumentSnapshot
} from "../services/fastDocumentSnapshot";
import {
    findFastClass,
    getFastCompletionIndex,
    lookupFastName,
    type IFastCompletionIndex
} from "./fastCompletionIndex";
import { buildRslHoverContent } from "./hoverFormatter";
import {
    createSignatureInformation,
    findRslCallContext
} from "./signatureHelpProvider";

/**
 * Состояние документа, по которому отвечает интерактивный запрос.
 *
 * Ctrl+Click, Hover и подсказка параметров приходят сразу после набора текста,
 * когда полная модель этой версии ещё считается. Ждать её значило заставлять
 * пользователя ждать вместе с ней: на модуле 550 КБ это 120–260 мс, то есть
 * переход «не работает», а подсказка появляется с опозданием.
 *
 * Поэтому у запроса есть контекст, собранный из того, что уже готово: токены
 * текущей версии, компактный индекс версии и — если повезло — готовая модель.
 * Всё, на что хватает токенов и индекса, отвечается сразу; модель остаётся
 * запасным путём для остального.
 */
export interface IRslInteractiveContext {
    document: TextDocument;
    uri: string;
    /** Версия документа на момент запроса: по ней проверяется устаревание. */
    version: number;
    offset: number;
    source: string;
    /** Токены ТЕКУЩЕЙ версии: из модели, если она есть, иначе из снимка. */
    tokens: readonly IRslToken[];
    token?: IRslToken;
    /** Модель ровно этой версии; undefined — она ещё считается. */
    module?: IIndexedModule;
    fastIndex: IFastCompletionIndex;
    /** Import текущей версии текста. */
    imports: readonly string[];
    /** Запрос устарел: документ изменился или запрос отменён. */
    isStale(): boolean;
}

export interface IRslInteractiveEnvironment {
    index: WorkspaceIndex;
    resolver: RslScopeResolver;
    getFastDocumentSnapshot(document: TextDocument): IFastDocumentSnapshot;
    getCurrentModule(document: TextDocument): IIndexedModule | undefined;
}

export function createRslInteractiveContext(
    environment: IRslInteractiveEnvironment,
    document: TextDocument,
    offset: number,
    isCancelled: () => boolean
): IRslInteractiveContext {
    const version = document.version;
    const module = environment.getCurrentModule(document);
    const snapshot = environment.getFastDocumentSnapshot(document);
    const fastIndex = getFastCompletionIndex(snapshot);
    /*
     * Токены берутся у модели, когда она есть: это тот же поток, по которому
     * посчитаны её символы, и ответы двух путей не расходятся из-за разных
     * лексирований.
     */
    const tokens = module ? module.lex.tokens : snapshot.lex.tokens;

    return {
        document,
        uri: document.uri,
        version,
        offset,
        source: module ? module.source : snapshot.text,
        tokens,
        token: tokenAtOffset(tokens, offset, true),
        module,
        fastIndex,
        imports: fastIndex.imports,
        isStale: () => document.version !== version || isCancelled()
    };
}

/**
 * Переход, для которого достаточно токенов и индекса проекта.
 *
 * Это три случая, и все три — переходы между файлами, ради которых Ctrl+Click в
 * этом языке и нужен: имя модуля в Import, имя процедуры в строке ExecMacro и
 * имя, объявленное не в этом файле. Локальные переходы остаются полной модели:
 * там она и так есть к моменту, когда пользователь целится в имя.
 */
export function findRslFastDefinition(
    context: IRslInteractiveContext,
    index: WorkspaceIndex
): Location | undefined {
    const importTarget = GetImportDefinitionTargetFromTokens(
        context.tokens as IRslToken[],
        context.offset
    );

    if (importTarget) {
        return moduleLocation(index, importTarget.moduleName);
    }

    if (context.token?.kind === "string") {
        return dynamicLocation(context, index);
    }

    if (context.token?.kind !== "identifier") {
        return undefined;
    }

    /*
     * Имя, объявленное в этом файле, быстрым путём не разрешается: у индекса
     * версии нет ни диапазонов объявлений, ни правил затенения на все случаи.
     * Такое имя уходит полной модели — она к этому моменту обычно готова.
     */
    if (lookupFastName(context.fastIndex, context.token.value, context.offset)
        .declared) {
        return undefined;
    }

    const own = normalizeIdentifier(context.token.value);

    if (context.fastIndex.classes.has(own)) {
        return undefined;
    }

    return importedSymbolLocation(index, context.uri, context.token.value);
}

/**
 * Переход к объявлению ТИПА имени под курсором.
 *
 * Отвечает на вопрос «что это за класс»: от переменной или поля — к его
 * классу. Тип берётся у индекса версии (написанный или выведенный), а класс —
 * там же, где его берут подсказки: в самом файле, в подключённом модуле или в
 * прикладном каталоге. Новой индексации для этого не нужно.
 */
export function findRslFastTypeDefinition(
    context: IRslInteractiveContext,
    index: WorkspaceIndex,
    resolver: RslScopeResolver
): Location | undefined {
    if (context.token?.kind !== "identifier") {
        return undefined;
    }

    const member = findFastMember(context, resolver);
    const typeName = member
        ? member.symbol.typeName
        : typeNameAt(context, resolver);

    if (!typeName || isPlainTypeName(typeName)) {
        return undefined;
    }

    /* Класс этого же файла: его границы знает индекс версии. */
    const own = findFastClass(context.fastIndex, typeName, context.offset);

    if (own) {
        return Location.create(context.uri, {
            start: context.document.positionAt(own.start),
            end: context.document.positionAt(own.start)
        });
    }

    const external = resolver.findFastClass(
        context.uri,
        typeName,
        context.fastIndex.imports
    );

    if (!external || !external.moduleUri) {
        return undefined;
    }

    const range = index.getDefinitionRange(
        external.moduleUri,
        external.symbol
    );

    return Location.create(
        external.moduleUri,
        range || {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 }
        }
    );
}

/** Тип имени под курсором: объявленный или выведенный индексом версии. */
function typeNameAt(
    context: IRslInteractiveContext,
    resolver: RslScopeResolver
): string {
    const token = context.token;

    if (!token) {
        return "";
    }

    const declared = lookupFastName(
        context.fastIndex,
        token.value,
        context.offset
    );

    if (declared.typeName) {
        return declared.typeName;
    }

    /*
     * Само имя может быть именем класса: тогда переход к типу — это переход к
     * нему же. Так ведут себя и другие языковые расширения.
     */
    const asClass = resolver.findFastClass(
        context.uri,
        token.value,
        context.fastIndex.imports
    );

    return asClass ? token.value : "";
}

/**
 * Примитивный тип: переходить некуда.
 *
 * Список короткий намеренно: это не проверка типов, а отбор имён, у которых
 * заведомо нет объявления-класса.
 */
function isPlainTypeName(value: string): boolean {
    return [
        "variant",
        "integer",
        "double",
        "money",
        "string",
        "bool",
        "date",
        "time",
        "dttm",
        "numeric",
        "decimal"
    ].includes(normalizeIdentifier(value));
}

/** Hover, для которого достаточно индекса версии и справочника. */
export function buildRslFastHover(
    context: IRslInteractiveContext,
    index: WorkspaceIndex,
    resolver: RslScopeResolver
): Hover | undefined {
    if (context.token?.kind !== "identifier") {
        return undefined;
    }

    const range = {
        start: context.document.positionAt(context.token.start),
        end: context.document.positionAt(context.token.end)
    };
    const member = findFastMember(context, resolver);

    if (member) {
        return {
            contents: buildRslHoverContent(
                index,
                member.moduleUri,
                member.symbol,
                member.symbol.typeName
            ),
            range
        };
    }

    const declared = lookupFastName(
        context.fastIndex,
        context.token.value,
        context.offset
    );

    if (declared.declared) {
        /*
         * Объявление этого файла: имя и тип уже посчитаны индексом версии.
         * Больше о переменной сказать нечего и полной модели — она добавила бы
         * только ссылку на то же объявление.
         */
        return {
            contents: {
                kind: "markdown",
                value: `**${context.token.value}**` +
                    (declared.typeName ? `: ${declared.typeName}` : "")
            },
            range
        };
    }

    const imported = singleImportedSymbol(index, context.uri, context.token.value);

    if (imported) {
        return {
            contents: buildRslHoverContent(
                index,
                imported.uri,
                imported.symbol,
                imported.symbol.typeName
            ),
            range
        };
    }

    return undefined;
}

/**
 * Подсказка параметров по токенам.
 *
 * Вызов и номер аргумента считаются по потоку токенов, а сама подпись берётся у
 * символа: метода каталожного класса, символа подключённого модуля или
 * процедуры этого файла.
 */
export function buildRslFastSignatureHelp(
    context: IRslInteractiveContext,
    index: WorkspaceIndex,
    resolver: RslScopeResolver
): SignatureHelp | undefined {
    const call = findRslCallContext(context.tokens, context.offset);

    if (!call) {
        return undefined;
    }

    const symbol = findCallableSymbol(context, index, resolver, call.callee);

    if (!symbol) {
        return undefined;
    }

    const signature = createSignatureInformation(symbol);
    const parameterCount = signature.parameters?.length || 0;

    return {
        signatures: [signature],
        activeSignature: 0,
        activeParameter: parameterCount === 0
            ? 0
            : Math.min(call.activeParameter, parameterCount - 1)
    };
}

/** Символ вызываемого имени: член класса, символ Import или процедура файла. */
function findCallableSymbol(
    context: IRslInteractiveContext,
    index: WorkspaceIndex,
    resolver: RslScopeResolver,
    callee: IRslToken
): RslSymbol | undefined {
    const asMember = findFastMemberAt(context, resolver, callee);

    if (asMember) {
        return asMember.symbol;
    }

    const imported = singleImportedSymbol(index, context.uri, callee.value);

    if (imported) {
        return imported.symbol;
    }

    /*
     * Процедура этого файла берётся из последней построенной модели — она
     * может быть на версию старше. Для подписи это допустимо: из символа
     * берутся имя и параметры, а не позиции, и список параметров процедуры не
     * меняется от того, что пользователь дописывает аргумент в её вызове.
     */
    const own = index.getModule(context.uri);

    if (!own) {
        return undefined;
    }

    const wanted = normalizeIdentifier(callee.value);

    return own.symbolTree.children.find(child =>
        normalizeIdentifier(child.name) === wanted &&
        (child.kind === 3 || child.kind === 2)
    );
}

/** Член класса-получателя перед точкой в позиции запроса. */
function findFastMember(
    context: IRslInteractiveContext,
    resolver: RslScopeResolver
): { symbol: RslSymbol; moduleUri: string } | undefined {
    return context.token
        ? findFastMemberAt(context, resolver, context.token)
        : undefined;
}

function findFastMemberAt(
    context: IRslInteractiveContext,
    resolver: RslScopeResolver,
    member: IRslToken
): { symbol: RslSymbol; moduleUri: string } | undefined {
    const receiver = receiverBefore(context.tokens, member);

    if (!receiver) {
        return undefined;
    }

    const typeName = lookupFastName(
        context.fastIndex,
        receiver.value,
        context.offset
    ).typeName;

    if (!typeName) {
        return undefined;
    }

    let current = resolver.findFastClass(
        context.uri,
        typeName,
        context.fastIndex.imports
    );
    const wanted = normalizeIdentifier(member.value);
    const visited = new Set<string>();

    while (current && !visited.has(current.symbol.id)) {
        visited.add(current.symbol.id);
        const found = current.symbol.children.find(child =>
            normalizeIdentifier(child.name) === wanted &&
            child.visibility !== "private"
        );

        if (found) {
            return {
                symbol: found,
                moduleUri: current.moduleUri || context.uri
            };
        }

        current = resolver.findFastBaseClass(
            current,
            current.symbol.baseClassName || "",
            context.fastIndex.imports
        );
    }

    return undefined;
}

/** Имя перед точкой, стоящей непосредственно перед токеном. */
function receiverBefore(
    tokens: readonly IRslToken[],
    member: IRslToken
): IRslToken | undefined {
    let dot: IRslToken | undefined;
    let receiver: IRslToken | undefined;

    for (const token of tokens) {
        if (token.start >= member.start) {
            break;
        }

        if (
            token.kind === "whitespace" ||
            token.kind === "comment" ||
            token.kind === "bom"
        ) {
            continue;
        }

        /* Перевод строки разрывает обращение: `a.` и имя на новой строке. */
        if (token.kind === "newline") {
            dot = undefined;
            receiver = undefined;
            continue;
        }

        if (token.kind === "symbol" && token.raw === ".") {
            dot = token;
            continue;
        }

        receiver = dot ? receiver : token;
        dot = undefined;
    }

    return dot && receiver?.kind === "identifier" ? receiver : undefined;
}

function moduleLocation(
    index: WorkspaceIndex,
    moduleName: string
): Location | undefined {
    const resolution = index.resolveWorkspaceFile(moduleName);

    /*
     * Неоднозначное имя не разрешается намеренно: увести в один из двух файлов
     * наугад хуже, чем не уводить никуда.
     */
    if (resolution.kind !== "resolved") {
        return undefined;
    }

    return Location.create(resolution.value, {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 }
    });
}

/** Переход по строковой ссылке: ExecMacro, ExecMacro2, ExecMacroFile. */
function dynamicLocation(
    context: IRslInteractiveContext,
    index: WorkspaceIndex
): Location | undefined {
    const target = GetDynamicDefinitionTargetFromTokens(
        context.tokens as IRslToken[],
        context.offset
    );

    if (!target) {
        return undefined;
    }

    /* Имя файла в ExecMacroFile: переход к самому файлу. */
    if (target.kind === "file" && target.moduleName) {
        return moduleLocation(index, target.moduleName);
    }

    if (target.kind === "fileMacro" && target.moduleName) {
        const file = moduleLocation(index, target.moduleName);

        if (file) {
            return file;
        }
    }

    if (!target.macroName) {
        return undefined;
    }

    /* Имя процедуры: сначала подключённые модули, потом сам файл. */
    const imported = singleImportedSymbol(
        index,
        context.uri,
        target.macroName
    );

    if (imported) {
        return symbolLocation(index, imported);
    }

    const own = index.getModule(context.uri);
    const wanted = normalizeIdentifier(target.macroName);
    const found = own?.symbolTree.children.find(child =>
        normalizeIdentifier(child.name) === wanted
    );

    return own && found
        ? symbolLocation(index, { uri: own.uri, symbolId: found.id, symbol: found })
        : undefined;
}

function importedSymbolLocation(
    index: WorkspaceIndex,
    uri: string,
    name: string
): Location | undefined {
    const found = singleImportedSymbol(index, uri, name);

    return found ? symbolLocation(index, found) : undefined;
}

/**
 * Единственный символ этого имени среди подключённых модулей.
 *
 * Одноимённые символы из двух Import не разрешаются: выбор компилятора без
 * полной модели неизвестен, и уводить наугад нельзя.
 */
function singleImportedSymbol(
    index: WorkspaceIndex,
    uri: string,
    name: string
): IIndexedSymbol | undefined {
    const found = index.findImportedSymbols(uri, name)
        .filter(item => !item.symbol.isPrivate);

    if (found.length !== 1) {
        return undefined;
    }

    return found[0];
}

function symbolLocation(
    index: WorkspaceIndex,
    found: IIndexedSymbol
): Location | undefined {
    const range = index.getDefinitionRange(found.uri, found.symbol);

    return Location.create(
        found.uri,
        range || {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 }
        }
    );
}

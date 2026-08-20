import {
    Hover,
    Location,
    SignatureHelp,
    SignatureInformation
} from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

import {
    GetDynamicDefinitionTargetFromTokens,
    GetImportDefinitionTargetFromTokens
} from "../execMacroDefinition";
import { normalizeIdentifier, tokenAtOffset, type IRslToken } from "../lexer";
import {
    findRslSingleImportedSymbol
} from "../analysis/importedSymbolLookup";
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
    getFastCompletionIndex,
    lookupFastName,
    scopeChainAt,
    type IFastCompletionIndex,
    type IFastSignature
} from "./fastCompletionIndex";
import {
    findRslClassDeclaration,
    findRslClassMember,
    type IRslClassMember
} from "./fastClassChain";
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
 * пользователя ждать вместе с ней: на модуле 584 КБ это 120–260 мс, то есть
 * переход «не работает», а подсказка появляется с опозданием.
 *
 * Поэтому у запроса есть контекст из того, что уже готово. Собирается он
 * ЛЕНИВО: переходу по Import достаточно токенов, и строить ради него индекс
 * версии — это лишние десятки миллисекунд на большом файле. Индекс появляется
 * только там, где нужны области видимости, типы и члены.
 */
export interface IRslInteractiveContext {
    document: TextDocument;
    uri: string;
    /** Версия документа на момент запроса: по ней проверяется устаревание. */
    version: number;
    offset: number;
    /** Токены ТЕКУЩЕЙ версии: из модели, если она есть, иначе из снимка. */
    readonly tokens: readonly IRslToken[];
    readonly token?: IRslToken;
    /** Модель ровно этой версии; undefined — она ещё считается. */
    module?: IIndexedModule;
    /** Import ТЕКУЩЕГО текста: из модели этой версии либо из индекса версии. */
    readonly imports: readonly string[];
    /** Индекс версии: строится при первом обращении. */
    readonly fastIndex: IFastCompletionIndex;
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
    let snapshot: IFastDocumentSnapshot | undefined;
    let fastIndex: IFastCompletionIndex | undefined;
    let tokens: readonly IRslToken[] | undefined = module
        ? module.lex.tokens
        : undefined;
    let token: IRslToken | undefined;
    let tokenResolved = false;

    const ensureSnapshot = (): IFastDocumentSnapshot => {
        if (!snapshot) {
            snapshot = environment.getFastDocumentSnapshot(document);
        }

        return snapshot;
    };

    return {
        document,
        uri: document.uri,
        version,
        offset,
        module,
        get tokens(): readonly IRslToken[] {
            if (!tokens) {
                tokens = ensureSnapshot().lex.tokens;
            }

            return tokens;
        },
        get token(): IRslToken | undefined {
            if (!tokenResolved) {
                token = tokenAtOffset(this.tokens, offset, true);
                tokenResolved = true;
            }

            return token;
        },
        get imports(): readonly string[] {
            /*
             * У готовой модели Import того же текста, что и у документа:
             * строить ради них индекс версии незачем.
             */
            return module ? module.imports : this.fastIndex.imports;
        },
        get fastIndex(): IFastCompletionIndex {
            if (!fastIndex) {
                fastIndex = getFastCompletionIndex(ensureSnapshot());
            }

            return fastIndex;
        },
        isStale: () => document.version !== version || isCancelled()
    };
}

/**
 * Переход, для которого достаточно токенов и индекса проекта.
 *
 * Это переходы между файлами, ради которых Ctrl+Click в этом языке и нужен:
 * имя модуля в Import, имя процедуры в строке ExecMacro и имя, объявленное не в
 * этом файле. Локальные переходы остаются полной модели: там она и так готова к
 * моменту, когда пользователь целится в имя.
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

    if (
        context.fastIndex.classes.has(own) ||
        context.fastIndex.signatures.has(own)
    ) {
        return undefined;
    }

    return importedSymbolLocation(context, index, context.token.value);
}

/** Переход к объявлению ТИПА имени под курсором. */
export function findRslFastTypeDefinition(
    context: IRslInteractiveContext,
    index: WorkspaceIndex,
    resolver: RslScopeResolver
): Location | undefined {
    if (context.token?.kind !== "identifier") {
        return undefined;
    }

    const member = findFastMember(context, resolver);
    const typeName = member ? member.typeName : typeNameAt(context, resolver);

    if (!typeName || isPlainTypeName(typeName)) {
        return undefined;
    }

    const declaration = findRslClassDeclaration(
        typeName,
        chainOptions(context, resolver)
    );

    if (!declaration) {
        return undefined;
    }

    if (declaration.start !== undefined) {
        return Location.create(declaration.moduleUri, {
            start: context.document.positionAt(declaration.start),
            end: context.document.positionAt(declaration.start)
        });
    }

    const range = declaration.symbol
        ? index.getDefinitionRange(declaration.moduleUri, declaration.symbol)
        : undefined;

    return Location.create(declaration.moduleUri, range || {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 }
    });
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
        return member.symbol
            ? {
                contents: buildRslHoverContent(
                    index,
                    member.moduleUri || context.uri,
                    member.symbol,
                    member.symbol.typeName
                ),
                range
            }
            : {
                /* Член класса этого файла: имя и тип знает индекс версии. */
                contents: {
                    kind: "markdown",
                    value: `**${member.name}**` +
                        (member.typeName ? `: ${member.typeName}` : "")
                },
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

    const imported = findRslSingleImportedSymbol(
        index,
        context.uri,
        context.imports,
        context.token.value
    );

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
 * Вызов и номер аргумента считаются по потоку токенов текущей версии, а подпись
 * берётся у того, кто знает её для ЭТОГО текста: индекс версии — для процедур
 * файла, справочник — для методов класса и символов подключённых модулей.
 * Модель предыдущей версии здесь не годится: после правки заголовка она
 * показывала прежний список параметров.
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

    const signature = findCallSignature(context, index, resolver, call.callee);

    if (!signature) {
        return undefined;
    }

    const parameterCount = signature.parameters?.length || 0;

    return {
        signatures: [signature],
        activeSignature: 0,
        activeParameter: parameterCount === 0
            ? 0
            : Math.min(call.activeParameter, parameterCount - 1)
    };
}

/** Подпись вызванного имени: член класса, процедура файла или символ Import. */
function findCallSignature(
    context: IRslInteractiveContext,
    index: WorkspaceIndex,
    resolver: RslScopeResolver,
    callee: IRslToken
): SignatureInformation | undefined {
    const member = findFastMemberAt(context, resolver, callee);

    if (member?.symbol) {
        return createSignatureInformation(member.symbol);
    }

    /*
     * Процедура ЭТОГО файла: подпись берётся из индекса версии, а не из
     * модели — модель отстаёт на правку.
     */
    const own = findOwnSignature(context, callee);

    if (own) {
        return {
            label: own.name + "(" + own.parameters.join(", ") + ")",
            parameters: own.parameters.map(label => ({ label }))
        };
    }

    if (member) {
        /* Член класса этого файла: параметров индекс версии не хранит. */
        return undefined;
    }

    const imported = findRslSingleImportedSymbol(
        index,
        context.uri,
        context.imports,
        callee.value
    );

    return imported ? createSignatureInformation(imported.symbol) : undefined;
}

/** Подпись процедуры этого файла, видимой в точке запроса. */
function findOwnSignature(
    context: IRslInteractiveContext,
    callee: IRslToken
): IFastSignature | undefined {
    const candidates = context.fastIndex.signatures.get(
        normalizeIdentifier(callee.value)
    );

    if (!candidates || candidates.length === 0) {
        return undefined;
    }

    /*
     * Одноимённые процедуры разных областей: берётся видимая отсюда, начиная с
     * самой внутренней. Метод класса снаружи по имени не вызывают.
     */
    for (const scope of scopeChainAt(context.fastIndex, context.offset)) {
        const found = candidates.find(item =>
            item.scope === scope && !item.isMethod
        );

        if (found) {
            return found;
        }
    }

    const global = candidates.filter(item =>
        item.scope === -1 && !item.isMethod
    );

    return global.length === 1 ? global[0] : undefined;
}


/** Общие правила обхода иерархии для всех быстрых ответов. */
function chainOptions(
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

/** Член класса-получателя перед точкой в позиции запроса. */
function findFastMember(
    context: IRslInteractiveContext,
    resolver: RslScopeResolver
): IRslClassMember | undefined {
    return context.token
        ? findFastMemberAt(context, resolver, context.token)
        : undefined;
}

function findFastMemberAt(
    context: IRslInteractiveContext,
    resolver: RslScopeResolver,
    member: IRslToken
): IRslClassMember | undefined {
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

    return findRslClassMember(
        typeName,
        member.value,
        chainOptions(context, resolver)
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
    const asClass = findRslClassDeclaration(
        token.value,
        chainOptions(context, resolver)
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

    /*
     * Имя процедуры внутри указанного файла: цель — её объявление, а не начало
     * файла. Прежде переход уводил в первую строку модуля, и по нему нельзя
     * было понять, есть ли там вообще такая процедура.
     */
    if (target.kind === "fileMacro") {
        return target.macroName
            ? macroInModuleLocation(
                index,
                target.moduleName || "",
                target.macroName
            )
            : undefined;
    }

    if (!target.macroName) {
        return undefined;
    }

    /* Имя процедуры: сначала подключённые модули, потом сам файл. */
    const imported = findRslSingleImportedSymbol(
        index,
        context.uri,
        context.imports,
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
        ? symbolLocation(index, {
            uri: own.uri,
            symbolId: found.id,
            symbol: found
        })
        : undefined;
}

/** Объявление процедуры в указанном модуле. */
function macroInModuleLocation(
    index: WorkspaceIndex,
    moduleName: string,
    macroName: string
): Location | undefined {
    const resolution = index.resolveWorkspaceFile(moduleName);

    if (resolution.kind !== "resolved") {
        return undefined;
    }

    const module = index.getModule(resolution.value);
    const wanted = normalizeIdentifier(macroName);
    const found = module?.symbolTree.children.find(child =>
        normalizeIdentifier(child.name) === wanted
    );

    if (!module || !found) {
        /*
         * Модуль ещё не прочитан или процедуры в нём нет. Уводить в начало
         * файла нельзя: это выглядело бы как найденное объявление.
         */
        return undefined;
    }

    return symbolLocation(index, {
        uri: module.uri,
        symbolId: found.id,
        symbol: found
    });
}

function importedSymbolLocation(
    context: IRslInteractiveContext,
    index: WorkspaceIndex,
    name: string
): Location | undefined {
    const found = findRslSingleImportedSymbol(
        index,
        context.uri,
        context.imports,
        name
    );

    return found ? symbolLocation(index, found) : undefined;
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

import {
    Hover,
    Location,
    SignatureHelp,
    SignatureInformation
} from "vscode-languageserver/node";

import {
    GetDynamicDefinitionTargetFromTokens,
    GetImportDefinitionTargetFromTokens
} from "../execMacroDefinition";
import { normalizeIdentifier, type IRslToken } from "../lexer";
import {
    findRslSingleImportedSymbol
} from "../analysis/importedSymbolLookup";
import type { RslScopeResolver } from "../scopeResolver";
import type { IIndexedSymbol, WorkspaceIndex } from "../workspaceIndex";
import {
    lookupFastName,
    readRslFastSignature,
    type IFastSignature
} from "./fastCompletionIndex";
import { findRslClassDeclaration } from "./fastClassChain";
import {
    chainOptions,
    type IRslReference
} from "./interactiveReferenceResolver";
import type { IRslInteractiveContext } from "./interactiveContext";
import { buildRslHoverContent } from "./hoverFormatter";
import {
    createSignatureInformation,
    findRslCallContext
} from "./signatureHelpProvider";

/**
 * Ответы по данным текущей версии текста.
 *
 * Здесь только сборка ответа из уже разрешённой ссылки: где искать символ и
 * можно ли считать поиск законченным — решает interactiveReferenceResolver, а
 * ждать ли модель — обработчик запроса. Раньше все три решения принимались в
 * одном месте, и правила расходились между Hover, переходом и подсказкой
 * параметров.
 */

/** Hover по разрешённой ссылке. */
export function buildRslReferenceHover(
    context: IRslInteractiveContext,
    index: WorkspaceIndex,
    reference: IRslReference
): Hover | undefined {
    const range = {
        start: context.document.positionAt(reference.token.start),
        end: context.document.positionAt(reference.token.end)
    };

    if (reference.imported) {
        return {
            contents: buildRslHoverContent(
                index,
                reference.imported.uri,
                reference.imported.symbol,
                reference.imported.symbol.typeName
            ),
            range
        };
    }

    const member = reference.member;

    if (member?.symbol) {
        return {
            contents: buildRslHoverContent(
                index,
                member.moduleUri || context.uri,
                member.symbol,
                member.symbol.typeName
            ),
            range
        };
    }

    if (reference.signature) {
        /* Процедура этого файла: подпись собирается по её заголовку. */
        return {
            contents: {
                kind: "markdown",
                value: "**" + signatureLabel(context, reference.signature) + "**"
            },
            range
        };
    }

    /*
     * Объявление этого файла: имя и тип уже посчитаны индексом версии. Больше о
     * переменной не скажет и полная модель — она добавила бы ссылку на то же
     * объявление.
     */
    return {
        contents: {
            kind: "markdown",
            value: "**" + reference.name + "**" +
                (reference.typeName ? ": " + reference.typeName : "")
        },
        range
    };
}

/**
 * Подсказка параметров по разрешённой ссылке.
 *
 * Подпись есть только у процедур и методов: поле, вызванное как процедура,
 * подсказки не даёт — прежде `thing.Field(` показывал `Field(): string`.
 */
export function buildRslReferenceSignatureHelp(
    context: IRslInteractiveContext,
    reference: IRslReference,
    activeParameter: number
): SignatureHelp | undefined {
    const signature = referenceSignature(context, reference);

    if (!signature) {
        return undefined;
    }

    const count = signature.parameters?.length || 0;

    return {
        signatures: [signature],
        activeSignature: 0,
        activeParameter: count === 0
            ? 0
            : Math.min(activeParameter, count - 1)
    };
}

/** Переход к объявлению по разрешённой ссылке; undefined — места не знаем. */
export function findRslReferenceDefinition(
    context: IRslInteractiveContext,
    index: WorkspaceIndex,
    reference: IRslReference
): Location | undefined {
    if (reference.imported) {
        return symbolLocation(index, reference.imported);
    }

    const member = reference.member;

    if (member?.symbol && member.moduleUri) {
        return symbolLocation(index, {
            uri: member.moduleUri,
            symbolId: member.symbol.id,
            symbol: member.symbol
        });
    }

    if (reference.declarationStart >= 0) {
        const position = context.document.positionAt(
            reference.declarationStart
        );

        return Location.create(context.uri, {
            start: position,
            end: position
        });
    }

    return undefined;
}

/** Переход к классу типа по разрешённой ссылке. */
export function findRslReferenceTypeDefinition(
    context: IRslInteractiveContext,
    index: WorkspaceIndex,
    resolver: RslScopeResolver,
    reference: IRslReference
): Location | undefined {
    const typeName = reference.typeName;

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

    if (declaration.nameStart !== undefined) {
        return Location.create(declaration.moduleUri, {
            start: context.document.positionAt(declaration.nameStart),
            end: context.document.positionAt(
                declaration.nameEnd ?? declaration.nameStart
            )
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

/**
 * Переход по имени модуля в `Import`.
 *
 * Отдельно от разрешения имён: это не ссылка на символ, а имя файла, и знает о
 * нём каталог проекта.
 */
/**
 * Переход к файлу модуля из директивы Import.
 *
 * Имя файла в проекте бывает не одно: в проверенном проекте макросов таких
 * имён семьдесят три. Прежде такой переход не работал вовсе — увести в один из
 * двух файлов наугад хуже, чем не уводить никуда. Теперь показываются все
 * подходящие файлы, и выбирает человек.
 */
export function findRslImportModuleDefinition(
    context: IRslInteractiveContext,
    index: WorkspaceIndex
): Location | Location[] | undefined {
    const target = GetImportDefinitionTargetFromTokens(
        context.tokens as IRslToken[],
        context.offset
    );

    if (!target) {
        return undefined;
    }

    const resolution = index.resolveWorkspaceFile(target.moduleName);

    if (resolution.kind === "resolved") {
        return fileStartLocation(resolution.value);
    }

    if (resolution.kind !== "ambiguous" || resolution.candidates.length === 0) {
        return undefined;
    }

    /* Порядок ответа не зависит от порядка обхода проекта. */
    return [...resolution.candidates]
        .sort()
        .map(uri => fileStartLocation(uri));
}

/** Начало файла: у макромодуля нет объявления, к которому можно было бы вести. */
function fileStartLocation(uri: string): Location {
    return Location.create(uri, {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 }
    });
}

/** Переход по строковой ссылке: ExecMacro, ExecMacro2, ExecMacroFile. */
export function findRslDynamicDefinition(
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

/** Вызов и номер аргумента в позиции курсора. */
export function findRslCallAt(
    context: IRslInteractiveContext
): { callee: IRslToken; activeParameter: number } | undefined {
    return findRslCallContext(context.tokens, context.offset);
}

/** Тип имени под курсором, когда сам символ ссылкой не разрешился. */
export function typeNameOfOwnClass(
    context: IRslInteractiveContext,
    resolver: RslScopeResolver,
    token: IRslToken
): string {
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
    return findRslClassDeclaration(token.value, chainOptions(context, resolver))
        ? token.value
        : "";
}

function referenceSignature(
    context: IRslInteractiveContext,
    reference: IRslReference
): SignatureInformation | undefined {
    if (!reference.isCallable) {
        return undefined;
    }

    if (reference.signature) {
        return fastSignatureInformation(context, reference.signature);
    }

    const symbol = reference.member?.symbol || reference.imported?.symbol;

    return symbol ? createSignatureInformation(symbol) : undefined;
}

/**
 * Подпись по записи индекса версии.
 *
 * Параметры и тип результата разбираются здесь, а не при построении индекса:
 * нужны они одному запросу из тысяч, а храниться пришлось бы для всех процедур
 * файла.
 */
function fastSignatureInformation(
    context: IRslInteractiveContext,
    signature: IFastSignature
): SignatureInformation {
    const parsed = readRslFastSignature(context.fastIndex, signature);
    const returnType = parsed.returnType &&
        normalizeIdentifier(parsed.returnType) !== "variant"
        ? ": " + parsed.returnType
        : "";

    return {
        label: signature.name + "(" + parsed.parameters.join(", ") + ")" +
            returnType,
        parameters: parsed.parameters.map(label => ({ label }))
    };
}

function signatureLabel(
    context: IRslInteractiveContext,
    signature: IFastSignature
): string {
    return fastSignatureInformation(context, signature).label;
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

    /*
     * Модуль не прочитан или процедуры в нём нет: переход не отдаётся вовсе.
     * Прежде он вёл в первую строку файла, и по нему нельзя было понять, есть
     * ли там такая процедура.
     */
    return module && found
        ? symbolLocation(index, {
            uri: module.uri,
            symbolId: found.id,
            symbol: found
        })
        : undefined;
}

function symbolLocation(
    index: WorkspaceIndex,
    symbol: IIndexedSymbol
): Location | undefined {
    const range = index.getDefinitionRange(symbol.uri, symbol.symbol);

    return Location.create(symbol.uri, range || {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 }
    });
}

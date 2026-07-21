import * as path from "path";
import { fileURLToPath } from "url";

import {
    CompletionItemKind,
    Diagnostic,
    DiagnosticSeverity,
    DiagnosticTag
} from "vscode-languageserver";

import { CBase, KEYWORDS, TYPES } from "./common";
import { RslScopeResolver } from "./scopeResolver";
import {
    GetDynamicMacroReferencesFromTokens,
    GetImportDefinitionTargetsFromTokens,
    IImportDefinitionTarget
} from "./execMacroDefinition";
import {
    IRslDiagnosticSettings
} from "./interfaces";
import {
    IRslToken,
    normalizeIdentifier,
    significantTokens
} from "./lexer";
import {
    IIndexedModule,
    WorkspaceIndex
} from "./workspaceIndex";

interface IBlockEntry {
    keyword: string;
    token: IRslToken;
    hasElse: boolean;
}

interface IDeclarationInfo {
    object: CBase;
    scope: CBase;
    parameter: boolean;
}

interface IDiagnosticData {
    start?: number;
    end?: number;
    name?: string;
    parameter?: boolean;
    moduleName?: string;
}

const BLOCK_START = new Set(["macro", "class", "if", "for", "while"]);
const END_KEYWORD = "end";
const MODIFIERS = new Set(["private", "local", "public"]);
const VARIABLE_KINDS = new Set<number>([
    CompletionItemKind.Variable,
    CompletionItemKind.Constant
]);
const RESERVED_IDENTIFIERS = new Set([
    "true",
    "false",
    "null",
    "undefined",
    "v_undef"
]);

export const DEFAULT_DIAGNOSTIC_SETTINGS: Required<IRslDiagnosticSettings> = {
    enabled: true,
    deprecatedDeclarations: true,
    structure: true,
    unusedVariables: true,
    unusedImports: true,
    debugBreak: true,
    useBeforeDeclaration: true,
    ambiguousReferences: true,
    maxProblems: 200
};

export function normalizeDiagnosticSettings(
    settings?: IRslDiagnosticSettings
): Required<IRslDiagnosticSettings> {
    return {
        enabled: settings?.enabled !== false,
        deprecatedDeclarations:
            settings?.deprecatedDeclarations !== false,
        structure: settings?.structure !== false,
        unusedVariables: settings?.unusedVariables !== false,
        unusedImports: settings?.unusedImports !== false,
        debugBreak: settings?.debugBreak !== false,
        useBeforeDeclaration:
            settings?.useBeforeDeclaration !== false,
        ambiguousReferences:
            settings?.ambiguousReferences !== false,
        maxProblems:
            typeof settings?.maxProblems === "number"
                ? Math.max(0, Math.floor(settings.maxProblems))
                : DEFAULT_DIAGNOSTIC_SETTINGS.maxProblems
    };
}

/**
 * Единая точка построения диагностик RSL.
 * Проверки используют уже готовые lexer/AST/workspace index и не читают файлы.
 */
export function buildRslDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    settings?: IRslDiagnosticSettings
): Diagnostic[] {
    const options = normalizeDiagnosticSettings(settings);

    if (!options.enabled || options.maxProblems === 0) {
        return [];
    }

    const result: Diagnostic[] = [];

    addSyntaxParserDiagnostics(module, result);

    if (options.deprecatedDeclarations) {
        addDeprecatedDeclarationDiagnostics(module, result);
    }

    if (options.structure) {
        addUnterminatedTokenDiagnostics(module, result);
        addBracketDiagnostics(module, result);
        addEndDiagnostics(module, result);
        addDuplicateDeclarationDiagnostics(module, result);
        addBasicImportDiagnostics(module, index, result);
    }

    if (options.debugBreak) {
        addDebugBreakDiagnostics(module, result);
    }

    if (options.unusedVariables) {
        addUnusedDeclarationDiagnostics(module, index, result);
    }

    if (options.useBeforeDeclaration) {
        addUseBeforeDeclarationDiagnostics(module, index, result);
    }

    if (options.ambiguousReferences) {
        addAmbiguousReferenceDiagnostics(module, index, result);
    }

    if (options.unusedImports) {
        addUnusedImportDiagnostics(module, index, result);
    }

    return deduplicateDiagnostics(result).slice(0, options.maxProblems);
}


function addSyntaxParserDiagnostics(
    module: IIndexedModule,
    result: Diagnostic[]
): void {
    module.syntax.diagnostics.forEach(item => {
        result.push(createOffsetDiagnostic(
            module,
            item.start,
            item.end,
            DiagnosticSeverity.Error,
            item.message,
            item.code
        ));
    });
}

function addDeprecatedDeclarationDiagnostics(
    module: IIndexedModule,
    result: Diagnostic[]
): void {
    for (const token of module.lex.tokens) {
        if (token.kind !== "identifier") {
            continue;
        }

        const word = normalizeIdentifier(token.value);

        if (word !== "record" && word !== "array") {
            continue;
        }

        result.push(createTokenDiagnostic(
            token,
            DiagnosticSeverity.Information,
            `Определение ${word.toUpperCase()} устарело, ` +
                "от него желательно избавляться по возможности",
            "deprecated-declaration"
        ));
    }
}

function addDebugBreakDiagnostics(
    module: IIndexedModule,
    result: Diagnostic[]
): void {
    for (const token of module.lex.tokens) {
        if (
            token.kind !== "identifier" ||
            normalizeIdentifier(token.value) !== "debugbreak"
        ) {
            continue;
        }

        result.push(createTokenDiagnostic(
            token,
            DiagnosticSeverity.Warning,
            "В коде оставлен DEBUGBREAK",
            "debugbreak",
            false,
            {
                start: token.start,
                end: token.end
            }
        ));
    }
}

function addUnterminatedTokenDiagnostics(
    module: IIndexedModule,
    result: Diagnostic[]
): void {
    for (const token of module.lex.tokens) {
        if (token.kind === "string" && !isClosedString(token.raw)) {
            result.push(createTokenDiagnostic(
                token,
                DiagnosticSeverity.Error,
                "Строковый литерал не закрыт",
                "unclosed-string"
            ));
        } else if (
            token.kind === "comment" &&
            token.raw.startsWith("/*") &&
            !token.raw.endsWith("*/")
        ) {
            result.push(createTokenDiagnostic(
                token,
                DiagnosticSeverity.Error,
                "Многострочный комментарий не закрыт",
                "unclosed-comment"
            ));
        } else if (
            token.kind === "square" &&
            !isClosedSquareBlock(token.raw)
        ) {
            result.push(createTokenDiagnostic(
                token,
                DiagnosticSeverity.Error,
                "Блок [ ... ] не закрыт символом ]",
                "unclosed-square-block"
            ));
        }
    }
}

function addBracketDiagnostics(
    module: IIndexedModule,
    result: Diagnostic[]
): void {
    const stacks: { [close: string]: IRslToken[] } = {
        ")": [],
        "}": []
    };
    const pair: { [open: string]: string } = {
        "(": ")",
        "{": "}"
    };
    const openingFor: { [close: string]: string } = {
        ")": "(",
        "}": "{"
    };

    for (const token of significantTokens(module.lex.tokens)) {
        if (token.kind !== "symbol") {
            continue;
        }

        const close = pair[token.raw];

        if (close) {
            stacks[close].push(token);
            continue;
        }

        if (!stacks[token.raw]) {
            continue;
        }

        const opening = stacks[token.raw].pop();

        if (!opening) {
            result.push(createTokenDiagnostic(
                token,
                DiagnosticSeverity.Error,
                `Лишняя закрывающая скобка ${token.raw}`,
                "extra-closing-bracket",
                false,
                {
                    start: token.start,
                    end: token.end
                }
            ));
        }
    }

    Object.keys(stacks).forEach(close => {
        stacks[close].forEach(opening => {
            result.push(createTokenDiagnostic(
                opening,
                DiagnosticSeverity.Error,
                `Для скобки ${openingFor[close]} не найдена закрывающая ${close}`,
                "missing-closing-bracket"
            ));
        });
    });
}

function addEndDiagnostics(
    module: IIndexedModule,
    result: Diagnostic[]
): void {
    const tokens = significantTokens(module.lex.tokens);
    const stack: IBlockEntry[] = [];
    let canStartBlock = true;
    let currentLine = -1;

    for (const token of tokens) {
        if (token.line !== currentLine) {
            currentLine = token.line;
            canStartBlock = true;
        }

        if (token.kind !== "identifier") {
            if (token.kind === "symbol" && token.raw === ";") {
                canStartBlock = true;
            } else {
                canStartBlock = false;
            }
            continue;
        }

        const word = normalizeIdentifier(token.value);

        if (word === END_KEYWORD) {
            if (stack.length === 0) {
                result.push(createTokenDiagnostic(
                    token,
                    DiagnosticSeverity.Error,
                    "Лишний END: нет открытого блока",
                    "extra-end",
                    false,
                    {
                        start: token.start,
                        end: token.end
                    }
                ));
            } else {
                stack.pop();
            }

            canStartBlock = true;
            continue;
        }

        if (canStartBlock && (word === "elif" || word === "else")) {
            const currentIf = stack.length > 0
                ? stack[stack.length - 1]
                : undefined;

            if (!currentIf || currentIf.keyword !== "if") {
                result.push(createTokenDiagnostic(
                    token,
                    DiagnosticSeverity.Error,
                    `${word.toUpperCase()} используется без соответствующего IF`,
                    "branch-without-if"
                ));
            } else if (word === "else") {
                if (currentIf.hasElse) {
                    result.push(createTokenDiagnostic(
                        token,
                        DiagnosticSeverity.Error,
                        "Повторный ELSE в одном блоке IF",
                        "duplicate-else",
                        false,
                        {
                            start: token.start,
                            end: token.end
                        }
                    ));
                } else {
                    currentIf.hasElse = true;
                }
            } else if (currentIf.hasElse) {
                result.push(createTokenDiagnostic(
                    token,
                    DiagnosticSeverity.Error,
                    "ELIF не может располагаться после ELSE",
                    "elif-after-else"
                ));
            }

            canStartBlock = false;
            continue;
        }

        if (canStartBlock && word === "onerror") {
            const insideMacro = stack.some(item => item.keyword === "macro");

            if (!insideMacro) {
                result.push(createTokenDiagnostic(
                    token,
                    DiagnosticSeverity.Warning,
                    "ONERROR находится вне блока MACRO",
                    "onerror-outside-macro"
                ));
            }

            canStartBlock = false;
            continue;
        }

        if (!canStartBlock) {
            continue;
        }

        if (MODIFIERS.has(word)) {
            continue;
        }

        canStartBlock = false;

        if (BLOCK_START.has(word)) {
            stack.push({
                keyword: word,
                token,
                hasElse: false
            });
        }
    }

    stack.reverse().forEach(block => {
        result.push(createTokenDiagnostic(
            block.token,
            DiagnosticSeverity.Error,
            `Для блока ${block.keyword.toUpperCase()} не найден закрывающий END`,
            "missing-end"
        ));
    });
}

function addUnusedDeclarationDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    result: Diagnostic[]
): void {
    const code = significantTokens(module.lex.tokens);
    const declarations = collectDeclarations(module, code);
    const identifierIndex = buildIdentifierIndex(code);
    const declarationRanges = declarations.map(item => item.object.Range);
    const resolver = new RslScopeResolver(index);

    for (const declaration of declarations) {
        const object = declaration.object;
        const scope = declaration.scope;
        const isLocal = scope.ObjKind === CompletionItemKind.Function ||
            scope.ObjKind === CompletionItemKind.Method;
        const isPrivateModuleDeclaration =
            scope.ObjKind === CompletionItemKind.Unit && object.Private;

        /*
         * Публичные глобальные объекты и свойства класса могут использоваться
         * внешней средой или импортирующими файлами.
         */
        if (!isLocal && !isPrivateModuleDeclaration) {
            continue;
        }

        const name = normalizeIdentifier(object.Name);
        const used = (identifierIndex.get(name) || []).some(token => {
            if (
                token.start < scope.Range.start ||
                token.end > scope.Range.end ||
                declarationRanges.some(range =>
                    sameRange(token.start, token.end, range.start, range.end)
                )
            ) {
                return false;
            }

            const resolved = resolver.resolveAt(
                module.uri,
                module.object,
                token.start
            );

            return !!resolved &&
                resolved.uri === module.uri &&
                resolved.object === object;
        });

        if (used) {
            continue;
        }

        const kind = declaration.parameter
            ? "Параметр"
            : object.ObjKind === CompletionItemKind.Constant
                ? "Константа"
                : "Переменная";
        const declared = kind === "Параметр" ? "объявлен" : "объявлена";
        const range = findObjectNameRange(module, object);

        result.push(createOffsetDiagnostic(
            module,
            range.start,
            range.end,
            DiagnosticSeverity.Warning,
            `${kind} ${object.Name} ${declared}, но не используется`,
            "unused-declaration",
            true,
            {
                start: range.start,
                end: range.end,
                name: object.Name,
                parameter: declaration.parameter
            }
        ));
    }
}

function addUseBeforeDeclarationDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    result: Diagnostic[]
): void {
    const code = significantTokens(module.lex.tokens);
    const declarations = collectDeclarations(module, code);
    const identifierIndex = buildIdentifierIndex(code);
    const declarationRanges = declarations.map(item => item.object.Range);
    const resolver = new RslScopeResolver(index);

    for (const declaration of declarations) {
        const scope = declaration.scope;

        if (
            declaration.parameter ||
            (
                scope.ObjKind !== CompletionItemKind.Function &&
                scope.ObjKind !== CompletionItemKind.Method
            )
        ) {
            continue;
        }

        const object = declaration.object;

        /*
         * Повреждённое или неоднозначное дерево не должно превращать
         * служебные слова RSL (IF, VAR и т. п.) в объявления переменных.
         */
        if (isReservedIdentifier(object.Name)) {
            continue;
        }

        const name = normalizeIdentifier(object.Name);
        const nestedScopes = scope.getChilds()
            .filter(child => child.isObject());
        const use = (identifierIndex.get(name) || []).find(token => {
            if (
                token.start < scope.Range.start ||
                token.start >= object.Range.start ||
                declarationRanges.some(range =>
                    sameRange(token.start, token.end, range.start, range.end)
                ) ||
                isMemberName(code, token) ||
                nestedScopes.some(child =>
                    child !== scope &&
                    child.Range.start <= token.start &&
                    token.end <= child.Range.end
                )
            ) {
                return false;
            }

            const resolved = resolver.resolveAt(
                module.uri,
                module.object,
                token.start
            );

            return !resolved;
        });

        if (!use) {
            continue;
        }

        result.push(createTokenDiagnostic(
            use,
            DiagnosticSeverity.Error,
            `Переменная ${object.Name} используется до объявления`,
            "use-before-declaration",
            false,
            {
                start: use.start,
                end: use.end,
                name: object.Name
            }
        ));
    }
}

function addDuplicateDeclarationDiagnostics(
    module: IIndexedModule,
    result: Diagnostic[]
): void {
    walkScopes(module.object, scope => {
        const byName = new Map<string, CBase[]>();

        for (const child of scope.getChilds()) {
            const name = normalizeIdentifier(child.Name);

            if (!name) {
                continue;
            }

            const list = byName.get(name) || [];
            list.push(child);
            byName.set(name, list);
        }

        byName.forEach(items => {
            if (items.length < 2) {
                return;
            }

            items.slice(1).forEach(item => {
                const nameRange = findObjectNameRange(module, item);
                result.push(createOffsetDiagnostic(
                    module,
                    nameRange.start,
                    nameRange.end,
                    DiagnosticSeverity.Warning,
                    `Имя ${item.Name} повторно объявлено в той же области видимости`,
                    "duplicate-declaration"
                ));
            });
        });
    });
}

function addBasicImportDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    result: Diagnostic[]
): void {
    const references = GetImportDefinitionTargetsFromTokens(module.lex.tokens);
    const seenImports = new Set<string>();

    for (const reference of references) {
        const normalizedImport = normalizeModuleReference(reference.moduleName);

        if (seenImports.has(normalizedImport)) {
            result.push(createImportDiagnostic(
                module,
                reference,
                DiagnosticSeverity.Information,
                `Модуль ${reference.moduleName} импортирован повторно`,
                "duplicate-import",
                true,
                {
                    start: reference.start,
                    end: reference.end,
                    moduleName: reference.moduleName
                }
            ));
        } else {
            seenImports.add(normalizedImport);
        }

        const imported = index.findModuleByName(reference.moduleName);
        const workspaceUri = index.findWorkspaceFileUri(reference.moduleName);

        if ((imported && imported.uri === module.uri) || workspaceUri === module.uri) {
            result.push(createImportDiagnostic(
                module,
                reference,
                DiagnosticSeverity.Warning,
                `Файл импортирует сам себя: ${reference.moduleName}`,
                "self-import"
            ));
        }

        /*
         * Отсутствие файла в workspace не является ошибкой:
         * модуль может входить в базовую поставку RS-Bank.
         */
    }
}

function addUnusedImportDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    result: Diagnostic[]
): void {
    const references = GetImportDefinitionTargetsFromTokens(module.lex.tokens);
    const dynamicMacroNames = GetDynamicMacroReferencesFromTokens(module.lex.tokens);
    const importInfos: Array<{
        reference: IImportDefinitionTarget;
        closureUris: Set<string>;
        publicNames: Set<string>;
    }> = [];

    for (const reference of references) {
        const imported = index.findModuleByName(reference.moduleName);

        /* Проверяем только модули, известные текущему проекту. */
        if (!imported || imported.uri === module.uri) {
            continue;
        }

        const closure = [
            imported,
            ...index.getImportedModules(imported.uri)
        ];
        const closureUris = new Set(closure.map(item => item.uri));
        const publicNames = new Set<string>();

        closure.forEach(item => {
            item.object.getChilds()
                .filter(child => !child.Private)
                .filter(child =>
                    child.ObjKind === CompletionItemKind.Variable ||
                    child.ObjKind === CompletionItemKind.Constant ||
                    child.ObjKind === CompletionItemKind.Function ||
                    child.ObjKind === CompletionItemKind.Class
                )
                .forEach(child =>
                    publicNames.add(normalizeIdentifier(child.Name))
                );
        });

        importInfos.push({
            reference,
            closureUris,
            publicNames
        });
    }

    const allPublicNames = new Set<string>();
    importInfos.forEach(info =>
        info.publicNames.forEach(name => allPublicNames.add(name))
    );

    const resolver = new RslScopeResolver(index);
    const usedImportedUris = new Set<string>();

    module.lex.tokens
        .filter(token => token.kind === "identifier")
        .filter(token => !references.some(reference =>
            reference.start <= token.start && token.end <= reference.end
        ))
        .filter(token =>
            allPublicNames.has(normalizeIdentifier(token.value))
        )
        .forEach(token => {
            const candidates = index.findImportedSymbols(
                module.uri,
                token.value
            );

            if (candidates.length > 1) {
                candidates.forEach(candidate =>
                    usedImportedUris.add(candidate.uri)
                );
                return;
            }

            const resolved = resolver.resolveAt(
                module.uri,
                module.object,
                token.start
            );

            if (resolved && resolved.uri !== module.uri) {
                usedImportedUris.add(resolved.uri);
            }
        });

    dynamicMacroNames.forEach(name => {
        index.findImportedSymbols(module.uri, name)
            .forEach(resolved => usedImportedUris.add(resolved.uri));
    });

    importInfos.forEach(info => {
        /* Модуль без публичных объявлений может импортироваться ради side effects. */
        if (info.publicNames.size === 0) {
            return;
        }

        const used = Array.from(info.closureUris)
            .some(uri => usedImportedUris.has(uri));

        if (used) {
            return;
        }

        result.push(createImportDiagnostic(
            module,
            info.reference,
            DiagnosticSeverity.Warning,
            `Импорт ${info.reference.moduleName}, возможно, не используется`,
            "unused-import",
            true,
            {
                start: info.reference.start,
                end: info.reference.end,
                moduleName: info.reference.moduleName
            }
        ));
    });
}

function addAmbiguousReferenceDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    result: Diagnostic[]
): void {
    const importedModules = index.getImportedModules(module.uri);
    const byName = new Map<string, Array<{ uri: string; object: CBase }>>();

    importedModules.forEach(imported => {
        imported.object.getChilds()
            .filter(child => !child.Private)
            .forEach(child => {
                const name = normalizeIdentifier(child.Name);
                const list = byName.get(name) || [];

                if (!list.some(item =>
                    item.uri === imported.uri && item.object === child
                )) {
                    list.push({
                        uri: imported.uri,
                        object: child
                    });
                }

                byName.set(name, list);
            });
    });

    const ambiguous = new Map<string, Array<{ uri: string; object: CBase }>>();
    byName.forEach((items, name) => {
        if (items.length > 1) {
            ambiguous.set(name, items);
        }
    });

    if (ambiguous.size === 0) {
        return;
    }

    const code = significantTokens(module.lex.tokens);
    const resolver = new RslScopeResolver(index);
    const importReferences = GetImportDefinitionTargetsFromTokens(module.lex.tokens);
    const declarationRanges = collectAllObjectRanges(module.object);

    for (const token of code) {
        if (token.kind !== "identifier") {
            continue;
        }

        const name = normalizeIdentifier(token.value);
        const candidates = ambiguous.get(name);

        if (
            !candidates ||
            declarationRanges.some(range =>
                sameRange(token.start, token.end, range.start, range.end)
            ) ||
            importReferences.some(reference =>
                reference.start <= token.start && token.end <= reference.end
            ) ||
            isMemberName(code, token) ||
            resolver.resolveInScopeChain(
                module.object,
                token.value,
                token.start
            )
        ) {
            continue;
        }

        const moduleNames = candidates
            .map(candidate => formatModuleName(candidate.uri))
            .filter((value, position, all) => all.indexOf(value) === position)
            .sort();

        result.push(createTokenDiagnostic(
            token,
            DiagnosticSeverity.Error,
            `Ссылка ${token.value} неоднозначна: ` +
                `символ объявлен в ${moduleNames.join(", ")}`,
            "ambiguous-reference",
            false,
            {
                start: token.start,
                end: token.end,
                name: token.value
            }
        ));
    }
}

function collectDeclarations(
    module: IIndexedModule,
    codeTokens: IRslToken[]
): IDeclarationInfo[] {
    const result: IDeclarationInfo[] = [];
    const signatureRanges = new Map<
        CBase,
        { start: number; end: number } | undefined
    >();

    walkScopes(module.object, scope => {
        if (
            scope.ObjKind === CompletionItemKind.Function ||
            scope.ObjKind === CompletionItemKind.Method
        ) {
            signatureRanges.set(
                scope,
                findSignatureRange(codeTokens, scope)
            );
        }

        for (const child of scope.getChilds()) {
            if (
                !VARIABLE_KINDS.has(child.ObjKind) ||
                isReservedIdentifier(child.Name)
            ) {
                continue;
            }

            const signature = signatureRanges.get(scope);

            result.push({
                object: child,
                scope,
                parameter: !!signature &&
                    signature.start < child.Range.start &&
                    child.Range.end <= signature.end
            });
        }
    });

    return result;
}

function buildIdentifierIndex(
    tokens: IRslToken[]
): Map<string, IRslToken[]> {
    const result = new Map<string, IRslToken[]>();

    for (const token of tokens) {
        if (token.kind !== "identifier") {
            continue;
        }

        const name = normalizeIdentifier(token.value);

        if (isReservedIdentifier(name)) {
            continue;
        }

        const list = result.get(name) || [];
        list.push(token);
        result.set(name, list);
    }

    return result;
}

function isReservedIdentifier(value: string): boolean {
    const normalized = normalizeIdentifier(value);

    if (!normalized) {
        return true;
    }

    return KEYWORDS.is(normalized).first ||
        TYPES.is(normalized).first ||
        RESERVED_IDENTIFIERS.has(normalized);
}


function findSignatureRange(
    tokens: IRslToken[],
    scope: CBase
): { start: number; end: number } | undefined {
    let start = -1;
    let depth = 0;

    for (const token of tokens) {
        if (token.start < scope.Range.start) {
            continue;
        }

        if (token.start > scope.Range.end) {
            break;
        }

        if (token.kind !== "symbol") {
            continue;
        }

        if (token.raw === "(") {
            if (start < 0) {
                start = token.start;
            }

            depth++;
            continue;
        }

        if (token.raw === ")" && start >= 0 && depth > 0) {
            depth--;

            if (depth === 0) {
                return {
                    start,
                    end: token.end
                };
            }
        }
    }

    return undefined;
}

function walkScopes(root: CBase, action: (scope: CBase) => void): void {
    action(root);

    root.getChilds().forEach(child => {
        if (child.isObject()) {
            walkScopes(child, action);
        }
    });
}

function collectAllObjectRanges(
    root: CBase
): Array<{ start: number; end: number }> {
    const result: Array<{ start: number; end: number }> = [];

    walkScopes(root, scope => {
        scope.getChilds().forEach(child => {
            result.push(child.Range);
        });
    });

    return result;
}

function isMemberName(tokens: IRslToken[], token: IRslToken): boolean {
    const index = tokens.indexOf(token);

    if (index <= 0) {
        return false;
    }

    const previous = tokens[index - 1];
    return previous.kind === "symbol" && previous.raw === ".";
}

function isClosedSquareBlock(raw: string): boolean {
    let depth = 0;
    let quote = "";

    for (let index = 0; index < raw.length; index++) {
        const char = raw.charAt(index);
        const next = raw.charAt(index + 1);

        if (quote) {
            if (char === quote) {
                if (next === quote) {
                    index++;
                } else {
                    quote = "";
                }
            }
            continue;
        }

        if (char === "'" || char === "\"") {
            quote = char;
            continue;
        }

        if ((char === "-" && next === "-") || (char === "/" && next === "/")) {
            while (
                index < raw.length &&
                raw.charAt(index) !== "\r" &&
                raw.charAt(index) !== "\n"
            ) {
                index++;
            }
            continue;
        }

        if (char === "/" && next === "*") {
            index += 2;
            while (
                index < raw.length - 1 &&
                !(raw.charAt(index) === "*" && raw.charAt(index + 1) === "/")
            ) {
                index++;
            }
            index++;
            continue;
        }

        if (char === "[") {
            depth++;
        } else if (char === "]") {
            depth--;
            if (depth === 0) {
                return true;
            }
        }
    }

    return false;
}

function normalizeModuleReference(value: string): string {
    return (value || "")
        .trim()
        .replace(/\\/g, "/")
        .toLowerCase();
}

function formatModuleName(uri: string): string {
    try {
        return path.basename(fileURLToPath(uri));
    } catch (_error) {
        return path.posix.basename(uri.replace(/\\/g, "/"));
    }
}

function isClosedString(raw: string): boolean {
    if (raw.length < 2) {
        return false;
    }

    const quote = raw.charAt(0);

    if (raw.charAt(raw.length - 1) !== quote) {
        return false;
    }

    let backslashes = 0;

    for (
        let index = raw.length - 2;
        index >= 0 && raw.charAt(index) === "\\";
        index--
    ) {
        backslashes++;
    }

    return backslashes % 2 === 0;
}

function findObjectNameRange(
    module: IIndexedModule,
    object: CBase
): { start: number; end: number } {
    const normalized = normalizeIdentifier(object.Name);
    const token = module.lex.tokens.find(candidate =>
        candidate.kind === "identifier" &&
        candidate.start >= object.Range.start &&
        candidate.end <= object.Range.end &&
        normalizeIdentifier(candidate.value) === normalized
    );

    return token
        ? { start: token.start, end: token.end }
        : object.Range;
}

function createImportDiagnostic(
    module: IIndexedModule,
    reference: IImportDefinitionTarget,
    severity: DiagnosticSeverity,
    message: string,
    code: string,
    unnecessary: boolean = false,
    data?: IDiagnosticData
): Diagnostic {
    return createOffsetDiagnostic(
        module,
        reference.start,
        reference.end,
        severity,
        message,
        code,
        unnecessary,
        data
    );
}

function createTokenDiagnostic(
    token: IRslToken,
    severity: DiagnosticSeverity,
    message: string,
    code: string,
    unnecessary: boolean = false,
    data?: IDiagnosticData
): Diagnostic {
    const diagnostic: Diagnostic = {
        severity,
        range: {
            start: {
                line: token.line,
                character: token.character
            },
            end: {
                line: token.endLine,
                character: token.endCharacter
            }
        },
        message,
        source: "RSL parser",
        code,
        data
    };

    if (unnecessary) {
        diagnostic.tags = [DiagnosticTag.Unnecessary];
    }

    return diagnostic;
}

function createOffsetDiagnostic(
    module: IIndexedModule,
    start: number,
    end: number,
    severity: DiagnosticSeverity,
    message: string,
    code: string,
    unnecessary: boolean = false,
    data?: IDiagnosticData
): Diagnostic {
    const diagnostic: Diagnostic = {
        severity,
        range: {
            start: positionAt(module, start),
            end: positionAt(module, Math.max(start + 1, end))
        },
        message,
        source: "RSL parser",
        code,
        data
    };

    if (unnecessary) {
        diagnostic.tags = [DiagnosticTag.Unnecessary];
    }

    return diagnostic;
}

function positionAt(
    module: IIndexedModule,
    offset: number
): { line: number; character: number } {
    const starts = module.lex.lineStarts;
    let left = 0;
    let right = starts.length - 1;
    let line = 0;

    while (left <= right) {
        const middle = Math.floor((left + right) / 2);

        if (starts[middle] <= offset) {
            line = middle;
            left = middle + 1;
        } else {
            right = middle - 1;
        }
    }

    return {
        line,
        character: Math.max(0, offset - starts[line])
    };
}

function sameRange(
    start1: number,
    end1: number,
    start2: number,
    end2: number
): boolean {
    return start1 === start2 && end1 === end2;
}

function deduplicateDiagnostics(items: Diagnostic[]): Diagnostic[] {
    const result: Diagnostic[] = [];
    const seen = new Set<string>();

    for (const item of items) {
        const key = [
            item.code,
            item.range.start.line,
            item.range.start.character,
            item.range.end.line,
            item.range.end.character
        ].join(":");

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(item);
    }

    return result;
}

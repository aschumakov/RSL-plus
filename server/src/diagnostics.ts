import {
    CompletionItemKind,
    Diagnostic,
    DiagnosticSeverity,
    DiagnosticTag
} from "vscode-languageserver";

import { CBase } from "./common";
import { RslScopeResolver } from "./scopeResolver";
import {
    GetDynamicMacroReferencesFromTokens,
    GetImportDefinitionTargetsFromTokens,
    IImportDefinitionTarget
} from "./execMacroDefinition";
import {
    IRslToken,
    normalizeIdentifier,
    significantTokens
} from "./lexer";
import {
    BLOCK_START_KEYWORDS,
    END_KEYWORD
} from "./languageMetadata";
import {
    IIndexedModule,
    WorkspaceIndex
} from "./workspaceIndex";


interface IBlockEntry {
    keyword: string;
    token: IRslToken;
}

interface IDeclarationInfo {
    object: CBase;
    scope: CBase;
    parameter: boolean;
}

const BLOCK_START = new Set(BLOCK_START_KEYWORDS);
const MODIFIERS = new Set(["private", "local", "public"]);
const VARIABLE_KINDS = new Set<number>([
    CompletionItemKind.Variable,
    CompletionItemKind.Constant
]);

/**
 * Единая точка построения диагностик RSL.
 * Проверки используют уже готовые lexer/AST/workspace index и не читают файлы.
 */
export function buildRslDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex
): Diagnostic[] {
    const result: Diagnostic[] = [];

    addDeprecatedDeclarationDiagnostics(module, result);
    addUnterminatedTokenDiagnostics(module, result);
    addBracketDiagnostics(module, result);
    addEndDiagnostics(module, result);
    addUnusedDeclarationDiagnostics(module, result);
    addDuplicateDeclarationDiagnostics(module, result);
    addImportDiagnostics(module, index, result);

    return deduplicateDiagnostics(result);
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
                "extra-closing-bracket"
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

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

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
                    "extra-end"
                ));
            } else {
                stack.pop();
            }

            canStartBlock = true;
            continue;
        }

        if (canStartBlock && (word === "elif" || word === "else")) {
            if (stack.length === 0 || stack[stack.length - 1].keyword !== "if") {
                result.push(createTokenDiagnostic(
                    token,
                    DiagnosticSeverity.Error,
                    `${word.toUpperCase()} используется без соответствующего IF`,
                    "branch-without-if"
                ));
            }

            canStartBlock = false;
            continue;
        }

        if (canStartBlock && word === "onerror") {
            if (stack.length === 0 || stack[stack.length - 1].keyword !== "macro") {
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
            stack.push({ keyword: word, token });
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
    result: Diagnostic[]
): void {
    const code = significantTokens(module.lex.tokens);
    const declarations = collectDeclarations(module, code);
    const identifierIndex = new Map<string, IRslToken[]>();
    const declarationRanges = new Map<CBase, Map<string, Array<{ start: number; end: number }>>>();

    for (const token of code) {
        if (token.kind !== "identifier") {
            continue;
        }

        const name = normalizeIdentifier(token.value);
        const list = identifierIndex.get(name) || [];
        list.push(token);
        identifierIndex.set(name, list);
    }

    for (const declaration of declarations) {
        const scopeMap = declarationRanges.get(declaration.scope) ||
            new Map<string, Array<{ start: number; end: number }>>();
        const name = normalizeIdentifier(declaration.object.Name);
        const ranges = scopeMap.get(name) || [];
        ranges.push(declaration.object.Range);
        scopeMap.set(name, ranges);
        declarationRanges.set(declaration.scope, scopeMap);
    }

    for (const declaration of declarations) {
        const object = declaration.object;
        const scope = declaration.scope;
        const isLocal = scope.ObjKind === CompletionItemKind.Function ||
            scope.ObjKind === CompletionItemKind.Method;
        const isPrivateModuleDeclaration =
            scope.ObjKind === CompletionItemKind.Unit && object.Private;

        /*
         * Публичные глобальные переменные/константы могут использоваться
         * внешней средой или импортирующими файлами, поэтому их не помечаем.
         * Свойства класса также могут вызываться извне.
         */
        if (!isLocal && !isPrivateModuleDeclaration) {
            continue;
        }

        const name = normalizeIdentifier(object.Name);
        const ranges = declarationRanges.get(scope)?.get(name) || [];
        const used = (identifierIndex.get(name) || []).some(token =>
            token.start >= scope.Range.start &&
            token.end <= scope.Range.end &&
            !ranges.some(range =>
                sameRange(token.start, token.end, range.start, range.end)
            )
        );

        if (used) {
            continue;
        }

        const kind = declaration.parameter
            ? "Параметр"
            : object.ObjKind === CompletionItemKind.Constant
                ? "Константа"
                : "Переменная";
        const declared = kind === "Параметр" ? "объявлен" : "объявлена";

        result.push(createOffsetDiagnostic(
            module,
            object.Range.start,
            object.Range.end,
            DiagnosticSeverity.Hint,
            `${kind} ${object.Name} ${declared}, но не используется`,
            "unused-declaration",
            true
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

function addImportDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    result: Diagnostic[]
): void {
    const references = GetImportDefinitionTargetsFromTokens(module.lex.tokens);
    const dynamicMacroNames = GetDynamicMacroReferencesFromTokens(module.lex.tokens);
    const seenImports = new Set<string>();
    const importInfos: Array<{
        reference: IImportDefinitionTarget;
        closureUris: Set<string>;
        publicNames: Set<string>;
    }> = [];

    for (const reference of references) {
        const normalizedImport = normalizeModuleReference(reference.moduleName);

        if (seenImports.has(normalizedImport)) {
            result.push(createImportDiagnostic(
                module,
                reference,
                DiagnosticSeverity.Information,
                `Модуль ${reference.moduleName} импортирован повторно`,
                "duplicate-import",
                true
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
            continue;
        }

        if (!imported) {
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
        const resolved = index.findImportedSymbols(module.uri, name)[0];

        if (resolved) {
            usedImportedUris.add(resolved.uri);
        }
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
            DiagnosticSeverity.Hint,
            `Импорт ${info.reference.moduleName}, возможно, не используется: ` +
                "в текущем файле не найдено обращений к его публичным " +
                "переменным, константам, макросам или классам",
            "unused-import",
            true
        ));
    });
}

function collectDeclarations(
    module: IIndexedModule,
    codeTokens: IRslToken[]
): IDeclarationInfo[] {
    const result: IDeclarationInfo[] = [];
    const signatureRanges = new Map<CBase, { start: number; end: number } | undefined>();

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
            if (!VARIABLE_KINDS.has(child.ObjKind)) {
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
            while (index < raw.length && raw.charAt(index) !== "\r" && raw.charAt(index) !== "\n") {
                index++;
            }
            continue;
        }

        if (char === "/" && next === "*") {
            index += 2;
            while (index < raw.length - 1 && !(raw.charAt(index) === "*" && raw.charAt(index + 1) === "/")) {
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

function isClosedString(raw: string): boolean {
    if (raw.length < 2) {
        return false;
    }

    const quote = raw.charAt(0);

    if (raw.charAt(raw.length - 1) !== quote) {
        return false;
    }

    let backslashes = 0;

    for (let index = raw.length - 2; index >= 0 && raw.charAt(index) === "\\"; index--) {
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
    unnecessary: boolean = false
): Diagnostic {
    return createOffsetDiagnostic(
        module,
        reference.start,
        reference.end,
        severity,
        message,
        code,
        unnecessary
    );
}

function createTokenDiagnostic(
    token: IRslToken,
    severity: DiagnosticSeverity,
    message: string,
    code: string,
    unnecessary: boolean = false
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
        code
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
    unnecessary: boolean = false
): Diagnostic {
    const diagnostic: Diagnostic = {
        severity,
        range: {
            start: positionAt(module, start),
            end: positionAt(module, Math.max(start + 1, end))
        },
        message,
        source: "RSL parser",
        code
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

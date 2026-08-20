import {
    CompletionItem,
    CompletionItemKind,
    TextEdit
} from "vscode-languageserver";

import type { RslSymbol } from "../symbols/rslSymbol";
import {
    DECLARATION_MODIFIERS,
    displayTypeName,
    FILE_RECORD_SPECIFIERS,
    isStatementKeyword
} from "../language/rslLanguageReference";
import { cachedSignificantTokens, type IRslToken } from "../lexer";
import type { RslScopeResolver } from "../scopeResolver";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

interface ICallContext {
    name: string;
    argumentIndex: number;
    openIndex: number;
}

const MAX_CONTEXT_COMPLETIONS = 200;

/*
 * Спецификаторы FILE и RECORD и модификаторы объявления берутся из справочника
 * языка: собственные перечни здесь расходились с parser-ом (в списке
 * модификаторов был PUBLIC, а среди спецификаторов не было APPEND).
 */
const FILE_MODIFIER_ITEMS: CompletionItem[] = FILE_RECORD_SPECIFIERS.map(
    name => ({
        label: displayTypeName(name) === name
            ? name.charAt(0).toUpperCase() + name.slice(1)
            : displayTypeName(name),
        kind: CompletionItemKind.Keyword,
        detail: "Параметр FILE/RECORD",
        insertText: name.charAt(0).toUpperCase() + name.slice(1)
    })
);

const FILE_RECORD_SPECIFIER_LINE = new RegExp(
    `^\\s*(?:(?:${DECLARATION_MODIFIERS.join("|")})\\s+)?` +
        "(?:file|record)\\b[^;\\n]*\\)[^;\\n]*$",
    "iu"
);
const FORMAT_SPECIFIERS: Array<[string, string]> = [
    ["l", "выравнивание влево"],
    ["r", "выравнивание вправо"],
    ["c", "выравнивание по центру"],
    ["a", "автоматический формат"],
    ["t", "формат времени"],
    ["d", "формат даты"],
    ["m", "денежный формат"],
    ["w", "вывод словами"],
    ["z", "подавление нулевого значения"],
    ["f", "фиксированный формат"],
    ["i", "целочисленный формат"],
    ["iv", "целочисленный формат со знаком"]
];

/**
 * Контекстные подсказки, которые должны работать внутри строк и Import.
 * undefined означает, что следует продолжить обычный Completion.
 */
export function buildRslContextCompletions(
    module: IIndexedModule,
    index: WorkspaceIndex,
    offset: number,
    resolver?: RslScopeResolver
): CompletionItem[] | undefined {
    const tokens = cachedSignificantTokens(module.lex.tokens);
    const imports = buildRslImportContextCompletions(
        { uri: module.uri, source: module.source },
        tokens,
        index,
        offset
    );

    if (imports) {
        return imports;
    }

    const staticItems = buildStaticContextItems(
        module,
        offset,
        resolver
    );
    if (staticItems) {
        return staticItems;
    }

    const stringIndex = findTokenIndexContainingOffset(tokens, offset);
    if (stringIndex < 0 || tokens[stringIndex].kind !== "string") {
        return undefined;
    }

    const call = findCallContext(tokens, stringIndex);
    if (!call) {
        return undefined;
    }

    const stringToken = tokens[stringIndex];
    const replacement = stringContentRange(module, stringToken);
    const typedPrefix = stringPrefixAt(module.source, stringToken, offset);

    if (
        (call.name === "execmacro" || call.name === "execmacro2") &&
        call.argumentIndex === 0
    ) {
        return buildMacroItems(
            [module, ...index.getImportedModules(module.uri)],
            replacement,
            typedPrefix
        );
    }

    if (call.name !== "execmacrofile") {
        return undefined;
    }

    if (call.argumentIndex === 0) {
        return buildModuleItems(
            module.uri,
            index,
            true,
            replacement,
            typedPrefix
        );
    }

    if (call.argumentIndex === 1) {
        const moduleName = firstStringArgument(
            tokens,
            call.openIndex,
            stringIndex
        );
        const target = moduleName
            ? index.findModuleByName(moduleName)
            : undefined;
        return target
            ? buildMacroItems([target], replacement, typedPrefix)
            : [];
    }

    return [];
}

function buildStaticContextItems(
    module: IIndexedModule,
    offset: number,
    resolver?: RslScopeResolver
): CompletionItem[] | undefined {
    const source = module.source;
    const lineStart = Math.max(0, source.lastIndexOf("\n", offset - 1) + 1);
    const line = source.slice(lineStart, offset);

    if (
        /(?:^|\b)(?:macro|class|var|const|array)\b[^;\n]*:\s*[\p{L}\p{N}_]*$/iu
            .test(line)
    ) {
        /*
         * В позиции типа предлагаются не только примитивы и встроенные классы,
         * но и классы самого файла, Import-замыкания и импортированных
         * прикладных модулей: именно их пишут в `Var doc: TBFile` чаще всего, а
         * раньше список был статическим и ни одного из них не содержал.
         */
        return resolver
            ? resolver.getTypeCompletions(module.uri, module.symbolTree)
            : undefined;
    }

    if (FILE_RECORD_SPECIFIER_LINE.test(line)) {
        return FILE_MODIFIER_ITEMS;
    }

    if (
        /\([^;\n]*:\s*[a-z]*$/iu.test(line) &&
        !/(?:macro|class|var|const|array)\b[^;\n]*:/iu.test(line)
    ) {
        return FORMAT_SPECIFIERS.map(([name, detail]) => ({
            label: name,
            kind: CompletionItemKind.EnumMember,
            detail: `Формат :${name} — ${detail}`,
            insertText: name
        }));
    }
    return undefined;
}

/**
 * Имена модулей в строке Import.
 *
 * Отделено от остального контекста намеренно: здесь хватает потока токенов и
 * uri документа, поэтому подсказка работает и до готовности модели. Без этого
 * быстрый путь предлагал в `Import ` обычные имена области видимости — то
 * есть заведомо не то, а после готовности модели список менялся.
 */
export function buildRslImportContextCompletions(
    document: { uri: string; source: string },
    tokens: readonly IRslToken[],
    index: WorkspaceIndex,
    offset: number
): CompletionItem[] | undefined {
    if (!isImportContext(tokens, offset)) {
        return undefined;
    }

    return buildModuleItems(
        document.uri,
        index,
        false,
        undefined,
        importPrefixAt(document.source, offset)
    );
}

function buildModuleItems(
    currentUri: string,
    index: WorkspaceIndex,
    includeExtension: boolean,
    replacement?: ReturnType<typeof stringContentRange>,
    typedPrefix = ""
): CompletionItem[] {
    const seen = new Set<string>();
    const candidates: string[] = [];
    const normalizedPrefix = typedPrefix.toLowerCase();

    for (const uri of index.getWorkspaceFileUris()) {
        if (uri === currentUri) {
            continue;
        }

        let name = index.getImportNameForUri(uri);
        if (includeExtension && !/\.mac$/i.test(name)) {
            name += ".mac";
        }
        const key = name.replace(/\\/g, "/").toLowerCase();
        if (
            seen.has(key) ||
            (normalizedPrefix && !key.includes(normalizedPrefix))
        ) {
            continue;
        }

        seen.add(key);
        candidates.push(name);
    }

    candidates.sort((left, right) =>
        completionOrder(left, right, normalizedPrefix)
    );

    return candidates
        .slice(0, MAX_CONTEXT_COMPLETIONS)
        .map(name => ({
            label: name,
            kind: CompletionItemKind.Module,
            detail: includeExtension
                ? "RSL-файл для ExecMacroFile"
                : "Модуль RSL",
            insertText: name,
            ...(replacement
                ? { textEdit: TextEdit.replace(replacement, name) }
                : {})
        }));
}

function buildMacroItems(
    modules: readonly IIndexedModule[],
    replacement: ReturnType<typeof stringContentRange>,
    typedPrefix = ""
): CompletionItem[] {
    const result: CompletionItem[] = [];
    const seen = new Set<string>();
    const normalizedPrefix = typedPrefix.toLowerCase();

    for (const module of modules) {
        for (const symbol of module.symbolTree.children) {
            if (!isCallable(symbol) || symbol.isPrivate) {
                continue;
            }

            const key = symbol.name.toLowerCase();
            if (
                seen.has(key) ||
                (normalizedPrefix && !key.includes(normalizedPrefix))
            ) {
                continue;
            }
            seen.add(key);
            result.push({
                ...symbol.completionItem,
                label: symbol.name,
                insertText: symbol.name,
                textEdit: TextEdit.replace(replacement, symbol.name)
            });
        }
    }

    return result
        .sort((left, right) => completionOrder(
            String(left.label),
            String(right.label),
            normalizedPrefix
        ))
        .slice(0, MAX_CONTEXT_COMPLETIONS);
}

function completionOrder(
    left: string,
    right: string,
    normalizedPrefix: string
): number {
    if (normalizedPrefix) {
        const leftStarts = left.toLowerCase().startsWith(normalizedPrefix);
        const rightStarts = right.toLowerCase().startsWith(normalizedPrefix);
        if (leftStarts !== rightStarts) {
            return leftStarts ? -1 : 1;
        }
    }
    return left.localeCompare(right, "ru");
}

function importPrefixAt(source: string, offset: number): string {
    const statement = source.slice(0, offset).split(/[;,]/).pop() ?? "";
    const match = /(?:^|\s)([^\s]*)$/.exec(statement);
    return match?.[1] ?? "";
}

function stringPrefixAt(
    source: string,
    token: IRslToken,
    offset: number
): string {
    return source.slice(Math.min(token.start + 1, offset), offset);
}

function isCallable(symbol: RslSymbol): boolean {
    return symbol.kind === CompletionItemKind.Function ||
        symbol.kind === CompletionItemKind.Method;
}

/**
 * Первый индекс токена с `start >= offset` (бинарный поиск, токены
 * отсортированы по позиции). Используется вместо линейного сканирования
 * всего файла на каждый Completion-запрос.
 */
function lowerBoundByStart(tokens: readonly IRslToken[], offset: number): number {
    let left = 0;
    let right = tokens.length;

    while (left < right) {
        const middle = Math.floor((left + right) / 2);
        if (tokens[middle].start < offset) {
            left = middle + 1;
        } else {
            right = middle;
        }
    }

    return left;
}

/** Индекс единственного токена, чей диапазон строго содержит offset, либо -1. */
function findTokenIndexContainingOffset(
    tokens: readonly IRslToken[],
    offset: number
): number {
    const index = lowerBoundByStart(tokens, offset) - 1;
    return index >= 0 &&
        tokens[index].start < offset &&
        offset < tokens[index].end
        ? index
        : -1;
}

function isImportContext(tokens: readonly IRslToken[], offset: number): boolean {
    for (let index = lowerBoundByStart(tokens, offset) - 1; index >= 0; index--) {
        const token = tokens[index];
        if (token.kind === "symbol" && token.raw === ";") {
            return false;
        }
        if (
            token.kind === "identifier" &&
            token.value.toLowerCase() === "import"
        ) {
            return true;
        }
        if (
            token.kind === "identifier" &&
            isStatementKeyword(token.value)
        ) {
            return false;
        }
    }
    return false;
}

function findCallContext(
    tokens: readonly IRslToken[],
    stringIndex: number
): ICallContext | undefined {
    let depth = 0;
    let argumentIndex = 0;

    for (let index = stringIndex - 1; index >= 0; index--) {
        const token = tokens[index];
        if (token.kind !== "symbol") {
            continue;
        }
        if (token.raw === ")") {
            depth++;
            continue;
        }
        if (token.raw === "(") {
            if (depth > 0) {
                depth--;
                continue;
            }

            const nameToken = tokens[index - 1];
            if (!nameToken || nameToken.kind !== "identifier") {
                return undefined;
            }
            return {
                name: nameToken.value.toLowerCase(),
                argumentIndex,
                openIndex: index
            };
        }
        if (token.raw === "," && depth === 0) {
            argumentIndex++;
        }
    }
    return undefined;
}

function firstStringArgument(
    tokens: readonly IRslToken[],
    openIndex: number,
    currentStringIndex: number
): string | undefined {
    for (let index = openIndex + 1; index < currentStringIndex; index++) {
        const token = tokens[index];
        if (token.kind === "string") {
            return token.value.trim();
        }
        if (token.kind === "symbol" && token.raw === ",") {
            break;
        }
    }
    return undefined;
}

function stringContentRange(
    module: IIndexedModule,
    token: IRslToken
) {
    const quoteOffset = token.raw.length >= 2 ? 1 : 0;
    return {
        start: positionAt(module, token.start + quoteOffset),
        end: positionAt(module, Math.max(
            token.start + quoteOffset,
            token.end - quoteOffset
        ))
    };
}

function positionAt(module: IIndexedModule, offset: number) {
    const starts = module.lex.lineStarts;
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1] <= offset) {
        line++;
    }
    return { line, character: Math.max(0, offset - starts[line]) };
}


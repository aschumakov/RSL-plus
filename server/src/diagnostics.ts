import * as path from "path";
import { fileURLToPath } from "url";

import {
    CompletionItemKind,
    Diagnostic,
    DiagnosticSeverity,
    DiagnosticTag
} from "vscode-languageserver";

import { RslSymbol } from "./symbols/rslSymbol";
import { isRslKeyword, isRslType } from "./syntax/rslIdentifiers";
import { getScopeChain, RslScopeResolver } from "./scopeResolver";
import {
    GetDynamicMacroReferencesFromTokens,
    GetImportDefinitionTargetsFromTokens,
    IImportDefinitionTarget
} from "./execMacroDefinition";
import {
    IRslDiagnosticSettings
} from "./interfaces";
import {
    cachedSignificantTokens,
    findUnrecognizedEscapes,
    IRslToken,
    normalizeIdentifier,
    normalizeReferenceIdentifier,
    type RslSquareKind
} from "./lexer";
import {
    isRslSystemSpecialVariableName
} from "./systemSpecialVariables";
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
    symbol: RslSymbol;
    scope: RslSymbol;
    parameter: boolean;
}

interface ILocalDiagnosticFacts {
    declarations: IDeclarationInfo[];
    identifierIndex: Map<string, IRslToken[]>;
    declarationRangeKeys: Set<string>;
}

interface IDiagnosticData {
    start?: number;
    end?: number;
    name?: string;
    parameter?: boolean;
    moduleName?: string;
    replacement?: string;
}

const BLOCK_START = new Set(["macro", "class", "if", "for", "while", "with"]);
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
    "valtype",
    "v_undef",
    "v_integer",
    "v_money",
    "v_decimal",
    "v_double",
    "v_string",
    "v_bool",
    "v_date",
    "v_time",
    "v_dttm",
    "v_file",
    "v_struc",
    "v_array",
    "v_txtfile",
    "v_dbffile",
    "v_proc",
    "v_r2m",
    "v_memaddr"
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
    dialect: "rsBank",
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
        dialect: settings?.dialect === "coreRsl" ? "coreRsl" : "rsBank",
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
export function buildLocalRslDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    settings?: IRslDiagnosticSettings
): Diagnostic[] {
    const options = normalizeDiagnosticSettings(settings);

    if (!options.enabled || options.maxProblems === 0) {
        return [];
    }

    const result: Diagnostic[] = [];
    const hasCapacity = (): boolean =>
        result.length < options.maxProblems;
    let resolver: RslScopeResolver | undefined;
    const getResolver = (): RslScopeResolver => {
        if (!resolver) {
            resolver = new RslScopeResolver(index);
        }

        return resolver;
    };
    let localFacts: ILocalDiagnosticFacts | undefined;
    const getLocalFacts = (): ILocalDiagnosticFacts => {
        if (!localFacts) {
            const declarations = collectDeclarations(
                module,
                module.syntax.tokens
            );
            localFacts = {
                declarations,
                identifierIndex: buildIdentifierIndex(module.syntax.tokens),
                declarationRangeKeys: new Set(
                    declarations.map(item => offsetRangeKey(
                        item.symbol.range.start,
                        item.symbol.range.end
                    ))
                )
            };
        }

        return localFacts;
    };

    addSyntaxParserDiagnostics(module, result);

    if (hasCapacity()) {
        addDocumentedLimitDiagnostics(module, result);
    }

    if (options.structure && hasCapacity()) {
        addUnterminatedTokenDiagnostics(module, result);
    }
    if (options.structure && hasCapacity()) {
        addUnrecognizedEscapeDiagnostics(module, result);
    }
    if (options.structure && hasCapacity()) {
        addBracketDiagnostics(module, result);
    }
    if (options.structure && hasCapacity()) {
        addEndDiagnostics(module, result);
    }
    if (options.structure && hasCapacity()) {
        addDuplicateDeclarationDiagnostics(module, result);
    }
    if (options.structure && hasCapacity()) {
        addBasicImportDiagnostics(module, result);
    }
    if (options.structure && hasCapacity()) {
        addImportPlacementDiagnostics(module, result);
    }
    if (options.structure && hasCapacity()) {
        addConstantAssignmentDiagnostics(module, getResolver(), result);
    }
    if (options.structure && hasCapacity()) {
        addLocalVisibilityDiagnostics(module, getResolver(), result);
    }
    if (
        options.structure &&
        options.dialect === "coreRsl" &&
        hasCapacity()
    ) {
        addCoreDialectDiagnostics(module, getResolver(), result);
        addReferenceArgumentDiagnostics(module, getResolver(), result);
    }

    /*
     * Ошибки использования до объявления публикуются раньше предупреждений,
     * чтобы maxProblems не скрывал более важные сообщения.
     */
    if (options.useBeforeDeclaration && hasCapacity()) {
        addUseBeforeDeclarationDiagnostics(
            module,
            getResolver(),
            getLocalFacts(),
            result,
            options.maxProblems
        );
    }

    if (options.deprecatedDeclarations && hasCapacity()) {
        addDeprecatedDeclarationDiagnostics(module, result);
    }

    if (options.debugBreak && hasCapacity()) {
        addDebugBreakDiagnostics(module, result);
    }

    if (options.unusedVariables && hasCapacity()) {
        addUnusedDeclarationDiagnostics(
            module,
            getResolver(),
            getLocalFacts(),
            result,
            options.maxProblems
        );
    }

    return deduplicateDiagnostics(result).slice(0, options.maxProblems);
}

/** Workspace-фаза не запускает parser/local rules повторно. */
export function buildWorkspaceRslDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    settings?: IRslDiagnosticSettings
): Diagnostic[] {
    const options = normalizeDiagnosticSettings(settings);
    if (!options.enabled || options.maxProblems === 0) return [];
    const result: Diagnostic[] = [];
    if (options.structure) {
        addSelfImportDiagnostics(module, index, result);
    }
    if (options.ambiguousReferences && result.length < options.maxProblems) {
        addAmbiguousReferenceDiagnostics(module, index, result);
    }
    if (options.unusedImports && result.length < options.maxProblems) {
        addUnusedImportDiagnostics(module, index, result);
    }
    return deduplicateDiagnostics(result).slice(0, options.maxProblems);
}

/** Полный результат для unit-тестов и batch-клиентов. */
export function buildRslDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    settings?: IRslDiagnosticSettings
): Diagnostic[] {
    const options = normalizeDiagnosticSettings(settings);
    const local = buildLocalRslDiagnostics(module, index, settings);
    const remaining = Math.max(0, options.maxProblems - local.length);
    const workspace = remaining > 0
        ? buildWorkspaceRslDiagnostics(module, index, {
            ...(settings || {}),
            maxProblems: remaining
        })
        : [];
    return deduplicateDiagnostics([...local, ...workspace])
        .slice(0, options.maxProblems);
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
            item.severity === "warning"
                ? DiagnosticSeverity.Warning
                : DiagnosticSeverity.Error,
            item.message,
            item.code
        ));
    });
}

/** Ограничения из сводки синтаксиса, проверяемые без построения новых AST. */
function addDocumentedLimitDiagnostics(
    module: IIndexedModule,
    result: Diagnostic[]
): void {
    for (const token of module.lex.tokens) {
        if (
            token.kind === "identifier" &&
            !isSpecialName(token.value) &&
            Array.from(token.value).length > 80
        ) {
            result.push(createTokenDiagnostic(
                token,
                DiagnosticSeverity.Error,
                "Имя идентификатора длиннее допустимых 80 символов",
                "identifier-too-long"
            ));
        } else if (
            token.kind === "string" &&
            Array.from(token.value).length > 2047
        ) {
            result.push(createTokenDiagnostic(
                token,
                DiagnosticSeverity.Error,
                "Строковый литерал длиннее допустимых 2047 символов",
                "string-literal-too-long",
                false,
                {
                    start: token.start,
                    end: token.end,
                    replacement: splitLongStringLiteral(token.raw)
                }
            ));
        } else if (
            token.kind === "number" &&
            token.raw.startsWith("$") &&
            !/[0-9]/.test(token.raw)
        ) {
            result.push(createTokenDiagnostic(
                token,
                DiagnosticSeverity.Error,
                "Неверная денежная константа",
                "invalid-money-constant"
            ));
        }
    }

    const fileName = moduleFileName(module.uri);
    const extension = path.extname(fileName);
    const stem = path.basename(fileName, extension);
    if (/^\.mac$/iu.test(extension) && Array.from(stem).length > 24) {
        result.push(createOffsetDiagnostic(
            module,
            0,
            Math.min(module.source.length, 1),
            /*
             * "Длина имени макрофайла не должна превышать 24 символа" —
             * та же нормативная формулировка, что и для длины идентификатора
             * (там Error), поэтому здесь тоже Error, а не рекомендация.
             */
            DiagnosticSeverity.Error,
            "Имя macro-файла длиннее допустимых 24 символов",
            "macro-file-name-too-long"
        ));
    }
}

function addImportPlacementDiagnostics(
    module: IIndexedModule,
    result: Diagnostic[]
): void {
    for (const reference of GetImportDefinitionTargetsFromTokens(
        module.lex.tokens
    )) {
        const scope = getScopeChain(module.symbolTree, reference.start);
        const callable = scope.find(item =>
            item.kind === CompletionItemKind.Function ||
            item.kind === CompletionItemKind.Method
        );
        if (!callable) {
            continue;
        }
        result.push(createImportDiagnostic(
            module,
            reference,
            DiagnosticSeverity.Error,
            "IMPORT допустим только вне MACRO",
            "import-inside-macro"
        ));
    }
}

function addConstantAssignmentDiagnostics(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    result: Diagnostic[]
): void {
    const tokens = cachedSignificantTokens(module.lex.tokens);
    const declarationStarts = new Set<number>();
    walkScopes(module.symbolTree, scope => {
        for (const child of scope.children) {
            if (child.kind === CompletionItemKind.Constant) {
                declarationStarts.add(findObjectNameRange(module, child).start);
            }
        }
    });

    for (let index = 0; index + 1 < tokens.length; index++) {
        const token = tokens[index];
        const next = tokens[index + 1];
        if (
            token.kind !== "identifier" ||
            next.kind !== "symbol" ||
            next.raw !== "=" ||
            declarationStarts.has(token.start)
        ) {
            continue;
        }
        const resolved = resolver.resolveAt(
            module.uri,
            module.symbolTree,
            token.start
        );
        if (resolved?.symbol.kind !== CompletionItemKind.Constant) {
            continue;
        }
        result.push(createTokenDiagnostic(
            token,
            DiagnosticSeverity.Error,
            `Константе ${token.value} нельзя присваивать новое значение`,
            "assignment-to-constant"
        ));
    }
}

/*
 * LOCAL модуля виден только процедуре инициализации модуля и local-процедурам
 * этого же модуля (стр. 43-44 руководства); LOCAL свойство класса видно
 * только конструктору класса и local-методам того же класса. Обращение из
 * любой другой (не-local) процедуры/метода того же файла — ошибка.
 * Кросс-модульная видимость LOCAL уже исключена отдельно (RslSymbol.isPrivate
 * фильтрует local наравне с private при экспорте/поиске из других файлов) —
 * эта проверка касается только ссылок внутри одного файла.
 */
function addLocalVisibilityDiagnostics(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    result: Diagnostic[]
): void {
    const ownerOf = new Map<RslSymbol, RslSymbol>();
    walkScopes(module.symbolTree, scope => {
        for (const child of scope.children) {
            ownerOf.set(child, scope);
        }
    });

    /*
     * visibility === "local" также используется отдельно для параметров
     * (не имеет отношения к модификатору LOCAL) — у них владелец всегда
     * MACRO/METHOD. Модификатор LOCAL по документации применим только на
     * уровне модуля или конструктора класса, поэтому здесь учитываются
     * только "local"-символы, чей владелец — Unit (модуль) или Class.
     */
    const declarationStarts = new Set<number>();
    for (const [symbol, owner] of ownerOf) {
        if (
            symbol.visibility === "local" &&
            (owner.kind === CompletionItemKind.Unit ||
                owner.kind === CompletionItemKind.Class)
        ) {
            declarationStarts.add(findObjectNameRange(module, symbol).start);
        }
    }

    if (declarationStarts.size === 0) {
        return;
    }

    const tokens = cachedSignificantTokens(module.lex.tokens);

    for (const token of tokens) {
        if (token.kind !== "identifier" || declarationStarts.has(token.start)) {
            continue;
        }

        const resolved = resolver.resolveAt(
            module.uri,
            module.symbolTree,
            token.start
        );

        if (!resolved || resolved.symbol.visibility !== "local") {
            continue;
        }

        const owner = ownerOf.get(resolved.symbol);

        if (!owner) {
            continue;
        }

        const refChain = getScopeChain(module.symbolTree, token.start);
        const ownerIndex = refChain.indexOf(owner);
        const allowed = ownerIndex !== -1 && (
            refChain.length === ownerIndex + 1 ||
            (
                refChain.length === ownerIndex + 2 &&
                refChain[ownerIndex + 1].visibility === "local"
            )
        );

        if (allowed) {
            continue;
        }

        const ownerLabel = owner.kind === CompletionItemKind.Class
            ? `конструктора класса ${owner.name}`
            : "процедуры инициализации модуля";
        result.push(createTokenDiagnostic(
            token,
            DiagnosticSeverity.Error,
            `${resolved.symbol.name} — локальный объект ${ownerLabel}; ` +
                "доступен только внутри неё и local-процедур того же уровня",
            "local-visibility-violation"
        ));
    }
}

/*
 * Руководство формулирует запрет доступа к PRIVATE через THIS безусловно
 * (стр. 43), но эта проверка включается только под dialect === "coreRsl"
 * (по умолчанию — "rsBank"). Это осознанное решение: настройка
 * rslPlus.language.dialect описывает rsBank как допускающий расширения
 * платформы сверх базового RSL, а тесты (extended-language-features)
 * явно проверяют, что под rsBank это не ошибка. Включение проверки по
 * умолчанию сгенерировало бы ложные ошибки на распространённом в RS-Bank
 * коде паттерне — поэтому gating оставлен как есть.
 */
function addCoreDialectDiagnostics(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    result: Diagnostic[]
): void {
    const tokens = cachedSignificantTokens(module.lex.tokens);
    for (let index = 0; index + 2 < tokens.length; index++) {
        const owner = tokens[index];
        const dot = tokens[index + 1];
        const member = tokens[index + 2];
        if (
            owner.kind !== "identifier" ||
            normalizeIdentifier(owner.value) !== "this" ||
            dot.kind !== "symbol" ||
            dot.raw !== "." ||
            member.kind !== "identifier"
        ) {
            continue;
        }
        const resolved = resolver.resolveAt(
            module.uri,
            module.symbolTree,
            member.start
        );
        if (!resolved?.symbol.isPrivate) {
            continue;
        }
        result.push(createTokenDiagnostic(
            member,
            DiagnosticSeverity.Error,
            "В базовом RSL PRIVATE-член нельзя вызывать через THIS",
            "core-private-member-through-this"
        ));
    }
}

function addReferenceArgumentDiagnostics(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    result: Diagnostic[]
): void {
    const tokens = cachedSignificantTokens(module.lex.tokens);
    const declarationStarts = new Set<number>();
    walkScopes(module.symbolTree, scope => {
        for (const child of scope.children) {
            if (
                child.kind === CompletionItemKind.Function ||
                child.kind === CompletionItemKind.Method
            ) {
                declarationStarts.add(findObjectNameRange(module, child).start);
            }
        }
    });
    for (let index = 0; index + 1 < tokens.length; index++) {
        const callee = tokens[index];
        const open = tokens[index + 1];
        if (
            callee.kind !== "identifier" ||
            open.kind !== "symbol" ||
            open.raw !== "("
        ) {
            continue;
        }
        if (declarationStarts.has(callee.start)) {
            continue;
        }
        const resolved = resolver.resolveAt(
            module.uri,
            module.symbolTree,
            callee.start
        );
        const references = referenceParameterIndexes(
            resolved?.symbol.parameterText || ""
        );
        if (references.size === 0) {
            continue;
        }
        for (const argument of callArguments(tokens, index + 1)) {
            if (!references.has(argument.index) || argument.tokens.length === 0) {
                continue;
            }
            const first = argument.tokens[0];
            if (first.kind === "symbol" && first.raw === "@") {
                continue;
            }
            result.push(createTokenDiagnostic(
                first,
                DiagnosticSeverity.Error,
                `Параметр ${argument.index + 1} передаётся по ссылке; ` +
                    "перед аргументом требуется @",
                "missing-reference-argument"
            ));
        }
    }
}

function referenceParameterIndexes(parameterText: string): Set<number> {
    const body = parameterText.trim().replace(/^\(/u, "").replace(/\)$/u, "");
    const result = new Set<number>();
    splitTopLevel(body).forEach((parameter, index) => {
        if (/(?:^|:)\s*@/u.test(parameter)) {
            result.add(index);
        }
    });
    return result;
}

function callArguments(
    tokens: readonly IRslToken[],
    openIndex: number
): Array<{ index: number; tokens: IRslToken[] }> {
    const result: Array<{ index: number; tokens: IRslToken[] }> = [];
    let current: IRslToken[] = [];
    let depth = 0;
    for (let index = openIndex + 1; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind === "symbol" && token.raw === "(") {
            depth++;
        } else if (token.kind === "symbol" && token.raw === ")") {
            if (depth === 0) {
                if (current.length > 0) {
                    result.push({ index: result.length, tokens: current });
                }
                break;
            }
            depth--;
        } else if (
            token.kind === "symbol" &&
            token.raw === "," &&
            depth === 0
        ) {
            result.push({ index: result.length, tokens: current });
            current = [];
            continue;
        }
        current.push(token);
    }
    return result;
}

function splitTopLevel(value: string): string[] {
    const result: string[] = [];
    let start = 0;
    let depth = 0;
    for (let index = 0; index < value.length; index++) {
        const char = value.charAt(index);
        if (char === "(" || char === "[" || char === "{") depth++;
        else if (char === ")" || char === "]" || char === "}") depth--;
        else if (char === "," && depth === 0) {
            result.push(value.slice(start, index));
            start = index + 1;
        }
    }
    result.push(value.slice(start));
    return result;
}

function moduleFileName(uri: string): string {
    try {
        return path.basename(fileURLToPath(uri));
    } catch {
        return path.basename(uri);
    }
}

function isSpecialName(value: string): boolean {
    return /^\{[^}\r\n]+\}$/u.test(value);
}

function splitLongStringLiteral(raw: string): string | undefined {
    if (raw.length < 2050 || (raw[0] !== "\"" && raw[0] !== "'")) {
        return undefined;
    }
    const quote = raw[0];
    const body = raw.slice(1, raw.endsWith(quote) ? -1 : undefined);
    const parts: string[] = [];
    let start = 0;
    while (body.length - start > 1800) {
        let end = start + 1800;
        while (end > start && body.charAt(end - 1) === "\\") end--;
        if (end === start) return undefined;
        parts.push(body.slice(start, end));
        start = end;
    }
    parts.push(body.slice(start));
    return parts.map(part => `${quote}${part}${quote}`).join(" +\n");
}

/*
 * RECORD документацией не объявлен устаревшим (только ARRAY, FILE и
 * специализированные ссылочные типы) — в отличие от прежней версии этой
 * проверки, здесь он не флагуется.
 */
const DEPRECATED_DECLARATION_MESSAGES = new Map<string, string>([
    [
        "array",
        "Определение ARRAY устарело, от него желательно избавляться по возможности"
    ],
    [
        "file",
        "Объект типа FILE — устаревшая конструкция; " +
            "рекомендуется использовать конструкцию Tbfile"
    ],
    [
        "btfileref",
        "BtFileRef — устаревший специализированный тип; " +
            "рекомендуется использовать обобщённый объект (TBfile)"
    ],
    [
        "strucref",
        "StrucRef — устаревший специализированный тип; " +
            "рекомендуется использовать обобщённый объект (TRecHandler)"
    ],
    [
        "arrayref",
        "ArrayRef — устаревший специализированный тип; " +
            "рекомендуется использовать обобщённый объект (TArray)"
    ],
    [
        "txtfileref",
        "TxtFileRef — устаревший специализированный тип; " +
            "рекомендуется использовать обобщённый объект"
    ],
    [
        "dbffileref",
        "DbfFileRef — устаревший специализированный тип; " +
            "рекомендуется использовать обобщённый объект"
    ]
]);

function addDeprecatedDeclarationDiagnostics(
    module: IIndexedModule,
    result: Diagnostic[]
): void {
    for (const token of module.lex.tokens) {
        if (token.kind !== "identifier") {
            continue;
        }

        const message = DEPRECATED_DECLARATION_MESSAGES.get(
            normalizeIdentifier(token.value)
        );

        if (!message) {
            continue;
        }

        result.push(createTokenDiagnostic(
            token,
            DiagnosticSeverity.Information,
            message,
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

function addUnrecognizedEscapeDiagnostics(
    module: IIndexedModule,
    result: Diagnostic[]
): void {
    for (const token of module.lex.tokens) {
        if (token.kind !== "string") {
            continue;
        }

        for (const offset of findUnrecognizedEscapes(token.raw)) {
            const start = token.start + offset;
            result.push(createOffsetDiagnostic(
                module,
                start,
                start + 2,
                DiagnosticSeverity.Warning,
                "Неизвестная escape-последовательность; " +
                    "допустимы \\n \\r \\t \\f \\xHH \\XHH \\\\",
                "unknown-escape-sequence"
            ));
        }
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
            !isClosedSquareBlock(token.raw, token.squareKind)
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

    for (const token of module.syntax.tokens) {
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
    const tokens = module.syntax.tokens;
    const stack: IBlockEntry[] = [];
    const onErrorOwners = new Set<string>();
    const unitEndStarts = new Set(
        module.syntax.root.tokens
            .filter(token =>
                token.kind === "identifier" &&
                normalizeIdentifier(token.value) === END_KEYWORD
            )
            .map(token => token.start)
    );
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
            if (unitEndStarts.has(token.start)) {
                break;
            }

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

        /* ONERROR открывает обработчик до END родительского MACRO или EOF. */
        if (canStartBlock && word === "onerror") {
            const owner = stack.length > 0
                ? stack[stack.length - 1]
                : undefined;

            if (
                owner &&
                owner.keyword !== "macro" &&
                owner.keyword !== "class"
            ) {
                result.push(createTokenDiagnostic(
                    token,
                    DiagnosticSeverity.Error,
                    "ONERROR допустим только на уровне файла, MACRO или CLASS",
                    "invalid-onerror-context"
                ));
            } else {
                const ownerKey = owner
                    ? `${owner.keyword}:${owner.token.start}`
                    : "unit";

                if (onErrorOwners.has(ownerKey)) {
                    result.push(createTokenDiagnostic(
                        token,
                        DiagnosticSeverity.Error,
                        "Для одной области допускается только один ONERROR",
                        "duplicate-onerror"
                    ));
                } else {
                    onErrorOwners.add(ownerKey);
                }
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
    resolver: RslScopeResolver,
    facts: ILocalDiagnosticFacts,
    result: Diagnostic[],
    maxProblems: number
): void {
    for (const declaration of facts.declarations) {
        if (result.length >= maxProblems) {
            break;
        }

        const symbol = declaration.symbol;
        const scope = declaration.scope;
        const isLocal = scope.kind === CompletionItemKind.Function ||
            scope.kind === CompletionItemKind.Method;
        const isPrivateModuleDeclaration =
            scope.kind === CompletionItemKind.Unit && symbol.isPrivate;

        /*
         * Публичные глобальные объекты и свойства класса могут использоваться
         * внешней средой или импортирующими файлами.
         */
        if (!isLocal && !isPrivateModuleDeclaration) {
            continue;
        }

        const name = normalizeIdentifier(symbol.name);
        const occurrences = facts.identifierIndex.get(name) || [];
        const used = someTokenInRange(
            occurrences,
            scope.range.start,
            scope.range.end,
            token => {
                if (
                    token.end > scope.range.end ||
                    facts.declarationRangeKeys.has(offsetRangeKey(
                        token.start,
                        token.end
                    ))
                ) {
                    return false;
                }

                const resolved = resolver.resolveAt(
                    module.uri,
                    module.symbolTree,
                    token.start
                );

                return !!resolved &&
                    resolved.uri === module.uri &&
                    resolved.symbol === symbol;
            }
        );

        if (used) {
            continue;
        }

        const kind = declaration.parameter
            ? "Параметр"
            : symbol.kind === CompletionItemKind.Constant
                ? "Константа"
                : "Переменная";
        const declared = kind === "Параметр" ? "объявлен" : "объявлена";
        const range = findObjectNameRange(module, symbol);

        result.push(createOffsetDiagnostic(
            module,
            range.start,
            range.end,
            DiagnosticSeverity.Warning,
            `${kind} ${symbol.name} ${declared}, но не используется`,
            "unused-declaration",
            true,
            {
                start: range.start,
                end: range.end,
                name: symbol.name,
                parameter: declaration.parameter
            }
        ));
    }
}

function addUseBeforeDeclarationDiagnostics(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    facts: ILocalDiagnosticFacts,
    result: Diagnostic[],
    maxProblems: number
): void {
    const code = module.syntax.tokens;
    const memberNameStarts = collectMemberNameStarts(code);
    const nestedScopesByScope = new Map<RslSymbol, RslSymbol[]>();

    for (const declaration of facts.declarations) {
        if (result.length >= maxProblems) {
            break;
        }

        const scope = declaration.scope;

        if (
            declaration.parameter ||
            (
                scope.kind !== CompletionItemKind.Function &&
                scope.kind !== CompletionItemKind.Method
            )
        ) {
            continue;
        }

        const symbol = declaration.symbol;

        /*
         * Повреждённое или неоднозначное дерево не должно превращать
         * служебные слова RSL (IF, VAR и т. п.) в объявления переменных.
         */
        if (isReservedIdentifier(symbol.name)) {
            continue;
        }

        const name = normalizeIdentifier(symbol.name);
        let nestedScopes = nestedScopesByScope.get(scope);

        if (!nestedScopes) {
            nestedScopes = scope.children
                .filter(child => child.isContainer);
            nestedScopesByScope.set(scope, nestedScopes);
        }

        const occurrences = facts.identifierIndex.get(name) || [];
        const use = findTokenInRange(
            occurrences,
            scope.range.start,
            symbol.range.start,
            token => {
                if (
                    facts.declarationRangeKeys.has(offsetRangeKey(
                        token.start,
                        token.end
                    )) ||
                    memberNameStarts.has(token.start) ||
                    nestedScopes.some(child =>
                        child !== scope &&
                        child.range.start <= token.start &&
                        token.end <= child.range.end
                    )
                ) {
                    return false;
                }

                const resolved = resolver.resolveAt(
                    module.uri,
                    module.symbolTree,
                    token.start
                );

                return !resolved;
            }
        );

        if (!use) {
            continue;
        }

        result.push(createTokenDiagnostic(
            use,
            DiagnosticSeverity.Error,
            `Переменная ${symbol.name} используется до объявления`,
            "use-before-declaration",
            false,
            {
                start: use.start,
                end: use.end,
                name: symbol.name
            }
        ));
    }
}

function addDuplicateDeclarationDiagnostics(
    module: IIndexedModule,
    result: Diagnostic[]
): void {
    walkScopes(module.symbolTree, scope => {
        const byName = new Map<string, RslSymbol[]>();

        for (const child of scope.children) {
            const name = normalizeIdentifier(child.name);

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
                    `Имя ${item.name} повторно объявлено в той же области видимости`,
                    "duplicate-declaration"
                ));
            });
        });
    });
}

/**
 * Повторный и конфликтующий по расширению Import.
 *
 * Строго локальная проверка: смотрит только на текст Import текущего файла и
 * не обращается к индексу, поэтому её результат не зависит от готовности
 * обхода workspace (см. addSelfImportDiagnostics).
 */
function addBasicImportDiagnostics(
    module: IIndexedModule,
    result: Diagnostic[]
): void {
    const references = GetImportDefinitionTargetsFromTokens(module.lex.tokens);
    const seenImports = new Set<string>();
    const importedByStem = new Map<string, string>();

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

        const stem = normalizedImport
            .replace(/^.*\//u, "")
            /* Resolver добавляет .mac к неизвестному расширению. */
            .replace(/\.(?:mac|rsm|d32|dlm)$/iu, "")
            .replace(/\.(?:mac|rsm|d32|dlm)$/iu, "");
        const previous = importedByStem.get(stem);
        if (previous && previous !== normalizedImport) {
            result.push(createImportDiagnostic(
                module,
                reference,
                DiagnosticSeverity.Error,
                "Нельзя импортировать файлы с одинаковым именем и " +
                    "разными расширениями",
                "duplicate-import-basename"
            ));
        } else if (stem) {
            importedByStem.set(stem, normalizedImport);
        }

        /*
         * Отсутствие файла в workspace не является ошибкой:
         * модуль может входить в базовую поставку RS-Bank.
         */
    }
}

/**
 * Файл импортирует сам себя.
 *
 * Проверка workspace-фазы, а не локальной: имя из Import сопоставляется с
 * файлом через каталог workspace и загруженные модули, то есть результат
 * зависит от готовности индекса. В локальной фазе она молча пропадала бы на
 * файлах, открытых до завершения обхода workspace — ключ локального кэша
 * состояние индекса не учитывает и пересчёта бы не случилось.
 */
function addSelfImportDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    result: Diagnostic[]
): void {
    for (const reference of GetImportDefinitionTargetsFromTokens(
        module.lex.tokens
    )) {
        const imported = index.findModuleByName(reference.moduleName);
        const workspaceUri = index.findWorkspaceFileUri(reference.moduleName);

        if (
            (imported && imported.uri === module.uri) ||
            workspaceUri === module.uri
        ) {
            result.push(createImportDiagnostic(
                module,
                reference,
                DiagnosticSeverity.Warning,
                `Файл импортирует сам себя: ${reference.moduleName}`,
                "self-import"
            ));
        }
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
            item.symbolTree.children
                .filter(child => !child.isPrivate)
                .filter(child =>
                    child.kind === CompletionItemKind.Variable ||
                    child.kind === CompletionItemKind.Constant ||
                    child.kind === CompletionItemKind.Function ||
                    child.kind === CompletionItemKind.Class
                )
                .forEach(child =>
                    publicNames.add(normalizeIdentifier(child.name))
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
                module.symbolTree,
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
    const byName = new Map<string, Array<{ uri: string; symbol: RslSymbol }>>();

    importedModules.forEach(imported => {
        imported.symbolTree.children
            .filter(child => !child.isPrivate)
            .forEach(child => {
                const name = normalizeIdentifier(child.name);
                const list = byName.get(name) || [];

                if (!list.some(item =>
                    item.uri === imported.uri && item.symbol === child
                )) {
                    list.push({
                        uri: imported.uri,
                        symbol: child
                    });
                }

                byName.set(name, list);
            });
    });

    const ambiguous = new Map<string, Array<{ uri: string; symbol: RslSymbol }>>();
    byName.forEach((items, name) => {
        if (items.length > 1) {
            ambiguous.set(name, items);
        }
    });

    if (ambiguous.size === 0) {
        return;
    }

    const code = module.syntax.tokens;
    const resolver = new RslScopeResolver(index);
    const importReferences = GetImportDefinitionTargetsFromTokens(module.lex.tokens);
    const declarationRangeKeys = new Set(
        collectAllObjectRanges(module.symbolTree).map(range =>
            offsetRangeKey(range.start, range.end)
        )
    );
    const memberNameStarts = collectMemberNameStarts(code);

    for (let tokenIndex = 0; tokenIndex < code.length; tokenIndex++) {
        const token = code[tokenIndex];

        if (token.kind !== "identifier") {
            continue;
        }

        const name = normalizeIdentifier(token.value);
        const candidates = ambiguous.get(name);

        if (
            !candidates ||
            isReservedIdentifier(name) ||
            isRslSystemSpecialVariableReference(code, tokenIndex) ||
            declarationRangeKeys.has(offsetRangeKey(
                token.start,
                token.end
            )) ||
            importReferences.some(reference =>
                reference.start <= token.start && token.end <= reference.end
            ) ||
            memberNameStarts.has(token.start) ||
            resolver.resolveInScopeChain(
                module.symbolTree,
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
        RslSymbol,
        { start: number; end: number } | undefined
    >();

    walkScopes(module.symbolTree, scope => {
        if (
            scope.kind === CompletionItemKind.Function ||
            scope.kind === CompletionItemKind.Method
        ) {
            signatureRanges.set(
                scope,
                findSignatureRange(codeTokens, scope)
            );
        }

        for (const child of scope.children) {
            if (
                !VARIABLE_KINDS.has(child.kind) ||
                isReservedIdentifier(child.name)
            ) {
                continue;
            }

            const signature = signatureRanges.get(scope);

            result.push({
                symbol: child,
                scope,
                parameter: !!signature &&
                    signature.start < child.range.start &&
                    child.range.end <= signature.end
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

        const name = normalizeReferenceIdentifier(token.value);

        if (isReservedIdentifier(name)) {
            continue;
        }

        const list = result.get(name) || [];
        list.push(token);
        result.set(name, list);
    }

    return result;
}

function isRslSystemSpecialVariableReference(
    tokens: IRslToken[],
    index: number
): boolean {
    const token = tokens[index];
    const previous = tokens[index - 1];
    const next = tokens[index + 1];

    return token?.kind === "identifier" &&
        (
            (
                token.raw.startsWith("{") &&
                token.raw.endsWith("}") &&
                isRslSystemSpecialVariableName(token.value)
            ) ||
            (
                isRslSystemSpecialVariableName(token.value) &&
                previous?.kind === "symbol" &&
                previous.raw === "{" &&
                next?.kind === "symbol" &&
                next.raw === "}"
            )
        );
}

function someTokenInRange(
    tokens: IRslToken[],
    start: number,
    end: number,
    predicate: (token: IRslToken) => boolean
): boolean {
    return findTokenInRange(tokens, start, end, predicate) !== undefined;
}

function findTokenInRange(
    tokens: IRslToken[],
    start: number,
    end: number,
    predicate: (token: IRslToken) => boolean
): IRslToken | undefined {
    for (
        let index = lowerBoundTokenStart(tokens, start);
        index < tokens.length && tokens[index].start < end;
        index++
    ) {
        if (predicate(tokens[index])) {
            return tokens[index];
        }
    }

    return undefined;
}

function lowerBoundTokenStart(tokens: IRslToken[], start: number): number {
    let low = 0;
    let high = tokens.length;

    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);

        if (tokens[middle].start < start) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    return low;
}

function isReservedIdentifier(value: string): boolean {
    const normalized = normalizeIdentifier(value);

    if (!normalized) {
        return true;
    }

    return isRslKeyword(normalized) ||
        isRslType(normalized) ||
        RESERVED_IDENTIFIERS.has(normalized);
}


function findSignatureRange(
    tokens: IRslToken[],
    scope: RslSymbol
): { start: number; end: number } | undefined {
    let start = -1;
    let depth = 0;
    const firstIndex = lowerBoundByStart(tokens, scope.range.start);

    for (let index = firstIndex; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.start > scope.range.end) {
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

function walkScopes(root: RslSymbol, action: (scope: RslSymbol) => void): void {
    action(root);

    root.children.forEach(child => {
        if (child.isContainer) {
            walkScopes(child, action);
        }
    });
}

function collectAllObjectRanges(
    root: RslSymbol
): Array<{ start: number; end: number }> {
    const result: Array<{ start: number; end: number }> = [];

    walkScopes(root, scope => {
        scope.children.forEach(child => {
            result.push(child.range);
        });
    });

    return result;
}

function collectMemberNameStarts(tokens: IRslToken[]): Set<number> {
    const result = new Set<number>();

    for (let index = 1; index < tokens.length; index++) {
        const previous = tokens[index - 1];
        const token = tokens[index];

        if (
            token.kind === "identifier" &&
            previous.kind === "symbol" &&
            previous.raw === "."
        ) {
            result.add(token.start);
        }
    }

    return result;
}

function lowerBoundByStart(tokens: IRslToken[], offset: number): number {
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

function offsetRangeKey(start: number, end: number): string {
    return `${start}:${end}`;
}

// "--" — комментарий только внутри SQL-блока (обычное соглашение SQL).
// У самого RSL комментарии — только двойной слэш и парный блочный, поэтому
// в output-form блоке "--" — это просто декоративная рамка шаблона
// (например, "----------------]"), а не начало комментария, и не должна
// прятать от сканера настоящий закрывающий "]" после неё.
function isClosedSquareBlock(
    raw: string,
    squareKind?: RslSquareKind
): boolean {
    const dashStartsComment = squareKind === "sql";
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

        if (
            (dashStartsComment && char === "-" && next === "-") ||
            (char === "/" && next === "/")
        ) {
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
    symbol: RslSymbol
): { start: number; end: number } {
    const normalized = normalizeIdentifier(symbol.name);
    const tokens = module.syntax.tokens;
    const firstIndex = lowerBoundByStart(tokens, symbol.range.start);

    for (let index = firstIndex; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.start > symbol.range.end) {
            break;
        }

        if (
            token.kind === "identifier" &&
            normalizeIdentifier(token.value) === normalized
        ) {
            return { start: token.start, end: token.end };
        }
    }

    return symbol.range;
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

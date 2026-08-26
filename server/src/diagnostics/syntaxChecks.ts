import {
    GetImportDefinitionTargetsFromTokens
} from "../execMacroDefinition";
import {
    BLOCK_START_KEYWORDS,
    DECLARATION_MODIFIERS,
    deprecatedConstructMessage,
    END_KEYWORD
} from "../language/rslLanguageReference";
import {
    cachedSignificantTokens,
    IRslToken,
    normalizeIdentifier
} from "../lexer";
import {
    getScopeChain,
    RslScopeResolver
} from "../scopeResolver";
import {
    IIndexedModule
} from "../workspaceIndex";
import * as path from "path";
import {
    CompletionItemKind,
    Diagnostic,
    DiagnosticSeverity
} from "vscode-languageserver";
import {
    countCharacters,
    createImportDiagnostic,
    createOffsetDiagnostic,
    createTokenDiagnostic,
    findObjectNameRange,
    isClosedSquareBlock,
    isClosedString,
    isSpecialName,
    moduleFileName,
    splitLongStringLiteral,
    splitTopLevel,
    walkScopes
} from "./diagnosticFactory";

/*
 * Синтаксические проверки: то, что видно в одном файле без резолвера.
 *
 * Ограничения платформы, незакрытые строки и блоки, парность скобок и
 * End, размещение Import, устаревшие конструкции, забытый DEBUGBREAK.
 */

export interface IBlockEntry {
    keyword: string;
    token: IRslToken;
    hasElse: boolean;
}

export const BLOCK_START = new Set(BLOCK_START_KEYWORDS);

export const MODIFIERS = new Set(DECLARATION_MODIFIERS);

export function addSyntaxParserDiagnostics(
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
/* Ограничения RSL: длина идентификатора и строкового литерала в символах. */
export const IDENTIFIER_LIMIT = 80;

export const STRING_LIMIT = 2047;

export const FILE_STEM_LIMIT = 24;

export function addDocumentedLimitDiagnostic(
    _module: IIndexedModule,
    token: IRslToken,
    result: Diagnostic[]
): void {
    if (
        token.kind === "identifier" &&
        /*
         * Дешёвая проверка идёт первой. Число символов может быть только
         * меньше числа единиц UTF-16, поэтому короткое по единицам имя
         * заведомо короткое и по символам — а перебор символов через
         * Array.from создавал массив на каждый идентификатор файла.
         */
        token.value.length > IDENTIFIER_LIMIT &&
        !isSpecialName(token.value) &&
        countCharacters(token.value) > IDENTIFIER_LIMIT
    ) {
        result.push(createTokenDiagnostic(
            token,
            DiagnosticSeverity.Error,
            "Имя идентификатора длиннее допустимых 80 символов",
            "identifier-too-long"
        ));
    } else if (
        token.kind === "string" &&
        token.value.length > STRING_LIMIT &&
        countCharacters(token.value) > STRING_LIMIT
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

/** Ограничение на длину имени самого файла: проверяется один раз. */
export function addFileNameLimitDiagnostic(
    module: IIndexedModule,
    result: Diagnostic[]
): void {
    const fileName = moduleFileName(module.uri);
    const extension = path.extname(fileName);
    const stem = path.basename(fileName, extension);
    if (
        /^\.mac$/iu.test(extension) &&
        countCharacters(stem) > FILE_STEM_LIMIT
    ) {
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

export function addImportPlacementDiagnostics(
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
export function addCoreDialectDiagnostics(
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

export function addReferenceArgumentDiagnostics(
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

export function referenceParameterIndexes(parameterText: string): Set<number> {
    const body = parameterText.trim().replace(/^\(/u, "").replace(/\)$/u, "");
    const result = new Set<number>();
    splitTopLevel(body).forEach((parameter, index) => {
        if (/(?:^|:)\s*@/u.test(parameter)) {
            result.add(index);
        }
    });
    return result;
}

export function callArguments(
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

export function addDeprecatedDeclarationDiagnostic(
    _module: IIndexedModule,
    token: IRslToken,
    result: Diagnostic[]
): void {

    if (token.kind !== "identifier") {
        return;
    }

    const message = deprecatedConstructMessage(token.value);

    if (!message) {
        return;
    }

    result.push(createTokenDiagnostic(
        token,
        DiagnosticSeverity.Information,
        message,
        "deprecated-declaration"
    ));
}

export function addDebugBreakDiagnostic(
    _module: IIndexedModule,
    token: IRslToken,
    result: Diagnostic[]
): void {

    if (
        token.kind !== "identifier" ||
        normalizeIdentifier(token.value) !== "debugbreak"
    ) {
        return;
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

export function addUnterminatedTokenDiagnostic(
    _module: IIndexedModule,
    token: IRslToken,
    result: Diagnostic[]
): void {
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

/**
 * Проверка скобок порциями.
 *
 * Стек открытых скобок живёт в замыкании и переживает паузу, поэтому обход,
 * разорванный на порции, видит ровно то же, что видел бы целиком. Прежде обход
 * шёл одним куском: на файле 700 КБ это до 31 мс непрерывной работы.
 */
export function createBracketScanner(
    result: Diagnostic[]
): { step(token: IRslToken): void; finish(): void } {
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

    const step = (token: IRslToken): void => {
        if (token.kind !== "symbol") {
            return;
        }

        const close = pair[token.raw];

        if (close) {
            stacks[close].push(token);
            return;
        }

        if (!stacks[token.raw]) {
            return;
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
    };

    /* Незакрытые скобки видны только после последнего токена файла. */
    const finish = (): void => {
        Object.keys(stacks).forEach(close => {
            stacks[close].forEach(opening => {
                result.push(createTokenDiagnostic(
                    opening,
                    DiagnosticSeverity.Error,
                    `Для скобки ${openingFor[close]} не найдена закрывающая ` +
                        close,
                    "missing-closing-bracket"
                ));
            });
        });
    };

    return { step, finish };
}

/**
 * Проверка блоков порциями.
 *
 * Стек открытых блоков, признак начала предложения и текущая строка живут в
 * замыкании и переживают паузу: обход, разорванный на порции, видит то же, что
 * видел бы целиком. Прежде он шёл одним куском — на крупном файле до 12 мс.
 */
export function createEndScanner(
    module: IIndexedModule,
    result: Diagnostic[]
): { step(token: IRslToken): void; finish(): void } {
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
    /* END единицы документа заканчивает обход: дальше проверять нечего. */
    let stopped = false;

    const step = (token: IRslToken): void => {
        if (stopped) {
            return;
        }

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
            return;
        }

        const word = normalizeIdentifier(token.value);

        if (word === END_KEYWORD) {
            if (unitEndStarts.has(token.start)) {
                stopped = true;
                return;
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
            return;
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
            return;
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
            return;
        }

        if (!canStartBlock) {
            return;
        }

        if (MODIFIERS.has(word)) {
            return;
        }

        canStartBlock = false;

        if (BLOCK_START.has(word)) {
            stack.push({
                keyword: word,
                token,
                hasElse: false
            });
        }
    };

    /* Незакрытые блоки видны только после последнего токена файла. */
    const finish = (): void => {
        stack.reverse().forEach(block => {
            result.push(createTokenDiagnostic(
                block.token,
                DiagnosticSeverity.Error,
                `Для блока ${block.keyword.toUpperCase()} не найден ` +
                    "закрывающий END",
                "missing-end"
            ));
        });
    };

    return { step, finish };
}

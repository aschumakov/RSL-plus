import {
    isRslImportWord,
    startsRslImportDirective
} from "../core/language/importDirective";
import { CompletionItemKind } from "vscode-languageserver";

import {
    BLOCK_START_KEYWORDS,
    canonicalTypeName,
    DECLARATION_KEYWORDS as DECLARATION_KEYWORD_LIST,
    DECLARATION_MODIFIERS,
    numericLiteralType
} from "../language/rslLanguageReference";
import {
    decodeRslModulePath,
    moduleReferenceKey
} from "../core/language/moduleName";
import { lexRsl, normalizeIdentifier, type IRslToken } from "../lexer";
import { readClassDeclarationHeader } from "../parsing/classDeclarationHeader";
import {
    getImportNamesFromSyntax,
    type IRslParseResult,
    type IRslSyntaxNode
} from "../syntaxParser";
import {
    createSymbolId,
    moduleSymbolId,
    RslSymbol,
    type RslSymbolVisibility,
    type SymbolId
} from "../symbols/rslSymbol";

export interface IExternalLocationRange {
    start: { line: number; character: number };
    end: { line: number; character: number };
}

export interface IRslDeclarationDescriptor {
    kind: "macro" | "class" | "variable";
    name: string;
    visibility: RslSymbolVisibility;
    isMethod?: boolean;
    isProperty?: boolean;
    isConstant?: boolean;
    parameterText?: string;
    returnType?: string;
    baseClassName?: string;
    typeName?: string;
    /**
     * Тип написан в объявлении, а не выведен из значения.
     *
     * `Var sql: String` и `Var sql = "aaa"` дают одинаковый typeName, но первое
     * — приведение к типу, а второе — Variant с текущим строковым значением.
     */
    typeIsDeclared?: boolean;
    value?: string;
    start: number;
    end: number;
    selectionStart: number;
    selectionEnd: number;
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
    children: IRslDeclarationDescriptor[];
}

export interface IRslDeclarationSnapshot {
    imports: string[];
    declarations: IRslDeclarationDescriptor[];
    /**
     * Имена файлов, на которые файл ссылается строкой в ExecMacroFile.
     *
     * Заполняет тот, кто держит поток токенов, — компактное чтение файла.
     * Сам сканер объявлений их не собирает: это не объявление.
     */
    fileReferences?: readonly string[];
    /**
     * Хэши уникальных идентификаторов файла для поиска ссылок.
     *
     * Считает их тот же, кто держит текст, — компактное чтение файла.
     * Раньше их собирал ReferenceIndex, читая тот же файл во второй раз
     * уже на основном потоке.
     */
    identifierHashes?: Uint32Array;
}

interface IBlockFrame {
    keyword: string;
    descriptor?: IRslDeclarationDescriptor;
}

export interface ICompactDeclarationOptions {
    /** Outline видит private/local, external summary хранит только exports. */
    includePrivate?: boolean;
    /** Fast Snapshot передаёт уже готовый lexer result без второго прохода. */
    tokens?: readonly IRslToken[];
    /**
     * Включать параметры Macro как дочерние объявления. Нужно Outline, где
     * параметры видны в дереве Structure, и не нужно внешним модулям.
     *
     * Для внешнего модуля это основной объём: параметры дают вчетверо больше
     * дескрипторов, чем сами объявления, а прочитать их некому — Signature
     * Help собирает подпись из parameterText, symbol index индексирует только
     * верхний уровень, а разрешение members обходит только контейнеры
     * (getObjectChildren фильтрует по isContainer). Параметры чужого Macro
     * из другого файла и не видны.
     */
    includeCallableParameters?: boolean;
    /**
     * Включать Macro, объявленные внутри другого Macro.
     *
     * Нужно Structure открытого документа: вложенное объявление — такой же
     * кусок кода, и умалчивать о нём панель не вправе. Внешней сводке не нужно
     * и вредно: вызвать вложенный Macro из соседнего файла нельзя, а в каталоге
     * проекта его имя стало бы ложной целью для Ctrl+T и перехода.
     *
     * Ключ отдельный, а не «заодно с includePrivate». Видимость и вложенность —
     * разные вопросы: `Private Macro` виден снаружи файла ровно так же, как
     * вложенный, то есть никак, но причины у этого разные, и режим, где нужно
     * одно без другого, существует.
     */
    includeNestedCallables?: boolean;
}

/*
 * Compact scanner берёт состав ключевых слов из общего справочника языка.
 *
 * PUBLIC модификатором больше не считается. Раньше он был им ЗДЕСЬ и не был им
 * в полном parser-е, поэтому `Public Var x;` давал объявление x в компактной
 * модели закрытого файла и не давал его в открытом документе: переход по такому
 * имени работал из соседнего файла и не работал в самом файле.
 */
const BLOCK_START = new Set(BLOCK_START_KEYWORDS);
const DECLARATION_KEYWORDS = new Set(DECLARATION_KEYWORD_LIST);
const MODIFIERS = new Set(DECLARATION_MODIFIERS);

/**
 * Однопроходный scanner для закрытых импортируемых модулей.
 * Не строит statement/expression AST и сохраняет только Import и внешние символы.
 */
export function extractCompactDeclarations(
    source: string,
    options: ICompactDeclarationOptions = {}
): IRslDeclarationSnapshot {
    const text = source || "";
    const sourceTokens = options.tokens ||
        lexRsl(text, { includeTrivia: false }).tokens;
    const tokens = sourceTokens.filter(token =>
        token.kind !== "comment" &&
        token.kind !== "square" &&
        token.kind !== "bom" &&
        token.kind !== "whitespace" &&
        token.kind !== "newline"
    );
    const imports: string[] = [];
    const rootSymbols: IRslDeclarationDescriptor[] = [];
    const blocks: IBlockFrame[] = [];
    let canStartStatement = true;
    let currentLine = -1;
    /* Глубина скобок: ключевое слово внутри вызова предложения не начинает. */
    let groupDepth = 0;
    let afterDot = false;

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.line !== currentLine) {
            currentLine = token.line;
            canStartStatement = true;
        }

        if (token.kind === "symbol") {
            if (token.raw === "(" || token.raw === "[" || token.raw === "{") {
                groupDepth++;
            } else if (
                token.raw === ")" || token.raw === "]" || token.raw === "}"
            ) {
                groupDepth = Math.max(0, groupDepth - 1);
            }

            if (token.raw === ";") {
                canStartStatement = true;
                /*
                 * Глубина сбрасывается на конце оператора: в файле с
                 * незакрытой скобкой она иначе осталась бы ненулевой до конца
                 * файла и объявления после ошибки перестали бы находиться.
                 */
                groupDepth = 0;
            } else if (token.raw !== ",") {
                canStartStatement = false;
            }
            afterDot = token.raw === ".";
            continue;
        }

        if (token.kind !== "identifier") {
            canStartStatement = false;
            afterDot = false;
            continue;
        }

        const word = normalizeIdentifier(token.value);
        const previousAfterDot = afterDot;
        afterDot = false;

        if (word === "end") {
            const closed = blocks.pop();
            if (closed?.descriptor) {
                /*
                 * До END растягивается только смещение: из него строится
                 * range символа, то есть занятый объявлением кусок текста.
                 *
                 * Строка и колонка остаются на имени. Из них строится
                 * definitionRanges — куда прыгает переход, — и растянутые до
                 * END они означали, что Ctrl+Click по Macro в НИКОГДА не
                 * открывавшемся файле выделяет весь Macro целиком, а в
                 * закрытом ранее — только имя: тот же файл вёл себя
                 * по-разному в зависимости от того, открывали ли его.
                 * Разбор открытого документа и запасное чтение с диска оба
                 * дают имя, и это правильный ответ.
                 */
                closed.descriptor.end = token.end;
            }
            canStartStatement = false;
            continue;
        }

        /*
         * Ключевое слово объявления начинает предложение даже посреди строки.
         *
         * Так compact-модель совпадает с полным parser-ом, который завершает
         * выражение на любом слове-операторе: в `Public Var x;` объявление x
         * обязано остаться, потому что компилятор ругается ровно на Public.
         *
         * Ограничения обязательны: имя после точки — поле записи, и словарь
         * базы вполне может содержать поле `file`; внутри скобок стоит
         * аргумент, а не объявление.
         */
        /*
         * Директива Import опознаётся общим правилом, а не отслеживанием
         * предложений: см. core/language/importDirective. Своё правило здесь
         * пропускало директиву после точки — так написаны четыре настоящих
         * файла проекта — и принимало за неё `Var Import = 1;`.
         */
        const importHere = isRslImportWord(token) &&
            startsRslImportDirective(tokens[index - 1], tokens[index + 1]);

        if (
            !importHere &&
            !canStartStatement &&
            !(
                groupDepth === 0 &&
                !previousAfterDot &&
                DECLARATION_KEYWORDS.has(word)
            )
        ) {
            continue;
        }

        let modifier: string | undefined;
        let keywordToken = token;
        let keyword = word;

        if (MODIFIERS.has(keyword)) {
            modifier = keyword;
            const next = nextIdentifier(tokens, index + 1, token.line);
            if (!next) {
                canStartStatement = false;
                continue;
            }
            keywordToken = next.token;
            keyword = normalizeIdentifier(next.token.value);
            index = next.index;
        }

        if (keyword === "import" && importHere) {
            const parsed = scanImportNames(tokens, index + 1, keywordToken.line);
            parsed.names.forEach(name => {
                if (name && !imports.some(item => moduleReferenceKey(item) === moduleReferenceKey(name))) {
                    imports.push(name);
                }
            });
            index = Math.max(index, parsed.lastIndex);
            canStartStatement = false;
            continue;
        }

        if (!DECLARATION_KEYWORDS.has(keyword)) {
            if (BLOCK_START.has(keyword)) {
                blocks.push({ keyword });
            }
            canStartStatement = false;
            continue;
        }

        const insideMacro = blocks.some(frame => frame.keyword === "macro");
        const currentClass = findCurrentClass(blocks);
        const privateModifier = modifier === "private" || modifier === "local";
        const isExternal = options.includePrivate === true || !privateModifier;

        if (keyword === "macro" || keyword === "class") {
            const classHeader = keyword === "class"
                ? readClassDeclarationHeader(tokens, index + 1)
                : undefined;
            const nameInfo = keyword === "class"
                ? classHeader && {
                    token: classHeader.nameToken,
                    index: classHeader.nameIndex
                }
                : nextIdentifier(tokens, index + 1);
            /*
             * Кому вложить объявление и вкладывать ли вообще.
             *
             * Со включёнными вложенными родителем становится ближайшее
             * объемлющее объявление — Macro или Class, — а без них Macro
             * внутри Macro не заводится вовсе. Пропущенный родитель забирает
             * с собой и детей: показывать Inner в корне, когда Outer скрыт
             * как приватный, значило бы соврать про место объявления.
             */
            const nestedAllowed = options.includeNestedCallables === true;
            const container = nestedAllowed
                ? findEnclosingDeclaration(blocks)
                : currentClass;
            const visibleContainer = (nestedAllowed || !insideMacro) &&
                (container === undefined || container.descriptor !== undefined);
            const descriptor = nameInfo && isExternal && visibleContainer
                ? createCallableDescriptor(
                    text,
                    tokens,
                    keyword,
                    keywordToken,
                    nameInfo.token,
                    nameInfo.index,
                    currentClass !== undefined,
                    privateModifier ? modifier as RslSymbolVisibility : "public",
                    classHeader?.baseClassToken?.value,
                    options.includeCallableParameters !== false
                )
                : undefined;

            if (descriptor) {
                addDescriptor(rootSymbols, container?.descriptor, descriptor);
            }

            blocks.push({ keyword, descriptor });
            if (nameInfo) {
                index = nameInfo.index;
            }
            canStartStatement = false;
            continue;
        }

        /* Локальные объявления внутри Macro не попадают во внешний summary. */
        if (
            insideMacro ||
            !isExternal ||
            (currentClass !== undefined && currentClass.descriptor === undefined)
        ) {
            canStartStatement = false;
            continue;
        }

        const parsedVariables = scanVariableNames(tokens, index + 1, keywordToken.line);
        for (const parsedVariable of parsedVariables.names) {
            const nameToken = parsedVariable.token;
            const value = keyword === "const"
                ? scanInitializerValue(
                    text,
                    tokens,
                    parsedVariable.index,
                    parsedVariables.lastIndex
                )
                : undefined;
            /*
             * Явная декларация — это `: Тип` и сами ключевые слова ARRAY, FILE,
             * RECORD: они и есть тип объекта. Тип, выведенный из значения
             * инициализатора, декларацией не является.
             */
            const declaredType = scanDeclaredType(
                tokens,
                parsedVariable.index,
                parsedVariables.lastIndex
            ) || declarationKeywordType(keyword);
            const descriptor: IRslDeclarationDescriptor = {
                kind: "variable",
                name: nameToken.value,
                visibility: privateModifier ? modifier as RslSymbolVisibility : "public",
                isProperty: currentClass !== undefined,
                isConstant: keyword === "const",
                start: nameToken.start,
                end: nameToken.end,
                selectionStart: nameToken.start,
                selectionEnd: nameToken.end,
                startLine: nameToken.line,
                startCharacter: nameToken.character,
                endLine: nameToken.endLine,
                endCharacter: nameToken.endCharacter,
                typeName: declaredType ||
                    inferCompactValueType(value, tokens, parsedVariable.index),
                typeIsDeclared: !!declaredType,
                value,
                children: []
            };
            addDescriptor(rootSymbols, currentClass?.descriptor, descriptor);
        }
        index = Math.max(index, parsedVariables.lastIndex);
        canStartStatement = false;
    }

    return {
        imports,
        declarations: rootSymbols
    };
}

function createCallableDescriptor(
    source: string,
    tokens: IRslToken[],
    keyword: string,
    keywordToken: IRslToken,
    nameToken: IRslToken,
    nameIndex: number,
    insideClass: boolean,
    visibility: RslSymbolVisibility,
    baseClassName: string | undefined,
    includeParameters: boolean
): IRslDeclarationDescriptor {
    const parameterRange = findParameterRange(tokens, nameIndex);
    return {
        kind: keyword === "class" ? "class" : "macro",
        name: nameToken.value,
        visibility,
        isMethod: keyword === "macro" && insideClass,
        parameterText: parameterRange
            ? source.substring(parameterRange.start, parameterRange.end)
            : "",
        returnType: keyword === "macro"
            ? scanCallableReturnType(
                tokens,
                parameterRange?.endIndex ?? nameIndex
            )
            : "variant",
        baseClassName,
        start: keywordToken.start,
        end: nameToken.end,
        selectionStart: nameToken.start,
        selectionEnd: nameToken.end,
        startLine: nameToken.line,
        startCharacter: nameToken.character,
        endLine: nameToken.endLine,
        endCharacter: nameToken.endCharacter,
        children: parameterRange && keyword === "macro" && includeParameters
            ? scanParameters(tokens, parameterRange.startIndex, parameterRange.endIndex)
            : []
    };
}

function scanCallableReturnType(
    tokens: readonly IRslToken[],
    headerEndIndex: number
): string {
    const headerLine = tokens[headerEndIndex]?.line ?? -1;
    for (let index = headerEndIndex + 1; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.line !== headerLine || token.raw === ";") break;
        if (token.kind === "symbol" && token.raw === ":") {
            const type = tokens[index + 1];
            return type?.kind === "identifier" ? type.value : "variant";
        }
    }
    return "variant";
}

function scanDeclaredType(
    tokens: readonly IRslToken[],
    nameIndex: number,
    declarationEndIndex: number
): string | undefined {
    let depth = 0;
    for (let index = nameIndex + 1; index <= declarationEndIndex; index++) {
        const token = tokens[index];
        if (token.kind === "symbol") {
            if (token.raw === "(" || token.raw === "[") depth++;
            else if (token.raw === ")" || token.raw === "]") depth--;
            else if (depth === 0 && [",", ";", "="].includes(token.raw)) break;
            else if (depth === 0 && token.raw === ":") {
                let typeIndex = index + 1;
                if (tokens[typeIndex]?.raw === "@") typeIndex++;
                const type = tokens[typeIndex];
                return type?.kind === "identifier"
                    ? normalizeType(type.value)
                    : undefined;
            }
        }
    }
    return undefined;
}

function declarationKeywordType(keyword: string): string | undefined {
    return keyword === "array" || keyword === "file" || keyword === "record"
        ? keyword
        : undefined;
}

function inferCompactValueType(
    value: string | undefined,
    tokens: readonly IRslToken[],
    nameIndex: number
): string {
    if (!value) return "variant";
    const equalsIndex = tokens.findIndex((token, index) =>
        index > nameIndex && token.kind === "symbol" && token.raw === "="
    );
    const first = equalsIndex >= 0 ? tokens[equalsIndex + 1] : undefined;
    if (first?.kind === "number") {
        return numericLiteralType(first.raw) || "variant";
    }
    if (first?.kind === "string" || first?.kind === "square") return "string";
    if (
        first?.kind === "identifier" &&
        ["true", "false"].includes(normalizeIdentifier(first.value))
    ) return "bool";
    return "variant";
}

function scanParameters(
    tokens: IRslToken[],
    startIndex: number,
    endIndex: number
): IRslDeclarationDescriptor[] {
    const result: IRslDeclarationDescriptor[] = [];
    let expectName = true;
    let nestedDepth = 0;

    for (let index = startIndex + 1; index < endIndex; index++) {
        const token = tokens[index];

        if (token.kind === "symbol") {
            if (token.raw === "(" || token.raw === "[" || token.raw === "{") {
                nestedDepth++;
                continue;
            }
            if (token.raw === ")" || token.raw === "]" || token.raw === "}") {
                nestedDepth = Math.max(0, nestedDepth - 1);
                continue;
            }
            if (token.raw === "," && nestedDepth === 0) {
                expectName = true;
                continue;
            }
        }

        if (expectName && nestedDepth === 0 && token.kind === "identifier") {
            result.push({
                kind: "variable",
                name: token.value,
                visibility: "local",
                isProperty: false,
                isConstant: false,
                start: token.start,
                end: token.end,
                selectionStart: token.start,
                selectionEnd: token.end,
                startLine: token.line,
                startCharacter: token.character,
                endLine: token.endLine,
                endCharacter: token.endCharacter,
                children: []
            });
            expectName = false;
        }
    }
    return result;
}

function scanImportNames(
    tokens: IRslToken[],
    startIndex: number,
    startLine: number
): { names: string[]; lastIndex: number } {
    const names: string[] = [];
    let current = "";
    let lastIndex = startIndex - 1;

    const flush = (): void => {
        const value = stripQuotes(current.trim());
        if (value) {
            names.push(value);
        }
        current = "";
    };

    for (let index = startIndex; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind === "symbol" && token.raw === ";") {
            flush();
            lastIndex = index;
            break;
        }
        if (
            token.line > startLine &&
            token.kind === "identifier" &&
            isStatementKeyword(token.value)
        ) {
            flush();
            break;
        }
        if (token.kind === "symbol" && token.raw === ",") {
            flush();
        } else if (
            token.kind === "symbol" &&
            (token.raw === "\\" || token.raw === "/" || token.raw === ".")
        ) {
            current += token.raw;
        } else if (token.kind === "identifier" || token.kind === "string") {
            current += token.kind === "string"
                ? decodeRslModulePath(token.raw)
                : token.value;
        }
        lastIndex = index;
    }

    flush();
    return { names, lastIndex };
}

function scanVariableNames(
    tokens: IRslToken[],
    startIndex: number,
    startLine: number
): { names: Array<{ token: IRslToken; index: number }>; lastIndex: number } {
    const names: Array<{ token: IRslToken; index: number }> = [];
    let lastIndex = startIndex - 1;
    let expectName = true;
    let nestedDepth = 0;

    for (let index = startIndex; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind === "symbol") {
            if (token.raw === "(" || token.raw === "[" || token.raw === "{") {
                nestedDepth++;
            } else if (token.raw === ")" || token.raw === "]" || token.raw === "}") {
                nestedDepth = Math.max(0, nestedDepth - 1);
            } else if (token.raw === ";" && nestedDepth === 0) {
                lastIndex = index;
                break;
            } else if (token.raw === "," && nestedDepth === 0) {
                expectName = true;
            }
        }

        if (
            nestedDepth === 0 &&
            token.line > startLine &&
            token.kind === "identifier" &&
            isStatementKeyword(token.value)
        ) {
            break;
        }

        if (expectName && nestedDepth === 0 && token.kind === "identifier") {
            names.push({ token, index });
            expectName = false;
        }
        lastIndex = index;
    }

    return { names, lastIndex };
}

function scanInitializerValue(
    source: string,
    tokens: IRslToken[],
    nameIndex: number,
    declarationEndIndex: number
): string | undefined {
    let depth = 0;
    let valueStart: number | undefined;
    let valueEnd: number | undefined;

    for (
        let index = nameIndex + 1;
        index <= declarationEndIndex && index < tokens.length;
        index++
    ) {
        const token = tokens[index];
        if (token.kind === "symbol") {
            if (token.raw === "(" || token.raw === "[") {
                depth++;
            } else if (token.raw === ")" || token.raw === "]") {
                depth = Math.max(0, depth - 1);
            } else if (depth === 0 && token.raw === "=") {
                valueStart = undefined;
                valueEnd = undefined;
                continue;
            } else if (
                depth === 0 &&
                (token.raw === "," || token.raw === ";")
            ) {
                break;
            }
        }

        if (valueStart === undefined) {
            const previous = tokens[index - 1];
            if (!(previous?.kind === "symbol" && previous.raw === "=")) {
                continue;
            }
            valueStart = token.start;
        }
        valueEnd = token.end;
    }

    if (valueStart === undefined || valueEnd === undefined) {
        return undefined;
    }
    const value = source.substring(valueStart, valueEnd)
        .replace(/\s+/g, " ")
        .trim();
    return value.length > 120
        ? value.substring(0, 117) + "..."
        : value || undefined;
}

function findParameterRange(
    tokens: IRslToken[],
    nameIndex: number
): {
    start: number;
    end: number;
    startIndex: number;
    endIndex: number;
} | undefined {
    const nameToken = tokens[nameIndex];
    let depth = 0;
    let start = -1;
    let startIndex = -1;

    for (let index = nameIndex + 1; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.line > nameToken.line + 20 && start < 0) {
            return undefined;
        }
        if (token.kind !== "symbol") {
            continue;
        }
        if (token.raw === "(") {
            if (start < 0) {
                start = token.start;
                startIndex = index;
            }
            depth++;
        } else if (token.raw === ")" && depth > 0) {
            depth--;
            if (depth === 0) {
                return {
                    start,
                    end: token.end,
                    startIndex,
                    endIndex: index
                };
            }
        } else if (token.raw === ";" && start < 0) {
            return undefined;
        }
    }
    return undefined;
}

function findCurrentClass(blocks: IBlockFrame[]): IBlockFrame | undefined {
    for (let index = blocks.length - 1; index >= 0; index--) {
        if (blocks[index].keyword === "macro") {
            return undefined;
        }
        if (blocks[index].keyword === "class") {
            return blocks[index];
        }
    }
    return undefined;
}

/**
 * Ближайшее объемлющее объявление: Macro или Class.
 *
 * В отличие от findCurrentClass не останавливается на Macro, а возвращает
 * его: вложенное объявление принадлежит именно ему.
 */
function findEnclosingDeclaration(
    blocks: IBlockFrame[]
): IBlockFrame | undefined {
    for (let index = blocks.length - 1; index >= 0; index--) {
        const frame = blocks[index];

        if (frame.keyword === "macro" || frame.keyword === "class") {
            return frame;
        }
    }

    return undefined;
}

function addDescriptor(
    roots: IRslDeclarationDescriptor[],
    parent: IRslDeclarationDescriptor | undefined,
    descriptor: IRslDeclarationDescriptor
): void {
    if (parent) {
        parent.children.push(descriptor);
    } else {
        roots.push(descriptor);
    }
}

function nextIdentifier(
    tokens: IRslToken[],
    startIndex: number,
    maxLine?: number
): { token: IRslToken; index: number } | undefined {
    for (let index = startIndex; index < tokens.length; index++) {
        const token = tokens[index];
        if (maxLine !== undefined && token.line > maxLine) {
            return undefined;
        }
        if (token.kind === "identifier") {
            return { token, index };
        }
        if (token.kind === "symbol" && token.raw === ";") {
            return undefined;
        }
    }
    return undefined;
}

function isStatementKeyword(value: string): boolean {
    const word = normalizeIdentifier(value);
    return DECLARATION_KEYWORDS.has(word) || BLOCK_START.has(word) || word === "import" || word === "end";
}

function stripQuotes(value: string): string {
    const text = (value || "").trim();
    if (text.length >= 2) {
        const first = text.charAt(0);
        const last = text.charAt(text.length - 1);
        if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
            return text.substring(1, text.length - 1);
        }
    }
    return text;
}



export interface ISyntaxDeclarationOptions {
    externalOnly?: boolean;
}

/** Полный parser и compact scanner сходятся в одном declaration contract. */
export function extractDeclarationsFromSyntax(
    source: string,
    syntax: IRslParseResult,
    options: ISyntaxDeclarationOptions = {}
): IRslDeclarationSnapshot {
    const declarations: IRslDeclarationDescriptor[] = [];
    const extractor = new SyntaxDeclarationExtractor(
        source,
        syntax.lex.tokens,
        options.externalOnly === true
    );
    extractor.populate(declarations, syntax.root, undefined);
    return {
        imports: getImportNamesFromSyntax(syntax.root),
        declarations
    };
}

/**
 * Позиции определений: только чтение по символу.
 *
 * Тип нарочно минимальный — Map и WeakMap одинаково подходят, а
 * точечному пути нужен именно WeakMap: он переживает версии файла и
 * не требует пересборки для неизменившихся символов.
 */
export interface IRslDefinitionRanges {
    get(symbol: RslSymbol): IExternalLocationRange | undefined;
}

export interface IRslMutableDefinitionRanges
    extends IRslDefinitionRanges {
    set(symbol: RslSymbol, range: IExternalLocationRange): unknown;
}

export interface IRslSymbolTreeBuildResult {
    root: RslSymbol;
    definitionRanges: IRslDefinitionRanges;
}

/** Единственное место преобразования деклараций в semantic symbol model. */
export function buildRslSymbolTree(
    sourceLength: number,
    descriptors: readonly IRslDeclarationDescriptor[]
): IRslSymbolTreeBuildResult {
    const definitionRanges = new Map<RslSymbol, IExternalLocationRange>();
    const rootId = moduleSymbolId();
    const root = new RslSymbol({
        id: rootId,
        name: "",
        kind: CompletionItemKind.Unit,
        range: { start: 0, end: Math.max(0, sourceLength) },
        children: buildChildren(descriptors, rootId, definitionRanges)
    });
    return { root, definitionRanges };
}

/** Символы одной единицы верхнего уровня. */
export interface IRslSymbolUnit {
    symbols: RslSymbol[];
}

/**
 * Сборка дерева символов по единицам верхнего уровня.
 *
 * Нужна точечному пути: при правке внутри одной процедуры символы
 * остальных пересобирать незачем, а на файле 651 КБ это 17 мс из 50.
 *
 * Порядок обязателен: идентификатор символа включает номер одноимённого
 * среди предыдущих братьев, поэтому единицы подаются слева направо, а
 * готовые — через reuse, чтобы счётчик шёл дальше как при полной сборке.
 */
export function createRslSymbolUnitBuilder(
    definitionRanges: IRslMutableDefinitionRanges
): {
    build(
        descriptors: readonly IRslDeclarationDescriptor[]
    ): IRslSymbolUnit;
    reuse(unit: IRslSymbolUnit): void;
    finish(
        sourceLength: number,
        units: readonly IRslSymbolUnit[]
    ): IRslSymbolTreeBuildResult;
} {
    const rootId = moduleSymbolId();
    const occurrences = new Map<string, number>();

    return {
        build(descriptors) {
            return {
                symbols: buildChildren(
                    descriptors,
                    rootId,
                    definitionRanges,
                    occurrences
                )
            };
        },
        reuse(unit) {
            for (const symbol of unit.symbols) {
                const key = `${symbol.kind}:${normalizeIdentifier(
                    symbol.name
                )}`;
                occurrences.set(key, (occurrences.get(key) || 0) + 1);
            }
        },
        finish(sourceLength, units) {
            const children: RslSymbol[] = [];

            for (const unit of units) {
                for (const symbol of unit.symbols) {
                    children.push(symbol);
                }
            }

            const root = new RslSymbol({
                id: rootId,
                name: "",
                kind: CompletionItemKind.Unit,
                range: { start: 0, end: Math.max(0, sourceLength) },
                children
            });
            return { root, definitionRanges };
        }
    };
}

function buildChildren(
    descriptors: readonly IRslDeclarationDescriptor[],
    parentId: SymbolId,
    definitionRanges: IRslMutableDefinitionRanges,
    /* Счётчик одноимённых: точечный путь ведёт его через все единицы. */
    sharedOccurrences?: Map<string, number>
): RslSymbol[] {
    const occurrences = sharedOccurrences || new Map<string, number>();
    return descriptors.map(descriptor => {
        const kind = descriptorKind(descriptor);
        const occurrenceKey = `${kind}:${normalizeIdentifier(descriptor.name)}`;
        const occurrence = occurrences.get(occurrenceKey) || 0;
        occurrences.set(occurrenceKey, occurrence + 1);
        const id = createSymbolId(parentId, kind, descriptor.name, occurrence);
        const symbol = new RslSymbol({
            id,
            name: descriptor.name,
            kind,
            visibility: descriptor.visibility,
            range: { start: descriptor.start, end: descriptor.end },
            selectionRange: {
                start: descriptor.selectionStart,
                end: descriptor.selectionEnd
            },
            typeName: descriptor.typeName || descriptor.returnType || "variant",
            /*
             * Variant — это либо написанный Variant, либо отсутствие декларации.
             * Тип результата Macro пишется явно или отсутствует вовсе, поэтому
             * дополнительного признака ему не нужно.
             */
            typeVariant: isVariantTypeName(
                descriptor.typeName || descriptor.returnType
            ) || !(descriptor.typeIsDeclared || descriptor.returnType),
            value: descriptor.value,
            parameterText: descriptor.parameterText,
            baseClassName: descriptor.baseClassName,
            children: buildChildren(descriptor.children, id, definitionRanges)
        });
        definitionRanges.set(symbol, {
            start: {
                line: descriptor.startLine,
                character: descriptor.startCharacter
            },
            end: {
                line: descriptor.endLine,
                character: descriptor.endCharacter
            }
        });
        return symbol;
    });
}

/**
 * Вид символа по дескриптору.
 *
 * Экспортируется, чтобы каталог проекта, заполняемый компактным
 * сканером, различал виды так же, как дерево символов: иначе Ctrl+T
 * показывал бы переменную процедурой в зависимости от того, каким путём
 * попал в каталог файл.
 */
export function descriptorKind(
    descriptor: IRslDeclarationDescriptor
): CompletionItemKind {
    if (descriptor.kind === "macro") {
        return descriptor.isMethod
            ? CompletionItemKind.Method
            : CompletionItemKind.Function;
    }
    if (descriptor.kind === "class") {
        return CompletionItemKind.Class;
    }
    if (descriptor.isConstant) {
        return CompletionItemKind.Constant;
    }
    if (descriptor.isProperty) {
        return CompletionItemKind.Property;
    }
    return CompletionItemKind.Variable;
}

class SyntaxDeclarationExtractor {
    constructor(
        private source: string,
        private tokens: readonly IRslToken[],
        private externalOnly: boolean
    ) {}

    populate(
        target: IRslDeclarationDescriptor[],
        node: IRslSyntaxNode,
        container: IRslDeclarationDescriptor | undefined
    ): void {
        node.children.forEach(child => this.visit(target, child, container));
    }

    private visit(
        target: IRslDeclarationDescriptor[],
        node: IRslSyntaxNode,
        container: IRslDeclarationDescriptor | undefined
    ): void {
        switch (node.kind) {
            case "VariableDeclaration":
            case "ArrayDeclaration":
                this.addVariables(target, node, container);
                return;
            case "FileDeclaration":
            case "RecordDeclaration":
                this.addDataSymbol(target, node, container);
                return;
            case "MacroDeclaration":
                this.addCallable(target, node, container, false);
                return;
            case "ClassDeclaration":
                this.addCallable(target, node, container, true);
                return;
            case "VariableDeclarator":
                if (!this.externalOnly && (
                    node.variableRole === "for" ||
                    node.variableRole === "onerror"
                )) {
                    this.append(target, container, this.variableDescriptor(
                        node,
                        false,
                        "local",
                        false
                    ));
                }
                return;
            case "ImportDeclaration":
            case "ImportItem":
            case "Parameter":
                return;
            default:
                if (!this.externalOnly) {
                    node.children.forEach(child =>
                        this.visit(target, child, container)
                    );
                }
        }
    }

    private addVariables(
        target: IRslDeclarationDescriptor[],
        node: IRslSyntaxNode,
        container: IRslDeclarationDescriptor | undefined
    ): void {
        const visibility = nodeVisibility(node);
        if (this.externalOnly && visibility !== "public") {
            return;
        }
        const isProperty = container?.kind === "class" &&
            visibility !== "local";
        node.children
            .filter(child => child.kind === "VariableDeclarator")
            .forEach(child => {
                const descriptor = this.variableDescriptor(
                    child,
                    node.name === "const",
                    visibility,
                    isProperty
                );
                /*
                 * SPNAME — общая специальная переменная RSL. Руководство
                 * определяет её видимость на уровне всего unit независимо от
                 * места объявления, поэтому локальный Macro не должен
                 * становиться контейнером такого имени.
                 */
                this.append(
                    target,
                    isSpecialVariableName(descriptor.name)
                        ? undefined
                        : container,
                    descriptor
                );
            });
    }

    private addDataSymbol(
        target: IRslDeclarationDescriptor[],
        node: IRslSyntaxNode,
        container: IRslDeclarationDescriptor | undefined
    ): void {
        const visibility = nodeVisibility(node);
        if (!node.name || (this.externalOnly && visibility !== "public")) {
            return;
        }
        this.append(target, container, this.variableDescriptor(
            node,
            false,
            visibility,
            container?.kind === "class" && visibility !== "local"
        ));
    }

    private addCallable(
        target: IRslDeclarationDescriptor[],
        node: IRslSyntaxNode,
        container: IRslDeclarationDescriptor | undefined,
        isClass: boolean
    ): void {
        const visibility = nodeVisibility(node);
        if (!node.name || (this.externalOnly && visibility !== "public")) {
            return;
        }
        const nameToken = this.findNameToken(node);
        const descriptor: IRslDeclarationDescriptor = {
            kind: isClass ? "class" : "macro",
            name: node.name,
            visibility,
            isMethod: !isClass && container?.kind === "class" &&
                visibility !== "local",
            parameterText: this.parameterText(node),
            returnType: node.typeName || "variant",
            baseClassName: node.baseClassName,
            start: node.start,
            end: node.end,
            selectionStart: nameToken?.start ?? node.start,
            selectionEnd: nameToken?.end ?? node.start + node.name.length,
            startLine: nameToken?.line ?? 0,
            startCharacter: nameToken?.character ?? 0,
            endLine: nameToken?.endLine ?? 0,
            endCharacter: nameToken?.endCharacter ?? node.name.length,
            children: []
        };
        this.append(target, container, descriptor);

        node.children
            .filter(child => child.kind === "Parameter")
            .forEach(parameter => descriptor.children.push(
                this.variableDescriptor(
                    parameter,
                    false,
                    "local",
                    false
                )
            ));

        node.children
            .filter(child => child.kind !== "Parameter")
            .forEach(child => {
                if (this.externalOnly && !isClass) {
                    return;
                }
                if (this.externalOnly && isClass && !isDeclaration(child)) {
                    return;
                }
                this.visit(target, child, descriptor);
            });
    }

    private variableDescriptor(
        node: IRslSyntaxNode,
        isConstant: boolean,
        visibility: RslSymbolVisibility,
        isProperty: boolean
    ): IRslDeclarationDescriptor {
        const name = node.name || "";
        const nameToken = this.findNameToken(node);
        return {
            kind: "variable",
            name,
            visibility,
            isConstant,
            isProperty,
            /*
             * typeName у узла ставит parser и только там, где тип написан: `:
             * Тип`, ключевые слова ARRAY/FILE/RECORD, объект ошибки в ONERROR.
             * Иначе тип берётся из инициализатора — и декларацией не считается.
             */
            typeName: node.typeName
                ? normalizeType(node.typeName)
                : inferInitializerType(node),
            typeIsDeclared: !!node.typeName,
            value: initializerText(this.source, node),
            start: nameToken?.start ?? node.start,
            end: nameToken?.end ?? node.end,
            selectionStart: nameToken?.start ?? node.start,
            selectionEnd: nameToken?.end ?? node.end,
            startLine: nameToken?.line ?? 0,
            startCharacter: nameToken?.character ?? 0,
            endLine: nameToken?.endLine ?? 0,
            endCharacter: nameToken?.endCharacter ?? name.length,
            children: []
        };
    }

    private findNameToken(node: IRslSyntaxNode): IRslToken | undefined {
        const name = normalizeIdentifier(node.name || "");
        const firstIndex = lowerBoundTokenStart(this.tokens, node.start);

        for (let index = firstIndex; index < this.tokens.length; index++) {
            const token = this.tokens[index];

            if (token.start > node.end) {
                break;
            }
            if (
                token.end <= node.end &&
                token.kind === "identifier" &&
                normalizeIdentifier(token.value) === name
            ) {
                return token;
            }
        }

        return undefined;
    }

    private parameterText(node: IRslSyntaxNode): string {
        return node.parameterListStart !== undefined &&
            node.parameterListEnd !== undefined
            ? this.source.substring(
                node.parameterListStart,
                node.parameterListEnd
            )
            : "";
    }

    private append(
        roots: IRslDeclarationDescriptor[],
        parent: IRslDeclarationDescriptor | undefined,
        descriptor: IRslDeclarationDescriptor
    ): void {
        if (!descriptor.name) {
            return;
        }
        if (parent) {
            parent.children.push(descriptor);
        } else {
            roots.push(descriptor);
        }
    }
}

function isSpecialVariableName(name: string): boolean {
    return /^\{[^}\r\n]+\}$/u.test(name);
}

/**
 * SyntaxDeclarationExtractor вызывается для каждого объявления. Поиск от
 * начала общего token stream превращал построение symbol tree в O(D * T).
 * Нижняя граница оставляет поиск локальным диапазону конкретного AST-узла.
 */
function lowerBoundTokenStart(
    tokens: readonly IRslToken[],
    offset: number
): number {
    let left = 0;
    let right = tokens.length;

    while (left < right) {
        const middle = (left + right) >>> 1;

        if (tokens[middle].start < offset) {
            left = middle + 1;
        } else {
            right = middle;
        }
    }

    return left;
}

function nodeVisibility(node: IRslSyntaxNode): RslSymbolVisibility {
    return node.modifier === "local"
        ? "local"
        : node.modifier === "private"
            ? "private"
            : "public";
}

function isDeclaration(node: IRslSyntaxNode): boolean {
    return node.kind === "VariableDeclaration" ||
        node.kind === "ArrayDeclaration" ||
        node.kind === "FileDeclaration" ||
        node.kind === "RecordDeclaration" ||
        node.kind === "MacroDeclaration" ||
        node.kind === "ClassDeclaration";
}

const normalizeType = canonicalTypeName;

/** Пустой тип — это тоже Variant: декларации нет. */
function isVariantTypeName(value: string | undefined): boolean {
    const normalized = normalizeIdentifier(value || "");
    return !normalized || normalized === "variant";
}

function inferInitializerType(node: IRslSyntaxNode): string {
    const first = node.tokens.find(token =>
        node.valueStart !== undefined &&
        node.valueEnd !== undefined &&
        token.start >= node.valueStart &&
        token.end <= node.valueEnd
    );
    if (!first) return "variant";
    if (first.kind === "string" || first.kind === "square") return "string";
    if (first.kind === "number") {
        return numericLiteralType(first.raw) || "variant";
    }
    if (
        first.kind === "identifier" &&
        ["true", "false"].includes(normalizeIdentifier(first.value))
    ) return "bool";
    return "variant";
}

function initializerText(
    source: string,
    node: IRslSyntaxNode
): string | undefined {
    if (node.valueStart === undefined || node.valueEnd === undefined) {
        return undefined;
    }
    const value = source.substring(node.valueStart, node.valueEnd)
        .replace(/\s+/g, " ")
        .trim();
    if (!value) return undefined;
    return value.length > 120 ? value.substring(0, 117) + "..." : value;
}

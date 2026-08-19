import {
    CompletionItemKind,
    SemanticTokens,
    SemanticTokensLegend
} from "vscode-languageserver";

import { RslSymbol } from "./symbols/rslSymbol";
import {
    createWorkSlice,
    type IRslWorkSlice
} from "./core/timeSlice";
import { isNonSymbolIdentifier } from "./language/rslLanguageReference";
import {
    IRslToken,
    normalizeIdentifier
} from "./lexer";
import { RslScopeResolver } from "./scopeResolver";
import {
    collectFormatSpecifierTokenStarts,
    parseOutputForms,
    type IRslOutputForm
} from "./parsing/outputFormParser";
import { IIndexedModule, WorkspaceIndex } from "./workspaceIndex";

const TOKEN_TYPES = [
    "class",
    "method",
    "function",
    "variable",
    "parameter",
    "property",
    "string",
    "regexp",
    "keyword"
];

const TOKEN_MODIFIERS = [
    "declaration",
    "readonly",
    "deprecated"
];


export const RSL_SEMANTIC_TOKENS_LEGEND: SemanticTokensLegend = {
    tokenTypes: TOKEN_TYPES,
    tokenModifiers: TOKEN_MODIFIERS
};

export interface IRslSemanticTokenRange {
    startLine: number;
    startCharacter?: number;
    endLine: number;
    endCharacter?: number;
}

interface ISemanticEntry {
    token: IRslToken;
    type: number;
    modifiers: number;
    length?: number;
}

interface IObjectInfo {
    symbol: RslSymbol;
    scope: RslSymbol;
    parameter: boolean;
}

/**
 * Семантическая подсветка объявлений и разрешённых ссылок.
 * TextMate остаётся базовым быстрым слоем, semantic tokens уточняют смысл
 * идентификаторов после завершения разбора.
 */
/*
 * Как часто возвращается управление и проверяется отмена.
 *
 * Проверка на каждом токене заметна на горячем пути, а раз в триста — нет.
 * Тысяча оказалась слишком много: на каждый идентификатор приходится обращение к
 * resolver, и тысяча токенов складывалась в 23 мс непрерывной работы — столько
 * же, сколько занимал самый долгий подготовительный проход.
 */
/*
 * Шаг сверки по областям, а не по токенам: на каждую область приходится поиск
 * границ её сигнатуры — это проход по её телу, поэтому шаг мелкий.
 */
const SCOPE_CHECK_INTERVAL = 4;

/*
 * Шаг сверки по идентификаторам основного цикла.
 *
 * Работа там приходится только на идентификаторы: остальные токены цикл
 * отбрасывает сразу, а на идентификатор — разрешение имени, десятки микросекунд.
 * Сверка раз в триста ТОКЕНОВ на плотном коде означала до трёхсот разрешений
 * подряд, то есть порцию под двадцать миллисекунд.
 */
const IDENTIFIER_CHECK_INTERVAL = 32;

const CANCEL_CHECK_INTERVAL = 300;

/**
 * Семантическая подсветка порциями.
 *
 * Тот же расчёт, что и синхронный, но каждые 5–10 мс он возвращает управление
 * event loop и после паузы заново спрашивает, нужен ли ещё результат. Без паузы
 * проверка отмены во время расчёта почти бесполезна: сообщение об отмене и о
 * смене активной вкладки приходит транспортом, а транспорт в это время стоит.
 *
 * Обход дерева символов и поток токенов идут по всему файлу даже для
 * Range-запроса, и до лимита 512 КБ это заметная пауза, за которую результата
 * уже никто не ждёт.
 */
export async function buildRslSemanticTokensChunked(
    module: IIndexedModule,
    index: WorkspaceIndex,
    sharedResolver?: RslScopeResolver,
    range?: IRslSemanticTokenRange,
    isCancelled: () => boolean = () => false,
    slice: IRslWorkSlice = createWorkSlice()
): Promise<SemanticTokens> {
    const steps = semanticTokenSteps(
        module,
        index,
        sharedResolver,
        range,
        isCancelled,
        () => slice.shouldYield()
    );
    let step = steps.next();

    while (!step.done) {
        await slice.yieldIfNeeded();
        step = steps.next();
    }

    return step.value;
}

export function buildRslSemanticTokens(
    module: IIndexedModule,
    index: WorkspaceIndex,
    sharedResolver?: RslScopeResolver,
    range?: IRslSemanticTokenRange,
    /*
     * Отмена проверяется ВНУТРИ расчёта, а не только перед ним.
     *
     * Раньше запрос, отменённый редактором (пользователь продолжил печатать
     * или ушёл в другой файл), всё равно доводился до конца: обход дерева
     * символов и части потока токенов идёт по всему файлу даже для
     * Range-запроса, и до лимита 512 КБ это заметная пауза, за которую никто
     * уже не ждёт результата.
     */
    isCancelled: () => boolean = () => false
): SemanticTokens {
    const steps = semanticTokenSteps(
        module,
        index,
        sharedResolver,
        range,
        isCancelled
    );
    let step = steps.next();

    while (!step.done) {
        step = steps.next();
    }

    return step.value;
}

/**
 * Один расчёт, две формы исполнения.
 *
 * Генератор отдаёт управление на границах порций; синхронный вызов просто
 * прокручивает его до конца, порционный — вставляет паузу. Так прерываемый и
 * непрерываемый расчёт заведомо считают одно и то же.
 */
function* semanticTokenSteps(
    module: IIndexedModule,
    index: WorkspaceIndex,
    sharedResolver: RslScopeResolver | undefined,
    range: IRslSemanticTokenRange | undefined,
    isCancelled: () => boolean,
    /*
     * Пора ли вернуть управление. Синхронный расчёт этого не передаёт и потому
     * идёт до конца одним куском; порционный отдаёт бюджет времени, а не число
     * токенов: "каждые 300 токенов" на загруженной машине не ограничивает
     * ничего, и именно так порция подсветки доходила до десятков миллисекунд.
     */
    shouldYield?: () => boolean
): Generator<void, SemanticTokens, void> {
    const resolver = sharedResolver || new RslScopeResolver(index);
    const tokens = module.syntax.tokens;
    const objects = yield* collectObjectsSteps(
        module,
        tokens,
        isCancelled,
        shouldYield
    );

    /*
     * Граница порции после обхода дерева символов: он идёт по всему файлу даже
     * для Range-запроса и на большом файле сам по себе занимает миллисекунды.
     */
    yield;

    if (isCancelled()) {
        return { data: [] };
    }
    const objectInfoByObject = new Map<RslSymbol, IObjectInfo>();
    const declarationByRange = new Map<string, IObjectInfo>();
    /*
     * Оба подготовительных обхода тоже отдают управление по бюджету, а не
     * целиком: каждый идёт по всему файлу, и вместе они занимали поток дольше
     * любой порции основного цикла.
     */
    const identifiersByName = new Map<string, IRslToken[]>();

    for (let index = 0; index < tokens.length; index++) {
        if (index % CANCEL_CHECK_INTERVAL === 0 && index > 0 &&
            (shouldYield === undefined || shouldYield())) {
            yield;

            if (isCancelled()) {
                return { data: [] };
            }
        }

        addToIdentifiersByName(identifiersByName, tokens[index]);
    }

    for (let index = 0; index < objects.length; index++) {
        if (index % CANCEL_CHECK_INTERVAL === 0 && index > 0 &&
            (shouldYield === undefined || shouldYield())) {
            yield;

            if (isCancelled()) {
                return { data: [] };
            }
        }

        const info = objects[index];
        objectInfoByObject.set(info.symbol, info);
        const token = findDeclarationToken(identifiersByName, info.symbol);

        if (token) {
            declarationByRange.set(
                rangeKey(token.start, token.end),
                info
            );
        }
    }

    /*
     * Граница порции перед разбором инструкций вывода: он идёт по всему потоку
     * токенов и на модуле 700 КБ занимает несколько миллисекунд.
     */
    yield;

    if (isCancelled()) {
        return { data: [] };
    }

    const entries: ISemanticEntry[] = [];
    /*
     * Один разбор на оба потребителя.
     *
     * И спецификаторы, и сами инструкции вывода берутся из общего результата:
     * он считается за один проход по файлу и запоминается на версию текста,
     * поэтому второе обращение здесь бесплатно.
     */
    const outputForms = parseOutputForms(module.lex.tokens);
    const formatSpecifierStarts = collectFormatSpecifierTokenStarts(
        module.lex.tokens
    );
    appendOutputFormEntries(outputForms, entries, range);

    yield;

    if (isCancelled()) {
        return { data: [] };
    }

    const firstTokenIndex = range
        ? lowerBoundByLine(tokens, Math.max(0, range.startLine))
        : 0;
    /* Сколько идентификаторов уже разобрано: по ним и сверяется бюджет. */
    let inspected = 0;

    for (let tokenIndex = firstTokenIndex; tokenIndex < tokens.length; tokenIndex++) {
        if (
            tokenIndex % CANCEL_CHECK_INTERVAL === 0 &&
            tokenIndex > firstTokenIndex &&
            /*
             * Спрашивается время, а не число пройденных токенов: за 300 токенов
             * работы может пройти и десять миллисекунд, и сто. Сам счётчик
             * остаётся, но только как разрежение — Date.now() на каждом токене
             * заметен на горячем пути.
             */
            (shouldYield === undefined || shouldYield())
        ) {
            /*
             * Пауза ПЕРЕД проверкой отмены. Обратный порядок — проверять, ничего
             * не отдав event loop, — как раз и был прежним поведением: сообщение
             * об отмене или о смене вкладки к этому моменту ещё не пришло.
             */
            yield;

            if (isCancelled()) {
                return { data: [] };
            }
        }

        const token = tokens[tokenIndex];

        if (range && isTokenAfterRange(token, range)) {
            break;
        }
        if (range && isTokenBeforeRange(token, range)) {
            continue;
        }
        if (token.kind !== "identifier") {
            continue;
        }

        if (
            ++inspected % IDENTIFIER_CHECK_INTERVAL === 0 &&
            (shouldYield === undefined || shouldYield())
        ) {
            yield;

            if (isCancelled()) {
                return { data: [] };
            }
        }

        if (formatSpecifierStarts.has(token.start)) {
            entries.push({
                token,
                type: TOKEN_TYPES.indexOf("keyword"),
                modifiers: 0
            });
            continue;
        }

        if (isNonSymbolIdentifier(token.value)) {
            continue;
        }

        if (isDeclaredTypeToken(tokens, tokenIndex)) {
            const typeSymbol = resolver.resolveTypeName(
                module.uri,
                module.symbolTree,
                token.value
            );

            if (typeSymbol) {
                entries.push({
                    token,
                    type: TOKEN_TYPES.indexOf("class"),
                    modifiers: 0
                });
                continue;
            }
        }

        const declaration = declarationByRange.get(
            rangeKey(token.start, token.end)
        );

        if (declaration) {
            const encoded = encodeObject(declaration.symbol, declaration.parameter);

            if (encoded) {
                entries.push({
                    token,
                    type: encoded.type,
                    modifiers: encoded.modifiers | modifierBit("declaration")
                });
            }
            continue;
        }

        const resolved = resolver.resolveAt(
            module.uri,
            module.symbolTree,
            token.start
        );

        if (!resolved) {
            const previous = tokens[tokenIndex - 1];

            if (
                previous?.kind === "symbol" &&
                previous.raw === "."
            ) {
                const next = tokens[tokenIndex + 1];
                const looksLikeMethod =
                    next?.kind === "symbol" &&
                    next.raw === "(";

                entries.push({
                    token,
                    type: TOKEN_TYPES.indexOf(
                        looksLikeMethod ? "method" : "property"
                    ),
                    modifiers: 0
                });
            }

            continue;
        }

        const resolvedInfo = objectInfoByObject.get(resolved.symbol);
        const encoded = encodeObject(
            resolved.symbol,
            !!resolvedInfo?.parameter
        );

        if (!encoded) {
            continue;
        }

        entries.push({
            token,
            type: encoded.type,
            modifiers: encoded.modifiers
        });
    }

    entries.sort((left, right) =>
        left.token.line - right.token.line ||
        left.token.character - right.token.character ||
        (left.length || 0) - (right.length || 0)
    );

    return {
        data: encodeDelta(entries)
    };
}


/**
 * Подсветка по одним токенам, без синтаксического дерева и разрешения имён.
 *
 * Нужна первому запросу подсветки: полный разбор большого файла занимает
 * десятки миллисекунд, и ждать его, чтобы ответить, значит держать документ
 * непокрашенным всё это время. Здесь красится только то, что видно из потока
 * токенов и не зависит от разбора — спецификаторы формата в печатных формах.
 * Остальное уточняется, когда модель готова: сервер просит клиента
 * перезапросить токены (см. notifyParsed в semanticTokensFeatureRegistry).
 *
 * Идентификаторы намеренно не красятся: их смысл — класс, метод, параметр,
 * свойство — как раз и определяется разбором. Покрасить их наугад значило бы
 * показать неверный цвет и потом молча его сменить.
 */
export function buildRslBasicSemanticTokens(
    lexTokens: readonly IRslToken[],
    range?: IRslSemanticTokenRange
): SemanticTokens {
    const entries: ISemanticEntry[] = [];
    appendOutputFormEntries(parseOutputForms(lexTokens), entries, range);
    const specifiers = collectFormatSpecifierTokenStarts(lexTokens);

    for (const token of lexTokens) {
        if (
            token.kind !== "identifier" ||
            !specifiers.has(token.start) ||
            (range && (
                isTokenAfterRange(token, range) ||
                isTokenBeforeRange(token, range)
            ))
        ) {
            continue;
        }

        entries.push({
            token,
            type: TOKEN_TYPES.indexOf("keyword"),
            modifiers: 0
        });
    }

    entries.sort((left, right) =>
        left.token.line - right.token.line ||
        left.token.character - right.token.character ||
        (left.length || 0) - (right.length || 0)
    );

    return { data: encodeDelta(entries) };
}

function appendOutputFormEntries(
    /*
     * Готовые инструкции вывода, а не весь поток токенов: искать их здесь
     * заново значило бы пройти файл ещё раз ровно за тем же самым.
     */
    forms: readonly IRslOutputForm[],
    entries: ISemanticEntry[],
    range?: IRslSemanticTokenRange
): void {
    for (const { form: token } of forms) {
        const lines = token.raw.split(/\r\n|\n|\r/);
        let absoluteOffset = token.start;

        lines.forEach((rawLine, lineIndex) => {
            const lineNumber = token.line + lineIndex;
            let contentStart = lineIndex === 0 && rawLine.startsWith("[") ? 1 : 0;
            let contentEnd = rawLine.length;
            if (lineIndex === lines.length - 1 && rawLine.endsWith("]")) {
                contentEnd--;
            }

            const content = rawLine.substring(contentStart, contentEnd);
            const baseCharacter = lineIndex === 0
                ? token.character + contentStart
                : contentStart;
            let cursor = 0;
            const placeholders = [...content.matchAll(/#+/g)];

            const appendSegment = (
                start: number,
                end: number,
                typeName: "string" | "regexp"
            ): void => {
                if (end <= start) {
                    return;
                }

                const virtual = createVirtualToken(
                    token,
                    absoluteOffset + contentStart + start,
                    lineNumber,
                    baseCharacter + start,
                    end - start
                );
                if (range && (
                    isTokenBeforeRange(virtual, range) ||
                    isTokenAfterRange(virtual, range)
                )) {
                    return;
                }

                entries.push({
                    token: virtual,
                    type: TOKEN_TYPES.indexOf(typeName),
                    modifiers: 0,
                    length: end - start
                });
            };

            for (const placeholder of placeholders) {
                const start = placeholder.index || 0;
                appendSegment(cursor, start, "string");
                appendSegment(start, start + placeholder[0].length, "regexp");
                cursor = start + placeholder[0].length;
            }
            appendSegment(cursor, content.length, "string");

            absoluteOffset += rawLine.length;
            if (lineIndex < lines.length - 1) {
                const remaining = token.raw.substring(absoluteOffset - token.start);
                absoluteOffset += remaining.startsWith("\r\n") ? 2 : 1;
            }
        });
    }
}

function createVirtualToken(
    source: IRslToken,
    start: number,
    line: number,
    character: number,
    length: number
): IRslToken {
    return {
        kind: "square",
        raw: "",
        value: "",
        start,
        end: start + length,
        line,
        character,
        endLine: line,
        endCharacter: character + length,
        squareKind: source.squareKind
    };
}

/**
 * Объекты файла и их области — порциями.
 *
 * Раньше этот обход шёл одним куском перед первой паузой: поиск границ
 * сигнатуры проходит по телу каждой процедуры, то есть в сумме по всему файлу,
 * и на файле 563 КБ это давало почти тридцать миллисекунд занятого потока — до
 * того, как расчёт вообще успевал отдать управление.
 *
 * Область — единица работы: сигнатура одной процедуры целиком либо не
 * начинается вовсе, поэтому пауза между областями не требует хранить состояние
 * поиска.
 */
function* collectObjectsSteps(
    module: IIndexedModule,
    code: IRslToken[],
    isCancelled: () => boolean,
    shouldYield?: () => boolean
): Generator<void, IObjectInfo[], void> {
    /*
     * Сначала собираются сами области — этот обход дешёвый, дорога сигнатура.
     */
    const scopes: RslSymbol[] = [];
    walk(module.symbolTree, scope => {
        scopes.push(scope);
    });

    const result: IObjectInfo[] = [];

    for (let visited = 0; visited < scopes.length; visited++) {
        if (visited > 0 && visited % SCOPE_CHECK_INTERVAL === 0) {
            /*
             * Обход идёт по всему дереву даже для Range-запроса, поэтому
             * проверка отмены нужна и здесь, а не только в цикле по токенам.
             */
            if (isCancelled()) {
                return result;
            }

            if (shouldYield === undefined || shouldYield()) {
                yield;
            }
        }

        const scope = scopes[visited];
        const signature = isCallable(scope)
            ? findSignatureRange(code, scope)
            : undefined;

        scope.children.forEach(child => {
            result.push({
                symbol: child,
                scope,
                parameter:
                    !!signature &&
                    signature.start < child.range.start &&
                    child.range.end <= signature.end &&
                    (
                        child.kind === CompletionItemKind.Variable ||
                        child.kind === CompletionItemKind.Constant
                    )
            });
        });
    }

    return result;
}

function encodeObject(
    symbol: RslSymbol,
    parameter: boolean
): { type: number; modifiers: number } | undefined {
    let typeName: string;

    if (parameter) {
        typeName = "parameter";
    } else {
        switch (symbol.kind) {
            case CompletionItemKind.Class:
                typeName = "class";
                break;
            case CompletionItemKind.Method:
                typeName = "method";
                break;
            case CompletionItemKind.Function:
                typeName = "function";
                break;
            case CompletionItemKind.Property:
            case CompletionItemKind.Field:
                typeName = "property";
                break;
            case CompletionItemKind.Variable:
            case CompletionItemKind.Constant:
                typeName = "variable";
                break;
            default:
                return undefined;
        }
    }

    let modifiers = 0;

    if (symbol.kind === CompletionItemKind.Constant) {
        modifiers |= modifierBit("readonly");
    }

    return {
        type: TOKEN_TYPES.indexOf(typeName),
        modifiers
    };
}

function encodeDelta(entries: ISemanticEntry[]): number[] {
    const data: number[] = [];
    let previousLine = 0;
    let previousCharacter = 0;

    for (const entry of entries) {
        const line = entry.token.line;
        const character = entry.token.character;
        const deltaLine = line - previousLine;
        const deltaCharacter = deltaLine === 0
            ? character - previousCharacter
            : character;
        const length = Math.max(1, entry.length ?? (entry.token.end - entry.token.start));

        data.push(
            deltaLine,
            deltaCharacter,
            length,
            entry.type,
            entry.modifiers
        );

        previousLine = line;
        previousCharacter = character;
    }

    return data;
}

function modifierBit(name: string): number {
    const index = TOKEN_MODIFIERS.indexOf(name);
    return index < 0 ? 0 : (1 << index);
}

function walk(root: RslSymbol, action: (scope: RslSymbol) => void): void {
    action(root);

    root.children.forEach(child => {
        if (child.isContainer) {
            walk(child, action);
        }
    });
}

function isCallable(scope: RslSymbol): boolean {
    return scope.kind === CompletionItemKind.Function ||
        scope.kind === CompletionItemKind.Method;
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


/**
 * Вхождения каждого имени по всему файлу, по одному проходу.
 *
 * Нужен для поиска токена объявления. Прежде тот поиск шёл перебором от начала
 * символа до его КОНЦА, а у Macro и Class конец — это конец тела: на модуле
 * 700 КБ обход всех объектов складывался в 50 мс непрерывной работы, и это была
 * самая долгая порция подсветки. С индексом на объект приходится двоичный поиск.
 */
function addToIdentifiersByName(
    result: Map<string, IRslToken[]>,
    token: IRslToken
): void {
    if (token.kind !== "identifier") {
        return;
    }

    const name = normalizeIdentifier(token.value);
    const list = result.get(name);

    if (list) {
        list.push(token);
    } else {
        result.set(name, [token]);
    }
}

function findDeclarationToken(
    identifiersByName: Map<string, IRslToken[]>,
    symbol: RslSymbol
): IRslToken | undefined {
    const occurrences = identifiersByName.get(
        normalizeIdentifier(symbol.name)
    );

    if (!occurrences) {
        return undefined;
    }

    /* Первое вхождение имени внутри символа — то же, что находил перебор. */
    const first = lowerBoundByStart(occurrences, symbol.range.start);

    return first < occurrences.length &&
        occurrences[first].start <= symbol.range.end
        ? occurrences[first]
        : undefined;
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


function isTokenBeforeRange(
    token: IRslToken,
    range: IRslSemanticTokenRange
): boolean {
    return token.line < range.startLine ||
        (
            token.line === range.startLine &&
            token.endCharacter <= (range.startCharacter ?? 0)
        );
}

function isTokenAfterRange(
    token: IRslToken,
    range: IRslSemanticTokenRange
): boolean {
    return token.line > range.endLine ||
        (
            token.line === range.endLine &&
            token.character >= (range.endCharacter ?? Number.MAX_SAFE_INTEGER)
        );
}

function lowerBoundByLine(tokens: IRslToken[], line: number): number {
    let left = 0;
    let right = tokens.length;

    while (left < right) {
        const middle = Math.floor((left + right) / 2);
        if (tokens[middle].line < line) {
            left = middle + 1;
        } else {
            right = middle;
        }
    }

    return left;
}

function rangeKey(start: number, end: number): string {
    return `${start}:${end}`;
}

function isDeclaredTypeToken(
    tokens: readonly IRslToken[],
    index: number
): boolean {
    if (index <= 0) {
        return false;
    }

    const previous = tokens[index - 1];
    return previous.kind === "symbol" && previous.raw === ":";
}

import * as fs from "fs";

import {
    Diagnostic,
    DiagnosticSeverity
} from "vscode-languageserver";

import {
    isFullyKnownImportContext,
    type RslImportContextCompleteness
} from "../analysis/importContextState";
import {
    createWorkSlice,
    type IRslWorkSlice
} from "../core/timeSlice";
import {
    isRslKeyword,
    isRslSystemConstant,
    isRslType
} from "../language/rslLanguageReference";
import { normalizeIdentifier, type IRslToken } from "../lexer";
import type { IRslSyntaxNode } from "../syntaxParser";
import {
    createRslMemberChecker,
    type IRslMemberFinding
} from "./unknownMemberDiagnostics";
import type { RslScopeResolver } from "../scopeResolver";
import {
    isRslSpecialVariableReference
} from "../systemSpecialVariables";
import type { IIndexedModule } from "../workspaceIndex";

/**
 * Необъявленные переменные.
 *
 * Компилятор RSL разрешает имена ещё и из RSM, DLM, встроенных модулей и
 * собственного контекста сборки, которых в workspace нет вообще: отсутствие
 * объявления в проекте само по себе не означает, что имени не существует.
 * Поэтому режимов три, и по умолчанию работает средний.
 *
 *   off    — не проверять;
 *   safe   — по умолчанию: только имя слева от «=», только при доказуемо
 *            полном контексте и только там, где в этой же области есть
 *            объявление VAR;
 *   strict — все неразрешённые имена; пользователь берёт неполный контекст
 *            на себя.
 *
 * Режим audit не публикует Problems, а собирает отчёт: на реальном репозитории
 * макросов правило надо сначала прогнать и посмотреть на ложные срабатывания, а
 * не включать по умолчанию.
 */
export type RslUnknownVariablesMode = "off" | "safe" | "strict";

export interface IRslUnknownVariableOptions {
    mode: RslUnknownVariablesMode;
    /**
     * Сколько находок нужно вызывающему.
     *
     * Обход прекращается на этом числе. Без него проверка проходила весь поток
     * токенов и копила все находки, а лишнее отбрасывалось уже после: на файле
     * 709 КБ с 30 тысячами неизвестных имён это 234 мс работы, из которой в
     * Problems попадали первые двести.
     *
     * Audit-режиму нужен полный отчёт, поэтому он передаёт Infinity.
     */
    limit?: number;
    /**
     * Расчёт больше не нужен: файл покинули или изменили.
     *
     * Проверяется раз в CANCEL_CHECK_INTERVAL токенов. Между порциями внешнего
     * расчёта управление уже возвращалось event loop, поэтому к этому моменту
     * состояние действительно могло измениться.
     */
    isCancelled?(): boolean;
    /**
     * Файл со списком известных глобальных переменных, процедур и классов.
     *
     * Одно имя на строку; `#` начинает комментарий. Такой файл — единственный
     * способ рассказать расширению про имена, которые компилятор берёт извне
     * workspace: без него правило в strict неизбежно ругается на них.
     */
    knownGlobalsFile?: string;
    /**
     * Проверять состав полностью известных классов.
     *
     * Идёт тем же обходом токенов: имена после точки этот обход и так
     * встречает, отдельного прохода по файлу не появляется.
     */
    checkMembers?: boolean;
}

/** Причина, по которой имя признано неразрешённым. */
export type RslUnknownVariableReason =
    | "no-declaration"
    | "incomplete-context";

export interface IRslUnknownVariableFinding {
    uri: string;
    /** Член класса, которого у него нет; иначе — имя. */
    kind?: "member";
    /** Класс получателя: только у находок о членах. */
    className?: string;
    name: string;
    start: number;
    end: number;
    line: number;
    character: number;
    /** Имя ближайшей области: Macro, метод или класс; пусто для модуля. */
    scope: string;
    /** Есть ли в этом файле хотя бы одно явное VAR. */
    hasExplicitVar: boolean;
    importContext: RslImportContextCompleteness;
    reason: RslUnknownVariableReason;
}

export function normalizeUnknownVariablesMode(
    value: unknown
): RslUnknownVariablesMode {
    if (value === "off" || value === "safe" || value === "strict") {
        return value;
    }

    /*
     * Значение по умолчанию — safe.
     *
     * Настройка может не дойти до сервера вовсе: старый клиент её не
     * присылает. Тогда действует то же значение, что и в окне параметров, —
     * иначе проверка была бы включена в интерфейсе и выключена на деле.
     */
    return "safe";
}

/**
 * Кандидаты на «необъявленную переменную» — без публикации.
 *
 * Один и тот же обход используют и диагностика, и audit-отчёт: иначе отчёт
 * описывал бы не то правило, которое потом включат.
 */
export function collectUnknownVariables(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    options: IRslUnknownVariableOptions
): IRslUnknownVariableFinding[] {
    const steps = unknownVariableSteps(module, resolver, options);
    let step = steps.next();

    while (!step.done) {
        step = steps.next();
    }

    return step.value;
}

/**
 * Тот же обход порциями.
 *
 * Нужен audit-режиму: ему требуются ВСЕ находки, а полный проход по файлу в
 * 700 КБ с тридцатью тысячами неизвестных имён занимает секунды — каждое имя
 * разрешается по всем правилам видимости. Одним куском такая работа держала бы
 * event loop, а значит и все интерактивные запросы.
 */
export async function collectUnknownVariablesChunked(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    options: IRslUnknownVariableOptions,
    slice: IRslWorkSlice = createWorkSlice()
): Promise<IRslUnknownVariableFinding[]> {
    const steps = unknownVariableSteps(module, resolver, options);
    let step = steps.next();

    while (!step.done) {
        await slice.yieldIfNeeded();
        step = steps.next();
    }

    return step.value;
}

/**
 * Один обход, два способа исполнения: см. semanticTokenSteps.
 *
 * Генератор отдаёт управление на тех же границах, где проверяется отмена, —
 * порционный вызов вставляет туда паузу, синхронный просто прокручивает.
 */
function* unknownVariableSteps(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    options: IRslUnknownVariableOptions
): Generator<void, IRslUnknownVariableFinding[], void> {
    if (options.mode === "off" && !options.checkMembers) {
        return [];
    }

    const state = resolver.getImportContextState(module.uri);

    /*
     * Условие полноты контекста. В safe оно обязательно: пока не видно всех
     * транзитивных .mac и всего состава прикладных модулей, «не нашли» и «нет» —
     * разные утверждения, и вторым из них пугать пользователя нельзя.
     */
    if (options.mode === "safe" && !isFullyKnownImportContext(state)) {
        return [];
    }

    const tokens = module.syntax.tokens;
    /*
     * Явное объявление VAR обязательно — и не где-нибудь в файле, а в той
     * области, где стоит присваивание, или в объемлющей.
     *
     * Проверять по тексту токена нельзя: `obj.Var()` — обращение к члену
     * с именем Var, а не объявление, и оно включало проверку целому файлу.
     * По той же причине не годится и «где-то в файле есть VAR»: правило
     * работает по умолчанию, и одна объявленная переменная в чужой Macro
     * не должна включать проверку неявных переменных всюду.
     */
    const varScopes = collectRslVarScopes(module);
    const checkNames = options.mode !== "off" && varScopes.length > 0;
    const members = options.checkMembers
        ? createRslMemberChecker({
            module,
            resolver,
            imports: module.imports
        })
        : undefined;

    if (!checkNames && !members) {
        return [];
    }

    const known = readKnownGlobals(options.knownGlobalsFile);
    const declarationStarts = collectDeclarationStarts(module);
    const importRanges = collectImportRanges(module);
    const result: IRslUnknownVariableFinding[] = [];
    const reason: RslUnknownVariableReason = isFullyKnownImportContext(state)
        ? "no-declaration"
        : "incomplete-context";
    const limit = options.limit ?? Number.POSITIVE_INFINITY;

    if (limit <= 0) {
        return [];
    }

    /*
     * Указатель по диапазонам Import вместо поиска по всем для каждого имени.
     *
     * Диапазоны отсортированы, токены тоже, поэтому достаточно двигать один
     * указатель вперёд. Раньше на каждый идентификатор перебирались все Import
     * файла — на файле с двумя десятками Import это перебор длиной в два
     * десятка на каждое имя.
     */
    let importIndex = 0;

    for (let index = 0; index < tokens.length; index++) {
        if (index % CANCEL_CHECK_INTERVAL === 0 && index > 0) {
            /* Пауза перед проверкой отмены: см. semanticTokenSteps. */
            yield;

            if (options.isCancelled?.()) {
                return result;
            }
        }

        const token = tokens[index];

        while (
            importIndex < importRanges.length &&
            importRanges[importIndex].end < token.start
        ) {
            importIndex++;
        }

        if (token.kind !== "identifier" ||
            isInsideImport(importRanges, importIndex, token)) {
            continue;
        }

        const receiver = receiverBeforeDot(tokens, index);

        if (receiver) {
            /*
             * Имя после точки — член объекта. Искать его среди объявлений
             * файла бессмысленно, а проверить состав класса можно — но
             * только когда класс известен целиком.
             */
            const found = members?.check(tokens, index, receiver);

            if (found) {
                result.push(memberFinding(module.uri, found, state));

                if (result.length >= limit) {
                    return result;
                }
            }

            continue;
        }

        if (
            !checkNames ||
            !isExpressionIdentifier(tokens, index, declarationStarts) ||
            known.has(normalizeIdentifier(token.value)) ||
            !isInsideAnyRange(varScopes, token.start)
        ) {
            continue;
        }

        /*
         * В safe проверяется только имя слева от «=» — переменная,
         * созданная присваиванием.
         *
         * Всё остальное — вызовы, константы, имена, которые может
         * подставить система, — слишком легко принять за ошибку: имя
         * может прийти из модуля, о котором сервер знает не всё. Для
         * полного набора неразрешённых имён есть strict.
         */
        if (options.mode === "safe" &&
            !isAssignmentTarget(tokens, index)) {
            continue;
        }

        if (resolver.resolveAt(module.uri, module.symbolTree, token.start)) {
            continue;
        }

        result.push({
            uri: module.uri,
            name: token.value,
            start: token.start,
            end: token.end,
            line: token.line,
            character: token.character,
            scope: scopeNameAt(module, token.start),
            hasExplicitVar: true,
            importContext: state.completeness,
            reason
        });

        if (result.length >= limit) {
            return result;
        }
    }

    return result;
}

/**
 * Как часто проверяется отмена: раз в тысячу токенов.
 *
 * На каждом токене проверка заметна на файле в сотни килобайт, а раз в тысячу —
 * нет: отклик на отмену остаётся внутри одной-двух миллисекунд работы.
 */
const CANCEL_CHECK_INTERVAL = 1000;

/** Попадает ли токен в диапазон Import, на котором стоит указатель. */
function isInsideImport(
    ranges: readonly { start: number; end: number }[],
    index: number,
    token: IRslToken
): boolean {
    const range = ranges[index];
    return !!range && range.start <= token.start && token.end <= range.end;
}

export function buildUnknownVariableDiagnostics(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    options: IRslUnknownVariableOptions
): Diagnostic[] {
    return collectUnknownVariables(module, resolver, options).map(finding => ({
        severity: DiagnosticSeverity.Warning,
        range: {
            start: { line: finding.line, character: finding.character },
            end: {
                line: finding.line,
                character: finding.character + (finding.end - finding.start)
            }
        },
        /*
         * Формулировка компилятора, а не своя. Проверка называется
         * «необъявленные переменные», но неизвестным может оказаться и вызов
         * процедуры, и имя класса: `MissingProc()` — не переменная, а
         * компилятор на всё это отвечает «неопределенный идентификатор».
         */
        message: finding.kind === "member"
            ? `У класса ${finding.className} нет члена ${finding.name}`
            : `Идентификатор ${finding.name} не определён`,
        source: "RSL parser",
        code: finding.kind === "member"
            ? "unknown-member"
            : "unknown-variable",
        data: {
            start: finding.start,
            end: finding.end,
            name: finding.name
        }
    }));
}

/**
 * Идентификатор в позиции выражения.
 *
 * Исключается всё, что выражением не является: имя объявления, тип после ':',
 * имя после точки, имя внутри Import, ключевое слово, системная константа и
 * общесистемная спецпеременная.
 */
function isExpressionIdentifier(
    tokens: readonly IRslToken[],
    index: number,
    declarationStarts: ReadonlySet<number>
): boolean {
    const token = tokens[index];
    const word = normalizeIdentifier(token.value);

    /*
     * Спецпеременная — любое имя в фигурных скобках, и объявлять её в макросе
     * не требуется: значение подставляет система. Прежде исключение делалось
     * только для двадцати восьми общесистемных, поэтому {GROUP_MODE} из
     * SbCrdInter и заведённая банком {Филиал} объявлялись «необъявленными».
     */
    if (
        isRslKeyword(word) ||
        isRslType(word) ||
        isRslSystemConstant(word) ||
        isRslSpecialVariableReference(token.raw)
    ) {
        return false;
    }

    /* Имя объявления: сам VAR его и объявляет. */
    if (declarationStarts.has(token.start)) {
        return false;
    }

    const previous = previousCode(tokens, index);

    /* Имя после точки — поле или метод; состав объекта нам неизвестен. */
    if (previous?.kind === "symbol" && previous.raw === ".") {
        return false;
    }

    /*
     * Имя после ':' — тип, а не переменная. Ссылочный параметр `@name`
     * переменной как раз является, поэтому '@' здесь не отсекается.
     */
    if (previous?.kind === "symbol" && previous.raw === ":") {
        return false;
    }

    /* Имя сразу за ключевым словом объявления: объявление, а не выражение. */
    if (
        previous?.kind === "identifier" &&
        isDeclarationIntroducer(previous.value)
    ) {
        return false;
    }

    return true;
}

/**
 * Имя слева от «=», начинающее инструкцию.
 *
 * Именно так в RSL появляется переменная без VAR: `sss = "ddfdf"`. От
 * сравнения `==` отличается самим оператором, а от `a.b = 1` и
 * `arr[i] = 1` — тем, что слева стоит одно имя.
 */
function isAssignmentTarget(
    tokens: readonly IRslToken[],
    index: number
): boolean {
    const next = nextCode(tokens, index);

    if (!next || next.kind !== "symbol" || next.raw !== "=") {
        return false;
    }

    const previous = previousCode(tokens, index);

    if (!previous) {
        return true;
    }

    if (previous.kind === "symbol") {
        return previous.raw === ";";
    }

    if (previous.kind === "identifier" &&
        isBlockBoundaryWord(previous.value)) {
        return true;
    }

    /* Инструкция с новой строки: точка с запятой выше пропущена. */
    return previous.endLine < tokens[index].line;
}

function isBlockBoundaryWord(value: string): boolean {
    const word = normalizeIdentifier(value);

    return word === "end" || word === "else" || word === "elif" ||
        word === "onerror" || word === "then";
}

function nextCode(
    tokens: readonly IRslToken[],
    index: number
): IRslToken | undefined {
    for (let current = index + 1; current < tokens.length; current++) {
        const token = tokens[current];

        if (
            token.kind !== "comment" &&
            token.kind !== "whitespace" &&
            token.kind !== "newline" &&
            token.kind !== "bom"
        ) {
            return token;
        }
    }

    return undefined;
}

/** Получатель перед точкой: имя, к члену которого обращаются. */
function receiverBeforeDot(
    tokens: readonly IRslToken[],
    index: number
): IRslToken | undefined {
    /*
     * Индексы, а не поиск токена в массиве.
     *
     * Прежде здесь стоял tokens.indexOf(dot) — просмотр от начала файла на
     * КАЖДОЕ обращение через точку. На файле с восемью тысячами таких
     * обращений проверка занимала 73 мс вместо 6, и платился этот счёт при
     * каждом пересчёте Problems.
     */
    const dotIndex = previousCodeIndex(tokens, index);
    const dot = dotIndex >= 0 ? tokens[dotIndex] : undefined;

    if (!dot || dot.kind !== "symbol" || dot.raw !== ".") {
        return undefined;
    }

    /*
     * Точка и имя обязаны стоять в одной строке.
     *
     * Незаконченное `obj.` в конце строки — обычное состояние текста при
     * наборе, и следующая строка к этому обращению не относится: иначе
     * `end`, `return` и любое имя ниже становились «членом класса», и
     * появлялась ошибка вида «у класса T нет члена End».
     */
    if (dot.line !== tokens[index].line) {
        return undefined;
    }

    const receiverIndex = previousCodeIndex(tokens, dotIndex);
    const receiver = receiverIndex >= 0
        ? tokens[receiverIndex]
        : undefined;

    return receiver?.kind === "identifier" &&
        receiver.endLine === dot.line
        ? receiver
        : undefined;
}

function memberFinding(
    uri: string,
    found: IRslMemberFinding,
    state: { completeness: RslImportContextCompleteness }
): IRslUnknownVariableFinding {
    return {
        uri,
        kind: "member",
        className: found.className,
        name: found.name,
        start: found.start,
        end: found.end,
        line: found.line,
        character: found.character,
        scope: "",
        hasExplicitVar: true,
        importContext: state.completeness,
        reason: "no-declaration"
    };
}

function isDeclarationIntroducer(value: string): boolean {
    const word = normalizeIdentifier(value);
    return word === "var" || word === "const" || word === "array" ||
        word === "file" || word === "record" || word === "macro" ||
        word === "class";
}

function previousCode(
    tokens: readonly IRslToken[],
    index: number
): IRslToken | undefined {
    const found = previousCodeIndex(tokens, index);

    return found >= 0 ? tokens[found] : undefined;
}

/** Индекс предыдущего значащего токена; -1 — его нет. */
function previousCodeIndex(
    tokens: readonly IRslToken[],
    index: number
): number {
    for (let current = index - 1; current >= 0; current--) {
        const token = tokens[current];

        if (
            token.kind !== "comment" &&
            token.kind !== "whitespace" &&
            token.kind !== "newline" &&
            token.kind !== "bom"
        ) {
            return current;
        }
    }

    return -1;
}

/**
 * Области, в которых есть настоящее объявление VAR.
 *
 * Считается по дереву разбора: только узел объявления переменной, а не
 * слово «var» в тексте. Областью считается ближайшая Macro или Class, а для
 * объявлений верхнего уровня — файл целиком: объявление модуля видно из
 * любой его процедуры, а объявление в соседней процедуре — нет.
 */
function collectRslVarScopes(
    module: IIndexedModule
): readonly { start: number; end: number }[] {
    const result: { start: number; end: number }[] = [];
    const seen = new Set<number>();
    const wholeFile = { start: 0, end: module.source.length };
    const tokens = module.syntax.tokens;

    const visit = (
        node: IRslSyntaxNode,
        scope: { start: number; end: number }
    ): void => {
        for (const child of node.children) {
            if (
                isRealVarDeclaration(child, tokens) &&
                !seen.has(scope.start)
            ) {
                seen.add(scope.start);
                result.push(scope);
            }

            visit(
                child,
                child.kind === "MacroDeclaration" ||
                    child.kind === "ClassDeclaration"
                    ? { start: child.start, end: child.end }
                    : scope
            );
        }
    };

    visit(module.syntax.root, wholeFile);

    return result;
}

/**
 * Настоящее объявление VAR, а не восстановление разбора.
 *
 * `obj.Var()` — обращение к члену с именем Var, и терпимый к ошибкам
 * разбор восстанавливается на нём узлом объявления без объявленных имён.
 * Признаков два, и оба проверяются: у объявления есть хотя бы одно имя, и
 * слово VAR не стоит после точки.
 */
function isRealVarDeclaration(
    node: IRslSyntaxNode,
    tokens: readonly IRslToken[]
): boolean {
    if (node.kind !== "VariableDeclaration" || node.name !== "var") {
        return false;
    }

    if (node.children.length === 0) {
        return false;
    }

    const at = tokens.findIndex(token => token.start === node.start);
    const previous = at > 0 ? previousCode(tokens, at) : undefined;

    return !(previous?.kind === "symbol" && previous.raw === ".");
}

function isInsideAnyRange(
    ranges: readonly { start: number; end: number }[],
    offset: number
): boolean {
    return ranges.some(range =>
        range.start <= offset && offset <= range.end
    );
}

/**
 * Начала имён всех объявлений документа.
 *
 * Только selectionRange: там и стоит имя. range у Macro начинается на ключевом
 * слове, и добавлять его значило бы глушить проверку по случайному совпадению
 * позиций.
 */
function collectDeclarationStarts(
    module: IIndexedModule
): ReadonlySet<number> {
    const result = new Set<number>();
    const walk = (symbol: IIndexedModule["symbolTree"]): void => {
        for (const child of symbol.children) {
            result.add(child.selectionRange.start);
            walk(child);
        }
    };

    walk(module.symbolTree);
    return result;
}

function collectImportRanges(
    module: IIndexedModule
): readonly { start: number; end: number }[] {
    return module.syntax.root.children
        .filter(node => node.kind === "ImportDeclaration")
        .map(node => ({ start: node.start, end: node.end }));
}

function scopeNameAt(module: IIndexedModule, offset: number): string {
    let name = "";
    let current = module.symbolTree;

    for (;;) {
        const nested = current.children.find(child =>
            child.isContainer &&
            child.range.start <= offset &&
            offset <= child.range.end
        );

        if (!nested) {
            return name;
        }
        name = name ? `${name}.${nested.name}` : nested.name;
        current = nested;
    }
}

/*
 * Список известных имён кэшируется по пути и времени правки: он читается на
 * каждую проверку файла, а меняется вручную и редко.
 */
interface IKnownGlobalsCacheEntry {
    modifiedMs: number;
    size: number;
    names: ReadonlySet<string>;
}

const knownGlobalsCache = new Map<string, IKnownGlobalsCacheEntry>();
const EMPTY_NAMES: ReadonlySet<string> = new Set<string>();

export function readKnownGlobals(filePath?: string): ReadonlySet<string> {
    if (!filePath) {
        return EMPTY_NAMES;
    }

    try {
        const stats = fs.statSync(filePath);
        const cached = knownGlobalsCache.get(filePath);

        if (
            cached &&
            cached.modifiedMs === stats.mtimeMs &&
            cached.size === stats.size
        ) {
            return cached.names;
        }

        const names = new Set<string>();

        for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
            const value = line.replace(/#.*$/, "").trim();

            if (value) {
                names.add(normalizeIdentifier(value));
            }
        }

        knownGlobalsCache.set(filePath, {
            modifiedMs: stats.mtimeMs,
            size: stats.size,
            names
        });
        return names;
    } catch (_error) {
        /*
         * Нечитаемый файл списка не должен ни ронять сервер, ни превращаться в
         * поток ложных предупреждений: считаем, что список пуст.
         */
        return EMPTY_NAMES;
    }
}

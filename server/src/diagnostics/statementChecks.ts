import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver";

import {
    BRANCH_KEYWORDS,
    END_KEYWORD,
    LITERAL_KEYWORDS,
    STATEMENT_KEYWORDS,
    WORD_OPERATORS
} from "../language/rslLanguageReference";
import { normalizeIdentifier, type IRslToken } from "../lexer";
import type { IRslSyntaxNode } from "../syntaxParser";
import type { IIndexedModule } from "../workspaceIndex";
import { createOffsetDiagnostic } from "./diagnosticFactory";

/**
 * Проверки одного оператора: то, что видно без вывода типов и без резолвера.
 *
 * Пять правил, у которых общее одно: они срабатывают только там, где вывод
 * доказуем по тексту. Присваивание переменной самой себе, сравнение значения с
 * самим собой, заведомо постоянное условие, повторное условие в цепочке
 * if/elif, выражение без эффекта — каждое из них почти всегда описка, но
 * каждое легко превратить в ложную тревогу, стоит начать угадывать.
 *
 * Отсюда общее правило: любой вызов, индекс или неизвестная конструкция —
 * повод промолчать. `Next() == Next()` может быть верным кодом, `a[i] = a[i]`
 * — тоже: индексатор бывает свойством с побочным эффектом. Молчание в спорном
 * случае дешевле, чем предупреждение, которое приходится объяснять.
 *
 * Все пять живут в одном проходе по токенам: он разбирает поток на операторы и
 * условия, а правила смотрят на готовые куски. Отдельного обхода файла ни у
 * одного правила нет.
 */

export interface IRslStatementCheckOptions {
    selfAssignment: boolean;
    selfComparison: boolean;
    constantCondition: boolean;
    duplicateBranchCondition: boolean;
    unusedExpression: boolean;
    maxProblems: number;
}

const COMPARISON_OPERATORS = new Set(["==", "!=", "<", ">", "<=", ">="]);
const ARITHMETIC_OPERATORS = new Set(["+", "-", "*", "/", "%"]);
const OPENING = new Set(["(", "[", "{"]);
const CLOSING = new Set([")", "]", "}"]);
const STATEMENT_START_KEYWORDS = new Set([
    ...STATEMENT_KEYWORDS,
    ...BRANCH_KEYWORDS,
    END_KEYWORD
]);
const WORD_OPERATOR_SET = new Set(WORD_OPERATORS);
const LITERAL_WORDS = new Set(LITERAL_KEYWORDS);
/* Длина самого длинного ключевого слова: «continue». */
const LONGEST_KEYWORD = 8;
/** Слова, после которых идёт заголовок, а не обычный оператор. */
const HEADER_KEYWORDS = new Set([
    "macro",
    "class",
    "if",
    "elif",
    "while",
    "for",
    "with",
    "onerror"
]);

/**
 * Роль ключевого слова одним поиском.
 *
 * Раньше на каждый короткий идентификатор приходилось два поиска по
 * множествам; на настоящем проекте это половина стоимости обхода, а
 * идентификаторов в нём сотни тысяч.
 */
type RslStatementWordRole = "end" | "header" | "start";

const WORD_ROLES = new Map<string, RslStatementWordRole>();

for (const word of STATEMENT_START_KEYWORDS) {
    WORD_ROLES.set(
        word,
        HEADER_KEYWORDS.has(word) ? "header" : "start"
    );
}

WORD_ROLES.set(END_KEYWORD, "end");
WORD_ROLES.set("else", "end");

/**
 * Разбор потока на операторы и условия.
 *
 * Состояние живёт между вызовами: обход возобновляемый, и порция может
 * кончиться посреди оператора.
 */
export interface IRslStatementScanner {
    /** Очередной токен потока и его номер в нём. */
    accept(token: IRslToken, index: number): void;
}

export function createRslStatementScanner(
    module: IIndexedModule,
    options: IRslStatementCheckOptions,
    result: Diagnostic[],
    /**
     * Поток, по которому идёт обход; по умолчанию весь файл.
     *
     * При точечном пересчёте это токены изменившихся единиц: оператор
     * целиком лежит в своей единице, и соседние ему не нужны.
     */
    scanned?: readonly IRslToken[]
): IRslStatementScanner {
    const tokens = scanned || module.syntax.tokens;
    /*
     * Оператор хранится границами в общем потоке, а не своим массивом, и
     * его приметы считаются тем же проходом.
     *
     * Копия каждого оператора и второй проход по нему обходились дороже
     * всей проверки: операторов в проекте десятки тысяч, а находок единицы.
     * Срез делается только для того оператора, который и правда кандидат.
     */
    let start = 0;
    let depth = 0;
    /*
     * Заголовок блока: точки с запятой у него нет, и без отдельной границы
     * он слипался бы с первым оператором тела.
     */
    let header = false;
    /* Приметы текущего оператора: см. IRslStatementShape. */
    let assignment = -1;
    let comparisons = 0;
    let hasCall = false;
    let hasMember = false;
    let hasOperator = false;

    const report = (diagnostic: Diagnostic): void => {
        if (result.length < options.maxProblems) {
            result.push(diagnostic);
        }
    };
    /**
     * Закончить оператор.
     *
     * end — за последним его токеном, next — первый токен следующего.
     * Разница важна: «;» в оператор не входит и следующему не достаётся, а
     * ключевое слово, начавшее новый оператор, достаётся именно ему.
     */
    const flush = (end: number, next: number): void => {
        if (end > start) {
            const length = end - start;
            const first = tokens[start];
            const expression = !hasCall && !hasMember && assignment < 0 && (
                (length === 1 && (
                    first.kind === "string" || first.kind === "number"
                )) ||
                (length >= 3 && hasOperator)
            );
            const interesting = expression ||
                (!hasCall && (assignment >= 0 || comparisons === 1));

            if (interesting) {
                checkStatement(
                    module,
                    options,
                    tokens,
                    start,
                    end,
                    { assignment, comparisons, expression },
                    report
                );
            }
        }

        start = next;
        header = false;
        assignment = -1;
        comparisons = 0;
        hasCall = false;
        hasMember = false;
        hasOperator = false;
    };

    return {
        accept(token: IRslToken, index: number): void {
            const kind = token.kind;

            if (kind === "symbol") {
                const raw = token.raw;

                if (raw === "(" || raw === "[" || raw === "{") {
                    depth++;

                    if (
                        index > start &&
                        tokens[index - 1].kind === "identifier"
                    ) {
                        hasCall = true;
                    }

                    return;
                }

                if (raw === ")" || raw === "]" || raw === "}") {
                    depth = depth > 0 ? depth - 1 : 0;

                    /* Закрылся список параметров заголовка. */
                    if (depth === 0 && header && raw === ")") {
                        flush(index + 1, index + 1);
                    }

                    return;
                }

                if (raw === ".") {
                    hasMember = true;

                    return;
                }

                if (depth !== 0) {
                    return;
                }

                if (raw === ";") {
                    flush(index, index + 1);

                    return;
                }

                if (raw === "=") {
                    if (assignment < 0) {
                        assignment = index - start;
                    }

                    return;
                }

                if (COMPARISON_OPERATORS.has(raw)) {
                    comparisons++;
                    hasOperator = true;

                    return;
                }

                if (ARITHMETIC_OPERATORS.has(raw)) {
                    hasOperator = true;
                }

                return;
            }

            if (depth !== 0 || kind !== "identifier") {
                return;
            }

            /*
             * Нормализация — не бесплатная операция, а ключевые слова
             * короткие: длинное имя заведомо не ключевое слово.
             */
            if (token.value.length > LONGEST_KEYWORD) {
                return;
            }

            const word = normalizeIdentifier(token.value);
            const role = WORD_ROLES.get(word);

            if (role === undefined) {
                if (WORD_OPERATOR_SET.has(word)) {
                    hasOperator = true;

                    return;
                }

                /* Заголовок без скобок кончается переводом строки. */
                if (
                    header &&
                    index > start &&
                    token.line > tokens[index - 1].endLine
                ) {
                    flush(index, index);
                }

                return;
            }

            if (role === "end") {
                /* END и ELSE заканчивают оператор и своего не начинают. */
                flush(index, index + 1);

                return;
            }

            flush(index, index);
            header = role === "header";
        }
    };
}

/**
 * Условия ветвлений: по дереву, а не по потоку токенов.
 *
 * У IfStatement, ElseIfClause и WhileStatement заголовок лежит в узле целиком,
 * и цепочка if/elif — это узел вместе со своими ветвями. Собирать то же самое
 * из потока значило бы повторять разбор и ошибаться на недописанном тексте.
 */
export function checkRslConditions(
    module: IIndexedModule,
    options: IRslStatementCheckOptions,
    result: Diagnostic[],
    /**
     * Границы, внутри которых считать; undefined — весь файл.
     *
     * Результат правил условия зависит только от текста своей единицы,
     * поэтому при точечном пересчёте обходить остальные незачем.
     */
    ranges?: readonly { start: number; end: number }[]
): void {
    if (
        !options.selfComparison &&
        !options.constantCondition &&
        !options.duplicateBranchCondition
    ) {
        return;
    }

    const report = (diagnostic: Diagnostic): void => {
        if (result.length < options.maxProblems) {
            result.push(diagnostic);
        }
    };

    const insideRanges = (node: IRslSyntaxNode): boolean =>
        ranges === undefined ||
        ranges.some(range =>
            node.end >= range.start && node.start <= range.end);

    const visit = (node: IRslSyntaxNode): void => {
        /*
         * Внутрь объявлений переменных и параметров ветвления не
         * попадают, а узлов таких в файле больше всего.
         */
        if (!CONTAINER_KINDS.has(node.kind) || !insideRanges(node)) {
            return;
        }

        if (node.kind === "IfStatement") {
            const chain: IRslChainCondition[] = [];

            checkOneCondition(module, options, node, chain, report);

            for (const child of node.children) {
                if (child.kind === "ElseIfClause") {
                    checkOneCondition(module, options, child, chain, report);
                }
            }
        } else if (node.kind === "WhileStatement") {
            checkOneCondition(module, options, node, undefined, report);
        }

        for (const child of node.children) {
            visit(child);
        }
    };

    visit(module.syntax.root);
}

/**
 * Узлы, внутри которых бывают ветвления.
 *
 * Обход условий заходит только в них: у объявления переменной или
 * параметра детей-ветвлений не бывает, а таких узлов в файле большинство.
 */
const CONTAINER_KINDS = new Set([
    "CompilationUnit",
    "MacroDeclaration",
    "ClassDeclaration",
    "IfStatement",
    "ElseIfClause",
    "ElseClause",
    "WhileStatement",
    "ForStatement",
    "WithStatement",
    "OnErrorClause",
    "Block"
]);

interface IRslChainCondition {
    text: string;
    line: number;
}

function checkOneCondition(
    module: IIndexedModule,
    options: IRslStatementCheckOptions,
    node: IRslSyntaxNode,
    chain: IRslChainCondition[] | undefined,
    report: (diagnostic: Diagnostic) => void
): void {
    const tokens = conditionTokens(node.tokens);

    if (tokens.length === 0) {
        return;
    }

    /*
     * Приметы условия считаются одним обходом и решают, какое правило вообще
     * может здесь сработать. Без этого каждое правило обходило условие само —
     * шесть проходов и столько же копий на каждое ветвление файла.
     */
    const shape = describeCondition(tokens);

    if (options.selfComparison && shape.comparisons === 1 && !shape.hasCall) {
        checkSelfComparison(module, tokens, report);
    }

    /*
     * `while (true)` — обычный способ записать бесконечный цикл, а не
     * описка: выход из него делают BREAK или RETURN. На настоящем
     * проекте это была вся находка правила, и она была ложной.
     */
    const infiniteLoop = node.kind === "WhileStatement" &&
        isTrueLiteral(tokens);

    if (
        options.constantCondition &&
        shape.constantOnly &&
        !infiniteLoop
    ) {
        checkConstantCondition(module, tokens, report);
    }

    if (chain && options.duplicateBranchCondition && !shape.hasCall) {
        checkDuplicateBranch(module, tokens, chain, report);
    }
}

/** Приметы условия: что в нём есть, чтобы не обходить его каждым правилом. */
interface IRslConditionShape {
    hasCall: boolean;
    /** Сколько сравнений верхнего уровня. */
    comparisons: number;
    /** Ни одного имени, кроме литералов и связок: значение вычислимо. */
    constantOnly: boolean;
}

function describeCondition(
    tokens: readonly IRslToken[]
): IRslConditionShape {
    let depth = 0;
    let hasCall = false;
    let comparisons = 0;
    let constantOnly = true;

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind === "symbol") {
            const raw = token.raw;

            if (raw === "(" || raw === "[" || raw === "{") {
                depth++;
                hasCall = hasCall ||
                    (index > 0 && tokens[index - 1].kind === "identifier");
                continue;
            }

            if (raw === ")" || raw === "]" || raw === "}") {
                depth--;
                continue;
            }

            if (depth === 0 && COMPARISON_OPERATORS.has(raw)) {
                comparisons++;
            }

            continue;
        }

        if (token.kind !== "identifier") {
            continue;
        }

        const word = token.value.length <= LONGEST_KEYWORD
            ? normalizeIdentifier(token.value)
            : "";

        if (!LITERAL_WORDS.has(word) && !WORD_OPERATOR_SET.has(word)) {
            constantOnly = false;
        }
    }

    return { hasCall, comparisons, constantOnly };
}

/** Условие — это ровно `true`, с любым числом внешних скобок. */
function isTrueLiteral(tokens: readonly IRslToken[]): boolean {
    const inner = withoutOuterParentheses(tokens);

    return inner.length === 1 &&
        inner[0].kind === "identifier" &&
        normalizeIdentifier(inner[0].value) === "true";
}

/** Условие между первой «(» заголовка и парной ей «)». */
function conditionTokens(tokens: readonly IRslToken[]): readonly IRslToken[] {
    const open = tokens.findIndex(token =>
        token.kind === "symbol" && token.raw === "(");

    if (open < 0) {
        return [];
    }

    let depth = 0;

    for (let index = open; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind !== "symbol") {
            continue;
        }

        if (OPENING.has(token.raw)) {
            depth++;
            continue;
        }

        if (CLOSING.has(token.raw)) {
            depth--;

            if (depth === 0) {
                return tokens.slice(open + 1, index);
            }
        }
    }

    return [];
}

/* ─── Правила оператора ──────────────────────────────────────────────────── */

/** Приметы оператора, посчитанные обходом: см. createRslStatementScanner. */
interface IRslStatementShape {
    /** Смещение «=» верхнего уровня от начала оператора или -1. */
    assignment: number;
    /** Сколько сравнений верхнего уровня. */
    comparisons: number;
    /** Похоже на выражение без эффекта. */
    expression: boolean;
}

function checkStatement(
    module: IIndexedModule,
    options: IRslStatementCheckOptions,
    tokens: readonly IRslToken[],
    from: number,
    to: number,
    shape: IRslStatementShape,
    report: (diagnostic: Diagnostic) => void
): void {
    const first = tokens[from];

    if (
        !first ||
        (first.kind === "identifier" &&
            first.value.length <= LONGEST_KEYWORD &&
            STATEMENT_START_KEYWORDS.has(normalizeIdentifier(first.value)))
    ) {
        /* return, var, break — не выражение и не присваивание. */
        return;
    }

    const statement = tokens.slice(from, to);

    if (options.selfAssignment && shape.assignment >= 0) {
        checkSelfAssignment(module, statement, report);
    }

    if (options.selfComparison && shape.comparisons === 1) {
        checkSelfComparison(module, statement, report);
    }

    if (options.unusedExpression && shape.expression) {
        checkUnusedExpression(module, statement, report);
    }
}

/**
 * `clientIIN = clientIIN;`
 *
 * Сравниваются нормализованные стороны: регистр в RSL не значим, пробелы и
 * комментарии в поток не попадают. Вызовы и индексы отменяют проверку — их
 * повторное вычисление может иметь смысл.
 */
function checkSelfAssignment(
    module: IIndexedModule,
    statement: readonly IRslToken[],
    report: (diagnostic: Diagnostic) => void
): void {
    const operator = topLevelAssignment(statement);

    if (operator < 0) {
        return;
    }

    const left = statement.slice(0, operator);
    const right = statement.slice(operator + 1);

    if (!isPureReference(left) || !isPureReference(right)) {
        return;
    }

    if (signatureOf(left) !== signatureOf(right)) {
        return;
    }

    report(createOffsetDiagnostic(
        module,
        statement[0].start,
        statement[statement.length - 1].end,
        DiagnosticSeverity.Warning,
        "Присваивание самому себе: значение не изменится",
        "self-assignment"
    ));
}

/**
 * `if (status == status)` и `amount != amount` в обычном операторе.
 *
 * Проверяется только простая форма: всё выражение — это `A op B` без других
 * операторов верхнего уровня. Иначе пришлось бы разбирать приоритеты, а
 * ошибиться в них значило бы предупредить о верном коде.
 */
function checkSelfComparison(
    module: IIndexedModule,
    tokens: readonly IRslToken[],
    report: (diagnostic: Diagnostic) => void
): void {
    const comparison = singleComparison(tokens);

    if (!comparison) {
        return;
    }

    const { left, right, operator } = comparison;

    if (!isPureReference(left) || !isPureReference(right)) {
        return;
    }

    if (signatureOf(left) !== signatureOf(right)) {
        return;
    }

    const always = operator === "==" || operator === "<=" || operator === ">="
        ? "истинно"
        : "ложно";

    report(createOffsetDiagnostic(
        module,
        left[0].start,
        right[right.length - 1].end,
        DiagnosticSeverity.Warning,
        `Сравнение значения с самим собой: всегда ${always}`,
        "self-comparison"
    ));
}

/**
 * `amount + commission;` — вычислили и выбросили.
 *
 * Предупреждение только там, где бесполезность доказуема: одиночный литерал
 * или выражение из имён, литералов и арифметики. Вызов, индекс, обращение к
 * члену и присваивание могут менять состояние, поэтому такой оператор
 * бесполезным не считается.
 */
function checkUnusedExpression(
    module: IIndexedModule,
    statement: readonly IRslToken[],
    report: (diagnostic: Diagnostic) => void
): void {
    if (topLevelAssignment(statement) >= 0) {
        return;
    }

    for (const token of statement) {
        if (token.kind === "symbol" && (
            OPENING.has(token.raw) ||
            CLOSING.has(token.raw) ||
            token.raw === "." ||
            token.raw === "="
        )) {
            return;
        }

        if (
            token.kind === "identifier" &&
            STATEMENT_START_KEYWORDS.has(normalizeIdentifier(token.value))
        ) {
            return;
        }
    }

    const single = statement.length === 1 &&
        (statement[0].kind === "string" || statement[0].kind === "number");
    const hasOperator = statement.some(token =>
        (token.kind === "symbol" && (
            ARITHMETIC_OPERATORS.has(token.raw) ||
            COMPARISON_OPERATORS.has(token.raw)
        )) ||
        (token.kind === "identifier" &&
            WORD_OPERATOR_SET.has(normalizeIdentifier(token.value))));

    if (!single && !(hasOperator && statement.length >= 3)) {
        return;
    }

    report(createOffsetDiagnostic(
        module,
        statement[0].start,
        statement[statement.length - 1].end,
        DiagnosticSeverity.Warning,
        "Выражение вычисляется, но результат никуда не идёт",
        "unused-expression"
    ));
}

/* ─── Правила условия ────────────────────────────────────────────────────── */

/**
 * `if (true)`, `while (false)`, `if (1 == 2)`.
 *
 * Вычисляется только заведомо известное: логический литерал, сравнение
 * литералов, `not` и связки над уже известными значениями. Ни переменных, ни
 * вызовов — полноценного вычислителя выражений здесь нет намеренно, потому что
 * ошибка в нём означала бы предупреждение о верном коде.
 */
function checkConstantCondition(
    module: IIndexedModule,
    tokens: readonly IRslToken[],
    report: (diagnostic: Diagnostic) => void
): void {
    const value = evaluate(tokens);

    if (value === undefined) {
        return;
    }

    report(createOffsetDiagnostic(
        module,
        tokens[0].start,
        tokens[tokens.length - 1].end,
        DiagnosticSeverity.Warning,
        `Условие всегда ${value ? "истинно" : "ложно"}`,
        "constant-condition"
    ));
}

/**
 * Повторное условие в одной цепочке if/elif.
 *
 * Сравниваются нормализованные токены без внешних скобок. Условие с вызовом
 * пропускается: два одинаковых вызова могут вернуть разное.
 */
function checkDuplicateBranch(
    module: IIndexedModule,
    condition: readonly IRslToken[],
    chain: IRslChainCondition[],
    report: (diagnostic: Diagnostic) => void
): void {
    const tokens = withoutOuterParentheses(condition);

    if (tokens.length === 0 || containsCall(tokens)) {
        return;
    }

    const text = signatureOf(tokens);
    const previous = chain.find(item => item.text === text);

    if (previous) {
        report(createOffsetDiagnostic(
            module,
            tokens[0].start,
            tokens[tokens.length - 1].end,
            DiagnosticSeverity.Warning,
            "Это условие уже проверено выше в той же цепочке (строка " +
                (previous.line + 1) + "); ветка недостижима",
            "duplicate-branch-condition"
        ));

        return;
    }

    chain.push({ text, line: tokens[0].line });
}

/* ─── Общее ──────────────────────────────────────────────────────────────── */

/** Индекс «=» на нулевой глубине; -1 — присваивания нет. */
function topLevelAssignment(tokens: readonly IRslToken[]): number {
    let depth = 0;

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind !== "symbol") {
            continue;
        }

        if (OPENING.has(token.raw)) {
            depth++;
            continue;
        }

        if (CLOSING.has(token.raw)) {
            depth--;
            continue;
        }

        if (depth === 0 && token.raw === "=") {
            return index;
        }
    }

    return -1;
}

/** Единственное сравнение верхнего уровня: `A op B` и больше ничего. */
function singleComparison(
    tokens: readonly IRslToken[]
): { left: IRslToken[]; right: IRslToken[]; operator: string } | undefined {
    let depth = 0;
    let operatorIndex = -1;

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind === "symbol" && OPENING.has(token.raw)) {
            depth++;
            continue;
        }

        if (token.kind === "symbol" && CLOSING.has(token.raw)) {
            depth--;
            continue;
        }

        if (depth !== 0) {
            continue;
        }

        if (
            token.kind === "identifier" &&
            WORD_OPERATOR_SET.has(normalizeIdentifier(token.value))
        ) {
            /* Связка верхнего уровня: разбирать приоритеты правило не берётся. */
            return undefined;
        }

        if (token.kind !== "symbol") {
            continue;
        }

        if (COMPARISON_OPERATORS.has(token.raw)) {
            if (operatorIndex >= 0) {
                return undefined;
            }

            operatorIndex = index;
            continue;
        }

        if (token.raw === "=") {
            return undefined;
        }
    }

    if (operatorIndex <= 0 || operatorIndex >= tokens.length - 1) {
        return undefined;
    }

    return {
        left: tokens.slice(0, operatorIndex),
        right: tokens.slice(operatorIndex + 1),
        operator: tokens[operatorIndex].raw
    };
}

/**
 * Чистая ссылка: имя, `this`, цепочка через точку.
 *
 * Ни вызовов, ни индексов, ни операторов: только то, повторное чтение чего
 * заведомо даёт то же самое.
 */
function isPureReference(tokens: readonly IRslToken[]): boolean {
    if (tokens.length === 0) {
        return false;
    }

    let expectName = true;

    for (const token of tokens) {
        if (expectName) {
            if (token.kind !== "identifier") {
                return false;
            }

            if (
                STATEMENT_START_KEYWORDS.has(normalizeIdentifier(token.value)) ||
                WORD_OPERATOR_SET.has(normalizeIdentifier(token.value))
            ) {
                return false;
            }

            expectName = false;
            continue;
        }

        if (token.kind === "symbol" && token.raw === ".") {
            expectName = true;
            continue;
        }

        return false;
    }

    return !expectName;
}

function signatureOf(tokens: readonly IRslToken[]): string {
    return tokens
        .map(token => token.kind === "identifier"
            ? normalizeIdentifier(token.value)
            : token.raw)
        .join(" ");
}

function containsCall(tokens: readonly IRslToken[]): boolean {
    return tokens.some((token, index) =>
        token.kind === "symbol" &&
        OPENING.has(token.raw) &&
        index > 0 &&
        tokens[index - 1].kind === "identifier");
}

function withoutOuterParentheses(
    tokens: readonly IRslToken[]
): readonly IRslToken[] {
    let current = tokens;

    for (;;) {
        if (
            current.length < 2 ||
            !(current[0].kind === "symbol" && current[0].raw === "(") ||
            !(current[current.length - 1].kind === "symbol" &&
                current[current.length - 1].raw === ")")
        ) {
            return current;
        }

        let depth = 0;
        let balanced = true;

        for (let index = 0; index < current.length - 1; index++) {
            const token = current[index];

            if (token.kind !== "symbol") {
                continue;
            }

            if (OPENING.has(token.raw)) {
                depth++;
            } else if (CLOSING.has(token.raw)) {
                depth--;

                if (depth === 0) {
                    balanced = false;
                    break;
                }
            }
        }

        if (!balanced) {
            return current;
        }

        current = current.slice(1, -1);
    }
}

/*
 * ─── Вычисление заведомо известного ─────────────────────────────────────────
 *
 * Разбор рекурсивный и нарочно бедный: связки, отрицание, сравнение литералов
 * и скобки. Всё остальное — undefined, то есть «не знаю», и правило молчит.
 */

function evaluate(tokens: readonly IRslToken[]): boolean | undefined {
    const inner = withoutOuterParentheses(tokens);

    if (inner.length === 0) {
        return undefined;
    }

    const or = splitByWord(inner, "or");

    if (or) {
        const left = evaluate(or.left);
        const right = evaluate(or.right);

        return left === undefined || right === undefined
            ? undefined
            : left || right;
    }

    const and = splitByWord(inner, "and");

    if (and) {
        const left = evaluate(and.left);
        const right = evaluate(and.right);

        return left === undefined || right === undefined
            ? undefined
            : left && right;
    }

    if (
        inner[0].kind === "identifier" &&
        normalizeIdentifier(inner[0].value) === "not"
    ) {
        const value = evaluate(inner.slice(1));

        return value === undefined ? undefined : !value;
    }

    if (inner.length === 1) {
        return booleanLiteral(inner[0]);
    }

    const comparison = singleComparison(inner);

    if (!comparison) {
        return undefined;
    }

    return compareLiterals(
        comparison.left,
        comparison.right,
        comparison.operator
    );
}

/** Делит по последней связке верхнего уровня: связки левоассоциативны. */
function splitByWord(
    tokens: readonly IRslToken[],
    word: string
): { left: readonly IRslToken[]; right: readonly IRslToken[] } | undefined {
    let depth = 0;

    for (let index = tokens.length - 1; index >= 0; index--) {
        const token = tokens[index];

        if (token.kind === "symbol" && CLOSING.has(token.raw)) {
            depth++;
            continue;
        }

        if (token.kind === "symbol" && OPENING.has(token.raw)) {
            depth--;
            continue;
        }

        if (
            depth === 0 &&
            token.kind === "identifier" &&
            normalizeIdentifier(token.value) === word
        ) {
            return {
                left: tokens.slice(0, index),
                right: tokens.slice(index + 1)
            };
        }
    }

    return undefined;
}

function booleanLiteral(token: IRslToken): boolean | undefined {
    if (token.kind !== "identifier") {
        return undefined;
    }

    const word = normalizeIdentifier(token.value);

    if (!LITERAL_WORDS.has(word)) {
        return undefined;
    }

    return word === "true" ? true : word === "false" ? false : undefined;
}

function compareLiterals(
    left: readonly IRslToken[],
    right: readonly IRslToken[],
    operator: string
): boolean | undefined {
    const first = literalValue(left);
    const second = literalValue(right);

    if (first === undefined || second === undefined) {
        return undefined;
    }

    if (typeof first !== typeof second) {
        /* Сравнение числа со строкой в RSL допустимо: результат не выводим. */
        return undefined;
    }

    switch (operator) {
        case "==":
            return first === second;
        case "!=":
            return first !== second;
        case "<":
            return first < second;
        case ">":
            return first > second;
        case "<=":
            return first <= second;
        case ">=":
            return first >= second;
        default:
            return undefined;
    }
}

/** Значение литерала; undefined — это не литерал. */
function literalValue(
    tokens: readonly IRslToken[]
): number | string | undefined {
    const inner = withoutOuterParentheses(tokens);

    if (inner.length === 1) {
        const token = inner[0];

        if (token.kind === "number") {
            const value = Number(token.value);

            return Number.isFinite(value) ? value : undefined;
        }

        if (token.kind === "string") {
            return token.value;
        }

        return undefined;
    }

    /* Отрицательное число: `-1`. */
    if (
        inner.length === 2 &&
        inner[0].kind === "symbol" &&
        inner[0].raw === "-" &&
        inner[1].kind === "number"
    ) {
        const value = Number(inner[1].value);

        return Number.isFinite(value) ? -value : undefined;
    }

    return undefined;
}

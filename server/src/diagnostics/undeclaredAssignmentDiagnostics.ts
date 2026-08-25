import {
    CompletionItemKind,
    Diagnostic,
    DiagnosticSeverity
} from "vscode-languageserver";

import {
    createWorkSlice,
    type IRslWorkSlice
} from "../core/timeSlice";
import { normalizeIdentifier, type IRslToken } from "../lexer";
import type { IRslFastClass, RslScopeResolver } from "../scopeResolver";
import type { RslSymbol } from "../symbols/rslSymbol";
import type { IIndexedModule } from "../workspaceIndex";
import {
    collectRslDeclarationStarts,
    collectRslVarScopes,
    isInsideVarScope,
    isRslExpressionIdentifier,
    isRslSimpleAssignmentTarget,
    type IRslOffsetRange
} from "./nameCheckScopes";
import {
    readKnownGlobals,
    type IRslUnknownVariableFinding
} from "./unknownVariableDiagnostics";

/**
 * Переменная, созданная присваиванием, но нигде не объявленная.
 *
 * Отдельная проверка, а не режим проверки «неопределённый идентификатор», и
 * различаются они не строгостью, а вопросом.
 *
 * Здесь вопрос местный: в процедуре объявляют переменные через VAR, а вот это
 * имя слева от «=» не объявлено ни параметром, ни VAR, ни полем класса, ни
 * переменной модуля. Ответ на него не зависит от того, прочитаны ли
 * импортированные модули: снаружи может прийти процедура, класс или константа,
 * но не объявление местной переменной. Поэтому проверка идёт в локальной фазе
 * и не ждёт Import-контекст — раньше один неизвестный RSM-модуль выключал её
 * целиком.
 *
 * Читающее обращение (`value = CONSTANT`), вызов, конструктор, обращение к
 * члену и тип не проверяются: там имя вполне может прийти извне проекта. Это
 * вопрос другой проверки — strict.
 */

export interface IRslUndeclaredAssignmentOptions {
    /** Сколько находок нужно вызывающему; см. проверку неизвестных имён. */
    limit?: number;
    /** Файл со списком имён, приходящих извне проекта. */
    knownGlobalsFile?: string;
    isCancelled?(): boolean;
}

/**
 * Область файла: где начинается, где кончается и что в ней объявлено.
 *
 * Имена объявленных переменных лежат множеством, вложенные области —
 * отсортированным массивом. Обход детей перебором стоил бы столько же, сколько
 * их в области, а у модуля с четырьмя тысячами процедур это четыре тысячи
 * сравнений на КАЖДУЮ цель присваивания.
 */
interface IRslScopeNode {
    symbol: RslSymbol;
    start: number;
    end: number;
    name: string;
    variables: ReadonlySet<string>;
    children: readonly IRslScopeNode[];
}

/**
 * Факты файла, общие для всех целей присваивания.
 *
 * Считаются один раз: обход дерева ради областей с VAR и обход объявлений — по
 * несколько миллисекунд на большом файле, а целей присваивания в нём тысячи.
 */
export interface IRslAssignmentCheckFacts {
    varScopes: readonly IRslOffsetRange[];
    declarationStarts: ReadonlySet<number>;
    knownGlobals: ReadonlySet<string>;
    scopes: IRslScopeNode;
}

export function createRslAssignmentCheckFacts(
    module: IIndexedModule,
    knownGlobalsFile?: string
): IRslAssignmentCheckFacts {
    return {
        varScopes: collectRslVarScopes(module),
        declarationStarts: collectRslDeclarationStarts(module),
        knownGlobals: readKnownGlobals(knownGlobalsFile),
        scopes: buildScopeNode(module.symbolTree, "")
    };
}

/**
 * Отбор кандидата без резолвера.
 *
 * Только простая цель присваивания в области, где переменные объявляют. Если
 * в области нет ни одного VAR, отличить опечатку от намеренно созданной
 * неявной переменной нечем, и проверка молчит.
 */
export function isRslUndeclaredAssignmentCandidate(
    tokens: readonly IRslToken[],
    index: number,
    facts: IRslAssignmentCheckFacts
): boolean {
    const token = tokens[index];

    return token.kind === "identifier" &&
        facts.varScopes.length > 0 &&
        isRslSimpleAssignmentTarget(tokens, index) &&
        isInsideVarScope(facts.varScopes, token.start) &&
        !facts.knownGlobals.has(normalizeIdentifier(token.value)) &&
        isRslExpressionIdentifier(tokens, index, facts.declarationStarts);
}

/**
 * Проверка отобранного кандидата.
 *
 * Подходит только объявление ПЕРЕМЕННОЙ: параметр, VAR своей или объемлющей
 * области, поле своего или родительского класса, переменная модуля,
 * переменная импортированного модуля. Процедура, класс или константа с таким
 * именем объявлением переменной не считается — присваивание им и создаёт ту
 * самую необъявленную переменную.
 */
export function checkRslUndeclaredAssignment(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    token: IRslToken,
    facts: IRslAssignmentCheckFacts
): IRslUnknownVariableFinding | undefined {
    const name = normalizeIdentifier(token.value);
    const chain = scopeChainAt(facts.scopes, token.start);

    if (chain.some(scope => scope.variables.has(name))) {
        return undefined;
    }

    const enclosingClass = lastClassOf(chain);

    if (
        enclosingClass &&
        hasInheritedField(module, resolver, enclosingClass.symbol, name)
    ) {
        return undefined;
    }

    const resolved = resolver.resolveAt(
        module.uri,
        module.symbolTree,
        token.start
    );

    if (resolved && isVariableSymbol(resolved.symbol)) {
        return undefined;
    }

    /*
     * Присваивание константе — своя ошибка, `assignment-to-constant`. Второе
     * сообщение о том же месте ничего не добавляет.
     */
    if (resolved?.symbol.kind === CompletionItemKind.Constant) {
        return undefined;
    }

    return {
        uri: module.uri,
        name: token.value,
        start: token.start,
        end: token.end,
        line: token.line,
        character: token.character,
        scope: chain.length > 0 ? chain[chain.length - 1].name : "",
        hasExplicitVar: true,
        importContext:
            resolver.getImportContextState(module.uri).completeness,
        reason: "no-declaration"
    };
}

export function collectRslUndeclaredAssignments(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    options: IRslUndeclaredAssignmentOptions = {}
): IRslUnknownVariableFinding[] {
    const steps = undeclaredAssignmentSteps(module, resolver, options);
    let step = steps.next();

    while (!step.done) {
        step = steps.next();
    }

    return step.value;
}

/** Тот же обход порциями: нужен audit-отчёту по всему файлу. */
export async function collectRslUndeclaredAssignmentsChunked(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    options: IRslUndeclaredAssignmentOptions = {},
    slice: IRslWorkSlice = createWorkSlice()
): Promise<IRslUnknownVariableFinding[]> {
    const steps = undeclaredAssignmentSteps(module, resolver, options);
    let step = steps.next();

    while (!step.done) {
        await slice.yieldIfNeeded();
        step = steps.next();
    }

    return step.value;
}

export function buildRslUndeclaredAssignmentDiagnostics(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    options: IRslUndeclaredAssignmentOptions = {}
): Diagnostic[] {
    return collectRslUndeclaredAssignments(module, resolver, options)
        .map(createUndeclaredAssignmentDiagnostic);
}

/**
 * Сообщение говорит ровно то, что проверено.
 *
 * Не «идентификатора не существует» — про имя из RSM или DLM этого никто не
 * знает, — а «в этой области оно не объявлено»: нарушен способ объявления
 * переменных, принятый в самой процедуре.
 */
export function createUndeclaredAssignmentDiagnostic(
    finding: IRslUnknownVariableFinding
): Diagnostic {
    return {
        severity: DiagnosticSeverity.Warning,
        range: {
            start: { line: finding.line, character: finding.character },
            end: {
                line: finding.line,
                character: finding.character + (finding.end - finding.start)
            }
        },
        message: `Переменная ${finding.name} не объявлена в текущей области`,
        source: "RSL parser",
        code: "undeclared-variable",
        data: {
            start: finding.start,
            end: finding.end,
            name: finding.name
        }
    };
}

/**
 * Как часто проверяется отмена: раз в тысячу токенов, как и в соседней
 * проверке имён.
 */
const CANCEL_CHECK_INTERVAL = 1000;

function* undeclaredAssignmentSteps(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    options: IRslUndeclaredAssignmentOptions
): Generator<void, IRslUnknownVariableFinding[], void> {
    const limit = options.limit ?? Number.POSITIVE_INFINITY;

    if (limit <= 0) {
        return [];
    }

    const facts = createRslAssignmentCheckFacts(
        module,
        options.knownGlobalsFile
    );

    if (facts.varScopes.length === 0) {
        return [];
    }

    const tokens = module.syntax.tokens;
    const result: IRslUnknownVariableFinding[] = [];

    for (let index = 0; index < tokens.length; index++) {
        if (index % CANCEL_CHECK_INTERVAL === 0 && index > 0) {
            yield;

            if (options.isCancelled?.()) {
                return result;
            }
        }

        if (!isRslUndeclaredAssignmentCandidate(tokens, index, facts)) {
            continue;
        }

        const finding = checkRslUndeclaredAssignment(
            module,
            resolver,
            tokens[index],
            facts
        );

        if (!finding) {
            continue;
        }

        result.push(finding);

        if (result.length >= limit) {
            return result;
        }
    }

    return result;
}

/**
 * Дерево областей файла с именами объявленных в них переменных.
 *
 * path — имя области так, как его показывает находка: `Holder.Method`. У
 * модуля имени нет, поэтому его дети начинают путь с себя.
 */
function buildScopeNode(symbol: RslSymbol, path: string): IRslScopeNode {
    const variables = new Set<string>();
    const children: IRslScopeNode[] = [];

    for (const child of symbol.children) {
        if (isVariableSymbol(child)) {
            variables.add(normalizeIdentifier(child.name));
        }

        if (child.isContainer) {
            children.push(buildScopeNode(
                child,
                path ? `${path}.${child.name}` : child.name
            ));
        }
    }

    children.sort((left, right) => left.start - right.start);

    return {
        symbol,
        start: symbol.range.start,
        end: symbol.range.end,
        name: path,
        variables,
        children
    };
}

/**
 * Цепочка областей от модуля до самой внутренней, содержащей смещение.
 *
 * Спуск двоичным поиском: у модуля с тысячами процедур перебор детей стоил бы
 * столько же, сколько процедур, и проверка становилась квадратичной — на 646 КБ
 * это 5,9 секунды вместо 0,2.
 */
function scopeChainAt(
    root: IRslScopeNode,
    offset: number
): readonly IRslScopeNode[] {
    const chain: IRslScopeNode[] = [root];
    let current = root;

    for (;;) {
        const next = childAt(current.children, offset);

        if (!next) {
            return chain;
        }

        chain.push(next);
        current = next;
    }
}

function childAt(
    children: readonly IRslScopeNode[],
    offset: number
): IRslScopeNode | undefined {
    let low = 0;
    let high = children.length - 1;

    while (low <= high) {
        const middle = (low + high) >> 1;
        const child = children[middle];

        if (offset < child.start) {
            high = middle - 1;
            continue;
        }

        if (offset > child.end) {
            low = middle + 1;
            continue;
        }

        return child;
    }

    return undefined;
}

function lastClassOf(
    chain: readonly IRslScopeNode[]
): IRslScopeNode | undefined {
    for (let index = chain.length - 1; index >= 0; index--) {
        if (chain[index].symbol.kind === CompletionItemKind.Class) {
            return chain[index];
        }
    }

    return undefined;
}

/**
 * Поле, унаследованное от родительского класса.
 *
 * Нечитаемая база — молчание, а не предупреждение: класс из модуля, которого
 * в проекте нет, вполне может объявлять это поле, и утверждать обратное не на
 * чем. Свои и разрешимые базы резолвер находит и сам, но ответить «базы не
 * видно» умеет только этот обход.
 */
function hasInheritedField(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    from: RslSymbol,
    name: string
): boolean {
    let current: IRslFastClass | undefined = {
        symbol: from,
        moduleUri: module.uri
    };
    /* Наследование в разбираемом файле бывает и circular. */
    const seen = new Set<RslSymbol>();

    while (current && !seen.has(current.symbol)) {
        seen.add(current.symbol);

        if (
            current.symbol.children.some(child =>
                isVariableSymbol(child) &&
                normalizeIdentifier(child.name) === name
            )
        ) {
            return true;
        }

        const baseName = current.symbol.baseClassName;

        if (!baseName) {
            return false;
        }

        const base: IRslFastClass | undefined = resolver.findFastBaseClass(
            current,
            baseName,
            module.imports
        );

        if (!base) {
            return true;
        }

        current = base;
    }

    return false;
}

function isVariableSymbol(symbol: { kind: CompletionItemKind }): boolean {
    return symbol.kind === CompletionItemKind.Variable ||
        symbol.kind === CompletionItemKind.Property ||
        symbol.kind === CompletionItemKind.Field;
}

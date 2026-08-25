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
    createRslAssignmentCheckFacts,
    enclosingRslClassScope,
    isInsideVarScope,
    isRslDeclaredVariableName,
    isRslExpressionIdentifier,
    isRslSimpleAssignmentTarget,
    isRslVariableSymbol,
    rslScopePathAt,
    type IRslAssignmentCheckFacts
} from "./nameCheckScopes";
import type {
    IRslUnknownVariableFinding
} from "./unknownVariableDiagnostics";

/**
 * Переменная, созданная присваиванием, но нигде не объявленная.
 *
 * Отдельная проверка, а не режим проверки «неопределённый идентификатор», и
 * различаются они не строгостью, а вопросом.
 *
 * Здесь вопрос местный: в процедуре объявляют переменные через VAR, а вот это
 * имя слева от «=» не объявлено ни параметром, ни VAR, ни полем класса, ни
 * переменной модуля. Отвечает на него сам файл, поэтому проверка идёт в
 * локальной фазе и работает в обоих режимах — и в safe, и в strict: strict
 * обязан находить всё, что находит safe, и добавлять к этому остальные
 * неразрешённые имена.
 *
 * Читающее обращение (`value = CONSTANT`), вызов, конструктор, обращение к
 * члену и тип не проверяются: там имя вполне может прийти извне проекта. Это
 * вопрос другой проверки — strict.
 *
 * Одно исключение из «локальности»: переменную может объявлять и
 * импортированный модуль. Пока его чтение не закончено, находка не публикуется
 * — иначе результат зависел бы от того, успел ли загрузиться модуль к моменту
 * расчёта. Когда чтение заканчивается, Import-контекст меняется, ключ
 * локальной фазы вместе с ним, и файл пересчитывается (см.
 * DiagnosticsCoordinator). Модуль, которого в проекте нет вовсе — RSM, DLM,
 * встроенный, — ожиданием не считается: ждать там нечего.
 */

export interface IRslUndeclaredAssignmentOptions {
    /** Сколько находок нужно вызывающему; см. проверку неизвестных имён. */
    limit?: number;
    /** Файл со списком имён, приходящих извне проекта. */
    knownGlobalsFile?: string;
    /**
     * Отдавать находки и при незаконченном чтении импортов.
     *
     * Нужно audit-отчёту: он и существует, чтобы увидеть полную картину, а
     * причина у каждой находки указана (`incomplete-context`).
     */
    includePending?: boolean;
    isCancelled?(): boolean;
}

/**
 * Отбор кандидата без резолвера.
 *
 * Только простая цель присваивания в области, где переменные объявляют. Если
 * в области нет ни одного VAR, отличить опечатку от намеренно созданной
 * неявной переменной нечем, и проверка молчит.
 *
 * Инициализатор for пропускается: там присваивание — принятый способ ввести
 * переменную цикла. Условие и шаг проверяются как обычный код: опечатка в
 * `for (i = 0; typo < 3; typo = typo + 1)` обязана находиться.
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
        !isInsideVarScope(facts.forInitializers, token.start) &&
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

    if (isRslDeclaredVariableName(facts, token.start, name)) {
        return undefined;
    }

    const enclosingClass = enclosingRslClassScope(facts, token.start);

    if (
        enclosingClass &&
        hasInheritedField(module, resolver, enclosingClass, name)
    ) {
        return undefined;
    }

    const resolved = resolver.resolveAt(
        module.uri,
        module.symbolTree,
        token.start
    );

    if (resolved && isRslVariableSymbol(resolved.symbol)) {
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
        scope: rslScopePathAt(facts, token.start),
        hasExplicitVar: true,
        importContext:
            resolver.getImportContextState(module.uri).completeness,
        reason: hasPendingRslImports(resolver, module.uri)
            ? "incomplete-context"
            : "no-declaration"
    };
}

/**
 * Ждём ли мы ещё чтения импортированного модуля.
 *
 * Ждать имеет смысл только то, что действительно прочитают: файл проекта в
 * очереди индексации и прикладной модуль, чей состав ещё не загружен. Import
 * модуля RSM или DLM в этот список не попадает — его не прочитают никогда, и
 * молчать из-за него значило бы не проверять вообще.
 *
 * Спрашивают из двух мест — из этапа конвейера диагностик и из своего
 * обхода, — поэтому правило вынесено и экспортировано. Пока оно жило
 * внутри обхода, конвейер его не знал: в Problems находка появлялась и
 * при непрочитанном модуле.
 */
export function hasPendingRslImports(
    resolver: RslScopeResolver,
    uri: string
): boolean {
    const state = resolver.getImportContextState(uri);

    return state.pending.length > 0 ||
        state.pendingPlatformModules.length > 0;
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

    /*
     * Чтение импортов не закончено — публиковать нечего.
     *
     * Переменная может быть объявлена в модуле, который вот-вот прочитают, и
     * показать её ошибкой сейчас значит показать ошибку, зависящую от момента
     * загрузки. Пересчёт после загрузки обеспечен ключом локальной фазы.
     */
    if (
        !options.includePending &&
        hasPendingRslImports(resolver, module.uri)
    ) {
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
                isRslVariableSymbol(child) &&
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

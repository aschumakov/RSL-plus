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
import { normalizeIdentifier, type IRslToken } from "../lexer";
import {
    collectRslDeclarationStarts,
    collectRslImportRanges,
    isInsideRslImport,
    isRslExpressionIdentifier,
    previousRslCodeIndex,
    rslScopeNameAt
} from "./nameCheckScopes";
import {
    createRslMemberChecker,
    type IRslMemberFinding
} from "./unknownMemberDiagnostics";
import type { RslScopeResolver } from "../scopeResolver";
import type { IIndexedModule } from "../workspaceIndex";

/**
 * Неразрешённые идентификаторы: всё, чему в файле не нашлось объявления.
 *
 * Компилятор RSL разрешает имена ещё и из RSM, DLM, встроенных модулей и
 * собственного контекста сборки, которых в workspace нет вообще: отсутствие
 * объявления в проекте само по себе не означает, что имени не существует.
 * Поэтому проверка идёт в межфайловой фазе и включается сознательно.
 *
 *   off    — не проверять;
 *   safe   — по умолчанию: этой проверки нет вовсе, работает соседняя, про
 *            необъявленную переменную слева от «=» (см.
 *            undeclaredAssignmentDiagnostics);
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
     * встречает, отдельного прохода по файлу не появляется. Настройка своя
     * (unknownMembers), поэтому проверка членов работает и при mode = safe.
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
 * Кандидаты на «неразрешённое имя» — без публикации.
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
    /*
     * Имена проверяет только strict.
     *
     * safe — это другая проверка, «переменная не объявлена в текущей области»:
     * она смотрит одни цели присваивания и живёт в локальной фазе.
     */
    const checkNames = options.mode === "strict";
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

    const state = resolver.getImportContextState(module.uri);
    const tokens = module.syntax.tokens;
    const known = readKnownGlobals(options.knownGlobalsFile);
    const declarationStarts = collectRslDeclarationStarts(module);
    const importRanges = collectRslImportRanges(module);
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
            isInsideRslImport(importRanges, importIndex, token)) {
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
            !isRslExpressionIdentifier(tokens, index, declarationStarts) ||
            known.has(normalizeIdentifier(token.value))
        ) {
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
            scope: rslScopeNameAt(module, token.start),
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
         * Формулировка компилятора, а не своя. Неизвестным здесь может
         * оказаться и вызов процедуры, и имя класса: `MissingProc()` — не
         * переменная, а компилятор на всё это отвечает «неопределенный
         * идентификатор».
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
    const dotIndex = previousRslCodeIndex(tokens, index);
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

    const receiverIndex = previousRslCodeIndex(tokens, dotIndex);
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

import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver";

import { readKnownGlobals } from "./unknownVariableDiagnostics";
import { positionAtOffset } from "../core/documentPosition";
import type { RslScopeResolver } from "../scopeResolver";
import {
    RSL_SYSTEM_SPECIAL_VARIABLES,
    isRslSpecialVariableReference,
    isRslSystemSpecialVariableName,
    isRslSpecialVariableFromExamples
} from "../systemSpecialVariables";
import type { IIndexedModule } from "../workspaceIndex";

/**
 * Спецпеременная без объявления.
 *
 * Имена в фигурных скобках бывают двух родов, и это видно по тому, как их
 * пишут.
 *
 * Одни подставляет система: `{curdate}`, `{oper}`, `{Name_Oper}` — их только
 * читают, объявлять не требуется, и справка описывает не все (в проверенном
 * репозитории `{HeadBankId}` и `{DprtCurDate}` используются в 19 файлах и не
 * объявлены нигде — это спецпеременные более новой версии RS-Bank, чем
 * имеющаяся справка).
 *
 * Другие — обычные переменные, которым просто дали имя в скобках:
 * `{txtfile} = GetIniString("TEXTDIR")`. Такие объявляют через VAR, и в
 * репозитории `{txtfile}` объявлен в 143 файлах.
 *
 * По умолчанию проверяются любые незнакомые имена: главная польза правила —
 * поймать опечатку, а `{currdate}` вместо `{curdate}` иначе тихо вернёт пустое
 * значение. Замечаний немного: на репозитории из 5784 файлов их шесть.
 *
 * Имя может прийти и оттуда, куда плагин не заглядывает: через модуль базовой
 * поставки, которого нет в проекте, или из настройки банка. Такие имена
 * перечисляются в файле известных имён; режим assigned оставлен для тех, кому
 * достаточно проверять только имена с присваиванием.
 */
export type RslSpecialVariablesMode = "off" | "assigned" | "all";

export function normalizeSpecialVariablesMode(
    value: unknown
): RslSpecialVariablesMode {
    if (value === "off" || value === "assigned") {
        return value;
    }

    return "all";
}

export interface IRslSpecialVariableOptions {
    mode: RslSpecialVariablesMode;
    /** Тот же файл известных имён, что и у проверки необъявленных переменных. */
    knownGlobalsFile?: string;
    limit?: number;
}

export function buildSpecialVariableDiagnostics(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    options: IRslSpecialVariableOptions
): Diagnostic[] {
    if (options.mode === "off") {
        return [];
    }

    const limit = options.limit ?? Number.POSITIVE_INFINITY;

    if (limit <= 0) {
        return [];
    }

    const known = readKnownGlobals(options.knownGlobalsFile);
    const tokens = module.syntax.tokens;
    const result: Diagnostic[] = [];
    /* Одно имя — одно замечание на файл: повторы ничего не добавляют. */
    const reported = new Set<string>();

    for (let index = 0; index < tokens.length; index++) {
        if (result.length >= limit) {
            break;
        }

        const token = tokens[index];

        if (
            token.kind !== "identifier" ||
            !isRslSpecialVariableReference(token.raw)
        ) {
            continue;
        }

        const name = token.raw;
        const key = name.toLowerCase();
        const next = tokens[index + 1];
        const assigned = next?.kind === "symbol" && next.raw === "=";

        if (
            reported.has(key) ||
            (options.mode === "assigned" && !assigned) ||
            !looksLikeSpecialVariable(name) ||
            isRslSystemSpecialVariableName(name) ||
            isRslSpecialVariableFromExamples(name) ||
            known.has(key) ||
            known.has(bareName(name).toLowerCase())
        ) {
            continue;
        }

        /*
         * Разрешение — то же, что у остальных проверок: объявления файла,
         * импортированные модули проекта, стандартная библиотека и прикладные
         * модули. Спецпеременную объявляют и вручную: `private var {curdate},`.
         */
        if (resolver.resolveName(
            module.uri,
            module.symbolTree,
            name,
            token.start
        )) {
            continue;
        }

        reported.add(key);
        const similar = closestKnownName(bareName(name));
        const hint = similar ? ` Возможно, имелась в виду {${similar}}.` : "";
        result.push({
            severity: DiagnosticSeverity.Warning,
            range: {
                start: positionAtOffset(module.lex.lineStarts, token.start),
                end: positionAtOffset(module.lex.lineStarts, token.end)
            },
            message: assigned
                ? `Спецпеременной ${name} присваивают значение, но её ` +
                    "объявления нет: обычную переменную объявляют через VAR." +
                    hint
                : `Спецпеременная ${name} неизвестна: её нет ни в ` +
                    "справочнике, ни в объявлениях файла." + hint,
            source: "RSL parser",
            code: "unknown-special-variable",
            data: { start: token.start, end: token.end, name }
        });
    }

    return result;
}

/**
 * Похоже ли на имя вообще.
 *
 * Внутри скобок допустим любой символ, но встречаются `.mac`-файлы со
 * встроенным двоичным содержимым — там открывающая скобка попадается случайно,
 * и «именем» оказывается страница мусора. Предел длины взят из сводки
 * синтаксиса: идентификатор RSL не длиннее 80 символов.
 */
function looksLikeSpecialVariable(name: string): boolean {
    if (name.length > 82) {
        return false;
    }

    for (let index = 0; index < name.length; index++) {
        if (name.charCodeAt(index) < 0x20) {
            return false;
        }
    }

    return true;
}

/**
 * Ближайшее известное имя — то, ради чего правило и включено.
 *
 * `{currdate}` вместо `{curdate}` компилятор не заметит: имя в скобках
 * законно любое, и значение просто окажется пустым. Подсказка даётся, когда
 * различие не больше двух букв — иначе это другое имя, а не описка.
 */
function closestKnownName(name: string): string {
    if (name.length < 4) {
        return "";
    }

    const limit = name.length <= 6 ? 1 : 2;
    let best = "";
    let bestDistance = limit + 1;

    for (const known of RSL_SYSTEM_SPECIAL_VARIABLES) {
        const distance = editDistance(
            name.toLowerCase(),
            known.name.toLowerCase(),
            bestDistance
        );

        if (distance < bestDistance) {
            bestDistance = distance;
            best = known.name;
        }
    }

    return bestDistance <= limit ? best : "";
}

/** Расстояние редактирования; счёт прекращается, когда превышен предел. */
function editDistance(first: string, second: string, limit: number): number {
    if (Math.abs(first.length - second.length) > limit) {
        return limit + 1;
    }

    let previous: number[] = [];

    for (let column = 0; column <= second.length; column++) {
        previous.push(column);
    }

    for (let row = 1; row <= first.length; row++) {
        const current = [row];
        let rowBest = row;

        for (let column = 1; column <= second.length; column++) {
            const cost = first.charAt(row - 1) === second.charAt(column - 1)
                ? 0
                : 1;
            const value = Math.min(
                previous[column] + 1,
                current[column - 1] + 1,
                previous[column - 1] + cost
            );
            current.push(value);
            rowBest = Math.min(rowBest, value);
        }

        if (rowBest > limit) {
            return limit + 1;
        }

        previous = current;
    }

    return previous[second.length];
}

/** Имя без скобок: в списке известных имён их пишут и так, и так. */
function bareName(value: string): string {
    return value.startsWith("{") && value.endsWith("}")
        ? value.slice(1, -1)
        : value;
}

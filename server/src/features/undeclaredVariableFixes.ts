import {
    CodeAction,
    CodeActionKind,
    Diagnostic,
    TextEdit
} from "vscode-languageserver";

import { normalizeIdentifier } from "../lexer";
import { applyRslKeywordCase } from "./formatOptions";
import {
    createRslAssignmentCheckFacts,
    visibleRslVariableNames
} from "../diagnostics/nameCheckScopes";
import type { IIndexedModule } from "../workspaceIndex";
import {
    positionInModule
} from "../core/documentPosition";

/**
 * Исправления для «переменная не объявлена в текущей области».
 *
 * Проверка находит копипаст вида `parm = ...` там, где рядом объявлен `param`.
 * Само исправление предлагается только по Ctrl+. — подбор ближайшего имени
 * стоит перебора видимых переменных, и делать его при наборе текста незачем.
 *
 * Замена предлагается ТОЛЬКО при одном уверенном кандидате. Две одинаково
 * близкие переменные — это уже угадывание: пользователь выберет сам, а
 * подсказка из двух вариантов на одно место мешает больше, чем помогает.
 *
 * Кандидатами считаются лишь переменные и параметры. Процедура, класс или
 * константа с похожим именем — не то, чем можно заменить цель присваивания:
 * присваивание им и создаёт необъявленную переменную.
 */

/** Максимальное расстояние правки: у коротких имён допуск меньше. */
function maximumDistance(name: string): number {
    if (name.length <= 3) {
        return 1;
    }

    return name.length <= 8 ? 2 : 3;
}

export function buildRslUndeclaredVariableFixes(
    module: IIndexedModule,
    diagnostic: Diagnostic,
    options: { keywordCase?: string } = {}
): CodeAction[] {
    const data = diagnostic.data as
        { start?: number; end?: number; name?: string } | undefined;
    const name = data?.name;
    const start = data?.start;

    if (!name || typeof start !== "number") {
        return [];
    }

    const facts = createRslAssignmentCheckFacts(module);
    const result: CodeAction[] = [];
    const replacement = nearestVariable(
        name,
        visibleRslVariableNames(facts, start)
    );

    if (replacement) {
        result.push(createAction(
            `Заменить на «${replacement}»`,
            module.uri,
            [TextEdit.replace(diagnostic.range, replacement)],
            diagnostic,
            true
        ));
    }

    const keyword = applyRslKeywordCase("Var", options.keywordCase);
    const declaration = declarationEdit(module, start, name, keyword);

    if (declaration) {
        result.push(createAction(
            `Объявить переменную: ${keyword} ${name};`,
            module.uri,
            [declaration],
            diagnostic,
            !replacement
        ));
    }

    return result;
}

/**
 * Ближайшее по написанию имя — если оно одно.
 *
 * Второй кандидат на том же расстоянии отменяет предложение: выбирать за
 * пользователя между `param` и `parms` не на чем.
 */
function nearestVariable(
    name: string,
    candidates: readonly string[]
): string | undefined {
    const wanted = normalizeIdentifier(name);
    const limit = maximumDistance(wanted);
    let best: { name: string; distance: number } | undefined;
    let ambiguous = false;

    for (const candidate of candidates) {
        const normalized = normalizeIdentifier(candidate);

        if (normalized === wanted) {
            continue;
        }

        const distance = editDistance(wanted, normalized, limit);

        if (distance > limit) {
            continue;
        }

        if (!best || distance < best.distance) {
            best = { name: candidate, distance };
            ambiguous = false;
            continue;
        }

        if (distance === best.distance &&
            normalizeIdentifier(best.name) !== normalized) {
            ambiguous = true;
        }
    }

    return best && !ambiguous ? best.name : undefined;
}

/**
 * Расстояние правки с ранним выходом.
 *
 * Полная матрица здесь не нужна: интересует только «ближе порога или нет», а
 * видимых переменных в области бывает много.
 */
function editDistance(left: string, right: string, limit: number): number {
    if (Math.abs(left.length - right.length) > limit) {
        return limit + 1;
    }

    let previous = Array.from(
        { length: right.length + 1 },
        (_unused, index) => index
    );

    for (let row = 1; row <= left.length; row++) {
        const current = [row];
        let rowBest = row;

        for (let column = 1; column <= right.length; column++) {
            const substitution = previous[column - 1] +
                (left[row - 1] === right[column - 1] ? 0 : 1);
            const value = Math.min(
                substitution,
                previous[column] + 1,
                current[column - 1] + 1
            );
            current.push(value);
            rowBest = Math.min(rowBest, value);
        }

        if (rowBest > limit) {
            return limit + 1;
        }

        previous = current;
    }

    return previous[right.length];
}

/**
 * Вставка `Var имя;` в начало тела процедуры.
 *
 * Предлагается только когда место однозначно: есть объемлющая Macro или метод
 * класса, и её тело начинается с новой строки. Для присваивания на верхнем
 * уровне модуля такого места нет — там объявление меняет смысл файла.
 */
function declarationEdit(
    module: IIndexedModule,
    offset: number,
    name: string,
    keyword: string
): TextEdit | undefined {
    const scope = enclosingCallable(module, offset);

    if (!scope) {
        return undefined;
    }

    const source = module.source;
    const headerEnd = source.indexOf("\n", scope.range.start);

    if (headerEnd < 0 || headerEnd >= offset) {
        return undefined;
    }

    const lineStart = headerEnd + 1;
    const indent = source.slice(
        lineStart,
        source.length
    ).match(/^[ \t]*/u)?.[0] ?? "    ";
    const position = positionInModule(module, lineStart);

    /*
     * Перевод строки — как в файле.
     *
     * Жёсткий \n в файле с CRLF давал строку с чужим окончанием: её
     * видно в diff, и она мешает тем, кто этот файл потом читает.
     */
    const eol = module.lex.eol || "\n";

    return TextEdit.insert(
        position,
        indent + keyword + " " + name + ";" + eol
    );
}

function enclosingCallable(
    module: IIndexedModule,
    offset: number
): { range: { start: number; end: number } } | undefined {
    let found: { range: { start: number; end: number } } | undefined;
    let current = module.symbolTree;

    for (;;) {
        const nested = current.children.find(child =>
            child.isContainer &&
            child.range.start <= offset &&
            offset <= child.range.end
        );

        if (!nested) {
            return found;
        }

        found = nested;
        current = nested;
    }
}


function createAction(
    title: string,
    uri: string,
    edits: TextEdit[],
    diagnostic: Diagnostic,
    preferred: boolean
): CodeAction {
    return {
        title,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        isPreferred: preferred,
        edit: { changes: { [uri]: edits } }
    };
}

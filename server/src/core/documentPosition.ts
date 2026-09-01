import type { Position, Range } from "vscode-languageserver";

/**
 * Перевод между смещением в тексте и позицией LSP.
 *
 * Обе функции жили копиями примерно в десяти файлах — диагностики, навигация,
 * Code Actions, подсказки, — и копии разошлись по существу, а не по написанию.
 *
 * Смещение в позицию: одни искали строку бинарным поиском, другие проходили
 * список начал строк подряд. На файле в двадцать тысяч строк линейный проход
 * стоит своего на каждый ответ, а ответов на одну правку десятки.
 *
 * Позиция в смещение: одни прижимали символ к концу строки, другие — к концу
 * документа. Разница видна на негодной позиции, а негодные позиции приходят:
 * редактор шлёт колонку по своему представлению текста, и после правки, пришедшей
 * следом, она может оказаться за концом строки. По первому правилу такая позиция
 * остаётся на своей строке, по второму — уезжает на следующие, и ответ выдаётся
 * не про то место, куда показывает пользователь.
 *
 * Здесь правило одно, и оно из спецификации LSP: строка прижимается к границам
 * документа, символ — к длине СВОЕЙ строки, а перевод строки в неё не входит.
 * Последнее важно: смещение внутри "\r\n" не принадлежит ни одному токену, и
 * поиск по нему не находит ничего.
 */

/**
 * Смещение в позицию LSP по готовому списку начал строк.
 *
 * Бинарный поиск, а не проход по тексту: диагностики вызывают это на каждую
 * найденную проблему.
 */
export function positionAtOffset(
    lineStarts: readonly number[],
    offset: number
): Position {
    if (lineStarts.length === 0) {
        return { line: 0, character: Math.max(0, offset) };
    }

    let left = 0;
    let right = lineStarts.length - 1;
    let line = 0;

    while (left <= right) {
        const middle = (left + right) >>> 1;

        if (lineStarts[middle] <= offset) {
            line = middle;
            left = middle + 1;
        } else {
            right = middle - 1;
        }
    }

    return {
        line,
        character: Math.max(0, offset - lineStarts[line])
    };
}

/**
 * Позиция LSP в смещение.
 *
 * Негодная позиция не отвергается: LSP разрешает прислать любую, и правило её
 * приведения задано спецификацией — «если символ больше длины строки, он
 * считается равным длине строки». Длина строки берётся без перевода строки,
 * поэтому конец строки — это смещение первого символа "\r" или "\n", а не
 * начало следующей строки.
 */
export function offsetAtPosition(
    lineStarts: readonly number[],
    source: string,
    position: { line: number; character: number }
): number {
    if (lineStarts.length === 0) {
        return clamp(Math.max(0, position.character), 0, source.length);
    }

    const line = clamp(position.line, 0, lineStarts.length - 1);
    const lineStart = lineStarts[line];
    const lineEnd = lineTextEnd(lineStarts, source, line);

    return clamp(
        lineStart + Math.max(0, position.character),
        lineStart,
        lineEnd
    );
}

/** Диапазон LSP по двум смещениям; порядок концов не важен. */
export function rangeAtOffsets(
    lineStarts: readonly number[],
    start: number,
    end: number
): Range {
    const from = Math.min(start, end);
    const to = Math.max(start, end);

    return {
        start: positionAtOffset(lineStarts, from),
        end: positionAtOffset(lineStarts, to)
    };
}

/**
 * Модуль глазами перевода координат.
 *
 * Тип описан по составу, а не импортом IIndexedModule: core не знает про
 * индекс проекта и знать не должен.
 */
export interface IRslPositionSource {
    readonly source: string;
    readonly lex: { readonly lineStarts: readonly number[] };
}

/** Смещение по позиции в модуле; см. offsetAtPosition. */
export function offsetInModule(
    module: IRslPositionSource,
    position: { line: number; character: number }
): number {
    return offsetAtPosition(module.lex.lineStarts, module.source, position);
}

/** Позиция по смещению в модуле; см. positionAtOffset. */
export function positionInModule(
    module: IRslPositionSource,
    offset: number
): Position {
    return positionAtOffset(module.lex.lineStarts, offset);
}

/** Диапазон по двум смещениям в модуле. */
export function rangeInModule(
    module: IRslPositionSource,
    start: number,
    end: number
): Range {
    return rangeAtOffsets(module.lex.lineStarts, start, end);
}

/** Конец текста строки: до "\r\n" или "\n", а не до начала следующей. */
function lineTextEnd(
    lineStarts: readonly number[],
    source: string,
    line: number
): number {
    const next = line + 1 < lineStarts.length
        ? lineStarts[line + 1]
        : source.length;
    let end = Math.min(next, source.length);

    if (end > lineStarts[line] && source.charCodeAt(end - 1) === 10) {
        end--;
    }

    if (end > lineStarts[line] && source.charCodeAt(end - 1) === 13) {
        end--;
    }

    return end;
}

function clamp(value: number, low: number, high: number): number {
    return Math.max(low, Math.min(value, high));
}

import type { Position } from "vscode-languageserver";

/**
 * Смещение в позицию LSP по готовому списку начал строк.
 *
 * Бинарный поиск, а не проход по тексту: диагностики вызывают это на каждую
 * найденную проблему. Копии этой функции разошлись по модулям диагностик —
 * здесь она одна на всех, кто её импортирует.
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

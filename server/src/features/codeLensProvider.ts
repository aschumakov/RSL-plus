import { CompletionItemKind, type CodeLens } from "vscode-languageserver";

import { normalizeIdentifier } from "../lexer";
import type { RslSymbol } from "../symbols/rslSymbol";
import type { IIndexedModule } from "../workspaceIndex";
import { positionAtOffset } from "../core/documentPosition";

/**
 * Строка над объявлением: сколько раз имя встречается в этом файле.
 *
 * Счёт именно по файлу, и это решено замером, а не удобством. Точный
 * проектный счёт одного объявления на проекте из 2826 файлов занимает от 40 мс
 * до 3,4 с: поиск обязан обойти файлы-кандидаты и разрешить в них каждое
 * вхождение. Редактор же спрашивает CodeLens сразу для всех видимых
 * объявлений, а в крупном файле проекта их сотни. Дешёвая замена — «в скольких
 * файлах имя упоминается» — тоже не подходит: пока запись файла не сверена с
 * диском, вывод «не упоминается» делать нельзя, а сверка стоит одного чтения
 * на файл, то есть первого же обхода всего проекта.
 *
 * Поэтому цифра здесь честно про файл, а за проектным ответом строка ведёт в
 * References и Call Hierarchy — туда, где он и считается.
 *
 * Сама строка выключена по умолчанию: постоянный текст над каждым Macro мешает
 * читать код тем, кто его не просил.
 */

const LENS_KINDS = new Set<number>([
    CompletionItemKind.Function,
    CompletionItemKind.Method,
    CompletionItemKind.Class
]);

export const RSL_SHOW_REFERENCES_COMMAND = "rsl.showReferences";
export const RSL_SHOW_CALL_HIERARCHY_COMMAND = "rsl.showCallHierarchy";

/** Объявления, над которыми имеет смысл строка. */
function lensTargets(module: IIndexedModule): RslSymbol[] {
    const result: RslSymbol[] = [];

    const visit = (symbol: RslSymbol): void => {
        for (const child of symbol.children) {
            if (LENS_KINDS.has(child.kind)) {
                result.push(child);
            }

            visit(child);
        }
    };

    visit(module.symbolTree);

    return result;
}

/**
 * Вхождения каждого имени — одним проходом по файлу.
 *
 * Считать их отдельно для каждого объявления значит пройти файл столько раз,
 * сколько в нём объявлений. На printdog.mac — 443 КБ, 141 объявление — это
 * было 134 мс непрерывной занятости потока на одну строку состояния.
 * Обращение к члену объекта сюда не попадает: `doc.Handle` и процедура
 * `Handle` этого файла — разные имена.
 */
function occurrencesByName(
    module: IIndexedModule
): Map<string, number[]> {
    const tokens = module.syntax.tokens;
    const result = new Map<string, number[]>();

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind !== "identifier") {
            continue;
        }

        const previous = tokens[index - 1];

        if (
            previous &&
            previous.kind === "symbol" &&
            previous.raw === "." &&
            previous.end === token.start
        ) {
            continue;
        }

        const name = normalizeIdentifier(token.value);
        const found = result.get(name);

        if (found) {
            found.push(token.start);
        } else {
            result.set(name, [token.start]);
        }
    }

    return result;
}

/** Процедура, внутри которой лежит смещение; двоичный поиск по началам. */
function ownerAt(
    procedures: readonly RslSymbol[],
    offset: number
): RslSymbol | undefined {
    let left = 0;
    let right = procedures.length - 1;
    let found: RslSymbol | undefined;

    while (left <= right) {
        const middle = (left + right) >>> 1;

        if (procedures[middle].range.start <= offset) {
            found = procedures[middle];
            left = middle + 1;
        } else {
            right = middle - 1;
        }
    }

    return found && offset <= found.range.end ? found : undefined;
}

/** Сколько раз имя встречается в файле и в скольких процедурах. */
function countInFile(
    symbol: RslSymbol,
    occurrences: ReadonlyMap<string, number[]>,
    procedures: readonly RslSymbol[]
): { uses: number; callers: number } {
    const found = occurrences.get(normalizeIdentifier(symbol.name)) || [];
    const owners = new Set<RslSymbol>();
    let uses = 0;

    for (const offset of found) {
        if (
            offset >= symbol.selectionRange.start &&
            offset < symbol.selectionRange.end
        ) {
            /* Само объявление использованием не считается. */
            continue;
        }

        uses++;

        const owner = ownerAt(procedures, offset);

        if (owner && owner !== symbol) {
            owners.add(owner);
        }
    }

    return { uses, callers: owners.size };
}

export function buildRslCodeLenses(module: IIndexedModule): CodeLens[] {
    const targets = lensTargets(module);

    if (targets.length === 0) {
        return [];
    }

    /* Двоичный поиск владельца требует порядка по началу области. */
    const procedures = targets
        .filter(item => item.kind !== CompletionItemKind.Class)
        .sort((left, right) => left.range.start - right.range.start);
    const occurrences = occurrencesByName(module);
    const result: CodeLens[] = [];

    for (const symbol of targets) {
        const position = positionAtOffset(
            module.lex.lineStarts,
            symbol.selectionRange.start
        );
        const range = { start: position, end: position };
        const counts = countInFile(symbol, occurrences, procedures);
        const argument = [module.uri, position];

        result.push({
            range,
            command: {
                title: counts.uses === 0
                    ? "в этом файле не используется"
                    : "в файле: " + counts.uses +
                        (counts.callers > 0
                            ? ", процедур: " + counts.callers
                            : ""),
                command: RSL_SHOW_REFERENCES_COMMAND,
                arguments: argument
            }
        });
        result.push({
            range,
            command: {
                title: "кто вызывает",
                command: RSL_SHOW_CALL_HIERARCHY_COMMAND,
                arguments: argument
            }
        });
    }

    return result;
}

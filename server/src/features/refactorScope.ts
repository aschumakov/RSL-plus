import { CompletionItemKind } from "vscode-languageserver";

import {
    BLOCK_BOUNDARY_KEYWORDS,
    KEYWORDS,
    STATEMENT_KEYWORDS
} from "../language/rslLanguageReference";
import { normalizeIdentifier, type IRslToken } from "../lexer";
import type { RslSymbol } from "../symbols/rslSymbol";
import type { IIndexedModule } from "../workspaceIndex";

/**
 * Что рефакторингу нужно знать о тексте вокруг выделения.
 *
 * Здесь только то, что общо для нескольких действий: где кончается оператор,
 * какая процедура его окружает, какие имена в ней уже заняты. Правила
 * безопасности у каждого действия свои и живут рядом с ним.
 */

export const RSL_STATEMENT_WORDS = new Set<string>([
    ...STATEMENT_KEYWORDS,
    ...BLOCK_BOUNDARY_KEYWORDS
]);

export const RSL_RESERVED_WORDS = new Set<string>(KEYWORDS);

/** Слова, после которых идёт заголовок блока, а не обычный оператор. */
export const RSL_HEADER_WORDS = new Set<string>([
    "macro",
    "class",
    "if",
    "elif",
    "while",
    "for",
    "with",
    "onerror"
]);

const PROCEDURE_KINDS = new Set<number>([
    CompletionItemKind.Function,
    CompletionItemKind.Method
]);

/** Процедура, внутри которой лежит смещение; самая внутренняя. */
export function enclosingRslProcedure(
    module: IIndexedModule,
    offset: number
): RslSymbol | undefined {
    let found: RslSymbol | undefined;

    const visit = (symbol: RslSymbol): void => {
        for (const child of symbol.children) {
            if (child.range.start > offset || child.range.end < offset) {
                continue;
            }

            if (PROCEDURE_KINDS.has(child.kind)) {
                found = child;
            }

            visit(child);
        }
    };

    visit(module.symbolTree);

    return found;
}

/**
 * Имена, которые в этой процедуре уже что-то значат.
 *
 * Считаются вместе объявления процедуры, имена верхнего уровня файла и
 * ключевые слова: новое имя не должно совпасть ни с одним из них, иначе
 * рефакторинг молча поменяет смысл кода.
 */
export function rslNamesInScope(
    module: IIndexedModule,
    procedure: RslSymbol | undefined
): Set<string> {
    const taken = new Set<string>(RSL_RESERVED_WORDS);

    const add = (symbol: RslSymbol): void => {
        taken.add(normalizeIdentifier(symbol.name));
    };

    module.symbolTree.children.forEach(add);

    if (procedure) {
        const visit = (symbol: RslSymbol): void => {
            for (const child of symbol.children) {
                add(child);
                visit(child);
            }
        };

        add(procedure);
        visit(procedure);
    }

    return taken;
}

/** Значимые токены, целиком лежащие в границах. */
export function rslTokensIn(
    tokens: readonly IRslToken[],
    start: number,
    end: number
): IRslToken[] {
    return tokens.filter(token => token.start >= start && token.end <= end);
}

/**
 * Границы оператора, внутри которого лежит смещение.
 *
 * Началом считается первый токен после предыдущей `;`, заголовка блока или
 * границы процедуры; концом — своя `;`. Если оператор не кончается точкой с
 * запятой, границы не определены: гадать, где он кончился, рефакторингу
 * незачем.
 */
export function rslStatementAround(
    module: IIndexedModule,
    offset: number
): { start: number; end: number } | undefined {
    const tokens = module.syntax.tokens;
    let start = -1;
    let depth = 0;
    /*
     * Заголовок блока — не оператор, и точки с запятой у него нет.
     *
     * Без отдельной границы `Macro Run(a, b)` слипался бы с первой строкой
     * тела, и объявление, вынесенное «перед оператором», уезжало бы к
     * заголовку процедуры.
     */
    let header = false;

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        const previous = tokens[index - 1];

        /* Заголовок без скобок кончается переводом строки. */
        if (
            header &&
            depth === 0 &&
            previous &&
            start >= 0 &&
            token.line > previous.endLine
        ) {
            if (offset <= previous.end) {
                return undefined;
            }

            start = -1;
            header = false;
        }

        if (token.kind === "symbol") {
            if (token.raw === "(" || token.raw === "[") {
                depth++;
            } else if (token.raw === ")" || token.raw === "]") {
                depth = depth > 0 ? depth - 1 : 0;

                if (depth === 0 && header && token.raw === ")") {
                    if (offset <= token.end) {
                        /* Смещение внутри заголовка: оператора здесь нет. */
                        return undefined;
                    }

                    start = -1;
                    header = false;
                }

                continue;
            } else if (token.raw === ";" && depth === 0) {
                if (start >= 0 && token.start >= offset) {
                    return { start, end: token.start + 1 };
                }

                start = -1;
                header = false;

                continue;
            }
        }

        if (
            depth === 0 &&
            token.kind === "identifier" &&
            RSL_STATEMENT_WORDS.has(normalizeIdentifier(token.value))
        ) {
            if (start >= 0 && token.start > offset) {
                /* Оператор кончился ключевым словом, а не точкой с запятой. */
                return undefined;
            }

            start = token.start;
            header = RSL_HEADER_WORDS.has(normalizeIdentifier(token.value));

            continue;
        }

        if (start < 0) {
            start = token.start;
        }
    }

    return undefined;
}

/** Стоит ли перед смещением на его строке только пробел. */
export function startsRslLine(
    module: IIndexedModule,
    offset: number
): boolean {
    const lineStart = Math.max(
        0,
        module.source.lastIndexOf("\n", offset - 1) + 1
    );

    return !module.source.slice(lineStart, offset).trim();
}

/**
 * Ссылки на имя внутри процедуры.
 *
 * Обращение к члену объекта — `document.status` — сюда не попадает: это другое
 * имя, живущее в другом месте.
 */
export function rslReferencesTo(
    module: IIndexedModule,
    procedure: RslSymbol,
    name: string
): IRslToken[] {
    const wanted = normalizeIdentifier(name);
    const tokens = module.syntax.tokens;
    const result: IRslToken[] = [];

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (
            token.kind !== "identifier" ||
            token.start < procedure.range.start ||
            token.end > procedure.range.end ||
            normalizeIdentifier(token.value) !== wanted
        ) {
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

        result.push(token);
    }

    return result;
}

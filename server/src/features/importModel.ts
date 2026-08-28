import { normalizeIdentifier, type IRslToken } from "../lexer";
import type { IIndexedModule } from "../workspaceIndex";

/**
 * Разбор секции Import в вид, пригодный для перестройки.
 *
 * Модель нужна для того, чтобы правки Import можно было писать через границы
 * текста, а не через склейку строк. Всё, что относится к сохранению исходного
 * написания, живёт здесь: элемент хранит свой кусок текста как есть, и
 * перестановка не превращает `Import "checkaml.mac";` в `Import checkaml;`.
 *
 * По проекту макросов: 5867 объявлений, из них 2463 — с несколькими элементами
 * (до 27 в одном), 1810 элементов из 14014 записаны строкой в кавычках, 1761 —
 * с расширением .mac. Поэтому форма объявления сохраняется, а не сводится к
 * одному имени на строку.
 */

export interface IRslImportItem {
    start: number;
    end: number;
    /** Имя модуля так, как его понял разбор. */
    name: string;
    /** Кусок исходного текста: кавычки, расширение и регистр — как написано. */
    text: string;
    /** Ключ сравнения: без кавычек, расширения, разделителей и регистра. */
    key: string;
}

export interface IRslImportDeclaration {
    /** Начало слова Import. */
    start: number;
    /** Смещение точки с запятой; -1 — её нет. */
    semicolon: number;
    /** Текст от слова Import до первого элемента. */
    prefix: string;
    /** Отступ строки, на которой стоит объявление. */
    indent: string;
    items: IRslImportItem[];
    /**
     * Объявление занимает строку целиком.
     *
     * До него на строке только пробелы, после точки с запятой — только
     * пробелы до конца строки. Только такие объявления можно переставлять:
     * у остальных рядом стоит чужой текст или комментарий.
     */
    ownLine: boolean;
    /**
     * Объявление можно собрать заново из имён элементов.
     *
     * Нельзя двух видов. С комментарием внутри: собрать из имён значит стереть
     * комментарий. Многострочное: автор разложил список по строкам сам, и
     * склеить его обратно в одну строку — не наведение порядка, а
     * переформатирование. Таких на проекте 156 объявлений из 5867.
     */
    rebuildable: boolean;
    /** Начало строки, на которой начинается объявление. */
    lineStart: number;
    /** Конец строки с точкой с запятой; без перевода строки. */
    lineEnd: number;
}

/** Ключ сравнения имён модулей. */
export function importKey(value: string): string {
    return normalizeIdentifier(
        value
            .trim()
            .replace(/^["']|["']$/gu, "")
            .replace(/\\/gu, "/")
            .replace(/\.mac$/iu, "")
    );
}

export function collectRslImports(
    module: IIndexedModule
): IRslImportDeclaration[] {
    const source = module.source;
    const tokens = module.lex.tokens;
    const result: IRslImportDeclaration[] = [];

    for (const node of module.syntax.root.children) {
        if (node.kind !== "ImportDeclaration") {
            continue;
        }

        const items = node.children
            .filter(child => child.kind === "ImportItem" && !!child.name)
            .map(child => {
                const text = source.slice(child.start, child.end);

                return {
                    start: child.start,
                    end: child.end,
                    name: child.name as string,
                    text,
                    key: importKey(text)
                };
            });

        if (items.length === 0) {
            continue;
        }

        const semicolon = followingSemicolon(tokens, node.end);
        const lineStart = Math.max(
            0,
            source.lastIndexOf("\n", node.start - 1) + 1
        );
        /*
         * Конец берётся от точки с запятой, а не от начала объявления.
         *
         * Объявление бывает многострочным, и строка со словом import кончается
         * задолго до его конца. Принять её за конец объявления значит
         * переписать первую строку, оставив хвост списка ниже нетронутым, —
         * ровно это и портило nbcash_op_9042_20_Print.mac.
         */
        const tail = semicolon >= 0 ? semicolon : node.end;
        const lineBreak = source.indexOf("\n", tail);
        const lineEnd = trimEol(
            source,
            lineBreak < 0 ? source.length : lineBreak
        );
        const after = semicolon < 0
            ? ""
            : source.slice(semicolon + 1, lineEnd);

        result.push({
            start: node.start,
            semicolon,
            prefix: source.slice(node.start, items[0].start),
            indent: source.slice(lineStart, node.start),
            items,
            ownLine: semicolon >= 0 &&
                !source.slice(lineStart, node.start).trim() &&
                !after.trim(),
            /*
             * Комментарий ищется по всему объявлению, а не между элементами.
             *
             * В deskord.mac закомментированный хвост списка лежит за последним
             * элементом, но до точки с запятой; собрать такое объявление из
             * имён значит стереть комментарий.
             */
            rebuildable: !source.slice(lineStart, lineEnd).includes("\n") &&
                !tokens.some(token =>
                    token.kind === "comment" &&
                    token.start >= node.start &&
                    token.end <= tail
                ),
            lineStart,
            lineEnd
        });
    }

    return result;
}

/**
 * Непрерывные группы объявлений, которые можно переставлять между собой.
 *
 * Группа обрывается на всём, что автор поставил осмысленно: комментарии,
 * пустая строка, чужой текст на строке объявления. Переставить объявление
 * через комментарий значит оторвать комментарий от того, что он поясняет.
 */
export function rslImportRuns(
    module: IIndexedModule,
    declarations: readonly IRslImportDeclaration[]
): IRslImportDeclaration[][] {
    const runs: IRslImportDeclaration[][] = [];
    let current: IRslImportDeclaration[] = [];

    const flush = (): void => {
        if (current.length > 0) {
            runs.push(current);
            current = [];
        }
    };

    for (const declaration of declarations) {
        if (!declaration.ownLine || !declaration.rebuildable) {
            flush();

            continue;
        }

        const previous = current[current.length - 1];

        if (previous && !joinable(module, previous, declaration)) {
            flush();
        }

        current.push(declaration);
    }

    flush();

    return runs;
}

/** Между объявлениями только перевод строки — ни комментария, ни пустой строки. */
function joinable(
    module: IIndexedModule,
    previous: IRslImportDeclaration,
    next: IRslImportDeclaration
): boolean {
    const between = module.source.slice(previous.lineEnd, next.lineStart);

    if (between.trim()) {
        return false;
    }

    /* Один перевод строки — соседние строки; два — автор разделил группы. */
    return (between.match(/\n/gu) || []).length === 1;
}

function followingSemicolon(
    tokens: readonly IRslToken[],
    offset: number
): number {
    for (const token of tokens) {
        if (token.start < offset) {
            continue;
        }

        if (
            token.kind === "whitespace" ||
            token.kind === "newline" ||
            token.kind === "comment"
        ) {
            continue;
        }

        return token.kind === "symbol" && token.raw === ";" ? token.start : -1;
    }

    return -1;
}

function trimEol(source: string, end: number): number {
    return end > 0 && source.charAt(end - 1) === "\r" ? end - 1 : end;
}

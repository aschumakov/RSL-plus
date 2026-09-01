import {
    DocumentRangeFormattingParams,
    Range,
    TextEdit
} from "vscode-languageserver";
import type { TextDocument } from "vscode-languageserver-textdocument";

import { FormatCode, type IRslFormatOptions } from "../format";
import {
    normalizeIdentifier,
    type IRslLexResult,
    type IRslToken
} from "../lexer";
import { BLOCK_START_KEYWORDS } from "../language/rslLanguageReference";

/**
 * Форматирует только полные строки, пересекающие выделение.
 *
 * Форматирование идёт не от начала файла, а от начала того верхнеуровневого
 * блока, в котором стоит выделение, и заканчивается началом следующего. В такой
 * точке состояние форматтера известно и тривиально: нулевой отступ, пустой стек
 * скобок, нет продолжения выражения и нет начатой группы выравнивания. Поэтому
 * кусок текста между двумя такими точками форматируется отдельно, а результат
 * для выбранных строк тот же, что при форматировании всего документа.
 *
 * Ради чего: прежде выделение из шести строк форматировалось вместе со всем
 * документом — на модуле 705 КБ это 170 мс, и всё это время language server не
 * отвечал ни на что другое.
 *
 * Границы блоков приходят снаружи — от того же разбиения на единицы документа,
 * которым пользуется инкрементальная диагностика. Своего сканирования здесь нет
 * намеренно: слово `macro` в начале строки встречается и внутри многострочного
 * SQL-запроса, и такая «контрольная точка» снимала бы отступ у текста, который
 * обязан остаться байт-в-байт.
 */
export interface IRangeFormattingOptions {
    /**
     * Строки, с которых начинаются верхнеуровневые блоки документа.
     *
     * Отсутствуют, если модель этой версии ещё не готова: тогда форматируется
     * весь документ — медленно, зато тем же текстом.
     */
    blockStartLines?: readonly number[];
    /**
     * Токены текущей версии.
     *
     * По ним проверяется, что перед выделением не осталось открытых блоков:
     * только тогда форматтер подходит к контрольной точке с нулевым отступом и
     * кусок даёт тот же текст, что весь документ. Иначе — и когда токенов нет —
     * форматируется весь документ: медленно, зато тем же текстом.
     */
    /**
     * Разбор текущей версии целиком.
     *
     * Отсюда берутся и токены для проверки открытых блоков, и готовый lex для
     * запасного пути: там форматируется весь документ, и лексировать его
     * заново незачем.
     */
    lex?: IRslLexResult;
    /**
     * Настройки форматирования: отступ проекта, пробелы, выравнивание.
     *
     * Их считает вызывающий: диапазонное форматирование обязано давать
     * тот же текст, что и форматирование всего документа, а значит и
     * настройки у них одни.
     */
    format?: IRslFormatOptions & { tabSize?: number };
}

export function formatRslDocumentRange(
    document: TextDocument,
    params: DocumentRangeFormattingParams,
    options: IRangeFormattingOptions = {}
): TextEdit[] {
    const source = document.getText();
    const startLine = Math.max(0, params.range.start.line);
    const requestedEndLine = params.range.end.character === 0 &&
        params.range.end.line > startLine
        ? params.range.end.line - 1
        : params.range.end.line;
    const endLine = Math.max(startLine, requestedEndLine);
    const replacementRange: Range = {
        start: { line: startLine, character: 0 },
        end: endLine + 1 < document.lineCount
            ? { line: endLine + 1, character: 0 }
            : document.positionAt(source.length)
    };
    const oldText = document.getText(replacementRange);
    const newText = formatLines(
        document,
        source,
        startLine,
        endLine,
        params.options,
        options
    );

    return newText === oldText
        ? []
        : [TextEdit.replace(replacementRange, newText)];
}

/** Текст выбранных строк после форматирования. */
function formatLines(
    document: TextDocument,
    source: string,
    startLine: number,
    endLine: number,
    editor: { tabSize: number; insertSpaces: boolean },
    options: IRangeFormattingOptions
): string {
    const format = options.format || {};
    const tabSize = Math.max(1, format.tabSize || editor.tabSize || 4);
    const formatOptions: IRslFormatOptions = {
        insertSpaces: format.insertSpaces ?? editor.insertSpaces !== false,
        spaceAroundOperators: format.spaceAroundOperators,
        alignAssignments: format.alignAssignments
    };
    const window = findWindow(
        options.blockStartLines,
        startLine,
        endLine,
        document
    );

    if (!window || openBlocksBefore(options.lex?.tokens, window.from) !== 0) {
        /* Запасной путь: весь документ, но с готовым разбором. */
        const whole = FormatCode(source, tabSize, formatOptions, options.lex);
        const offsets = lineRangeOffsets(whole, startLine, endLine);

        return whole.substring(offsets.start, offsets.end);
    }

    const sliceStart = document.offsetAt({ line: window.from, character: 0 });
    const sliceEnd = window.to >= 0 && window.to < document.lineCount
        ? document.offsetAt({ line: window.to, character: 0 })
        : source.length;
    const formatted = FormatCode(
        source.slice(sliceStart, sliceEnd),
        tabSize,
        formatOptions
    );
    /*
     * Из отформатированного куска берутся ровно выбранные строки: их номера
     * внутри куска сдвинуты на начало окна.
     */
    const offsets = lineRangeOffsets(
        formatted,
        startLine - window.from,
        endLine - window.from
    );

    return formatted.substring(offsets.start, offsets.end);
}

/*
 * Слова, которые открывают блок и закрываются END.
 *
 * Тот же список, что у проверки парности END: расходиться им нельзя, иначе
 * «сбалансированным» считался бы файл, который таковым не является.
 */
const BLOCK_OPENERS = new Set(BLOCK_START_KEYWORDS);

/**
 * Сколько блоков открыто перед контрольной точкой.
 *
 * Ноль означает, что форматтер подходит к этой строке с нулевым отступом, и
 * только тогда кусок можно считать отдельно. Форматирование одного и того же
 * кода обязано не зависеть от того, выделили его или нет, поэтому файл с
 * незакрытым блоком выше считается целиком.
 *
 * undefined — посчитать нельзя: нет токенов, END больше, чем открытых
 * блоков, либо выше есть обработчик ошибок. Такой файл тоже считается
 * целиком.
 */
function openBlocksBefore(
    tokens: readonly IRslToken[] | undefined,
    line: number
): number | undefined {
    if (!tokens) {
        return undefined;
    }

    let depth = 0;
    let previous: IRslToken | undefined;

    for (const token of tokens) {
        if (token.line >= line) {
            return depth;
        }

        if (token.kind === "newline") {
            /*
             * Перевод строки заканчивает обращение через точку.
             *
             * Иначе незавершённое `obj.` в конце строки делало
             * следующий END «именем после точки», END не засчитывался,
             * и кусок форматировался с чужого уровня отступа. Ровно
             * эта ошибка уже была в быстрых подсказках.
             */
            previous = undefined;
            continue;
        }

        if (
            token.kind === "whitespace" ||
            token.kind === "comment" || token.kind === "bom"
        ) {
            continue;
        }

        const afterDot = previous?.kind === "symbol" && previous.raw === ".";
        previous = token;

        if (token.kind !== "identifier" || afterDot) {
            continue;
        }

        const word = normalizeIdentifier(token.value);

        if (BLOCK_OPENERS.has(word)) {
            depth++;
            continue;
        }

        if (word === "end") {
            depth--;

            /* Ушли в минус: END больше, чем открытых блоков. */
            if (depth < 0) {
                return undefined;
            }

            continue;
        }

        /*
         * Обработчик ошибок форматтер считает и ветвью, и открытым блоком —
         * в зависимости от того, на каком уровне он стоит. Повторять этот
         * учёт здесь значило бы держать вторую копию модели отступов, а она
         * уже расходилась: на cardcashoper.mac проверенного репозитория кусок
         * получал отступ на уровень меньше, чем документ целиком. Такой файл
         * считается целиком.
         */
        if (word === "onerror") {
            return undefined;
        }
    }

    return depth;
}

/**
 * Окно форматирования по границам блоков.
 *
 * undefined — границы неизвестны или выделение начинается выше первого блока:
 * тогда куском обойтись нельзя.
 */
function findWindow(
    blockStartLines: readonly number[] | undefined,
    startLine: number,
    endLine: number,
    document: TextDocument
): { from: number; to: number } | undefined {
    if (!blockStartLines || blockStartLines.length === 0) {
        return undefined;
    }

    let from = -1;
    let nextBlock = -1;

    for (const line of blockStartLines) {
        if (line <= startLine) {
            from = Math.max(from, line);
            continue;
        }

        if (line > endLine && (nextBlock < 0 || line < nextBlock)) {
            nextBlock = line;
        }
    }

    if (from < 0) {
        return undefined;
    }

    /*
     * Хвост окна — до конца группы выравнивания, а не до конца блока.
     *
     * Ниже выделения форматтеру важно только одно: доиграть группу подряд
     * идущих присваиваний, по которой считается ширина выравнивания. Она
     * кончается пустой строкой или строкой без присваивания. Тянуть окно до
     * конца блока значило бы форматировать десять тысяч строк ради шести — а
     * такие процедуры в проверенном репозитории есть.
     */
    const alignmentEnd = findAlignmentEnd(document, endLine, nextBlock);

    return {
        from,
        to: nextBlock < 0 ? alignmentEnd : Math.min(nextBlock, alignmentEnd)
    };
}

/*
 * Докуда тянуть хвост, если группа присваиваний не кончается.
 *
 * Ограничение страхует от вырожденного случая — сотен подряд идущих
 * присваиваний: там окно всё равно закроется началом следующего блока.
 */
const MAX_ALIGNMENT_TAIL = 200;

/** Первая строка после выделения, на которой группа выравнивания кончается. */
function findAlignmentEnd(
    document: TextDocument,
    endLine: number,
    nextBlock: number
): number {
    const limit = Math.min(
        document.lineCount,
        endLine + 1 + MAX_ALIGNMENT_TAIL
    );

    for (let line = endLine + 1; line < limit; line++) {
        const text = document.getText({
            start: { line, character: 0 },
            end: { line: line + 1, character: 0 }
        });

        /* Пустая строка и строка без присваивания группу закрывают. */
        if (text.trim() === "" || !/=/.test(text)) {
            return line + 1;
        }
    }

    return nextBlock < 0 ? -1 : nextBlock;
}

function lineRangeOffsets(
    text: string,
    startLine: number,
    endLine: number
): { start: number; end: number } {
    const starts = [0];
    const expression = /\r\n|\n|\r/g;
    let match: RegExpExecArray | null;

    while ((match = expression.exec(text)) !== null) {
        starts.push(match.index + match[0].length);
    }

    const safeStart = Math.max(0, Math.min(startLine, starts.length - 1));
    const start = starts[safeStart];
    const end = endLine + 1 < starts.length
        ? starts[endLine + 1]
        : text.length;

    return { start, end };
}

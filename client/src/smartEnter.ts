import { RSL_BLOCK_END } from "./rslBlockText";

const RSL_NAME = String.raw`(?:\{[^}\r\n]+\}|[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*)`;
/* Пустые скобки допустимы во время набора: диагностика отдельно подскажет,
 * что условие/заголовок нужно заполнить, а редактор уже создаст тело блока. */
const CONDITION_BLOCK = /^(?:if|while|for|with)\s*\(.*\)$/iu;
const MACRO_BLOCK = new RegExp(
    String.raw`^(?:(?:private|local)\s+)?macro\s+${RSL_NAME}` +
    String.raw`(?:\s*\([^()\r\n]*\))?` +
    String.raw`(?:\s*:\s*@?${RSL_NAME})?$`,
    "iu"
);
const CLASS_BLOCK = new RegExp(
    String.raw`^(?:(?:private|local)\s+)?class\s+` +
    String.raw`(?:\([^()\r\n]*\)\s+)?${RSL_NAME}` +
    String.raw`(?:\s*\([^()\r\n]*\))?$`,
    "iu"
);

export interface IRslSmartEnterContext {
    beforeCursor: string;
    afterCursor: string;
    indentUnit: string;
    eol: string;
    nextNonEmptyLine?: string;
}

/** Возвращает snippet только для полностью введённого заголовка RSL-блока. */
export function buildRslSmartEnterSnippet(
    context: IRslSmartEnterContext
): string | undefined {
    if (context.afterCursor.trim().length > 0) {
        return undefined;
    }

    const header = context.beforeCursor.trim();
    if (!isRslBlockHeader(header)) {
        return undefined;
    }

    /*
     * VS Code автоматически добавляет отступ строки, в которой вставляется
     * многострочный snippet. Поэтому здесь нужны только относительные
     * отступы: повторное добавление отступа исходной строки сдвигало тело и
     * закрытие вправо.
     */
    const body = `${context.eol}${context.indentUnit}$0`;

    return isEndLine(context.nextNonEmptyLine)
        ? body
        : `${body}${context.eol}${RSL_BLOCK_END}`;
}

/**
 * Отступ, который получает новая строка при обычном переводе строки.
 *
 * Нужен только опциональному перехвату Enter: там команда уже забрала нажатие
 * и обязана сделать то, что сделал бы редактор. Отступ берётся у строки, а не
 * у текста до курсора, — Enter из середины отступа не должен его удваивать.
 */
export function plainEnterIndent(
    lineText: string,
    character: number
): string {
    const indent = /^[ \t]*/.exec(lineText)?.[0] || "";
    return indent.slice(0, character);
}

export function isRslBlockHeader(value: string): boolean {
    const text = value.trim();
    return CONDITION_BLOCK.test(text) ||
        MACRO_BLOCK.test(text) ||
        CLASS_BLOCK.test(text);
}

function isEndLine(value?: string): boolean {
    return !!value && /^end\b\s*;?\s*(?:\/\/.*)?$/iu.test(value.trim());
}

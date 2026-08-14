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
     * End; вправо.
     */
    const body = `${context.eol}${context.indentUnit}$0`;

    return isEndLine(context.nextNonEmptyLine)
        ? body
        : `${body}${context.eol}End;`;
}

/**
 * Snippet обычного перевода строки — без единого пробела отступа.
 *
 * Отступ добавляет сам редактор: вставка многострочного snippet повторяет
 * отступ строки, в которой она происходит (см. buildRslSmartEnterSnippet).
 * Свой отступ здесь удваивал бы его — ровно это и произошло, когда команда
 * перестала звать `default:type` и начала вставлять перевод строки сама.
 */
export function buildRslPlainEnterSnippet(eol: string): string {
    return `${eol}$0`;
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

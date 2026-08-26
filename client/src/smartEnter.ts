import { rslBlockEnd } from "./rslBlockText";

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
    /** Регистр вставляемых слов: rslPlus.format.keywordCase. */
    keywordCase?: string;
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
        : `${body}${context.eol}${rslBlockEnd(context.keywordCase)}`;
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

/** Что именно сделал перехваченный Enter. */
export type RslEnterKind = "snippet" | "plain";

export interface IRslEnterSample {
    kind: RslEnterKind;
    /** Всё нажатие: от вызова команды до возврата. */
    totalMs: number;
    /** Только правка документа: insertSnippet или editor.edit. */
    editMs: number;
}

export interface IRslEnterTimings {
    record(sample: IRslEnterSample): void;
    /** Сводка для журнала; undefined — замеров ещё не было. */
    summary(): string | undefined;
    /** Всего нажатий с начала работы: по нему решают, когда писать. */
    total(): number;
    /** Сколько замеров хранится сейчас: окно последних нажатий. */
    count(): number;
}

/**
 * Замеры перехваченного Enter.
 *
 * Нужны, чтобы отвечать на жалобу «курсор отстаёт» числами, а не
 * догадками: видно и полное время нажатия, и отдельно правку документа.
 * Обычный Enter при выключенной настройке до расширения не доходит
 * вовсе, и здесь его нет — что само по себе ответ на часть вопроса.
 */
export function createRslEnterTimings(
    limit: number = 200
): IRslEnterTimings {
    const samples: IRslEnterSample[] = [];
    let total = 0;

    const percentile = (values: number[], share: number): number => {
        const sorted = [...values].sort((left, right) => left - right);
        const at = Math.min(
            sorted.length - 1,
            Math.floor(sorted.length * share)
        );

        return sorted[at];
    };

    return {
        record(sample: IRslEnterSample): void {
            total++;
            samples.push(sample);

            if (samples.length > limit) {
                samples.shift();
            }
        },
        total(): number {
            return total;
        },
        count(): number {
            return samples.length;
        },
        summary(): string | undefined {
            if (samples.length === 0) {
                return undefined;
            }

            /* Имя отличается от счётчика нажатий: это времена. */
            const durations = samples.map(item => item.totalMs);
            const edit = samples.map(item => item.editMs);
            const snippets = samples.filter(item => item.kind === "snippet");

            return "Enter: нажатий " + total +
                " (в замере " + samples.length + ")" +
                ", завершено блоков " + snippets.length +
                "; всё нажатие p50 " + percentile(durations, 0.5).toFixed(1) +
                " мс, p95 " + percentile(durations, 0.95).toFixed(1) +
                " мс, максимум " + Math.max(...durations).toFixed(1) +
                " мс; правка документа p95 " +
                percentile(edit, 0.95).toFixed(1) + " мс";
        }
    };
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

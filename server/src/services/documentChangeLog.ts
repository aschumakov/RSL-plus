import type { Connection, TextDocuments } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";

/**
 * Где именно правили документ.
 *
 * Редактор присылает точные диапазоны правок, а служба разбора их выбрасывала и
 * искала изменение заново — сравнением общего префикса и суффикса двух версий
 * текста. На файле 700 КБ это два прохода по мегабайту символов на каждое
 * нажатие клавиши, и делаются они ради сведений, которые уже пришли.
 *
 * Журнал сохраняет присланные диапазоны и отдаёт совокупный изменённый участок
 * между двумя версиями документа. Ответа нет — значит уверенности нет, и
 * вызывающий код идёт полным путём: журнал умеет молчать, но не умеет врать.
 */

/** Совокупный изменённый участок между двумя версиями текста. */
export interface IRslChangedSpan {
    /** Начало изменения в тексте ДО правок. */
    oldStart: number;
    /** Конец изменения в тексте ДО правок. */
    oldEnd: number;
    /** Конец того же участка в тексте ПОСЛЕ правок. */
    newEnd: number;
}

/** Одна правка в координатах текста, каким он был перед нею. */
interface IRslRecordedEdit {
    start: number;
    end: number;
    /** Длина вставленного текста. */
    length: number;
}

/** Шаг журнала: переход документа из одной версии в следующую. */
interface IRslChangeStep {
    fromVersion: number;
    toVersion: number;
    span: IRslChangedSpan;
    /** Длина текста до шага: по ней журнал сверяется с настоящим текстом. */
    oldLength: number;
    newLength: number;
}

/*
 * Сколько шагов помнить на документ.
 *
 * Между двумя разборами укладывается пачка правок: набор текста склеивается
 * задержкой, и к моменту разбора их бывает несколько десятков. Шестьдесят
 * четыре шага покрывают такую пачку с запасом, а больше держать незачем — если
 * разбор отстал сильнее, дешевле пойти полным путём, чем сводить сотню правок.
 */
const MAX_STEPS_PER_DOCUMENT = 64;

/**
 * Сводит несколько последовательных правок в один участок.
 *
 * Каждая следующая правка приходит в координатах текста, уже изменённого
 * предыдущими. Приведение к исходным координатам держится на одном
 * наблюдении: всё, что лежит левее уже задетого участка, не сдвигалось, а всё,
 * что правее, сдвинуто ровно на накопленную разницу длин. Поэтому начало
 * берётся как есть, а конец — со снятым сдвигом; перекрытия при этом
 * поглощаются сами, потому что участок только растёт.
 */
function mergeEdits(
    edits: readonly IRslRecordedEdit[]
): IRslChangedSpan | undefined {
    if (edits.length === 0) {
        return undefined;
    }

    let oldStart = Number.MAX_SAFE_INTEGER;
    let oldEnd = -1;
    let shift = 0;

    for (const edit of edits) {
        if (edit.end < edit.start) {
            return undefined;
        }

        oldStart = Math.min(oldStart, edit.start);
        oldEnd = Math.max(oldEnd, edit.end - shift);
        shift += edit.length - (edit.end - edit.start);
    }

    const newEnd = oldEnd + shift;

    if (oldStart > oldEnd || newEnd < oldStart) {
        return undefined;
    }

    return { oldStart, oldEnd, newEnd };
}

/** Изменение документа, каким его присылает редактор. */
type RslContentChange = {
    range?: {
        start: { line: number; character: number };
        end: { line: number; character: number };
    };
    text: string;
};

export class RslDocumentChangeLog {
    private steps = new Map<string, IRslChangeStep[]>();

    /**
     * Запомнить правки одного события.
     *
     * previousText — текст ДО события: журнал слушает раньше, чем TextDocuments
     * применяет изменения, иначе исходных координат уже не восстановить.
     *
     * Полнотекстовое изменение (без диапазона) обрывает цепочку: о нём
     * известно только то, что текст стал другим.
     */
    record(
        uri: string,
        previous: TextDocument,
        toVersion: number,
        changes: readonly RslContentChange[]
    ): void {
        const previousText = previous.getText();
        const fromVersion = previous.version;
        const span = this.spanOfEvent(previous, changes);

        if (!span) {
            /* Достоверного участка нет: цепочка версий обрывается. */
            this.steps.delete(uri);

            return;
        }

        const list = this.steps.get(uri) || [];

        list.push({
            fromVersion,
            toVersion,
            span: span.span,
            oldLength: previousText.length,
            newLength: span.newLength
        });

        while (list.length > MAX_STEPS_PER_DOCUMENT) {
            list.shift();
        }

        this.steps.set(uri, list);
    }

    /**
     * Участок одного события.
     *
     * Одно изменение — обычный случай набора текста: смещения считаются по
     * тексту события, без единой лишней копии. Несколько изменений приходят
     * от множественного курсора и от форматирования: каждое следующее задано в
     * координатах текста, уже изменённого предыдущим, поэтому промежуточный
     * текст приходится собрать. Событие такое редкое, что лишний проход по
     * тексту в нём дешевле любой хитрости с пересчётом координат.
     */
    private spanOfEvent(
        previous: TextDocument,
        changes: readonly RslContentChange[]
    ): { span: IRslChangedSpan; newLength: number } | undefined {
        if (changes.length === 0) {
            return undefined;
        }

        const edits: IRslRecordedEdit[] = [];
        let document = previous;
        let length = previous.getText().length;
        const single = changes.length === 1;

        for (const change of changes) {
            if (!change.range) {
                /* Полнотекстовая замена: о месте правки ничего не известно. */
                return undefined;
            }

            /*
             * Смещения спрашиваются у самого документа.
             *
             * Своя арифметика позиций тут была бы почти правильной: TextDocument
             * не только прижимает позицию к границам строки, но и не пускает её
             * за перевод строки. Позиция «столбец 18» в строке из 17 символов
             * означает конец этой строки, а не начало следующей — и правка,
             * записанная на символ правее, дала бы неверный участок, который
             * никакая сверка длин не поймает: у вставки длина одна и та же,
             * куда её ни помести.
             */
            const start = document.offsetAt(change.range.start);
            const end = document.offsetAt(change.range.end);

            if (end < start) {
                return undefined;
            }

            edits.push({ start, end, length: change.text.length });
            length += change.text.length - (end - start);

            if (single) {
                /* Второго изменения нет: промежуточный текст не нужен. */
                break;
            }

            /*
             * Следующее изменение задано в координатах уже изменённого текста.
             * Событий с несколькими изменениями мало — множественный курсор и
             * форматирование, — и промежуточный документ в них дешевле любой
             * самодельной арифметики смещений.
             */
            const text = document.getText();

            document = TextDocument.create(
                previous.uri,
                previous.languageId,
                previous.version,
                text.slice(0, start) + change.text + text.slice(end)
            );
        }

        const span = mergeEdits(edits);

        return span ? { span, newLength: length } : undefined;
    }

    /**
     * Совокупный участок между двумя версиями документа.
     *
     * Длины сверяются с настоящими текстами: несовпадение означает, что журнал
     * и документ разошлись, и тогда правильный ответ — молчание. Отсутствующий
     * или неполный участок цепочки означает то же самое.
     */
    changedSpan(
        uri: string,
        fromVersion: number,
        toVersion: number,
        previousLength: number,
        nextLength: number
    ): IRslChangedSpan | undefined {
        if (fromVersion === toVersion) {
            return undefined;
        }

        const list = this.steps.get(uri);

        if (!list || list.length === 0) {
            return undefined;
        }

        const first = list.findIndex(step => step.fromVersion === fromVersion);

        if (first < 0) {
            return undefined;
        }

        const chain: IRslChangeStep[] = [];

        for (let at = first; at < list.length; at++) {
            const step = list[at];

            if (at > first && step.fromVersion !== list[at - 1].toVersion) {
                /* В цепочке дыра: между шагами документ менялся мимо журнала. */
                return undefined;
            }

            chain.push(step);

            if (step.toVersion === toVersion) {
                break;
            }
        }

        const last = chain[chain.length - 1];

        if (!last || last.toVersion !== toVersion) {
            return undefined;
        }

        if (
            chain[0].oldLength !== previousLength ||
            last.newLength !== nextLength
        ) {
            /* Журнал разошёлся с документом: доверять ему нельзя. */
            return undefined;
        }

        return mergeEdits(chain.map(step => ({
            start: step.span.oldStart,
            end: step.span.oldEnd,
            length: step.span.newEnd - step.span.oldStart
        })));
    }

    /** Документ закрыт: его история больше никому не нужна. */
    forget(uri: string): void {
        this.steps.delete(uri);
    }

    clear(): void {
        this.steps.clear();
    }

    /** Сколько шагов помнится: для тестов и отчёта о памяти. */
    get size(): number {
        let total = 0;

        for (const list of this.steps.values()) {
            total += list.length;
        }

        return total;
    }
}

/**
 * Подключает журнал к соединению, не трогая TextDocuments.
 *
 * TextDocuments сам подписывается на onDidChangeTextDocument и сразу применяет
 * изменения к документу. Журналу нужен текст ДО них, поэтому соединение
 * подменяется обёрткой: она перехватывает подписку, записывает изменения и
 * только потом отдаёт событие библиотеке. Так порядок гарантирован, а
 * библиотека остаётся нетронутой.
 */
export function connectionWithChangeLog(
    connection: Connection,
    documents: TextDocuments<TextDocument>,
    log: RslDocumentChangeLog
): Connection {
    return new Proxy(connection, {
        get(target, property, receiver) {
            if (property !== "onDidChangeTextDocument") {
                const value = Reflect.get(target, property, receiver);

                return typeof value === "function" ? value.bind(target) : value;
            }

            return (handler: (event: {
                textDocument: { uri: string; version: number };
                contentChanges: readonly RslContentChange[];
            }) => void) => connection.onDidChangeTextDocument(event => {
                const known = documents.get(event.textDocument.uri);

                if (known) {
                    log.record(
                        event.textDocument.uri,
                        known,
                        event.textDocument.version,
                        event.contentChanges as readonly RslContentChange[]
                    );
                } else {
                    log.forget(event.textDocument.uri);
                }

                handler(event);
            });
        }
    });
}

import {
    lexRsl,
    type IRslLexResult,
    type IRslToken,
    type RslTokenKind
} from "../lexer";
import type { IRslChangedSpan } from "./documentChangeLog";

/** Ниже этого размера полный lexRsl уже быстрее правки и её проверок. */
export const INCREMENTAL_LEX_MIN_CHARS = 50_000;

/*
 * comment/square/newline/bom могут менять состояние lexer за пределами
 * одного токена (многострочные конструкции), поэтому правка внутри них
 * всегда уходит на полный relex.
 */
const SAFE_KINDS = new Set<RslTokenKind>([
    "identifier", "number", "string", "symbol", "whitespace"
]);

/*
 * Место правки больше не отсекается.
 *
 * Цена точечного пути — не размер правки, а перекладывание хвоста потока:
 * токенам после правки нужны новые смещения и номера строк. Прежде это
 * считалось дорогим, и правки в первой части файла отвергались порогом 0.85 —
 * то есть уходили на полный lexRsl.
 *
 * Замер на настоящих файлах проекта показал обратное. На fxclose.mac (705 КБ,
 * 174 526 токенов) перекладывание всего потока целиком стоит 3.9 мс, а полный
 * lexRsl — 26-33 мс. С порогом правка в первых процентах файла отвергалась и
 * стоила 33 мс; без порога она стоит 9.2 мс, то есть втрое дешевле. Дальше по
 * файлу выигрыш только растёт: 5.0 мс на середине, 1.0 мс в конце.
 *
 * Прежняя таблица замеров, по которой ставился порог, снималась до того, как
 * изменённый участок стал приходить из журнала правок: тогда каждая попытка
 * точечного пути начиналась с двух проходов по всему тексту в поисках общего
 * префикса и суффикса, и на файле в мегабайт это съедало весь выигрыш. Теперь
 * участок известен заранее, и отсекать по месту правки больше нечего.
 *
 * Остальные отказы никуда не делись: слишком широкое окно, многострочная
 * конструкция в нём и неразделимая правка по-прежнему уводят на полный путь.
 */
/* Оставлено для отчёта: доля сдвинутого потока попадает в решение. */

/*
 * Какую долю файла разрешено перелексировать одним окном.
 *
 * Окно теперь может занимать несколько строк, и вставка большого куска текста
 * сделала бы его сопоставимым с файлом. Тогда точечный путь платит и за relex
 * окна, и за пересчёт позиций хвоста, то есть заведомо проигрывает полному
 * лексированию.
 */
const MAX_WINDOW_FRACTION = 0.25;

/**
 * Почему правка пошла точечным путём или полным.
 *
 * По одной длительности lex этого не видно, а причины разные и лечатся
 * по-разному: `multilineConstruct` — строка, комментарий или SQL-блок через
 * границу окна, `windowTooLarge` — большая вставка.
 */
export interface IRslRelexDecision {
    reason: "incremental" | "firstLex" | "smallFile" | "unchanged" |
        "multilineConstruct" | "windowTooLarge" |
        "unsplittableEdit";
    /** Смещение правки: видно, в какой части файла её сделали. */
    editStart?: number;
    editLine?: number;
    windowChars?: number;
    shiftedFraction?: number;
    lineDelta?: number;
}

/** Токены изменённых строк: что заменяем и на каком участке текста. */
interface ILineWindow {
    /** Номер первой строки окна. */
    line: number;
    /** Номер последней строки окна: правка может задеть несколько. */
    endLine: number;
    /** Начало первой строки и конец окна (включая перевод строки, если он есть). */
    start: number;
    end: number;
    /** Конец текста строки без перевода строки: правка обязана лежать здесь. */
    textEnd: number;
    /**
     * Ожидается ли перевод строки последним токеном пересчёта.
     *
     * Строковый литерал RSL может продолжиться на следующей строке, поэтому
     * «строка кончилась» — это не «дошли до конца слайса», а «в этом месте
     * действительно возник newline». У последней строки файла его нет.
     */
    expectTrailingNewline: boolean;
    /** Диапазон заменяемых токенов, включительно; firstIndex > lastIndex — окно пусто. */
    firstIndex: number;
    lastIndex: number;
}

/**
 * Пытается пересчитать lex только для изменённой строки вместо полного
 * повторного прохода по документу.
 *
 * Единицей пересчёта служит строка, а не отдельный токен. Правка внутри одного
 * токена — редкий случай: пользователь набирает пробел, точку с запятой,
 * скобку, то есть меняет само разбиение строки на токены, а не содержимое
 * одного из них. На замере набора текста в файле 567КБ из 300 правок 187
 * меняли число токенов — прежний путь («один токен на входе, один на выходе»)
 * отвергал их все и уходил на полный lexRsl. Пересчёт строки принимает их и
 * стоит 16 мс против 38 мс полного лексирования.
 *
 * При этом путь остаётся проверяемым: строка лексируется в отрыве от
 * документа, поэтому достаточно убедиться, что в ней не открыто и не
 * открывается ни одной многострочной конструкции.
 *
 * Именно это и проверяется. Исходные токены строки обязаны быть безопасного
 * вида: comment, square и bom означали бы, что состояние lexer приходит
 * извне строки. Полученные токены проверяются так же — набранное «/*» или «[»
 * даёт comment или square, и такая правка уходит на полный lexRsl. Сама правка
 * не должна пересекать строки, иначе менялось бы их количество.
 *
 * Любое сомнение возвращает undefined: вызывающий код делает обычный полный
 * lexRsl, поэтому некорректный результат здесь невозможен — можно только не
 * ускориться.
 */
export function tryIncrementalRelex(
    previousText: string,
    previousLex: IRslLexResult,
    nextText: string,
    onDecision?: (decision: IRslRelexDecision) => void,
    /*
     * Готовый изменённый участок из журнала правок, если он есть.
     *
     * Редактор присылает точные диапазоны, и искать их заново сравнением
     * префикса и суффикса — два прохода по всему тексту на каждое нажатие
     * клавиши. Участок необязателен: без него работает прежний поиск.
     */
    knownSpan?: IRslChangedSpan
): IRslLexResult | undefined {
    /*
     * Причина решения уходит в лог: по одной длительности lex не видно, почему
     * правка пошла полным путём — файл мал, правка в начале, окно велико или в
     * него попала многострочная конструкция.
     */
    const decide = (
        reason: IRslRelexDecision["reason"],
        fields?: Partial<IRslRelexDecision>
    ): void => onDecision?.({ reason, ...fields });

    if (previousText.length < INCREMENTAL_LEX_MIN_CHARS) {
        decide("smallFile");
        return undefined;
    }

    if (previousText === nextText) {
        decide("unchanged");
        return previousLex;
    }

    const found = trustedSpan(previousText, nextText, knownSpan) ||
        scanChangedSpan(previousText, nextText);
    const oldStart = found.oldStart;
    const oldEnd = found.oldEnd;
    const newEnd = found.newEnd;

    if (oldEnd < oldStart || newEnd < oldStart) {
        decide("unsplittableEdit", { editStart: oldStart });
        return undefined;
    }

    const window = findLineWindow(previousLex, previousText, oldStart, oldEnd);

    if (!window) {
        decide("multilineConstruct", { editStart: oldStart });
        return undefined;
    }

    if (window.end - window.start > previousText.length * MAX_WINDOW_FRACTION) {
        decide("windowTooLarge", {
            editStart: oldStart,
            editLine: window.line,
            windowChars: window.end - window.start
        });
        return undefined;
    }

    const shifted = previousLex.tokens.length - window.lastIndex - 1;

    const delta = nextText.length - previousText.length;
    const sliceEnd = window.end + delta;

    if (sliceEnd < window.start) {
        decide("unsplittableEdit", {
            editStart: oldStart,
            editLine: window.line
        });
        return undefined;
    }

    const slice = nextText.slice(window.start, sliceEnd);
    const produced = lexRsl(slice).tokens;

    if (!coversExactly(produced, slice.length, window.expectTrailingNewline)) {
        decide("multilineConstruct", {
            editStart: oldStart,
            editLine: window.line
        });
        return undefined;
    }

    const replacement: IRslToken[] = produced.map(token => shiftToken(
        token,
        window.start,
        window.line
    ));

    /*
     * Сколько строк стало больше или меньше.
     *
     * Ради этого числа правки с переводом строки прежде отвергались целиком:
     * у всего остатка потока меняются не только смещения, но и номера строк.
     * Считать его несложно — переводы строки есть и в старом окне, и в новом,
     * достаточно сравнить их количество.
     */
    const producedNewlines = replacement.filter(
        token => token.kind === "newline"
    );
    const replacedNewlines = window.endLine - window.line +
        (window.expectTrailingNewline ? 1 : 0);
    const lineDelta = producedNewlines.length - replacedNewlines;

    /*
     * Массив собирается один раз нужной длины, без push и без промежуточных
     * concat: перекладывание хвоста — самая массовая операция этого пути, и
     * именно она определяла, применим он вообще или нет.
     */
    const tailStart = window.lastIndex + 1;
    const tailLength = previousLex.tokens.length - tailStart;
    const tokens: IRslToken[] = new Array(
        window.firstIndex + replacement.length + tailLength
    );

    for (let index = 0; index < window.firstIndex; index++) {
        tokens[index] = previousLex.tokens[index];
    }

    for (let index = 0; index < replacement.length; index++) {
        tokens[window.firstIndex + index] = replacement[index];
    }

    /*
     * Колонки хвоста не меняются: окно кончается либо переводом строки, либо
     * концом файла, поэтому следующий токен всегда начинает строку.
     */
    const tailOffset = window.firstIndex + replacement.length;

    for (let index = 0; index < tailLength; index++) {
        tokens[tailOffset + index] = shiftToken(
            previousLex.tokens[tailStart + index],
            delta,
            lineDelta
        );
    }

    /*
     * lineStarts собирается из трёх частей: строки до окна остаются как есть,
     * строки окна берутся из пересчёта, строки после — сдвигаются.
     */
    const lineStarts = previousLex.lineStarts.slice(0, window.line + 1);

    for (const token of producedNewlines) {
        lineStarts.push(token.end);
    }

    const firstUntouchedLine = window.endLine + 1 +
        (window.expectTrailingNewline ? 1 : 0);

    for (
        let index = firstUntouchedLine;
        index < previousLex.lineStarts.length;
        index++
    ) {
        lineStarts.push(previousLex.lineStarts[index] + delta);
    }

    decide("incremental", {
        editStart: oldStart,
        editLine: window.line,
        windowChars: window.end - window.start,
        shiftedFraction: shifted / previousLex.tokens.length,
        lineDelta
    });

    return {
        tokens,
        eol: previousLex.eol,
        hasFinalEol: /(?:\r\n|\n|\r)$/.test(nextText),
        hasBom: previousLex.hasBom,
        lineStarts
    };
}

/**
 * Окно пересчёта — строка, внутри которой лежит правка.
 *
 * Возвращает undefined, если правка выходит за строку или хотя бы один её
 * токен получен из многострочной конструкции: лексирование такой строки в
 * отрыве от документа дало бы другой результат.
 */
function findLineWindow(
    previousLex: IRslLexResult,
    previousText: string,
    changeStart: number,
    changeEnd: number
): ILineWindow | undefined {
    const line = findLineIndex(previousLex.lineStarts, changeStart);
    const changeEndLine = findLineIndex(previousLex.lineStarts, changeEnd);

    if (line === undefined || changeEndLine === undefined) {
        return undefined;
    }

    const start = previousLex.lineStarts[line];
    const tokens = previousLex.tokens;

    /* Первый токен строки: двоичный поиск по возрастающему start. */
    const firstIndex = lowerBound(tokens, start);
    let lastIndex = firstIndex - 1;
    let textEnd = previousText.length;
    let end = previousText.length;
    let endLine = changeEndLine;
    let expectTrailingNewline = false;

    /*
     * Токен, начавшийся раньше и накрывающий начало строки, — это открытый
     * многострочный комментарий, квадратный блок или строковый литерал. По
     * одному виду токенов самой строки его не увидеть: его start меньше начала
     * строки, и поиск по start его не находит. Такую строку в отрыве от
     * документа лексировать нельзя.
     */
    if (firstIndex > 0 && tokens[firstIndex - 1].end > start) {
        return undefined;
    }

    for (let index = firstIndex; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind === "newline") {
            lastIndex = index;

            /*
             * Окно закрывается на переводе строки последней задетой строки.
             * Он входит в окно: без него незакрытый строковый литерал,
             * «съедающий» перевод строки, выглядел бы законным однострочным
             * токеном (см. expectTrailingNewline). Переводы строки внутри
             * окна — это правка, изменившая их количество: как раз Enter.
             */
            if (token.line >= changeEndLine) {
                textEnd = token.start;
                end = token.end;
                endLine = token.line;
                expectTrailingNewline = true;
                break;
            }

            continue;
        }

        if (!SAFE_KINDS.has(token.kind) || token.line !== token.endLine) {
            return undefined;
        }

        endLine = Math.max(endLine, token.endLine);
        lastIndex = index;
    }

    /*
     * Правка обязана целиком лежать в тексте строки без её перевода строки.
     * Иначе окно не покрывает изменение, и сплайс собрал бы поток, в котором
     * часть текста не пролексирована заново.
     */
    if (changeStart < start || changeEnd > textEnd) {
        return undefined;
    }

    /*
     * lastIndex < firstIndex означает пустую последнюю строку. Это законное
     * окно: заменять нечего, и вставка произойдёт на месте firstIndex.
     */
    return {
        line,
        endLine,
        start,
        end,
        textEnd,
        expectTrailingNewline,
        firstIndex,
        lastIndex
    };
}

/**
 * Проверяет, что пересчёт строки годен для сплайса.
 *
 * Требования: токены идут непрерывно и покрывают слайс целиком (разрыв означал
 * бы, что часть текста в поток не попала, перекрытие — что смещения
 * разъехались); все они безопасного вида и однострочны.
 *
 * Отдельно проверяется хвост. Если у строки был перевод строки, он обязан
 * возникнуть и в пересчёте — и именно последним токеном. Незакрытая кавычка
 * делает строковый литерал, который продолжается на следующие строки: в
 * пределах слайса он выглядит обычным однострочным токеном, и без этой
 * проверки такая правка молча давала бы token stream, не совпадающий с полным
 * лексированием.
 */
function coversExactly(
    tokens: readonly IRslToken[],
    length: number,
    expectTrailingNewline: boolean
): boolean {
    const lastIndex = tokens.length - 1;
    let offset = 0;

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.start !== offset) {
            return false;
        }

        /*
         * Перевод строки допустим в любом месте окна: правка могла их и
         * добавить, и убрать. Требование к хвосту проверяется отдельно, ниже.
         */
        if (
            token.kind !== "newline" &&
            (!SAFE_KINDS.has(token.kind) || token.line !== token.endLine)
        ) {
            return false;
        }

        offset = token.end;
    }

    if (offset !== length) {
        return false;
    }

    return !expectTrailingNewline ||
        (lastIndex >= 0 && tokens[lastIndex].kind === "newline");
}

/**
 * Тот же токен, сдвинутый по смещению и по номеру строки.
 *
 * Поля перечислены явно, а не скопированы через spread. Разница на потоке из
 * 200 тысяч токенов — 9 мс против 46, то есть spread и был той ценой, из-за
 * которой правку в начале файла приходилось отправлять на полное
 * лексирование (см. MAX_SHIFTED_TOKEN_FRACTION).
 *
 * squareKind ставится только когда он есть: лишнее поле со значением undefined
 * сделало бы токен неотличимым по смыслу, но отличимым при сравнении с полным
 * лексированием — а на этом сравнении держится проверка всего пути.
 */
function shiftToken(
    token: IRslToken,
    offsetDelta: number,
    lineDelta: number
): IRslToken {
    const shifted: IRslToken = {
        kind: token.kind,
        raw: token.raw,
        value: token.value,
        start: token.start + offsetDelta,
        end: token.end + offsetDelta,
        line: token.line + lineDelta,
        character: token.character,
        endLine: token.endLine + lineDelta,
        endCharacter: token.endCharacter
    };

    if (token.squareKind !== undefined) {
        shifted.squareKind = token.squareKind;
    }

    return shifted;
}

/** Индекс строки, содержащей смещение; lineStarts возрастает. */
function findLineIndex(
    lineStarts: readonly number[],
    offset: number
): number | undefined {
    if (lineStarts.length === 0 || offset < lineStarts[0]) {
        return undefined;
    }

    let low = 0;
    let high = lineStarts.length - 1;
    let candidate = 0;

    while (low <= high) {
        const middle = (low + high) >>> 1;

        if (lineStarts[middle] <= offset) {
            candidate = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }

    return candidate;
}

/** Первый индекс токена с start >= offset. */
function lowerBound(tokens: readonly IRslToken[], offset: number): number {
    let low = 0;
    let high = tokens.length;

    while (low < high) {
        const middle = (low + high) >>> 1;

        if (tokens[middle].start < offset) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    return low;
}

/*
 * Сколько символов сверять по обе стороны участка.
 *
 * Полная сверка означала бы два прохода по всему тексту — ровно то, ради чего
 * участок и приходит готовым. Окна в шестьдесят четыре символа хватает, чтобы
 * поймать настоящую беду этого места — участок, съехавший на несколько
 * символов: тогда по одну сторону от границы тексты уже расходятся.
 */
const SPAN_CHECK_CHARS = 64;

/**
 * Участок из журнала, если он похож на правду.
 *
 * Участок приходит снаружи, и неверный означал бы молча неверный token stream.
 * Сверяются границы: то, что примыкает к участку снаружи, обязано совпадать в
 * обоих текстах — по определению участка. Не сошлось — участок отбрасывается,
 * и работает обычный поиск сравнением: медленнее, но правильно.
 *
 * Сверка ограниченная и полной гарантии не даёт: участок, съехавший целиком в
 * другое место файла, границы пройдёт. От этого защищает не проверка, а
 * источник — журнал строит участок из диапазонов самого редактора и сверяет
 * длины; см. documentChangeLog.
 */
function trustedSpan(
    previousText: string,
    nextText: string,
    span: IRslChangedSpan | undefined
): IRslChangedSpan | undefined {
    if (!span) {
        return undefined;
    }

    if (
        span.oldStart < 0 ||
        span.oldEnd > previousText.length ||
        span.newEnd > nextText.length ||
        span.oldEnd < span.oldStart ||
        span.newEnd < span.oldStart
    ) {
        return undefined;
    }

    if (
        nextText.length - previousText.length !==
        span.newEnd - span.oldEnd
    ) {
        /* Разница длин обязана совпадать с разницей длин участка. */
        return undefined;
    }

    const before = Math.max(0, span.oldStart - SPAN_CHECK_CHARS);

    if (
        previousText.slice(before, span.oldStart) !==
        nextText.slice(before, span.oldStart)
    ) {
        return undefined;
    }

    if (
        previousText.slice(span.oldEnd, span.oldEnd + SPAN_CHECK_CHARS) !==
        nextText.slice(span.newEnd, span.newEnd + SPAN_CHECK_CHARS)
    ) {
        return undefined;
    }

    return span;
}

/** Изменённый участок сравнением: запасной путь, когда журнал молчит. */
function scanChangedSpan(
    previousText: string,
    nextText: string
): IRslChangedSpan {
    const prefix = commonPrefixLength(previousText, nextText);
    const maxSuffix = Math.min(
        previousText.length - prefix,
        nextText.length - prefix
    );
    const suffix = commonSuffixLength(previousText, nextText, maxSuffix);

    return {
        oldStart: prefix,
        oldEnd: previousText.length - suffix,
        newEnd: nextText.length - suffix
    };
}

function commonPrefixLength(left: string, right: string): number {
    const max = Math.min(left.length, right.length);
    let index = 0;

    while (index < max && left.charCodeAt(index) === right.charCodeAt(index)) {
        index++;
    }

    return index;
}

function commonSuffixLength(left: string, right: string, max: number): number {
    let index = 0;

    while (
        index < max &&
        left.charCodeAt(left.length - 1 - index) ===
            right.charCodeAt(right.length - 1 - index)
    ) {
        index++;
    }

    return index;
}


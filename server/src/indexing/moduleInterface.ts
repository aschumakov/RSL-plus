import { CompletionItemKind } from "vscode-languageserver";

import { moduleIdOf } from "../core/identity/uriKey";
import type { IRslModuleModel } from "../moduleModel";
import type { RslSymbol } from "../symbols/rslSymbol";

/**
 * Внешний интерфейс модуля: всё, чем он способен повлиять на другие файлы.
 *
 * Отдельно от тела. Соседний файл видит от модуля только его Import и
 * публичные объявления с подписями, типами и базовыми классами; что написано
 * внутри Macro — его дело. Правка тела не меняет ни одного вывода в соседнем
 * файле, и пересчитывать из-за неё межфайловые проверки незачем.
 *
 * ЧЕГО ЗДЕСЬ НЕТ — положений в тексте. Диапазоны съезжают от любой правки выше
 * по файлу, и включить их значило бы объявлять интерфейс изменившимся на каждое
 * нажатие клавиши. Тем, кому нужно положение — переходу, Hover, — отвечает сам
 * индекс на момент запроса, а не отпечаток.
 */
export interface IRslModuleInterface {
    /** Отпечаток: сравнивается строкой, других операций над ним нет. */
    fingerprint: string;
    /** Сколько публичных объявлений учтено; для лога и проверок. */
    declarationCount: number;
}

/*
 * Отпечаток считается свёрткой прямо по полям.
 *
 * Первая версия склеивала поля в строку и брала SHA1. Считается интерфейс на
 * КАЖДЫЙ модуль при индексации, и на 4000 файлах это стоило 10% времени обхода
 * проекта — при том, что сама строка нужна была только чтобы её тут же
 * выбросить. Здесь строк не строится вовсе: символы полей подмешиваются в два
 * независимых 32-битных накопителя.
 *
 * Два накопителя, а не один: одного мало. Совпадение отпечатка означает «ничего
 * не пересчитывать», и ошибка тут не косметическая — соседний файл остался бы с
 * устаревшими межфайловыми проверками. Вместе с числом полей это порядка 2^64
 * состояний.
 */
const FNV_PRIME = 0x01000193;
const SECOND_PRIME = 0x85ebca6b;
const GOLDEN = 0x9e3779b9;
const OFFSET_ONE = 0x811c9dc5;
const OFFSET_TWO = 0x7fed7fed;

/** Разделители полей: подмешиваются как обычные символы, но встретиться в тексте не могут. */
const FIELD_MARK = 1;
const ITEM_MARK = 2;

/**
 * Интерфейс по уже построенной модели.
 *
 * Ни разбора, ни сканирования текста здесь нет: всё берётся из дерева символов
 * и списка Import, которые к этому моменту уже есть.
 */
export function computeRslModuleInterface(
    model: IRslModuleModel
): IRslModuleInterface {
    let first = OFFSET_ONE;
    let second = OFFSET_TWO;
    let fields = 0;

    /** Подмешать код символа в оба накопителя. */
    const mixCode = (code: number): void => {
        first = Math.imul(first ^ code, FNV_PRIME);
        /*
         * Второй накопитель считается ИНАЧЕ, а не тем же способом от
         * сдвинутого входа. Первая версия брала тот же простой множитель и
         * фиксированную добавку — состояния получались связанными, и вместо
         * заявленных 64 бит выходило около 32: на 6166 настоящих модулях это
         * дало 6 коллизий. Теперь у второго свой множитель и сдвиг.
         */
        second = Math.imul(second + code + GOLDEN, SECOND_PRIME);
        second ^= second >>> 13;
    };
    /**
     * Подмешать значение поля и его границу.
     *
     * Регистр имён не значит ничего: RSL сравнивает их без него, и `Send` и
     * `send` — одно объявление. Приведение делается на лету, чтобы не заводить
     * строку на каждое имя. Записанное ЗНАЧЕНИЕ — исключение: это литерал, и
     * `"Да"` от `"ДА"` там отличается.
     */
    const mix = (
        value: string | undefined,
        mark: number,
        caseMatters = false
    ): void => {
        fields++;

        if (value) {
            for (let at = 0; at < value.length; at++) {
                const code = value.charCodeAt(at);

                mixCode(caseMatters ? code : foldCase(code));
            }
        }

        mixCode(mark);
    };

    /*
     * Import — множество, а не последовательность: порядок в тексте на то,
     * что видит соседний файл, не влияет.
     *
     * Написание приводится к КАНОНИЧЕСКОМУ виду — тому же, по которому
     * разрешаются ссылки и сравнивается набор Import. Простого toLowerCase
     * мало: `Import lib` и `Import lib.mac` — одна и та же зависимость, и
     * набор Import это уже знал. Отпечаток — нет, и переписывание ссылки
     * без изменения смысла объявлялось изменением интерфейса: рёбра графа
     * не трогались, а зависимые всё равно пересчитывались.
     */
    const imports = model.imports
        .map(name => moduleIdOf(name) as string)
        .sort();

    for (const name of imports) {
        mix(name, FIELD_MARK);
    }

    mix("imports", ITEM_MARK);

    let declarationCount = 0;
    const append = (symbol: RslSymbol, level: number): void => {
        if (symbol.isPrivate) {
            /* Непубличное снаружи не видно вовсе — ни само, ни его члены. */
            return;
        }

        declarationCount++;
        mixCode(level);
        mix(symbol.name, FIELD_MARK);
        mixCode(symbol.kind);
        mix(symbol.visibility, FIELD_MARK);
        mix(symbol.parameterText, FIELD_MARK);
        mix(symbol.typeName, FIELD_MARK);
        mixCode(symbol.isTypeVariant ? 1 : 0);
        mix(symbol.baseClassName, FIELD_MARK);
        /*
         * Записанное значение — внешне значимое свойство: соседний файл
         * показывает его в Hover и выводит из него тип. Берётся у всякого
         * публичного объявления, а не только у Const: у публичной Var оно
         * видно снаружи ровно так же.
         */
        mix(symbol.value, ITEM_MARK, true);

        for (const child of symbol.children) {
            /*
             * У вызываемых объявлений дети — это параметры и локальные имена.
             * Снаружи их не видно: подпись уже учтена отдельным полем.
             */
            if (isCallableKind(symbol.kind)) {
                break;
            }

            append(child, level + 1);
        }
    };

    for (const symbol of model.symbolTree.children) {
        append(symbol, 0);
    }

    return {
        fingerprint: fields.toString(36) + ":" +
            avalanche(first).toString(36) + ":" +
            avalanche(second).toString(36),
        declarationCount
    };
}

/** Финальное перемешивание: разводит близкие состояния по всему диапазону. */
function avalanche(value: number): number {
    let result = value >>> 0;

    result ^= result >>> 16;
    result = Math.imul(result, 0x85ebca6b);
    result ^= result >>> 13;
    result = Math.imul(result, 0xc2b2ae35);
    result ^= result >>> 16;

    return result >>> 0;
}

/** Латиница и кириллица к нижнему регистру; остальное как есть. */
function foldCase(code: number): number {
    if (code >= 65 && code <= 90) {
        return code + 32;
    }

    /* А-Я и Ё: тот же сдвиг, что и в normalizeIdentifier. */
    if (code >= 0x0410 && code <= 0x042f) {
        return code + 32;
    }

    return code === 0x0401 ? 0x0451 : code;
}

function isCallableKind(kind: CompletionItemKind): boolean {
    return kind === CompletionItemKind.Function ||
        kind === CompletionItemKind.Method ||
        kind === CompletionItemKind.Constructor;
}


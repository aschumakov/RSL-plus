/**
 * Декодирование исходников RSL с диска.
 *
 * Макросы RS-Bank хранятся либо в UTF-8, либо в CP866 — это OEM-кодировка DOS,
 * в которой платформа работала исторически. На реальном репозитории из 5816
 * файлов 4286 (74%) не читаются как UTF-8.
 *
 * Прежде файл всегда декодировался как UTF-8, и для этих трёх четвертей каждая
 * кириллическая буква превращалась в символ замены. Отсюда следовало всё
 * остальное: `Macro НоваяОперация` становился `Macro ????????????`, то есть
 * имя переставало быть идентификатором. Символы импортированного модуля с
 * русскими именами не находились ни переходом, ни автодополнением, ни выводом
 * типов, а компактные сводки и дисковый индекс запоминали этот мусор.
 *
 * Открытые в редакторе документы приходят от VS Code уже декодированными и
 * этого пути не касаются.
 */

/**
 * Верхняя половина CP866: байты 0x80..0xFF.
 *
 * Таблица выписана целиком, а не вычисляется арифметикой. Кириллица в CP866
 * действительно идёт подряд тремя кусками, и на них соблазнительно обойтись
 * формулой — но между ними лежат 48 символов псевдографики, порядок которых
 * произвольный. Формула давала для них другие символы: рамки в комментариях
 * и строковых литералах превращались в посторонние знаки, а проверка,
 * смотревшая только на кириллицу, этого не замечала.
 */
const CP866_HIGH: readonly number[] = Object.freeze([
    /* 0x80 */ 0x0410, 0x0411, 0x0412, 0x0413, 0x0414, 0x0415, 0x0416, 0x0417,
    /* 0x88 */ 0x0418, 0x0419, 0x041A, 0x041B, 0x041C, 0x041D, 0x041E, 0x041F,
    /* 0x90 */ 0x0420, 0x0421, 0x0422, 0x0423, 0x0424, 0x0425, 0x0426, 0x0427,
    /* 0x98 */ 0x0428, 0x0429, 0x042A, 0x042B, 0x042C, 0x042D, 0x042E, 0x042F,
    /* 0xA0 */ 0x0430, 0x0431, 0x0432, 0x0433, 0x0434, 0x0435, 0x0436, 0x0437,
    /* 0xA8 */ 0x0438, 0x0439, 0x043A, 0x043B, 0x043C, 0x043D, 0x043E, 0x043F,
    /* 0xB0 */ 0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556,
    /* 0xB8 */ 0x2555, 0x2563, 0x2551, 0x2557, 0x255D, 0x255C, 0x255B, 0x2510,
    /* 0xC0 */ 0x2514, 0x2534, 0x252C, 0x251C, 0x2500, 0x253C, 0x255E, 0x255F,
    /* 0xC8 */ 0x255A, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256C, 0x2567,
    /* 0xD0 */ 0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256B,
    /* 0xD8 */ 0x256A, 0x2518, 0x250C, 0x2588, 0x2584, 0x258C, 0x2590, 0x2580,
    /* 0xE0 */ 0x0440, 0x0441, 0x0442, 0x0443, 0x0444, 0x0445, 0x0446, 0x0447,
    /* 0xE8 */ 0x0448, 0x0449, 0x044A, 0x044B, 0x044C, 0x044D, 0x044E, 0x044F,
    /* 0xF0 */ 0x0401, 0x0451, 0x0404, 0x0454, 0x0407, 0x0457, 0x040E, 0x045E,
    /* 0xF8 */ 0x00B0, 0x2219, 0x00B7, 0x221A, 0x2116, 0x00A4, 0x25A0, 0x00A0
]);

export type RslSourceEncoding = "utf8" | "cp866" | "utf16";

export interface IRslDecodedSource {
    text: string;
    encoding: RslSourceEncoding;
}

function decodeCp866(buffer: Buffer): string {
    const result = new Array<string>(buffer.length);

    for (let index = 0; index < buffer.length; index++) {
        const byte = buffer[index];
        /* Один байт — один символ: на этом держится совпадение смещений. */
        result[index] = String.fromCharCode(
            byte < 0x80 ? byte : CP866_HIGH[byte - 0x80]
        );
    }

    return result.join("");
}

/**
 * Проверка «это корректный UTF-8» делается строгим декодером, а не поиском
 * символа замены: файл имеет право содержать U+FFFD сам по себе, и тогда поиск
 * объявил бы UTF-8 сломанным.
 */
function tryDecodeUtf8(buffer: Buffer): string | undefined {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch (error) {
        return undefined;
    }
}

/**
 * Текст файла в UTF-16 по его BOM.
 *
 * Такие макросы встречаются: в проверенном репозитории их 12 из 5784. Без этого
 * файл читался побайтно — между буквами оказывались нулевые символы, и
 * содержимое не разбиралось вовсе: ни подсветка, ни подсказки, ни Problems по
 * нему не работали.
 */
function decodeUtf16(buffer: Buffer): string | undefined {
    if (buffer.length < 2) {
        return undefined;
    }

    if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
        return buffer.toString("utf16le", 2);
    }

    if (buffer[0] === 0xFE && buffer[1] === 0xFF) {
        /* Big-endian: Node умеет только LE, поэтому байты меняются местами. */
        const swapped = Buffer.from(buffer.subarray(2));
        swapped.swap16();
        return swapped.toString("utf16le");
    }

    return undefined;
}

/** Исходник и кодировка, в которой он оказался записан. */
export function decodeRslSource(buffer: Buffer): IRslDecodedSource {
    /* BOM снимается: иначе он попадёт в текст первым символом. */
    if (
        buffer.length >= 3 &&
        buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF
    ) {
        return {
            text: buffer.toString("utf8", 3),
            encoding: "utf8"
        };
    }

    const utf16 = decodeUtf16(buffer);

    if (utf16 !== undefined) {
        return { text: utf16, encoding: "utf16" };
    }

    const utf8 = tryDecodeUtf8(buffer);

    return utf8 === undefined
        ? { text: decodeCp866(buffer), encoding: "cp866" }
        : { text: utf8, encoding: "utf8" };
}

/** Текст без сведений о кодировке — для мест, которым она безразлична. */
export function decodeRslSourceText(buffer: Buffer): string {
    return decodeRslSource(buffer).text;
}

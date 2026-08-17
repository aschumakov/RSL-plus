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

/* CP866: 0x80..0x9F — А..Я, 0xA0..0xAF — а..п, 0xE0..0xEF — р..я. */
const CP866_TAIL: Readonly<Record<number, number>> = Object.freeze({
    0xF0: 0x0401, // Ё
    0xF1: 0x0451, // ё
    0xF2: 0x0404, // Є
    0xF3: 0x0454, // є
    0xF4: 0x0407, // Ї
    0xF5: 0x0457, // ї
    0xF6: 0x040E, // Ў
    0xF7: 0x045E, // ў
    0xF8: 0x00B0, // °
    0xF9: 0x2219, // ∙
    0xFA: 0x00B7, // ·
    0xFB: 0x221A, // √
    0xFC: 0x2116, // №
    0xFD: 0x00A4, // ¤
    0xFE: 0x25A0, // ■
    0xFF: 0x00A0  // неразрывный пробел
});

/*
 * 0xB0..0xDF — рамки псевдографики. В коде они встречаются только внутри
 * комментариев-разделителей, и содержательного значения не несут, но заменять
 * их на что-то другое нельзя: смещения обязаны совпадать байт в символ.
 */
const CP866_BOX_START = 0xB0;
const CP866_BOX_END = 0xDF;

export type RslSourceEncoding = "utf8" | "cp866";

export interface IRslDecodedSource {
    text: string;
    encoding: RslSourceEncoding;
}

function decodeCp866(buffer: Buffer): string {
    const result = new Array<string>(buffer.length);

    for (let index = 0; index < buffer.length; index++) {
        const byte = buffer[index];

        if (byte < 0x80) {
            result[index] = String.fromCharCode(byte);
        } else if (byte <= 0x9F) {
            result[index] = String.fromCharCode(0x0410 + (byte - 0x80));
        } else if (byte <= 0xAF) {
            result[index] = String.fromCharCode(0x0430 + (byte - 0xA0));
        } else if (byte <= CP866_BOX_END) {
            /* Псевдографика: один байт — один символ, как и везде. */
            result[index] = String.fromCharCode(
                0x2550 + (byte - CP866_BOX_START)
            );
        } else if (byte <= 0xEF) {
            result[index] = String.fromCharCode(0x0440 + (byte - 0xE0));
        } else {
            result[index] = String.fromCharCode(CP866_TAIL[byte] || 0xFFFD);
        }
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

    const utf8 = tryDecodeUtf8(buffer);

    return utf8 === undefined
        ? { text: decodeCp866(buffer), encoding: "cp866" }
        : { text: utf8, encoding: "utf8" };
}

/** Текст без сведений о кодировке — для мест, которым она безразлична. */
export function decodeRslSourceText(buffer: Buffer): string {
    return decodeRslSource(buffer).text;
}

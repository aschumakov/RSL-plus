/**
 * Имя модуля RSL: разбор написания и приведение к общему виду.
 *
 * Директивы Import достаются из файла пятью независимыми способами — деревом,
 * компактным извлекателем, сканером ссылок, быстрым индексом подсказок и
 * моделью Organize Imports. Так и задумано: одним нужен точный текст с
 * комментариями и диапазонами, другим — дешёвая сводка без разбора. Но имя
 * модуля они обязаны понимать одинаково, и раньше не понимали.
 *
 * Здесь живёт только разбор написания: ни каталога проекта, ни файловой
 * системы, ни индекса. Поэтому core/language, а не indexing.
 */

/**
 * Путь модуля из строкового написания.
 *
 * Обратный слеш в пути значим, а лексер разбирает строку по общим правилам
 * языка, где он открывает escape-последовательность. Из-за этого пятеро
 * расходились: кто брал значение строки, терял `\` в `"sub\lib.mac"`, кто брал
 * исходный текст — оставлял оба в `"..\\user\\lib.mac"`.
 *
 * В проверенном проекте из 6166 файлов такие пути пишут только с удвоенным
 * слешем: девять директив из девяти. Поэтому `\\` — это один разделитель. А
 * одиночный `\` перед буквой — тоже разделитель, а не escape: терять его нельзя
 * ни при каком написании.
 */
export function decodeRslModulePath(raw: string): string {
    const body = stripQuotes(String(raw || "").trim());

    if (body.indexOf("\\") < 0) {
        return body;
    }

    let result = "";

    for (let at = 0; at < body.length; at++) {
        const current = body.charAt(at);

        if (current !== "\\") {
            result += current;
            continue;
        }

        /* Удвоенный слеш — один разделитель. */
        if (body.charAt(at + 1) === "\\") {
            result += "\\";
            at++;
            continue;
        }

        /* Одиночный — тоже разделитель, а не начало escape. */
        result += "\\";
    }

    return result;
}

/**
 * Имя модуля из токенов одного пункта директивы Import.
 *
 * Пункт — это либо строка, либо последовательность имён и разделителей пути:
 * `Import sub\lib;` и `Import "sub\lib.mac";` — одно и то же.
 */
export function rslModuleItemName(
    tokens: readonly { kind: string; raw: string }[]
): string {
    if (tokens.length === 0) {
        return "";
    }

    if (tokens.length === 1 && tokens[0].kind === "string") {
        return decodeRslModulePath(tokens[0].raw);
    }

    return decodeRslModulePath(
        tokens.map(token => token.raw).join("").trim()
    );
}

/** Написание без обрамляющих кавычек. */
export function stripQuotes(value: string): string {
    const text = String(value || "");

    if (text.length < 2) {
        return text;
    }

    const first = text.charAt(0);

    if ((first === "\"" || first === "'") && text.endsWith(first)) {
        return text.slice(1, -1);
    }

    return text;
}

/**
 * Имя файла модуля: с расширением, прямыми слешами, в нижнем регистре.
 *
 * По нему каталог проекта ищет файл.
 */
export function normalizeModuleName(value: string): string {
    let result = decodeRslModulePath(value)
        .replace(/\\/gu, "/")
        .toLowerCase();

    while (result.startsWith("./")) {
        result = result.substring(2);
    }

    return result.endsWith(".mac") ? result : result + ".mac";
}

/**
 * Ключ имени модуля: по нему два написания считаются одним файлом.
 *
 * Разделитель пути, регистр и кавычки в RSL не значимы, а расширение .mac
 * подразумевается: Import oralib и Import "oralib.mac" — один и тот же модуль.
 * Прочие расширения оставлены как есть: файлы с одинаковым именем и разными
 * расширениями — это ошибка, и диагностика сообщает о ней отдельно.
 */
export function moduleReferenceKey(value: string): string {
    return decodeRslModulePath(value)
        .replace(/\\/gu, "/")
        .toLowerCase()
        .replace(/\.mac$/u, "");
}

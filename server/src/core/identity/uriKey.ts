import * as path from "path";
import { fileURLToPath } from "url";

import { normalizeModuleName } from "../language/moduleName";

/**
 * Идентичность файла и идентичность написанной ссылки на модуль.
 *
 * Раньше это правило жило в четырёх местах и в каждом по-своему: индекс
 * модулей звал getUriIdentity, сканер ссылок держал свою копию с безусловным
 * toLowerCase, дерево зависимостей сравнивало URI строкой, а индекс ссылок
 * ключевался сырой строкой вовсе. Различие не косметическое: на регистронезависимой
 * файловой системе `file:///D:/a/lib.mac` и `file:///d:/a/lib.mac` — один файл, и
 * тот, кто сравнивает строки, считает их разными; на регистрозависимой всё
 * наоборот, и безусловный toLowerCase склеивает два РАЗНЫХ файла.
 *
 * Здесь оба правила названы своими именами:
 *
 *   UriKey   — идентичность физического файла;
 *   ModuleId — идентичность НАПИСАНИЯ ссылки на модуль.
 *
 * Второе не заменяет первое. `Import lib` может вести в два разных файла, и
 * ModuleId у них будет один: это ключ ссылки, а не ключ модуля. Разрешение
 * ссылки в файл живёт в каталоге проекта и остаётся там.
 */

/** Идентичность физического файла: сравнивать URI можно только по ней. */
export type UriKey = string & { readonly __uriKey: unique symbol };

/** Идентичность написания ссылки на модуль: `lib`, `LIB.mac`, `sub\lib`. */
export type ModuleId = string & { readonly __moduleId: unique symbol };

/**
 * Файловый ли это URI.
 *
 * Проверка схемы стоит до вызова fileURLToPath намеренно. На не-файловом URI —
 * а таковы все встроенные символы и untitled-документы — он бросает исключение,
 * и хотя оно тут же ловится, конструирование ошибки со стеком в V8 недёшево.
 * На горячем пути это заметно: в профиле семантической подсветки файла 379 КБ
 * создание NodeError занимало 5,9 секунды из всего профиля — больше, чем весь
 * разбор и разрешение имён вместе взятые. Идентичность ресурса спрашивают на
 * каждый разрешённый символ, а встроенных среди них большинство.
 */
function isFileUri(uri: string): boolean {
    return uri.length > 5 &&
        (uri.charCodeAt(0) === 102 || uri.charCodeAt(0) === 70) &&
        uri.slice(0, 5).toLowerCase() === "file:";
}

/**
 * Регистр значим для файловой системы этой платформы?
 *
 * Отдельной функцией, а не выражением на месте: правило одно на весь сервер, и
 * менять его придётся в одном месте, если появится платформа с иным поведением.
 */
function ignoresCase(): boolean {
    return process.platform === "win32" || process.platform === "darwin";
}

/*
 * Ответ запоминается: это чистая функция от строки, а спрашивают её на каждый
 * разрешённый символ. В профиле семантической подсветки файла 379 КБ разбор
 * URI — fileURLToPath, path.normalize, конструктор URL — занимал около 120 мс
 * на прогон при том, что различных URI в файле единицы.
 *
 * Предел нужен на случай проекта с тысячами файлов: карта живёт всю сессию.
 */
const IDENTITY_LIMIT = 4096;
const identityByUri = new Map<string, UriKey>();

/** Ключ физической идентичности ресурса. Исходный URI не изменяется. */
export function uriKey(uri: string): UriKey {
    const known = identityByUri.get(uri);

    if (known !== undefined) {
        return known;
    }

    const identity = computeUriKey(uri);

    if (identityByUri.size >= IDENTITY_LIMIT) {
        identityByUri.clear();
    }
    identityByUri.set(uri, identity);

    return identity;
}

function computeUriKey(uri: string): UriKey {
    /* Не-файловые URI, например untitled: или встроенные, не нормализуем. */
    if (!isFileUri(uri)) {
        return uri as UriKey;
    }

    try {
        return filePathKey(fileURLToPath(uri)) as string as UriKey;
    } catch (_error) {
        return uri as UriKey;
    }
}

/** Тот же ключ для пути на диске: у обхода проекта URI на руках нет. */
export function filePathKey(fullPath: string): string {
    const normalized = path.normalize(fullPath);

    return ignoresCase() ? normalized.toLowerCase() : normalized;
}

/** Один ли это файл. Единственный допустимый способ сравнить два URI. */
export function sameUri(left: string, right: string): boolean {
    return left === right || uriKey(left) === uriKey(right);
}

/** Один ли это путь на диске; та же платформенная семантика. */
export function samePath(left: string, right: string): boolean {
    return left === right || filePathKey(left) === filePathKey(right);
}

/**
 * Путь URI прямыми слешами и в нижнем регистре.
 *
 * Это НЕ идентичность файла, а ключ для сравнения по хвосту пути: ссылка
 * `sub/lib.mac` обязана совпасть с `.../sub/lib.mac` при любом написании. Здесь
 * регистр снимается всегда, потому что регистр НАПИСАНИЯ ссылки в RSL не
 * значим — см. ModuleId.
 */
export function uriPathKey(uri: string): string {
    if (isFileUri(uri)) {
        try {
            return fileURLToPath(uri)
                .replace(/\\/gu, "/")
                .toLowerCase();
        } catch (_error) {
            /* Испорченный file:-URI: ниже он приводится как обычная строка. */
        }
    }

    return uri
        .replace(/\\/gu, "/")
        .toLowerCase();
}

/**
 * Идентичность написания ссылки на модуль.
 *
 * Та же нормализация, что у разрешения имён: разделитель пути, регистр и
 * кавычки не значимы, расширение `.mac` подразумевается. `lib`, `LIB.mac` и
 * `sub\lib` про один и тот же модуль — и обязаны давать один ключ, иначе
 * переписывание `Import lib` в `Import lib.mac` считается сменой набора
 * зависимостей и перестраивает то, что не изменилось.
 */
export function moduleIdOf(reference: string): ModuleId {
    return normalizeModuleName(reference) as ModuleId;
}

/** Ссылка, которой в этот файл попадают: имя файла с расширением. */
export function moduleIdOfUri(uri: string): ModuleId {
    const normalized = uriPathKey(uri);
    const slash = normalized.lastIndexOf("/");

    return moduleIdOf(slash < 0 ? normalized : normalized.slice(slash + 1));
}

/** Один ли это модуль по написанию ссылок. */
export function sameModuleId(left: string, right: string): boolean {
    return moduleIdOf(left) === moduleIdOf(right);
}

/**
 * Базовое имя модуля-файла: `.../sub/lib.mac` -> `lib`.
 *
 * По нему написанная ссылка и файл сравниваются по имени — так же, как в
 * обратных рёбрах Import-графа. Написание с путём и без него даёт одно имя, и
 * `Import sub\lib` совпадает с файлом `lib.mac`.
 */
export function moduleBaseNameOfUri(uri: string): string {
    const id = moduleIdOfUri(uri) as string;

    return id.endsWith(".mac") ? id.slice(0, -4) : id;
}

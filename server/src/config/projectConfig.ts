import * as fs from "fs";
import * as path from "path";

/**
 * Необязательная настройка проекта: `.rslplus.json` в корне.
 *
 * Без файла всё работает ровно как раньше — это обязательное условие, а не
 * пожелание: у проекта уже есть автоматическое поведение, и появление
 * возможности его настроить не должно менять его по умолчанию.
 *
 * Негодный файл — не повод молча пойти с умолчаниями. Опечатка в имени поля
 * или сломанный JSON означают, что пользователь хотел другого поведения, и
 * промолчать значило бы незаметно его не дать. Ошибки возвращаются наружу, а
 * решает вызывающий: сервер их показывает, но работать продолжает.
 */
export interface IRslProjectConfig {
    /** Каталоги, где искать модули; относительно корня проекта. */
    moduleRoots: string[];
    /** Что не обходить: шаблоны в стиле glob. */
    exclude: string[];
    /** Где лежат заглушки внешних модулей. */
    stubPaths: string[];
}

/*
 * Чего здесь нет — поля dialect.
 *
 * Оно было в первой версии настройки: читалось, проверялось и не
 * меняло ровно ничего. Публичная настройка, которая молча ничего не
 * делает, хуже её отсутствия — пользователь пишет её и ждёт эффекта.
 * Вернём, когда появится сама поддержка диалектов.
 */

export interface IRslProjectConfigResult {
    config: IRslProjectConfig;
    /** Найден ли файл настройки; без него поведение прежнее. */
    found: boolean;
    /** Путь файла, если он найден. */
    filePath?: string;
    /** Что не так с файлом: пустой список — всё в порядке. */
    problems: string[];
}

export const RSL_PROJECT_CONFIG_NAME = ".rslplus.json";

const KNOWN_FIELDS = new Set([
    "moduleRoots",
    "exclude",
    "stubPaths"
]);

/** Умолчания: ровно нынешнее поведение. */
export function defaultRslProjectConfig(): IRslProjectConfig {
    return {
        moduleRoots: [],
        exclude: [],
        stubPaths: []
    };
}

/** Читает настройку из первого корня, где она есть. */
export function readRslProjectConfig(
    roots: readonly string[]
): IRslProjectConfigResult {
    for (const root of roots) {
        const filePath = path.join(root, RSL_PROJECT_CONFIG_NAME);

        if (!fs.existsSync(filePath)) {
            continue;
        }

        return parseRslProjectConfig(readText(filePath), filePath);
    }

    return { config: defaultRslProjectConfig(), found: false, problems: [] };
}

/** Разбор содержимого: отдельно от чтения, чтобы это можно было проверить. */
export function parseRslProjectConfig(
    text: string | undefined,
    filePath?: string
): IRslProjectConfigResult {
    const config = defaultRslProjectConfig();
    const problems: string[] = [];

    if (text === undefined) {
        return {
            config,
            found: true,
            filePath,
            problems: ["Файл настройки не читается"]
        };
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(text);
    } catch (error) {
        return {
            config,
            found: true,
            filePath,
            problems: ["Файл настройки не разбирается: " + String(error)]
        };
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
            config,
            found: true,
            filePath,
            problems: ["Ожидался объект настроек"]
        };
    }

    const record = parsed as Record<string, unknown>;

    for (const key of Object.keys(record)) {
        if (!KNOWN_FIELDS.has(key)) {
            /*
             * Опечатка в имени поля — самая частая ошибка, и молчать о ней
             * нельзя: настройка выглядит записанной, а не действует.
             */
            problems.push("Неизвестное поле: " + key);
        }
    }

    config.moduleRoots = readStrings(record, "moduleRoots", problems);
    config.exclude = readStrings(record, "exclude", problems);
    config.stubPaths = readStrings(record, "stubPaths", problems);

    return { config, found: true, filePath, problems };
}

/**
 * Подходит ли путь под шаблоны исключения.
 *
 * Шаблоны простые: `*` — любые символы кроме разделителя, `**` — любые,
 * включая разделитель. Полноценный glob здесь не нужен, а вводить зависимость
 * ради трёх правил тем более.
 */
export function isExcludedByRslConfig(
    relativePath: string,
    patterns: readonly string[]
): boolean {
    if (patterns.length === 0) {
        return false;
    }

    const normalized = relativePath.replace(/\\/gu, "/").toLowerCase();

    return patterns.some(pattern => globToRegExp(pattern).test(normalized));
}

function globToRegExp(pattern: string): RegExp {
    let normalized = pattern.replace(/\\/gu, "/").toLowerCase();
    /*
     * Шаблон, кончающийся двумя звёздами, исключает и сам каталог.
     *
     * Иначе `archive` со звёздами не исключал бы каталог archive — только его
     * содержимое, и обход всё равно в него заходил бы.
     */
    let tailOptional = false;

    if (normalized.endsWith("/**")) {
        normalized = normalized.slice(0, -3);
        tailOptional = true;
    }

    let source = "";

    for (let at = 0; at < normalized.length; at++) {
        const character = normalized.charAt(at);

        if (character === "*") {
            if (normalized.charAt(at + 1) === "*") {
                source += ".*";
                at++;

                /*
                 * Две звезды со слешем покрывают и пустой путь: шаблон
                 * archive со звёздами исключает и сам каталог archive.
                 */
                if (normalized.charAt(at + 1) === "/") {
                    at++;
                }

                continue;
            }

            source += "[^/]*";
            continue;
        }

        if (character === "?") {
            source += "[^/]";
            continue;
        }

        source += character.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    }

    return new RegExp(
        "^" + source + (tailOptional ? "(/.*)?" : "") + "$",
        "u"
    );
}

function readStrings(
    record: Record<string, unknown>,
    key: string,
    problems: string[]
): string[] {
    const value = record[key];

    if (value === undefined) {
        return [];
    }

    if (!Array.isArray(value)) {
        problems.push(key + ": ожидался список строк");

        return [];
    }

    const result: string[] = [];

    for (const item of value) {
        if (typeof item !== "string" || !item.trim()) {
            problems.push(key + ": непустая строка ожидалась, получено " +
                JSON.stringify(item));
            continue;
        }

        result.push(item.trim());
    }

    return result;
}

function readText(filePath: string): string | undefined {
    try {
        return fs.readFileSync(filePath, "utf8");
    } catch (_error) {
        return undefined;
    }
}

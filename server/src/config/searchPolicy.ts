import * as path from "path";

import { samePath } from "../core/identity/uriKey";

import {
    compileRslExcludePatterns,
    matchesRslExcludePatterns,
    type IRslProjectConfig
} from "./projectConfig";
import { isExcludedRslDirectory } from "../indexing/workspaceModuleResolver";

/**
 * Где искать модули проекта — одно правило на всех.
 *
 * Обход состава проекта и адресный поиск по имени — два разных пути к одному
 * ответу, и раньше они расходились: обход учитывал `exclude` из настройки, а
 * адресный поиск шёл по диску своим ходом и находил файл, который настройка
 * исключила. Получалось, что один и тот же Import разрешался по-разному до и
 * после того, как каталог достроится.
 *
 * Здесь корни, исключения и нормализация путей собраны в один объект, и оба
 * пути спрашивают его.
 */
export interface IRslSearchPolicy {
    /** Корни, по которым ищутся прикладные модули. */
    readonly moduleRoots: readonly string[];
    /** Корни заглушек: отдельные, но обходятся так же. */
    readonly stubRoots: readonly string[];
    /** Всё, что нужно обойти: без вложенных и повторяющихся корней. */
    readonly searchRoots: readonly string[];
    /** Исключён ли путь настройкой проекта или системным правилом. */
    isExcluded(fullPath: string): boolean;
}

/**
 * Политика по корням рабочей области и настройке проекта.
 *
 * Семантика moduleRoots — ЗАМЕНА, а не добавление. Настройка называется
 * «корни модулей»; если она перечисляет `macro`, обходить и весь проект, и
 * `macro` внутри него значит не ограничить поиск, а удвоить его. Без
 * настройки корнями остаются корни рабочей области — прежнее поведение.
 */
export function createRslSearchPolicy(
    workspaceRoots: readonly string[],
    config: IRslProjectConfig
): IRslSearchPolicy {
    const base = collapseRoots(workspaceRoots.map(root => path.resolve(root)));
    const moduleRoots = config.moduleRoots.length > 0
        ? collapseRoots(expand(base, config.moduleRoots))
        : base;
    const stubRoots = collapseRoots(expand(base, config.stubPaths));
    const searchRoots = collapseRoots([...moduleRoots, ...stubRoots]);
    /* Один раз на политику, а не на каждый проверяемый путь. */
    const compiled = compileRslExcludePatterns(config.exclude);
    /*
     * Длины корней: по ним видно, откуда начинать смотреть сегменты.
     *
     * Считать их у всего пути нельзя. Проект вполне может лежать внутри
     * каталога с именем `build` или `dist`, и тогда системное правило
     * спрятало бы его целиком.
     */
    const roots = [...new Set([...searchRoots, ...base])];

    return {
        moduleRoots,
        stubRoots,
        searchRoots,
        isExcluded(fullPath: string): boolean {
            if (hasExcludedSegment(fullPath, segmentStart(fullPath, roots))) {
                return true;
            }

            /* Своих шаблонов нет — и работы больше никакой. */
            if (compiled.length === 0) {
                return false;
            }

            /*
             * Шаблоны написаны относительно корня рабочей области, а не
             * корня поиска: пользователь пишет `legacy` со звёздами,
             * глядя на дерево проекта, и про moduleRoots не думает.
             */
            for (const root of base) {
                const relative = path.relative(root, fullPath);

                if (isInside(relative)) {
                    return matchesRslExcludePatterns(relative, compiled);
                }
            }

            return false;
        }
    };
}

/** Политика без настройки: ровно прежнее поведение. */
export function createDefaultRslSearchPolicy(
    workspaceRoots: readonly string[]
): IRslSearchPolicy {
    return createRslSearchPolicy(workspaceRoots, {
        moduleRoots: [],
        exclude: [],
        stubPaths: []
    });
}

/**
 * Системные исключения: служебные каталоги вроде node_modules.
 *
 * Проверяется каждый сегмент пути, а не только имя файла: адресный поиск
 * умеет начать обход изнутри, и одного имени ему мало.
 *
 * Путь просматривается одним проходом, без split: спрашивают эту проверку
 * на каждую запись каталога при обходе проекта, и массив на каждый вызов
 * там заметен.
 *
 * Смотрятся только сегменты НИЖЕ корня: сам корень может лежать внутри
 * каталога с системным именем, и это не повод спрятать проект.
 */
function hasExcludedSegment(fullPath: string, from: number): boolean {
    let end = fullPath.length;

    for (let at = fullPath.length - 1; at >= from; at--) {
        const code = fullPath.charCodeAt(at);

        if (code !== SLASH && code !== BACKSLASH) {
            continue;
        }

        if (
            end > at + 1 &&
            isExcludedRslDirectory(fullPath.slice(at + 1, end))
        ) {
            return true;
        }

        end = at;
    }

    return end > from && isExcludedRslDirectory(fullPath.slice(from, end));
}

/**
 * С какого места путь принадлежит проекту.
 *
 * Ноль означает «корень не найден»: путь не из проекта, и смотреть его
 * целиком не вредно — в состав он всё равно не попадёт.
 */
function segmentStart(fullPath: string, roots: readonly string[]): number {
    for (const root of roots) {
        if (startsWithRoot(fullPath, root)) {
            return root.length + 1;
        }
    }

    return 0;
}

/** Начинается ли путь этим корнем; регистр на Windows не значит ничего. */
function startsWithRoot(fullPath: string, root: string): boolean {
    if (fullPath.length <= root.length) {
        return false;
    }

    const next = fullPath.charCodeAt(root.length);

    if (next !== SLASH && next !== BACKSLASH) {
        return false;
    }

    for (let at = 0; at < root.length; at++) {
        if (!sameChar(fullPath.charCodeAt(at), root.charCodeAt(at))) {
            return false;
        }
    }

    return true;
}

function sameChar(left: number, right: number): boolean {
    if (left === right) {
        return true;
    }

    /* Разделители равны между собой, регистр латиницы не важен. */
    if (
        (left === SLASH || left === BACKSLASH) &&
        (right === SLASH || right === BACKSLASH)
    ) {
        return true;
    }

    return lowerChar(left) === lowerChar(right);
}

function lowerChar(code: number): number {
    return code >= 65 && code <= 90 ? code + 32 : code;
}

const SLASH = 47;
const BACKSLASH = 92;

/** Корни из настройки: относительно каждого корня рабочей области. */
function expand(
    base: readonly string[],
    items: readonly string[]
): string[] {
    const result: string[] = [];

    for (const root of base) {
        for (const item of items) {
            result.push(path.resolve(root, item));
        }
    }

    return result;
}

/**
 * Убирает повторы и вложенные корни.
 *
 * Вложенный корень означал бы второй обход тех же файлов: и лишнюю работу, и
 * повторные записи в каталоге.
 */
export function collapseRoots(values: readonly string[]): string[] {
    const resolved: string[] = [];

    for (const value of values) {
        const item = path.resolve(value);

        if (!resolved.some(other => sameRoot(other, item))) {
            resolved.push(item);
        }
    }

    resolved.sort((left, right) => left.length - right.length);

    const result: string[] = [];

    for (const item of resolved) {
        if (!result.some(other => isInside(path.relative(other, item)))) {
            result.push(item);
        }
    }

    return result;
}

function sameRoot(left: string, right: string): boolean {
    return samePath(left, right);
}

function isInside(relative: string): boolean {
    return relative.length > 0 &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative);
}

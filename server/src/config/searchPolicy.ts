import * as path from "path";

import {
    isExcludedByRslConfig,
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
    const patterns = config.exclude;

    return {
        moduleRoots,
        stubRoots,
        searchRoots,
        isExcluded(fullPath: string): boolean {
            const resolved = path.resolve(fullPath);

            if (hasExcludedSegment(resolved, base, searchRoots)) {
                return true;
            }

            if (patterns.length === 0) {
                return false;
            }

            /*
             * Шаблоны написаны относительно корня рабочей области, а не корня
             * поиска: пользователь пишет `legacy/**`, глядя на дерево проекта,
             * и про moduleRoots при этом не думает.
             */
            for (const root of base) {
                const relative = path.relative(root, resolved);

                if (isInside(relative)) {
                    return isExcludedByRslConfig(relative, patterns);
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
 * Системные исключения по имени каталога.
 *
 * Проверяется каждый сегмент пути ниже корня: адресный поиск умеет начать
 * обход изнутри, и проверки одного имени файла ему мало.
 */
function hasExcludedSegment(
    fullPath: string,
    base: readonly string[],
    searchRoots: readonly string[]
): boolean {
    for (const root of [...searchRoots, ...base]) {
        const relative = path.relative(root, fullPath);

        if (!isInside(relative)) {
            continue;
        }

        const segments = relative.split(/[\\/]/u);

        /* Последний сегмент — имя файла, и системное правило про каталоги. */
        return segments
            .slice(0, -1)
            .some(segment => isExcludedRslDirectory(segment));
    }

    return false;
}

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
    return process.platform === "win32"
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;
}

function isInside(relative: string): boolean {
    return relative.length > 0 &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative);
}

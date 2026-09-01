import * as fs from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

import type { InitializeParams } from "vscode-languageserver/node";

import type { ModuleResolution } from "./indexTypes";
import { normalizeModuleName } from "./moduleNames";

/**
 * Единственное место, где имя модуля превращается в файл проекта.
 *
 * Разрешением занимались двое. Каталог проекта отвечал по составу файлов,
 * собранному обходом, и честно сообщал о неоднозначности. Переход к
 * определению, не дождавшись каталога, обходил диск сам — своим списком
 * исключаемых каталогов, своей нормализацией имени и своим правилом выбора:
 * первый подошедший файл, без всякой неоднозначности.
 *
 * Из-за этого один и тот же `Import` вёл себя по-разному в зависимости от
 * того, успел ли построиться каталог:
 *
 *   до каталога переход молча уводил в первый из одноимённых файлов, после —
 *   показывал оба и давал выбрать;
 *
 *   до каталога находились файлы в dist, build, archive, backup и .history —
 *   обход перехода их не исключал, — а каталог их не видит, поэтому ни Ctrl+T,
 *   ни проверки, ни Organize Imports про эти файлы не знают.
 *
 * Здесь оба пути сведены в один. Ответ всегда даёт каталог: обход диска нужен
 * только чтобы наполнить его до того, как он построится, и найденное сразу в
 * него попадает. Значит и правило неоднозначности, и список исключений, и сам
 * URI — общие по построению, а не по договорённости.
 */

/**
 * Каталоги, в которые проект не заглядывает.
 *
 * Список общий для обхода проекта и для адресного поиска: файл, невидимый
 * одному, обязан быть невидим и другому. Иначе переход ведёт туда, где для
 * всего остального плагина файла нет.
 */
export const RSL_EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
    ".git",
    "node_modules",
    "out",
    "dist",
    "build",
    "archive",
    "backup",
    ".history"
]);

export function isExcludedRslDirectory(name: string): boolean {
    return RSL_EXCLUDED_DIRECTORIES.has(name.toLowerCase());
}

/**
 * Корни проекта, как их прислал редактор.
 *
 * Регистр сохраняется. Прежде корень приводился к нижнему регистру целиком, и
 * все URI проекта строились из него: `D:\Project\Book\fm.mac` превращался в
 * `file:///d:/project/book/fm.mac`. Открыть такой файл Windows позволяет, но
 * с URI документа, который держит редактор, он не совпадает ни байтом — и
 * всякое сравнение URI строкой мимо getUriIdentity даёт ложное «разные
 * файлы». Совпадение регистра для одинаковости корней проверяется ключом, а
 * хранится исходный путь.
 */
export function resolveRslWorkspaceRoots(
    params: Pick<InitializeParams, "workspaceFolders" | "rootUri" | "rootPath">
): string[] {
    const values: string[] = [];

    for (const folder of params.workspaceFolders || []) {
        const root = uriToPath(folder.uri);

        if (root) {
            values.push(root);
        }
    }

    if (values.length === 0 && params.rootUri) {
        const root = uriToPath(params.rootUri);

        if (root) {
            values.push(root);
        }
    }

    if (values.length === 0 && params.rootPath) {
        values.push(params.rootPath);
    }

    return uniqueRoots(values);
}

/** Одинаковые корни отсеиваются по ключу, а в списке остаётся исходный путь. */
export function uniqueRoots(values: readonly string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const value of values) {
        const resolved = path.resolve(value);
        const key = process.platform === "win32"
            ? resolved.toLowerCase()
            : resolved;

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(resolved);
    }

    return result;
}

/**
 * Каталог файлов проекта глазами resolver.
 *
 * Ровно то, что ему нужно от WorkspaceIndex: спросить, добавить и узнать,
 * закончен ли обход.
 */
export interface IRslModuleCatalog {
    resolveWorkspaceFile(moduleName: string): ModuleResolution<string>;
    registerWorkspaceFile(uri: string): void;
    /** Обход проекта закончен: чего нет в каталоге, того нет и на диске. */
    workspaceFilesReady(): boolean;
}

export interface IWorkspaceModuleResolverOptions {
    catalog: IRslModuleCatalog;
    /** Корни проекта; спрашиваются каждый раз: их могут добавить и убрать. */
    roots(): readonly string[];
    log?(message: string): void;
}

export class WorkspaceModuleResolver {
    /**
     * Имена, которых на диске нет.
     *
     * Отрицательный ответ дороже положительного: он стоит полного обхода
     * корней. Сбрасывается вместе с положительным — созданный файл обязан
     * найтись, а удалённый перестать находиться.
     */
    private misses = new Set<string>();
    /** Идущие поиски: два перехода подряд не обходят диск дважды. */
    private running = new Map<string, Promise<ModuleResolution<string>>>();

    constructor(private options: IWorkspaceModuleResolverOptions) {}

    /**
     * Файл проекта по имени модуля.
     *
     * Ответ всегда из каталога: обход диска только добавляет в него найденное.
     * Поэтому URI возвращается ровно тот, что зарегистрирован за файлом
     * проекта, а неоднозначность решается одним правилом на оба пути.
     */
    async resolve(moduleName: string): Promise<ModuleResolution<string>> {
        const target = normalizeModuleName(moduleName);

        if (!target || target === ".mac") {
            return { kind: "missing" };
        }

        const known = this.options.catalog.resolveWorkspaceFile(moduleName);

        if (known.kind !== "missing") {
            return known;
        }

        /*
         * Обход закончен — значит файла нет.
         *
         * Ctrl+Click по неразрешимому имени иначе обходил бы весь проект
         * заново, каждый раз: на проверенном проекте это 5819 файлов ради
         * заведомо отрицательного ответа.
         */
        if (this.options.catalog.workspaceFilesReady()) {
            return { kind: "missing" };
        }

        if (this.misses.has(target)) {
            return { kind: "missing" };
        }

        const started = this.running.get(target);

        if (started) {
            return started;
        }

        const search = this.searchOnDisk(target, moduleName)
            .finally(() => this.running.delete(target));

        this.running.set(target, search);

        return search;
    }

    /**
     * Забыть найденное и ненайденное.
     *
     * Зовётся на создание, удаление и переименование файла: и положительный, и
     * отрицательный ответ после этого недействительны.
     */
    invalidate(): void {
        this.misses.clear();
    }

    private async searchOnDisk(
        target: string,
        moduleName: string
    ): Promise<ModuleResolution<string>> {
        const found: string[] = [];

        for (const root of this.options.roots()) {
            /* Прямое попадание по пути из имени: без обхода вовсе. */
            const direct = path.resolve(root, target.replace(/\//g, path.sep));

            if (isPathInsideRoot(root, direct) && await isFile(direct)) {
                found.push(direct);
            }

            await collectMatches(root, target, root, found);
        }

        if (found.length === 0) {
            this.misses.add(target);

            return { kind: "missing" };
        }

        /*
         * Найденное попадает в каталог, и он же отвечает.
         *
         * Так правило неоднозначности и выбор точного совпадения по `sub/lib.mac`
         * существуют в одном экземпляре, а не в двух похожих. Заодно следующий
         * переход по этому имени обходить диск уже не станет.
         */
        for (const file of found) {
            this.options.catalog.registerWorkspaceFile(
                pathToFileURL(file).toString()
            );
        }

        this.misses.delete(target);

        return this.options.catalog.resolveWorkspaceFile(moduleName);
    }
}

/** Все файлы корня, подходящие под имя модуля. Первый попавшийся не годится. */
async function collectMatches(
    directory: string,
    target: string,
    root: string,
    found: string[]
): Promise<void> {
    let entries: fs.Dirent[];

    try {
        entries = await fs.promises.readdir(directory, {
            withFileTypes: true
        });
    } catch (_error) {
        return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));

    const base = path.posix.basename(target);

    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }

        if (entry.name.toLowerCase() !== base) {
            continue;
        }

        const candidate = path.join(directory, entry.name);

        if (!found.includes(candidate)) {
            found.push(candidate);
        }
    }

    for (const entry of entries) {
        if (!entry.isDirectory() || isExcludedRslDirectory(entry.name)) {
            continue;
        }

        await collectMatches(
            path.join(directory, entry.name),
            target,
            root,
            found
        );
    }
}

function isPathInsideRoot(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);

    return relative.length > 0 &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative);
}

async function isFile(filePath: string): Promise<boolean> {
    try {
        return (await fs.promises.stat(filePath)).isFile();
    } catch (_error) {
        return false;
    }
}

function uriToPath(uri: string): string | undefined {
    try {
        return fileURLToPath(uri);
    } catch (_error) {
        return undefined;
    }
}

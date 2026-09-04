import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

import { isExcludedRslDirectory } from "./workspaceModuleResolver";
import { uriKey, type UriKey } from "../core/identity/uriKey";
import { normalizeModuleName } from "./moduleNames";

/**
 * Библиотеки модулей за пределами проекта.
 *
 * Порядок поиска повторяет USERMACRODIR платформы: сперва проект, затем
 * библиотеки в том порядке, в каком их перечислили. Первое совпадение
 * побеждает, и неоднозначности между библиотеками не бывает по построению —
 * следующая библиотека спрашивается только тогда, когда в предыдущей ничего
 * не нашлось. Это не «ещё одна папка проекта»: базовая поставка перекрывается
 * проектом, а не спорит с ним.
 *
 * Читаются здесь только ИМЕНА файлов, и только когда о модуле спросили. На
 * поставке из 9457 файлов и 222 МБ такой указатель строится за 41-57 мс и
 * занимает около 766 КБ — при том, что ни один исходник не прочитан. Читать
 * содержимое будет тот, кто попросил модуль, и только его: состав библиотеки
 * в каталог проекта, в Ctrl+T и в индекс ссылок не попадает.
 */

export interface IRslLibraryModuleIndexOptions {
    /** Библиотеки по порядку; спрашиваются каждый раз: настройку меняют. */
    paths(): readonly string[];
    /**
     * Временный первый корень: каталог открытого файла вне проекта.
     *
     * У такого файла соседи по каталогу — его ближайшая библиотека, и
     * платформа разрешает имена так же. Корень временный: он живёт, пока
     * открыт тот файл, и в настройках его нет.
     */
    temporaryRoot?(): string | undefined;
    log?(message: string): void;
}

interface IRslLibraryRoot {
    /** Каталог как его написали: он же идёт в путь найденного файла. */
    directory: string;
    /** Имя файла в нижнем регистре -> пути; строится при первом вопросе. */
    byName: Map<string, string[]> | undefined;
    files: number;
}

export class RslLibraryModuleIndex {
    private roots = new Map<string, IRslLibraryRoot>();
    private answers = new Map<string, string | undefined>();
    private stats = { scans: 0, files: 0, hits: 0, misses: 0 };
    /** Файлы, пришедшие из библиотек: см. remember. */
    private fromLibrary = new Set<UriKey>();

    constructor(private options: IRslLibraryModuleIndexOptions) {}

    /**
     * Файл библиотеки по имени модуля; пусто, если ни в одной его нет.
     *
     * Ответ — URI, тот же вид, что и у файла проекта: дальше модуль читают,
     * разбирают и кладут в общий индекс тем же путём, что и любой другой.
     */
    resolve(moduleName: string): string | undefined {
        const target = normalizeModuleName(moduleName);

        if (!target || target === ".mac") {
            return undefined;
        }

        const order = this.searchOrder();

        if (order.length === 0) {
            return undefined;
        }

        /*
         * Ключ включает порядок поиска: он меняется от настройки и от того,
         * какой файл открыт, и ответ на то же имя при другом порядке другой.
         */
        const key = order.join("\u0000") + "\u0000" + target;
        const known = this.answers.get(key);

        if (known !== undefined || this.answers.has(key)) {
            this.stats[known ? "hits" : "misses"]++;

            return known;
        }

        let found: string | undefined;

        for (const directory of order) {
            found = this.findInRoot(directory, target);

            if (found) {
                break;
            }
        }

        const answer = found ? pathToFileURL(found).toString() : undefined;

        if (answer) {
            this.remember(answer);
        }

        this.answers.set(key, answer);
        this.stats[answer ? "hits" : "misses"]++;

        return answer;
    }

    /**
     * Запомнить, что этот файл пришёл из библиотеки.
     *
     * По этому признаку решается, записывать ли модуль в состав проекта:
     * загруженный модуль — не модуль проекта. Признак ставится в момент
     * разрешения имени, а не гадается по пути: путь бывает и общим, когда
     * библиотека лежит внутри проекта.
     */
    remember(uri: string): void {
        this.fromLibrary.add(uriKey(uri));
    }

    /** Пришёл ли этот файл из библиотеки. */
    owns(uri: string): boolean {
        return this.fromLibrary.has(uriKey(uri));
    }

    /**
     * Забыть найденное и ненайденное.
     *
     * Зовётся на смену настройки и на события файлового наблюдателя: и
     * положительный, и отрицательный ответ после этого недействительны.
     *
     * Список библиотечных файлов при этом СОХРАНЯЕТСЯ: их модели уже
     * загружены, и забыть, откуда они взялись, значит начать записывать их
     * в состав проекта при следующей же правке.
     */
    invalidate(): void {
        this.roots.clear();
        this.answers.clear();
    }

    /** Сколько библиотек прочитано и сколько имён в них: см. тесты. */
    get counters(): {
        scans: number;
        files: number;
        hits: number;
        misses: number;
        scannedRoots: number;
    } {
        return {
            ...this.stats,
            scannedRoots: [...this.roots.values()]
                .filter(root => root.byName !== undefined).length
        };
    }

    /** Каталог открытого вне проекта файла идёт первым. */
    private searchOrder(): readonly string[] {
        const temporary = this.options.temporaryRoot?.();
        const configured = this.options.paths();

        if (!temporary) {
            return configured;
        }

        return [
            temporary,
            ...configured.filter(item =>
                path.resolve(item) !== path.resolve(temporary))
        ];
    }

    private findInRoot(directory: string, target: string): string | undefined {
        const root = this.rootOf(directory);

        if (!root.byName) {
            return undefined;
        }

        /*
         * Написанный путь сильнее имени: `Import sub/lib` обязан привести
         * именно в sub, даже когда lib.mac лежит и в корне библиотеки.
         */
        const direct = path.resolve(
            directory,
            target.replace(/\//gu, path.sep)
        );

        if (isFile(direct)) {
            return direct;
        }

        const candidates = root.byName.get(path.posix.basename(target));

        if (!candidates || candidates.length === 0) {
            return undefined;
        }

        if (candidates.length === 1 || !target.includes("/")) {
            return candidates[0];
        }

        /*
         * Одноимённые внутри одной библиотеки: выбирает написанный хвост
         * пути. Не выбрал — берётся первый по порядку обхода, а не
         * «неоднозначно»: между библиотеками и внутри них правило одно —
         * первое совпадение побеждает.
         */
        const suffix = "/" + target.toLowerCase();
        const exact = candidates.find(item =>
            item.replace(/\\/gu, "/").toLowerCase().endsWith(suffix));

        return exact || candidates[0];
    }

    private rootOf(directory: string): IRslLibraryRoot {
        const key = path.resolve(directory).toLowerCase();
        let root = this.roots.get(key);

        if (!root) {
            root = { directory, byName: undefined, files: 0 };
            this.roots.set(key, root);
        }

        if (root.byName) {
            return root;
        }

        const byName = new Map<string, string[]>();
        const started = Date.now();

        collectNames(directory, byName);

        root.byName = byName;
        root.files = [...byName.values()]
            .reduce((total, item) => total + item.length, 0);
        this.stats.scans++;
        this.stats.files += root.files;

        this.options.log?.(
            "Библиотека " + directory + ": имён " + root.files + ", " +
            (Date.now() - started) + " мс"
        );

        return root;
    }
}

/**
 * Имена файлов библиотеки; содержимое не читается.
 *
 * Обход синхронный нарочно: разрешение имени спрашивают отовсюду — Import,
 * переход, Hover, подсказка, дерево зависимостей, — и все эти вызовы
 * синхронные. Цена одна на библиотеку за сессию, и это чтение оглавлений, а
 * не файлов.
 */
function collectNames(
    directory: string,
    byName: Map<string, string[]>
): void {
    let entries: fs.Dirent[];

    try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (_error) {
        return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
        if (entry.isFile()) {
            if (!/\.mac$/iu.test(entry.name)) {
                continue;
            }

            const key = entry.name.toLowerCase();
            const list = byName.get(key);
            const full = path.join(directory, entry.name);

            if (list) {
                list.push(full);
            } else {
                byName.set(key, [full]);
            }
        } else if (
            entry.isDirectory() &&
            !isExcludedRslDirectory(entry.name)
        ) {
            collectNames(path.join(directory, entry.name), byName);
        }
    }
}

function isFile(fullPath: string): boolean {
    try {
        return fs.statSync(fullPath).isFile();
    } catch (_error) {
        return false;
    }
}

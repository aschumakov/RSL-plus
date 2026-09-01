import type { IIndexedModule, ModuleResolution } from "./indexTypes";

/**
 * Какие модули видны из документа через цепочку Import.
 *
 * Уровнем ниже уже всё общее: слово Import опознаёт importDirective, написание
 * имени разбирает moduleName, имя в файл проекта превращает
 * WorkspaceModuleResolver. А вот обход самой цепочки — документ, его Import,
 * их Import и так далее — был написан заново в пяти местах: в индексе проекта,
 * в resolver, в Completion, в проверке полноты контекста и в загрузчике
 * модулей.
 *
 * Назначение у них разное, но основа одна, и разойтись она может незаметно:
 * Completion увидит одну цепочку, проверки другую, переход третью. Прошлый
 * разбор Import ровно так и разошёлся — пять извлекателей понимали путь
 * по-разному, и нашлось это только общим корпусом.
 *
 * Поэтому здесь один обход и один ответ. Классификация модулей — прикладной,
 * встроенный, непрозрачный — сюда не входит: это решает тот, кто спрашивает.
 */

/** То немногое, что обходу нужно от индекса проекта. */
export interface IRslImportClosureIndex {
    resolveWorkspaceFile(moduleName: string): ModuleResolution<string>;
    getModule(uri: string): IIndexedModule | undefined;
}

export interface IRslImportClosure {
    /** Разрешённые и уже загруженные модули, в порядке обхода. */
    modules: IIndexedModule[];
    /** Имена, не разрешившиеся ни в один файл проекта. */
    missing: string[];
    /** Имена, разрешившиеся сразу в несколько файлов. */
    ambiguous: string[];
    /** Файл в проекте есть, но модуль ещё не прочитан. */
    unloaded: string[];
}

export interface IRslImportClosureOptions {
    /**
     * Имена вместо Import разобранного модуля.
     *
     * Нужно быстрому пути Completion: там текущий текст новее полной модели, и
     * Import надо брать из него, а не из отставшего разбора.
     */
    seedImports?: readonly string[];
    /**
     * Остановиться, не заходя в Import найденных модулей.
     *
     * Для потребителей, которым нужен только первый уровень.
     */
    directOnly?: boolean;
    /** Прервать обход: он бывает длинным на больших цепочках. */
    isCancelled?(): boolean;
    /**
     * Имя обслуживает вызывающий: обход его не разрешает и внутрь не заходит.
     *
     * Так классификация остаётся снаружи. Прикладные модули RS-Bank знает
     * каталог платформы, и он имеет преимущество перед файлом проекта с тем же
     * именем; складывать это знание сюда значит тащить платформу в обход.
     */
    skipName?(name: string): boolean;
}

/**
 * Транзитивное Import-замыкание документа.
 *
 * Имя разрешается каталогом проекта, а не поиском среди загруженных модулей:
 * так «файла нет» и «файл есть, но ещё не прочитан» — разные ответы, а
 * неоднозначность видна отдельно. Потребителям это важно: проверка, делающая
 * вывод из отсутствия символа, обязана знать, полон ли контекст.
 */
export function collectRslImportClosure(
    index: IRslImportClosureIndex,
    uri: string,
    options: IRslImportClosureOptions = {}
): IRslImportClosure {
    const modules: IIndexedModule[] = [];
    const missing: string[] = [];
    const ambiguous: string[] = [];
    const unloaded: string[] = [];
    const seenNames = new Set<string>();
    const seenUris = new Set<string>([uri]);
    const isCancelled = options.isCancelled;

    const root = options.seedImports
        ? options.seedImports
        : index.getModule(uri)?.imports || [];
    /* Очередь списков имён: цикл Import сам себя не зациклит — см. seenUris. */
    const queue: (readonly string[])[] = [root];

    for (let at = 0; at < queue.length; at++) {
        if (isCancelled?.()) {
            break;
        }

        for (const name of queue[at]) {
            const key = name.toLowerCase();

            if (seenNames.has(key)) {
                continue;
            }

            seenNames.add(key);

            if (options.skipName?.(name)) {
                continue;
            }

            const resolution = index.resolveWorkspaceFile(name);

            if (resolution.kind === "ambiguous") {
                ambiguous.push(name);
                continue;
            }

            if (resolution.kind !== "resolved") {
                missing.push(name);
                continue;
            }

            if (seenUris.has(resolution.value)) {
                continue;
            }

            const imported = index.getModule(resolution.value);

            if (!imported) {
                unloaded.push(name);
                continue;
            }

            seenUris.add(imported.uri);
            modules.push(imported);

            if (!options.directOnly) {
                queue.push(imported.imports);
            }
        }
    }

    return { modules, missing, ambiguous, unloaded };
}

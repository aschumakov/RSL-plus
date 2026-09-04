import {
    collectRslImportClosure
} from "../indexing/importClosure";
import {
    buildImportContextState,
    type IRslImportContextState,
    type RslImportContextCompleteness
} from "./importContextState";
import type { PlatformModuleCatalog } from "../builtins/platformModuleCatalog";
import { normalizeIdentifier } from "../lexer";
import type { IIndexedModule } from "../workspaceIndex";
import type { WorkspaceIndex } from "../workspaceIndex";

/**
 * Import-контекст документа одним ответом.
 *
 * Обход цепочки уже общий (collectRslImportClosure), а вот ВЫВОДЫ из него
 * каждый делал свои: подсказка смотрела на состав, проверки на полноту,
 * дерево зависимостей на классификацию имён. Расходились они незаметно —
 * одному имя видно, другому нет.
 *
 * Здесь всё это собрано в один ответ, и главное в нём — полнота отдельно для
 * КАЖДОГО прямого Import. Общая полнота документа для проверки «модуль не
 * используется» не годится:
 *
 *   main -> A -> B -> C
 *
 * Пока C дочитывается, объявить `Import A` неиспользуемым нельзя: имя,
 * которым A оправдан, может лежать как раз в C. При этом непрозрачный
 * СОСЕДНИЙ Import выключать проверку целиком не должен — у него своя
 * полнота, и к A она отношения не имеет.
 */

export type RslDirectImportKind =
    | "workspace"
    | "platform"
    | "missing"
    | "ambiguous";

export interface IRslDirectImport {
    /** Имя, как оно написано в директиве. */
    name: string;
    kind: RslDirectImportKind;
    /** Файл модуля; пусто у прикладного, ненайденного и неоднозначного. */
    uri?: string;
    /**
     * Файлы, до которых можно дойти через этот Import, включая его самого.
     *
     * Пусто, пока модуль не прочитан: закрытие считается по загруженным
     * моделям, и его неполнота видна по completeness, а не по размеру.
     */
    closureUris: ReadonlySet<string>;
    /** Полнота ЭТОГО Import: см. пример в описании модуля. */
    completeness: RslImportContextCompleteness;
}

export interface IRslResolvedImportContext {
    uri: string;
    directImports: readonly IRslDirectImport[];
    /** Модули проекта и библиотек, видимые из документа, включая транзитивные. */
    visibleWorkspaceModules: readonly IIndexedModule[];
    /** Прикладные модули, чьи имена видны отсюда. */
    visiblePlatformModules: readonly string[];
    /** Полнота контекста целиком: слабейшее звено среди всех источников. */
    completeness: RslImportContextCompleteness;
    /** Подробности неполноты: неоднозначные, непрозрачные, недочитанные. */
    state: IRslImportContextState;
}

export interface IRslResolvedImportContextOptions {
    platformModules?: PlatformModuleCatalog;
    /**
     * Import текущего текста вместо разобранных.
     *
     * Нужен быстрому пути: там модель отстаёт на одну правку, а только что
     * набранный Import обязан действовать сразу.
     */
    seedImports?: readonly string[];
}

/**
 * Разобранный Import-контекст документа.
 *
 * Считается по требованию и ничего не загружает: всё берётся у индекса в
 * момент вопроса. Полнота каждого прямого Import считается своим обходом —
 * их столько же, сколько директив, и каждый идёт по уже прочитанным моделям.
 */
export function resolveRslImportContext(
    index: WorkspaceIndex,
    uri: string,
    options: IRslResolvedImportContextOptions = {}
): IRslResolvedImportContext {
    const platform = options.platformModules;
    const written = options.seedImports || index.getModule(uri)?.imports || [];
    const visiblePlatform = new Set<string>();
    const seenNames = new Set<string>();
    const directImports: IRslDirectImport[] = [];

    for (const name of written) {
        const key = normalizeIdentifier(name);

        if (seenNames.has(key)) {
            continue;
        }

        seenNames.add(key);
        directImports.push(describeDirectImport(
            index,
            name,
            platform,
            visiblePlatform
        ));
    }

    /*
     * Видимые модули — тем же обходом, что и у всех: прикладное имя внутрь
     * себя не пускает, его состав знает каталог.
     */
    const closure = collectRslImportClosure(index, uri, {
        seedImports: options.seedImports,
        skipName: importName => {
            if (!platform?.knowsModule(importName)) {
                return false;
            }

            addPlatformModule(platform, importName, visiblePlatform);

            return true;
        }
    });
    const state = buildImportContextState(index, uri, platform);

    return {
        uri,
        directImports,
        visibleWorkspaceModules: closure.modules,
        visiblePlatformModules: Object.freeze([...visiblePlatform]),
        completeness: state.completeness,
        state
    };
}

/** Прямой Import: куда он ведёт и всё ли за ним видно. */
function describeDirectImport(
    index: WorkspaceIndex,
    name: string,
    platform: PlatformModuleCatalog | undefined,
    visiblePlatform: Set<string>
): IRslDirectImport {
    if (platform?.knowsModule(name)) {
        addPlatformModule(platform, name, visiblePlatform);

        /*
         * Прикладной модуль: состав знает каталог, и полнота у него своя —
         * пока он читается, судить о нём рано.
         */
        return {
            name,
            kind: "platform",
            closureUris: EMPTY,
            completeness: platform.moduleState(name) === "loading"
                ? "loading"
                : "complete"
        };
    }

    /*
     * Имя превращается в файл общим resolver'ом: он один знает порядок
     * «проект, потом библиотеки» и отвечает про неоднозначность.
     */
    const resolution = index.resolveWorkspaceFile(name);

    if (resolution.kind === "ambiguous") {
        return {
            name,
            kind: "ambiguous",
            closureUris: EMPTY,
            completeness: "ambiguous"
        };
    }

    /*
     * Каталог молчит — спрашиваем загруженные модели, но ТОЛЬКО после него.
     *
     * Порядок остаётся за resolver: пока он отвечает, слово за ним. Откат
     * нужен там, где каталог ещё не построен или файл в него не попал: так
     * работает разбор ещё не сохранённого файла и заглушки. Без отката
     * проверка молчала бы обо всём, что прочитано, но не зарегистрировано.
     */
    const fallback = resolution.kind === "resolved"
        ? undefined
        : index.importedModule(name);

    if (resolution.kind !== "resolved" && !fallback) {
        /*
         * Файла нет: так выглядит Import модуля RSM, DLM или любого имени,
         * которое компилятор берёт из своего окружения. Источник непрозрачен.
         */
        return {
            name,
            kind: "missing",
            closureUris: EMPTY,
            completeness: "opaque"
        };
    }

    const uri = resolution.kind === "resolved"
        ? resolution.value
        : (fallback as IIndexedModule).uri;
    const own = index.getModule(uri);

    if (!own) {
        /* Файл есть, но ещё не прочитан: полнота придёт сама. */
        return {
            name,
            kind: "workspace",
            uri,
            closureUris: EMPTY,
            completeness: "loading"
        };
    }

    const closureUris = new Set<string>([uri]);
    let completeness: RslImportContextCompleteness = "complete";
    const weaken = (next: RslImportContextCompleteness): void => {
        if (rank(next) > rank(completeness)) {
            completeness = next;
        }
    };

    const closure = collectRslImportClosure(index, uri, {
        skipName: importName => {
            if (!platform?.knowsModule(importName)) {
                return false;
            }

            if (platform.moduleState(importName) === "loading") {
                weaken("loading");
            }

            return true;
        }
    });

    closure.modules.forEach(item => closureUris.add(item.uri));
    closure.unloaded.forEach(() => weaken("loading"));
    closure.ambiguous.forEach(() => weaken("ambiguous"));
    closure.missing.forEach(() => weaken("opaque"));

    return { name, kind: "workspace", uri, closureUris, completeness };
}

/** Прикладной модуль и то, что он открывает собой. */
function addPlatformModule(
    platform: PlatformModuleCatalog,
    moduleName: string,
    into: Set<string>
): void {
    if (into.has(moduleName)) {
        return;
    }

    into.add(moduleName);

    for (const next of platform.importsOfModule(moduleName)) {
        if (platform.knowsModule(next)) {
            addPlatformModule(platform, next, into);
        }
    }
}

const EMPTY: ReadonlySet<string> = Object.freeze(new Set<string>());

/*
 * Порядок тот же, что у полноты документа: «ещё грузится» полезнее
 * «неоднозначно», а прозрачное отсутствие файла — самый слабый сигнал.
 */
function rank(value: RslImportContextCompleteness): number {
    switch (value) {
        case "complete":
            return 0;
        case "loading":
            return 1;
        case "ambiguous":
            return 2;
        default:
            return 3;
    }
}

/**
 * Полон ли контекст ЭТОГО Import.
 *
 * Единственный предикат для проверок, делающих вывод из отсутствия
 * использования. Сосед с непрозрачным Import на этот ответ не влияет.
 */
export function isRslDirectImportComplete(item: IRslDirectImport): boolean {
    return item.completeness === "complete";
}

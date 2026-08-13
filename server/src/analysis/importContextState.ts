import type { PlatformModuleCatalog } from "../builtins/platformModuleCatalog";
import { normalizeIdentifier } from "../lexer";
import type { WorkspaceIndex } from "../workspaceIndex";

/**
 * Полнота Import-контекста документа.
 *
 * Проверки, которые делают вывод из ОТСУТСТВИЯ символа, обязаны знать, всё ли
 * они видели. Неизвестный Import — не отсутствующий: компилятор RSL разрешает
 * имена ещё и из RSM, DLM, встроенных модулей и собственного контекста сборки,
 * которых в workspace просто нет.
 *
 *   complete  — все транзитивные .mac найдены и проиндексированы;
 *   loading   — каталог файлов или Import-замыкание ещё строится;
 *   ambiguous — Import разрешается в несколько файлов;
 *   opaque    — символы могут поступать извне: RSM, DLM, встроенный модуль,
 *               непрочитанный прикладной модуль, внешний контекст компилятора.
 */
export type RslImportContextCompleteness =
    | "loading"
    | "complete"
    | "ambiguous"
    | "opaque";

export interface IRslImportContextState {
    completeness: RslImportContextCompleteness;
    /** Import-имена, которым соответствует несколько файлов проекта. */
    ambiguous: readonly string[];
    /**
     * Import-имена, которых среди .mac проекта нет.
     *
     * Это НЕ ошибка: так выглядит Import модуля RSM или DLM, встроенного модуля
     * платформы и любого имени, которое компилятор берёт из своего окружения.
     */
    opaque: readonly string[];
    /** Файл найден, но ещё не проиндексирован. */
    pending: readonly string[];
    /** Прикладной модуль известен каталогу, но его состав ещё не прочитан. */
    pendingPlatformModules: readonly string[];
}

const COMPLETE: IRslImportContextState = Object.freeze({
    completeness: "complete" as const,
    ambiguous: Object.freeze([]),
    opaque: Object.freeze([]),
    pending: Object.freeze([]),
    pendingPlatformModules: Object.freeze([])
});

/** Готовое состояние «всё видно»: для сравнения и для тестов. */
export function completeImportContextState(): IRslImportContextState {
    return COMPLETE;
}

/**
 * Видно ли всё, из чего файл может брать символы.
 *
 * Единственный предикат для всех проверок, которые делают вывод из ОТСУТСТВИЯ
 * символа. По построению `complete` возвращается только когда все четыре списка
 * пусты (см. buildImportContextState), поэтому проверять их ещё раз на месте
 * вызова незачем — а два разных условия для одного вопроса разошлись бы.
 */
export function isFullyKnownImportContext(
    state: IRslImportContextState
): boolean {
    return state.completeness === "complete";
}

export function buildImportContextState(
    index: WorkspaceIndex,
    uri: string,
    platformModules?: PlatformModuleCatalog
): IRslImportContextState {
    const ambiguous = new Set<string>();
    const opaque = new Set<string>();
    const pending = new Set<string>();
    const pendingPlatform = new Set<string>();
    /*
     * Каталог файлов проекта ещё не построен: судить об отсутствии файла по
     * пустому каталогу нельзя — там пока нет ни одного.
     */
    let loading = !index.workspaceFilesReady;

    const root = index.getModule(uri);

    if (!root) {
        loading = true;
    }

    const visitedFiles = new Set<string>([uri]);
    const visitedNames = new Set<string>();
    const queue: string[][] = [root ? root.imports.slice() : []];

    for (let position = 0; position < queue.length; position++) {
        for (const importName of queue[position]) {
            const key = normalizeIdentifier(importName);

            if (visitedNames.has(key)) {
                continue;
            }
            visitedNames.add(key);

            if (platformModules?.knowsModule(importName)) {
                collectPlatformModule(
                    platformModules,
                    importName,
                    pendingPlatform
                );
                continue;
            }

            /*
             * Каталог прикладных модулей ещё не прочитан: имя МОГЛО оказаться
             * прикладным модулем, и считать его отсутствующим рано.
             */
            if (platformModules && !platformModules.ready) {
                loading = true;
            }

            const resolution = index.resolveWorkspaceFile(importName);

            if (resolution.kind === "ambiguous") {
                ambiguous.add(importName);
                continue;
            }

            if (resolution.kind === "missing") {
                opaque.add(importName);
                continue;
            }

            if (visitedFiles.has(resolution.value)) {
                continue;
            }
            visitedFiles.add(resolution.value);

            const imported = index.getModule(resolution.value);

            if (!imported) {
                pending.add(importName);
                continue;
            }

            queue.push(imported.imports.slice());
        }
    }

    if (
        !loading &&
        ambiguous.size === 0 &&
        opaque.size === 0 &&
        pending.size === 0 &&
        pendingPlatform.size === 0
    ) {
        return COMPLETE;
    }

    return Object.freeze({
        completeness: chooseCompleteness(
            loading || pending.size > 0 || pendingPlatform.size > 0,
            ambiguous.size > 0,
            opaque.size > 0
        ),
        ambiguous: Object.freeze(Array.from(ambiguous).sort()),
        opaque: Object.freeze(Array.from(opaque).sort()),
        pending: Object.freeze(Array.from(pending).sort()),
        pendingPlatformModules: Object.freeze(
            Array.from(pendingPlatform).sort()
        )
    });
}

/**
 * Прикладной модуль и его объявленные зависимости.
 *
 * Непрочитанный состав делает контекст неполным: класс модуля может наследовать
 * класс зависимости, и без неё членов у него не будет.
 */
function collectPlatformModule(
    platformModules: PlatformModuleCatalog,
    moduleName: string,
    pendingPlatform: Set<string>
): void {
    const queue = [normalizeIdentifier(moduleName)];
    const visited = new Set<string>();

    for (let position = 0; position < queue.length; position++) {
        const key = queue[position];

        if (visited.has(key)) {
            continue;
        }
        visited.add(key);

        if (!platformModules.isModuleLoaded(key)) {
            pendingPlatform.add(key);
        }

        queue.push(...platformModules.dependenciesOf(key));
    }
}

/*
 * Порядок важен: «ещё грузится» полезнее для вызывающего, чем «неоднозначно»,
 * потому что через мгновение может стать complete. Прозрачное отсутствие файла
 * — самый слабый сигнал, он никогда не изменится сам.
 */
function chooseCompleteness(
    isLoading: boolean,
    isAmbiguous: boolean,
    isOpaque: boolean
): RslImportContextCompleteness {
    if (isLoading) {
        return "loading";
    }
    if (isAmbiguous) {
        return "ambiguous";
    }
    return isOpaque ? "opaque" : "complete";
}

import {
    collectRslImportClosure
} from "../indexing/importClosure";
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

    /*
     * Обход цепочки Import общий: см. collectRslImportClosure. Здесь остаётся
     * только классификация имён — прикладной модуль, непрозрачный источник,
     * незагруженный файл, — а она к обходу отношения не имеет.
     */
    const closure = collectRslImportClosure(index, uri, {
        skipName: importName => {
            if (platformModules?.knowsModule(importName)) {
                collectPlatformModule(
                    platformModules,
                    importName,
                    pendingPlatform,
                    opaque
                );

                return true;
            }

            /*
             * Каталог прикладных модулей ещё не прочитан: имя МОГЛО оказаться
             * прикладным модулем, и считать его отсутствующим рано.
             *
             * А если индекс прочитать НЕ УДАЛОСЬ, ждать нечего: состав каталога
             * так и останется неизвестным, и это непрозрачный источник символов,
             * а не незавершённая загрузка. Иначе контекст оставался бы
             * «загружающимся» навсегда, молча выключая проверки, которым нужен
             * полный контекст.
             */
            if (platformModules?.indexState === "loading") {
                loading = true;
            } else if (platformModules?.indexState === "failed") {
                opaque.add(importName);
            }

            return false;
        }
    });

    closure.ambiguous.forEach(name => ambiguous.add(name));
    /* Имя не разрешилось ни в один файл проекта: источник непрозрачен. */
    closure.missing.forEach(name => opaque.add(name));
    /* Файл есть, но ещё не прочитан: контекст не полон, но и не потерян. */
    closure.unloaded.forEach(name => pending.add(name));

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
 * класс зависимости, и без неё членов у него не будет. Но «ещё не прочитан» и
 * «прочитать не удалось» — разные вещи: первое пройдёт само, второе нет, и
 * второе делает источник символов непрозрачным.
 */
function collectPlatformModule(
    platformModules: PlatformModuleCatalog,
    moduleName: string,
    pendingPlatform: Set<string>,
    opaque: Set<string>
): void {
    const queue = [normalizeIdentifier(moduleName)];
    const visited = new Set<string>();

    for (let position = 0; position < queue.length; position++) {
        const key = queue[position];

        if (visited.has(key)) {
            continue;
        }
        visited.add(key);

        const state = platformModules.moduleState(key);

        if (state === "loading") {
            pendingPlatform.add(key);
        } else if (state === "failed" || state === "missing") {
            opaque.add(key);
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

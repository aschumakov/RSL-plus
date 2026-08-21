import { normalizeIdentifier } from "../lexer";
import type {
    IIndexedModule,
    IIndexedSymbol,
    WorkspaceIndex
} from "../workspaceIndex";

/**
 * Символы, видимые через Import ТЕКУЩЕГО текста.
 *
 * Правило одно на всех — Completion, переход, Hover, подсказка параметров, — и
 * живёт здесь именно поэтому. Раньше быстрые ответы спрашивали
 * `index.findImportedSymbols`, а тот строит замыкание по Import последней
 * РАЗОБРАННОЙ модели: она отстаёт на правку. Из-за этого только что добавленный
 * `Import new` не действовал, а только что удалённый `Import old` продолжал
 * уводить в чужой файл.
 *
 * Замыкание транзитивное: в RSL подключение даёт доступ ко всей цепочке Import
 * подключённого модуля.
 */
export function resolveRslImportClosure(
    index: WorkspaceIndex,
    uri: string,
    imports: readonly string[]
): IIndexedModule[] {
    if (!index.areImportsEnabled) {
        return [];
    }

    const result: IIndexedModule[] = [];
    const seen = new Set<string>([uri]);
    const queue: string[] = [];

    for (const name of imports) {
        const resolved = resolvedUri(index, name);

        if (resolved) {
            queue.push(resolved);
        }
    }

    /* Курсор, а не shift: сдвиг массива — это копия всей очереди. */
    for (let at = 0; at < queue.length; at++) {
        const next = queue[at];

        if (seen.has(next)) {
            continue;
        }

        seen.add(next);
        const module = index.getModule(next);

        if (!module) {
            continue;
        }

        result.push(module);

        for (const name of module.imports) {
            const transitive = resolvedUri(index, name);

            if (transitive && !seen.has(transitive)) {
                queue.push(transitive);
            }
        }
    }

    return result;
}

/**
 * Публичные символы имени среди подключённых модулей.
 *
 * Пусто — имени там нет; больше одного — неоднозначность, и выбирать наугад
 * нельзя: какой символ возьмёт компилятор, без полной модели неизвестно.
 */
export function findRslImportedSymbols(
    index: WorkspaceIndex,
    uri: string,
    imports: readonly string[],
    name: string
): IIndexedSymbol[] {
    const wanted = normalizeIdentifier(name);

    if (!wanted || !index.areImportsEnabled) {
        return [];
    }

    /*
     * Обычный случай: Import текста и Import разобранной модели совпадают
     * — правили не заголовок файла. Тогда отвечает готовый кэш индекса:
     * замыкание уже построено и разложено по именам. Строить своё на
     * каждый Hover и каждую подсказку значит платить за то же самое
     * заново.
     */
    if (importsMatchModule(index, uri, imports)) {
        return index.findImportedSymbols(uri, name);
    }

    /*
     * Import только что правили. Кандидаты берутся по имени из общего
     * указателя проекта и отсеиваются по замыканию текущего текста —
     * вместо перебора всех объявлений всех подключённых модулей.
     */
    const visible = new Set(
        resolveRslImportClosure(index, uri, imports)
            .map(module => module.uri)
    );

    if (visible.size === 0) {
        return [];
    }

    return index.findSymbols(name).filter(item =>
        !item.symbol.isPrivate && visible.has(item.uri)
    );
}

/** Совпадает ли список Import текста с тем, что у разобранной модели. */
function importsMatchModule(
    index: WorkspaceIndex,
    uri: string,
    imports: readonly string[]
): boolean {
    const module = index.getModule(uri);

    if (!module || module.imports.length !== imports.length) {
        return false;
    }

    for (let at = 0; at < imports.length; at++) {
        if (
            normalizeIdentifier(module.imports[at]) !==
                normalizeIdentifier(imports[at])
        ) {
            return false;
        }
    }

    return true;
}

/** Единственный символ этого имени; иначе undefined. */
export function findRslSingleImportedSymbol(
    index: WorkspaceIndex,
    uri: string,
    imports: readonly string[],
    name: string
): IIndexedSymbol | undefined {
    const found = findRslImportedSymbols(index, uri, imports, name);

    return found.length === 1 ? found[0] : undefined;
}

function resolvedUri(
    index: WorkspaceIndex,
    name: string
): string | undefined {
    const resolution = index.resolveWorkspaceFile(name);

    return resolution.kind === "resolved" ? resolution.value : undefined;
}

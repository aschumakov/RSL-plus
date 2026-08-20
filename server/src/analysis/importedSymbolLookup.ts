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

    while (queue.length > 0) {
        const next = queue.shift()!;

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

    if (!wanted) {
        return [];
    }

    const result: IIndexedSymbol[] = [];

    for (const module of resolveRslImportClosure(index, uri, imports)) {
        for (const symbol of module.symbolTree.children) {
            if (
                symbol.isPrivate ||
                normalizeIdentifier(symbol.name) !== wanted
            ) {
                continue;
            }

            result.push({
                uri: module.uri,
                symbolId: symbol.id,
                symbol
            });
        }
    }

    return result;
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

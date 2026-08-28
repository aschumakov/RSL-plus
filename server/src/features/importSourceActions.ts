import { CodeActionKind, type WorkspaceEdit } from "vscode-languageserver";

import {
    markUsedImport,
    prepareUnusedImports
} from "../diagnostics/importChecks";
import { KEYWORDS } from "../language/rslLanguageReference";
import { normalizeIdentifier } from "../lexer";
import { RslScopeResolver } from "../scopeResolver";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";
import { collectRslImports, importKey } from "./importModel";
import { planRslImports } from "./organizeImports";
import {
    singleFileEdit,
    type IRslRefactor,
    type IRslRefactorContext
} from "./refactorRegistry";

/**
 * Четыре действия над секцией Import.
 *
 * Разделены намеренно. «Удалить лишние» — единственное из четырёх, что может
 * убрать нужное: признак «не используется» держится на том, что все модули
 * файла разобраны. «Добавить недостающие» ничего не ломает, но меняет
 * зависимости файла. Сортировка не меняет смысла вовсе. Складывать всё это в
 * одну кнопку значит заставлять соглашаться на удаление ради сортировки.
 *
 * Полное действие носит вид source.organizeImports: его вызывает и команда
 * редактора, и codeActionsOnSave. Остальные три лежат под своими видами, чтобы
 * эта команда не превращалась в выбор из четырёх.
 */

export const RSL_IMPORT_ACTION_KINDS = {
    sort: "source.rsl.imports.sort",
    removeUnused: "source.rsl.imports.removeUnused",
    addMissing: "source.rsl.imports.addMissing",
    all: CodeActionKind.SourceOrganizeImports
};

/* Ключевое слово Import-ом не подключается: см. справочник языка. */
const NON_IMPORT_IDENTIFIERS = new Set(KEYWORDS);

/**
 * Разобраны ли все модули, подключённые файлом.
 *
 * Пока хоть один Import не разрешился, удалять нельзя: неизвестный модуль мог
 * объявлять как раз то имя, по которому соседний импорт кажется лишним.
 */
export function rslImportContextIsComplete(
    module: IIndexedModule,
    index: WorkspaceIndex
): boolean {
    if (!index.areImportsEnabled) {
        return false;
    }

    const declarations = collectRslImports(module);

    if (declarations.length === 0) {
        return false;
    }

    return declarations.every(declaration =>
        declaration.items.every(item => !!index.findModuleByName(item.name)));
}

/**
 * Модули, чьи имена в файле нигде не встречаются.
 *
 * Считается тем же способом, что и предупреждение unused-import, чтобы
 * действие и Problems не расходились: разница между «подчёркнуто» и «удалено»
 * была бы худшим сортом неожиданности.
 */
export function findUnusedRslImports(
    module: IIndexedModule,
    index: WorkspaceIndex
): Set<string> {
    const context = prepareUnusedImports(module, index);
    const resolver = new RslScopeResolver(index);

    for (const token of module.lex.tokens) {
        if (
            token.kind !== "identifier" ||
            !context.allPublicNames.has(normalizeIdentifier(token.value)) ||
            context.references.some(reference =>
                reference.start <= token.start && token.end <= reference.end)
        ) {
            continue;
        }

        markUsedImport(module, index, resolver, token, context);
    }

    const unused = new Set<string>();

    for (const info of context.importInfos) {
        /* Модуль без публичных объявлений подключают ради побочного действия. */
        if (info.publicNames.size === 0) {
            continue;
        }

        const used = [...info.closureUris].some(uri =>
            context.usedImportedUris.has(uri));

        if (!used) {
            unused.add(importKey(info.reference.moduleName));
        }
    }

    return unused;
}

/**
 * Имена, которые файл использует, но не подключает.
 *
 * В счёт идут только однозначные: имя, объявленное в двух модулях, подключать
 * за пользователя нельзя — выбор между ними и есть решение, которое он должен
 * принять сам.
 */
export function findMissingRslImports(
    module: IIndexedModule,
    index: WorkspaceIndex,
    isCancelled: () => boolean
): string[] {
    if (!index.areImportsEnabled) {
        return [];
    }

    const resolver = new RslScopeResolver(index);
    const known = new Set(
        index.getImportedModules(module.uri).map(item => item.uri)
    );

    known.add(module.uri);

    const seen = new Set<string>();
    const found = new Map<string, string>();

    for (const token of module.lex.tokens) {
        if (isCancelled()) {
            return [];
        }

        if (token.kind !== "identifier") {
            continue;
        }

        const name = normalizeIdentifier(token.value);

        if (
            seen.has(name) ||
            NON_IMPORT_IDENTIFIERS.has(name) ||
            resolver.resolveAt(module.uri, module.symbolTree, token.start)
        ) {
            continue;
        }

        seen.add(name);

        const candidates = index.catalog
            .modulesExporting(token.value)
            .filter(uri => !known.has(uri));

        if (candidates.length !== 1) {
            continue;
        }

        found.set(index.getImportNameForUri(candidates[0]), name);
    }

    return [...found.keys()]
        .map(item => matchImportSpelling(module, item))
        .sort();
}

/**
 * Разделитель пути — такой же, как у остальных Import файла.
 *
 * Вставить `a/b` в файл, где всё написано через обратный слеш, значит оставить
 * после себя две разные записи одного и того же.
 */
function matchImportSpelling(module: IIndexedModule, name: string): string {
    const backslash = module.imports.some(item => item.includes("\\"));
    const slash = module.imports.some(item => item.includes("/"));

    return backslash || (!slash && name.includes("/"))
        ? name.replace(/\//gu, "\\")
        : name;
}

/* ── Сами действия ──────────────────────────────────────────────────────── */

function hasImports(context: IRslRefactorContext): boolean {
    return collectRslImports(context.module).length > 0;
}

function edit(
    context: IRslRefactorContext,
    plan: Parameters<typeof planRslImports>[1]
): WorkspaceEdit | undefined {
    const edits = planRslImports(context.module, plan);

    return edits.length > 0 ? singleFileEdit(context.module, edits) : undefined;
}

export const sortImportsRefactor: IRslRefactor = {
    id: "imports.sort",
    kind: RSL_IMPORT_ACTION_KINDS.sort,
    applies: context => hasImports(context)
        ? [{ title: "RSL: отсортировать Import и убрать повторы" }]
        : [],
    resolve: context => edit(context, { sort: true })
};

export const removeUnusedImportsRefactor: IRslRefactor = {
    id: "imports.removeUnused",
    kind: RSL_IMPORT_ACTION_KINDS.removeUnused,
    /*
     * Полнота контекста проверяется уже здесь: она стоит одного обхода списка
     * Import, а показывать действие, которое откажется работать, нечестно.
     */
    applies: context => rslImportContextIsComplete(context.module, context.index)
        ? [{ title: "RSL: удалить неиспользуемые Import" }]
        : [],
    resolve: context => {
        if (!rslImportContextIsComplete(context.module, context.index)) {
            return undefined;
        }

        const remove = findUnusedRslImports(context.module, context.index);

        return remove.size > 0 ? edit(context, { remove }) : undefined;
    }
};

export const addMissingImportsRefactor: IRslRefactor = {
    id: "imports.addMissing",
    kind: RSL_IMPORT_ACTION_KINDS.addMissing,
    applies: context => context.index.areImportsEnabled
        ? [{ title: "RSL: добавить недостающие Import" }]
        : [],
    resolve: context => {
        const add = findMissingRslImports(
            context.module,
            context.index,
            context.isCancelled
        );

        return add.length > 0 ? edit(context, { add }) : undefined;
    }
};

export const organizeImportsRefactor: IRslRefactor = {
    id: "imports.all",
    kind: RSL_IMPORT_ACTION_KINDS.all,
    applies: context => context.index.areImportsEnabled
        ? [{ title: "RSL: привести Import в порядок" }]
        : [],
    resolve: context => {
        const complete = rslImportContextIsComplete(
            context.module,
            context.index
        );

        /*
         * Порядок шагов задан смыслом. Добавленное только что не может быть
         * лишним, поэтому добавление идёт первым; сортировка ставит новые
         * строки на место в том же проходе.
         */
        return edit(context, {
            sort: true,
            add: findMissingRslImports(
                context.module,
                context.index,
                context.isCancelled
            ),
            remove: complete
                ? findUnusedRslImports(context.module, context.index)
                : undefined
        });
    }
};

export const RSL_IMPORT_REFACTORS: readonly IRslRefactor[] = [
    organizeImportsRefactor,
    sortImportsRefactor,
    removeUnusedImportsRefactor,
    addMissingImportsRefactor
];

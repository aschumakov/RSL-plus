import * as path from "path";
import { fileURLToPath } from "url";

import {
    CodeAction,
    CodeActionKind,
    CompletionItem,
    Range,
    TextEdit,
    WorkspaceEdit
} from "vscode-languageserver";

import type { RslSymbol } from "../symbols/rslSymbol";
import { KEYWORDS } from "../language/rslLanguageReference";
import { normalizeIdentifier, tokenAtOffset } from "../lexer";
import type { RslScopeResolver } from "../scopeResolver";
import {
    RslProjectIndexView,
    type IRslProjectSymbol
} from "../indexing/projectIndexView";
import type {
    IIndexedModule,
    IIndexedSymbol,
    WorkspaceIndex
} from "../workspaceIndex";
import { offsetInModule, positionInModule } from "../core/documentPosition";

/* Ключевое слово Import-ом не исправляется: см. справочник языка. */
const NON_IMPORT_IDENTIFIERS = new Set(KEYWORDS);

export interface IAutoImportCandidate {
    uri: string;
    symbol: RslSymbol;
}

export interface IAutoImportSearchResult {
    items: CompletionItem[];
    /** Совпадений было больше предела: список обязан считаться неполным. */
    truncated: boolean;
}

/**
 * Completion с additionalTextEdits, не запускающий полный workspace scan.
 *
 * Правка Import в списке НЕ считается вовсе: её строит completionItem/resolve
 * для той строки, которую пользователь выбрал. Каждая правка проходит по
 * объявлениям Import файла и разрешает имя модуля, а выбирают из списка одну
 * строку из сотни. Прежде правка строилась для каждого совпавшего символа: на
 * проекте из 10 000 символов один запрос стоил около 585 мс — и повторялся на
 * каждую нажатую букву.
 *
 * Порядок при этом задаётся до конца — совпадение, имя, файл, символ, — а не
 * тем, в каком порядке проект успел проиндексироваться.
 */
export function buildKnownAutoImportCompletions(
    module: IIndexedModule,
    index: WorkspaceIndex,
    prefix = "",
    limit = Number.MAX_SAFE_INTEGER
): IAutoImportSearchResult {
    if (!index.areImportsEnabled) {
        return { items: [], truncated: false };
    }

    /*
     * Кандидаты спрашиваются у общего входа, а не у индекса загруженных
     * символов.
     *
     * Прежде отвечал только он, а держит он лишь то, что сейчас в памяти:
     * на проекте, который в предел по числу модулей не помещается,
     * предложение подключить объявление ИСЧЕЗАЛО, стоило модель его модуля
     * вытеснить. Объявление при этом из проекта никуда не делось.
     *
     * Постоянный каталог помнит весь прочитанный проект, поэтому ответ
     * больше не зависит от того, что успела прочитать фоновая индексация и
     * что из прочитанного ещё не вытеснено.
     */
    const found = viewOf(index).findUnimportedSymbols(
        module.uri,
        prefix,
        limit
    );
    const built = buildAutoImportItems(
        module,
        index,
        found.items,
        limit
    );

    return {
        items: built.items,
        truncated: built.truncated || found.truncated
    };
}

/**
 * Один вход к сведениям проекта на этот индекс.
 *
 * Сам вход состояния не держит, но заводить его на каждую нажатую букву
 * незачем.
 */
const viewByIndex = new WeakMap<WorkspaceIndex, RslProjectIndexView>();

function viewOf(index: WorkspaceIndex): RslProjectIndexView {
    let view = viewByIndex.get(index);

    if (!view) {
        view = new RslProjectIndexView(index);
        viewByIndex.set(index, view);
    }

    return view;
}

/** Элементы списка и правки Import — только для тех, кто в список попал. */
function buildAutoImportItems(
    module: IIndexedModule,
    index: WorkspaceIndex,
    matched: readonly IRslProjectSymbol[],
    limit: number
): IAutoImportSearchResult {
    const items: CompletionItem[] = [];
    /* Имя модуля для Import одно на модуль: у соседних символов оно то же. */
    const names = new Map<string, string>();

    for (const candidate of matched) {
        if (items.length >= limit) {
            return { items, truncated: true };
        }

        const uri = candidate.ref.uri;

        if (!names.has(uri)) {
            names.set(uri, importName(module, index, uri));
        }

        /* Модуль, имя которого не определить, подключить нечем. */
        if (!names.get(uri)) {
            continue;
        }

        const source = autoImportSource(candidate);
        items.push({
            ...source,
            detail: [
                source.detail || "",
                `Auto Import: ${displayModule(uri)}`
            ].filter(value => !!value).join("\n"),
            sortText: `z_${String(source.label).toLowerCase()}`,
            /*
             * Происхождение нужно порядку, разрешению документации и правке
             * Import: её строит resolve по этим же данным.
             */
            data: {
                rslAutoImportUri: uri,
                rslAutoImportFrom: module.uri,
                uri,
                symbolId: candidate.ref.symbolId
            }
        });
    }

    return { items, truncated: false };
}

/**
 * Правка Import для выбранной строки списка.
 *
 * Вызывается из completionItem/resolve: к этому моменту пользователь выбрал
 * ровно один элемент, и стоит она столько же, сколько стоила бы для него в
 * списке, — но один раз вместо ста восьмидесяти.
 */
export function resolveAutoImportEdit(
    module: IIndexedModule,
    index: WorkspaceIndex,
    targetUri: string
): TextEdit | undefined {
    return buildImportEdit(module, index, targetUri);
}

/**
 * Строка списка для кандидата.
 *
 * У загруженной модели есть готовый элемент подсказки — с подписью,
 * заготовкой параметров и документацией. У записи каталога их нет: он
 * помнит имя, вид и место. Подробности дополнит completionItem/resolve —
 * он и без того загружает модуль, чтобы построить правку Import.
 */
function autoImportSource(candidate: IRslProjectSymbol): CompletionItem {
    return candidate.symbol
        ? candidate.symbol.completionItem
        : { label: candidate.name, kind: candidate.kind };
}

/**
 * Quick Fix для идентификатора без разрешённого объявления.
 * Полный поиск кандидатов выполняет переданный callback только по запросу.
 */
export async function buildMissingImportActions(
    module: IIndexedModule,
    index: WorkspaceIndex,
    resolver: RslScopeResolver,
    range: Range,
    findCandidates: (name: string) => Promise<IIndexedModule[]>
): Promise<CodeAction[]> {
    if (!index.areImportsEnabled) {
        return [];
    }

    const offset = offsetInModule(module, range.start);
    const token = tokenAtOffset(module.lex.tokens, offset, true);

    if (
        !token ||
        token.kind !== "identifier" ||
        NON_IMPORT_IDENTIFIERS.has(normalizeIdentifier(token.value)) ||
        resolver.resolveAt(module.uri, module.symbolTree, token.start)
    ) {
        return [];
    }

    const modules = await findCandidates(token.value);
    const importedUris = new Set(
        index.getImportedModules(module.uri).map(item => item.uri)
    );
    importedUris.add(module.uri);
    const candidates: IIndexedSymbol[] = [];

    for (const candidateModule of modules) {
        if (importedUris.has(candidateModule.uri)) {
            continue;
        }

        for (const object of candidateModule.symbolTree.children) {
            if (
                !object.isPrivate &&
                normalizeIdentifier(object.name) ===
                    normalizeIdentifier(token.value)
            ) {
                candidates.push({
                    uri: candidateModule.uri,
                    symbolId: object.id,
                    symbol: object
                });
            }
        }
    }

    return candidates.map(candidate =>
        createImportCodeAction(module, index, token.value, candidate)
    ).filter((action): action is CodeAction => !!action);
}

function createImportCodeAction(
    module: IIndexedModule,
    index: WorkspaceIndex,
    symbolName: string,
    candidate: IAutoImportCandidate
): CodeAction | undefined {
    const edit = buildImportEdit(module, index, candidate.uri);
    if (!edit) {
        return undefined;
    }

    const workspaceEdit: WorkspaceEdit = {
        changes: {
            [module.uri]: [edit]
        }
    };

    return {
        title:
            `Добавить Import ${importName(module, index, candidate.uri)}` +
            ` для ${symbolName}`,
        kind: CodeActionKind.QuickFix,
        isPreferred: true,
        edit: workspaceEdit
    };
}

export function buildImportEdit(
    module: IIndexedModule,
    index: WorkspaceIndex,
    targetUri: string
): TextEdit | undefined {
    return buildRslImportEditForName(
        module,
        importName(module, index, targetUri)
    );
}

/**
 * Вставка `Import <имя>;` в правильное место файла.
 *
 * По имени, а не по файлу: у прикладного модуля платформы файла в
 * проекте нет вовсе, а вставка нужна та же — то же место после последней
 * директивы, тот же перевод строки, тот же учёт BOM и та же проверка
 * «уже подключён».
 *
 * Пусто означает «вставлять нечего»: имени нет или модуль уже подключён.
 */
export function buildRslImportEditForName(
    module: IIndexedModule,
    name: string
): TextEdit | undefined {
    if (!name || module.imports.some(item =>
        normalizeImportName(item) === normalizeImportName(name)
    )) {
        return undefined;
    }

    const eol = module.lex.eol || "\n";
    const imports = module.syntax.root.children.filter(node =>
        node.kind === "ImportDeclaration"
    );

    if (imports.length === 0) {
        const offset = module.lex.hasBom ? 1 : 0;
        const position = positionInModule(module, offset);
        return TextEdit.insert(position, `Import ${name};${eol}`);
    }

    const lastImport = imports[imports.length - 1];
    const insertionOffset = followingLineStart(
        module.source,
        lastImport.end
    );
    const hasLineBreakBefore = insertionOffset > lastImport.end;
    const prefix = hasLineBreakBefore ? "" : eol;

    return TextEdit.insert(
        positionInModule(module, insertionOffset),
        `${prefix}Import ${name};${eol}`
    );
}

function importName(
    module: IIndexedModule,
    index: WorkspaceIndex,
    targetUri: string
): string {
    const base = index.getImportNameForUri(targetUri);
    const usesBackslash = module.imports.some(item => item.includes("\\"));
    const usesSlash = module.imports.some(item => item.includes("/"));

    if (usesBackslash || (!usesSlash && base.includes("/"))) {
        return base.replace(/\//g, "\\");
    }

    return base;
}

function normalizeImportName(value: string): string {
    return value
        .trim()
        .replace(/\\/g, "/")
        .replace(/\.mac$/i, "")
        .toLowerCase();
}

function followingLineStart(source: string, offset: number): number {
    for (let index = Math.max(0, offset); index < source.length; index++) {
        if (source.charAt(index) === "\n") {
            return index + 1;
        }
        if (source.charAt(index) === "\r") {
            return source.charAt(index + 1) === "\n"
                ? index + 2
                : index + 1;
        }
    }

    return source.length;
}



function displayModule(uri: string): string {
    try {
        return path.basename(fileURLToPath(uri));
    } catch (_error) {
        return path.basename(uri);
    }
}

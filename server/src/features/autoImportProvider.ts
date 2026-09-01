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
import type {
    IIndexedModule,
    IIndexedSymbol,
    WorkspaceIndex
} from "../workspaceIndex";
import { completionLabelMatchesPrefix } from "./completionRanking";
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
     * Сначала имена, начинающиеся с набранного: их находит индекс, не
     * перебирая проект. Перебор остаётся на случай, когда таких мало — тогда
     * в списке уместны и совпадения по середине имени, и он дёшев.
     */
    const byPrefix = index.findUnimportedSymbolsByPrefix(
        module.uri,
        prefix,
        /* На один больше предела: так видно, что список пришлось урезать. */
        limit === Number.MAX_SAFE_INTEGER ? limit : limit + 1
    );

    if (byPrefix.length > limit) {
        return buildAutoImportItems(module, index, byPrefix, limit);
    }

    const matched: IIndexedSymbol[] = [];
    const seen = new Set<string>();

    for (const symbol of index.findUnimportedSymbols(module.uri)) {
        if (!completionLabelMatchesPrefix(symbol.symbol.name, prefix)) {
            continue;
        }

        const key = [
            normalizeIdentifier(symbol.symbol.name),
            symbol.uri
        ].join(":");

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        matched.push(symbol);
    }

    matched.sort((left, right) => compareAutoImportCandidates(left, right));

    return buildAutoImportItems(module, index, matched, limit);
}

/** Элементы списка и правки Import — только для тех, кто в список попал. */
function buildAutoImportItems(
    module: IIndexedModule,
    index: WorkspaceIndex,
    matched: readonly IIndexedSymbol[],
    limit: number
): IAutoImportSearchResult {
    const items: CompletionItem[] = [];
    /* Имя модуля для Import одно на модуль: у соседних символов оно то же. */
    const names = new Map<string, string>();

    for (const symbol of matched) {
        if (items.length >= limit) {
            return { items, truncated: true };
        }

        if (!names.has(symbol.uri)) {
            names.set(symbol.uri, importName(module, index, symbol.uri));
        }

        /* Модуль, имя которого не определить, подключить нечем. */
        if (!names.get(symbol.uri)) {
            continue;
        }

        const source = symbol.symbol.completionItem;
        items.push({
            ...source,
            detail: [
                source.detail || "",
                `Auto Import: ${displayModule(symbol.uri)}`
            ].filter(value => !!value).join("\n"),
            sortText: `z_${String(source.label).toLowerCase()}`,
            /*
             * Происхождение нужно порядку, разрешению документации и правке
             * Import: её строит resolve по этим же данным.
             */
            data: {
                rslAutoImportUri: symbol.uri,
                rslAutoImportFrom: module.uri,
                uri: symbol.uri,
                symbolId: symbol.symbolId
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

/** Порядок кандидатов: имя, затем файл и символ — без опоры на индексацию. */
function compareAutoImportCandidates(
    left: IIndexedSymbol,
    right: IIndexedSymbol
): number {
    const byName = normalizeIdentifier(left.symbol.name)
        .localeCompare(normalizeIdentifier(right.symbol.name));

    if (byName !== 0) {
        return byName;
    }

    const byUri = left.uri.localeCompare(right.uri);

    return byUri !== 0 ? byUri : left.symbolId.localeCompare(right.symbolId);
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
    const name = importName(module, index, targetUri);
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

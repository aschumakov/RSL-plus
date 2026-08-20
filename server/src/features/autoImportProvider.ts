import * as path from "path";
import { fileURLToPath } from "url";

import {
    CodeAction,
    CodeActionKind,
    CompletionItem,
    Position,
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
 * Порядок работы важен для скорости: сначала отбор по набранному, потом
 * упорядочивание, и только потом — правка Import для тех, кто в список попал.
 * Прежде правка строилась для КАЖДОГО совпавшего символа, а каждая правка
 * проходит по объявлениям Import файла и разрешает имя модуля. На проекте из
 * 10 000 символов, где набранное совпадает почти со всеми, один запрос стоил
 * около 585 мс — и повторялся на каждую нажатую букву, потому что список
 * Auto Import помечается неполным.
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
    /* Правка Import одна на модуль: у соседних символов она совпадает. */
    const edits = new Map<string, TextEdit | undefined>();

    for (const symbol of matched) {
        if (items.length >= limit) {
            return { items, truncated: true };
        }

        if (!edits.has(symbol.uri)) {
            edits.set(symbol.uri, buildImportEdit(module, index, symbol.uri));
        }

        const edit = edits.get(symbol.uri);

        if (!edit) {
            continue;
        }

        const source = symbol.symbol.completionItem;
        items.push({
            ...source,
            detail: [
                source.detail || "",
                `Auto Import: ${displayModule(symbol.uri)}`
            ].filter(value => !!value).join("\n"),
            additionalTextEdits: [edit],
            sortText: `z_${String(source.label).toLowerCase()}`,
            /*
             * Происхождение нужно и порядку, и разрешению документации: два
             * одноимённых символа из разных файлов различаются только им.
             */
            data: {
                rslAutoImportUri: symbol.uri,
                uri: symbol.uri,
                symbolId: symbol.symbolId
            }
        });
    }

    return { items, truncated: false };
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

    const offset = offsetAt(module, range.start);
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
        const position = positionAt(module, offset);
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
        positionAt(module, insertionOffset),
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

function positionAt(module: IIndexedModule, offset: number): Position {
    const starts = module.lex.lineStarts;
    let left = 0;
    let right = starts.length - 1;
    let line = 0;

    while (left <= right) {
        const middle = (left + right) >>> 1;
        if (starts[middle] <= offset) {
            line = middle;
            left = middle + 1;
        } else {
            right = middle - 1;
        }
    }

    return {
        line,
        character: Math.max(0, offset - starts[line])
    };
}

function offsetAt(module: IIndexedModule, position: Position): number {
    const line = Math.max(
        0,
        Math.min(position.line, module.lex.lineStarts.length - 1)
    );
    return Math.min(
        module.source.length,
        module.lex.lineStarts[line] + Math.max(0, position.character)
    );
}

function displayModule(uri: string): string {
    try {
        return path.basename(fileURLToPath(uri));
    } catch (_error) {
        return path.basename(uri);
    }
}

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

import type { CBase } from "../common";
import { normalizeIdentifier, tokenAtOffset } from "../lexer";
import type { RslScopeResolver } from "../scopeResolver";
import type {
    IIndexedModule,
    IIndexedSymbol,
    WorkspaceIndex
} from "../workspaceIndex";

const NON_IMPORT_IDENTIFIERS = new Set([
    "and", "array", "break", "class", "const", "continue", "elif", "else",
    "end", "false", "file", "for", "if", "import", "local", "macro", "not",
    "null", "onerror", "or", "private", "record", "return", "this", "true",
    "var", "while", "with"
]);

export interface IAutoImportCandidate {
    uri: string;
    object: CBase;
}

/** Completion с additionalTextEdits, не запускающий полный workspace scan. */
export function buildKnownAutoImportCompletions(
    module: IIndexedModule,
    index: WorkspaceIndex
): CompletionItem[] {
    if (!index.areImportsEnabled) {
        return [];
    }

    const result: CompletionItem[] = [];
    const seen = new Set<string>();

    for (const symbol of index.findUnimportedSymbols(module.uri)) {
        const key = [
            normalizeIdentifier(symbol.object.Name),
            symbol.uri
        ].join(":");

        if (seen.has(key)) {
            continue;
        }

        const edit = buildImportEdit(module, index, symbol.uri);
        if (!edit) {
            continue;
        }

        seen.add(key);
        const source = symbol.object.CIInfo;
        result.push({
            ...source,
            detail: [
                source.detail || "",
                `Auto Import: ${displayModule(symbol.uri)}`
            ].filter(value => !!value).join("\n"),
            additionalTextEdits: [edit],
            sortText: `z_${String(source.label).toLowerCase()}`,
            data: {
                rslAutoImportUri: symbol.uri
            }
        });
    }

    return result;
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
        resolver.resolveAt(module.uri, module.object, token.start)
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

        for (const object of candidateModule.object.getChilds()) {
            if (
                !object.Private &&
                normalizeIdentifier(object.Name) ===
                    normalizeIdentifier(token.value)
            ) {
                candidates.push({
                    uri: candidateModule.uri,
                    object
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

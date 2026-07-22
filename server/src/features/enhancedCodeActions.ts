import {
    CodeAction,
    CodeActionKind,
    CodeActionParams,
    Diagnostic,
    Position,
    Range,
    TextEdit,
    WorkspaceEdit
} from "vscode-languageserver";

import { buildRslCodeActions } from "../codeActions";
import { RslQuickFixRegistry } from "./quickFixRegistry";
import type { IRslSyntaxNode } from "../syntaxParser";
import type { IIndexedModule } from "../workspaceIndex";

interface IDiagnosticData {
    start?: number;
    end?: number;
    parameter?: boolean;
}

interface IVariableDeclarationMatch {
    declaration: IRslSyntaxNode;
    declarator: IRslSyntaxNode;
    declarators: IRslSyntaxNode[];
    index: number;
}

/**
 * Единый реестр Quick Fix. Legacy-провайдер остаётся fallback, а новые
 * исправления регистрируются по diagnostic.code без второго switch.
 */
const quickFixRegistry = new RslQuickFixRegistry();
quickFixRegistry.register(
    "unused-declaration",
    (module, diagnostic) => createRemoveUnusedDeclarationAction(
        module,
        diagnostic
    )
);
quickFixRegistry.setFallback((module, diagnostic, params) =>
    buildRslCodeActions(module, {
        ...params,
        context: {
            ...params.context,
            diagnostics: [diagnostic]
        }
    })
);

export function buildEnhancedRslCodeActions(
    module: IIndexedModule,
    params: CodeActionParams
): CodeAction[] {
    return quickFixRegistry.build(module, params);
}

function createRemoveUnusedDeclarationAction(
    module: IIndexedModule,
    diagnostic: Diagnostic
): CodeAction | undefined {
    if (String(diagnostic.code || "") !== "unused-declaration") {
        return undefined;
    }

    const data = diagnostic.data as IDiagnosticData | undefined;

    /* Параметры Macro автоматически не удаляем: сигнатура может быть внешней. */
    if (data?.parameter) {
        return undefined;
    }

    const start = typeof data?.start === "number"
        ? data.start
        : offsetAt(module, diagnostic.range.start);
    const match = findVariableDeclaration(module.syntax.root, start);

    if (!match) {
        return undefined;
    }

    const edit = buildDeclarationRemovalEdit(module, match);

    if (!edit) {
        return undefined;
    }

    const workspaceEdit: WorkspaceEdit = {
        changes: {
            [module.uri]: [edit]
        }
    };

    return {
        title: match.declarators.length === 1
            ? "Удалить неиспользуемое объявление"
            : "Удалить переменную из объявления",
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        isPreferred: true,
        edit: workspaceEdit
    };
}

function buildDeclarationRemovalEdit(
    module: IIndexedModule,
    match: IVariableDeclarationMatch
): TextEdit | undefined {
    const semicolon = findDeclarationSemicolon(
        module,
        match.declaration.end
    );

    if (!semicolon) {
        return undefined;
    }

    if (match.declarators.length === 1) {
        const statementStart = includeLeadingIndent(
            module.source,
            match.declaration.start
        );
        const statementEnd = includeFollowingNewline(
            module.source,
            semicolon.end
        );

        return {
            range: offsetRange(module, statementStart, statementEnd),
            newText: ""
        };
    }

    let removalStart: number;
    let removalEnd: number;

    if (match.index < match.declarators.length - 1) {
        const next = match.declarators[match.index + 1];
        const separator = findComma(
            module,
            match.declarator.end,
            next.start
        );

        if (!separator) {
            return undefined;
        }

        /*
         * Оставляем запятую перед текущим элементом и удаляем запятую после
         * него. Поэтому одинаково корректно обрабатываются первый и средний
         * элементы списка: "a, b, c" -> "a, c" при удалении b.
         */
        removalStart = match.declarator.start;
        removalEnd = next.start;
    } else {
        const previous = match.declarators[match.index - 1];
        const separator = findComma(
            module,
            previous.end,
            match.declarator.start
        );

        if (!separator) {
            return undefined;
        }

        removalStart = separator.start;
        removalEnd = semicolon.start;
    }

    return {
        range: offsetRange(module, removalStart, removalEnd),
        newText: ""
    };
}

function findVariableDeclaration(
    node: IRslSyntaxNode,
    offset: number
): IVariableDeclarationMatch | undefined {
    if (offset < node.start || offset > node.end) {
        return undefined;
    }

    if (node.kind === "VariableDeclaration") {
        const declarators = node.children.filter(child =>
            child.kind === "VariableDeclarator"
        );
        const index = declarators.findIndex(declarator =>
            declarator.start <= offset && offset < declarator.end
        );

        if (index >= 0) {
            return {
                declaration: node,
                declarator: declarators[index],
                declarators,
                index
            };
        }
    }

    for (const child of node.children) {
        const result = findVariableDeclaration(child, offset);

        if (result) {
            return result;
        }
    }

    return undefined;
}

function findDeclarationSemicolon(
    module: IIndexedModule,
    declarationEnd: number
): { start: number; end: number } | undefined {
    for (const token of module.lex.tokens) {
        if (token.end <= declarationEnd) {
            continue;
        }

        if (
            token.kind === "whitespace" ||
            token.kind === "newline" ||
            token.kind === "comment" ||
            token.kind === "bom"
        ) {
            continue;
        }

        return token.kind === "symbol" && token.raw === ";"
            ? { start: token.start, end: token.end }
            : undefined;
    }

    return undefined;
}

function findComma(
    module: IIndexedModule,
    start: number,
    end: number
): { start: number; end: number } | undefined {
    const token = module.lex.tokens.find(item =>
        start <= item.start &&
        item.end <= end &&
        item.kind === "symbol" &&
        item.raw === ","
    );

    return token
        ? { start: token.start, end: token.end }
        : undefined;
}

function includeLeadingIndent(source: string, start: number): number {
    const lineStart = Math.max(0, source.lastIndexOf("\n", start - 1) + 1);

    return source.substring(lineStart, start).trim().length === 0
        ? lineStart
        : start;
}

function includeFollowingNewline(source: string, end: number): number {
    if (source.substr(end, 2) === "\r\n") {
        return end + 2;
    }

    if (source.charAt(end) === "\n" || source.charAt(end) === "\r") {
        return end + 1;
    }

    return end;
}

function offsetRange(
    module: IIndexedModule,
    start: number,
    end: number
): Range {
    return {
        start: positionAt(module, start),
        end: positionAt(module, end)
    };
}

function positionAt(module: IIndexedModule, offset: number): Position {
    const starts = module.lex.lineStarts;
    let left = 0;
    let right = starts.length - 1;
    let line = 0;

    while (left <= right) {
        const middle = Math.floor((left + right) / 2);

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
    const lineStart = module.lex.lineStarts[line];
    const lineEnd = line + 1 < module.lex.lineStarts.length
        ? module.lex.lineStarts[line + 1]
        : module.source.length;

    return Math.max(
        lineStart,
        Math.min(lineStart + position.character, lineEnd)
    );
}

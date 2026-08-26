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
import {
    RslQuickFixRegistry,
    type IRslQuickFixOptions
} from "./quickFixRegistry";
import type { IRslSyntaxNode } from "../syntaxParser";
import type { IIndexedModule } from "../workspaceIndex";
import { RSL_BLOCK_END } from "../language/rslLanguageReference";
import { applyRslKeywordCase } from "./formatOptions";

interface IDiagnosticData {
    start?: number;
    end?: number;
    parameter?: boolean;
    replacement?: string;
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
quickFixRegistry.register(
    "string-literal-too-long",
    (module, diagnostic) => createSplitLongStringAction(module, diagnostic)
);
quickFixRegistry.register(
    "redundant-header-semicolon",
    (module, diagnostic) => createRemoveHeaderSemicolonAction(
        module,
        diagnostic
    )
);
quickFixRegistry.register(
    "missing-member-name",
    (module, diagnostic) => createRemoveExtraDotAction(module, diagnostic)
);
quickFixRegistry.register(
    "missing-end",
    (module, diagnostic, _params, options) => createCloseBlockAction(
        module,
        diagnostic,
        options.keywordCase
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
    params: CodeActionParams,
    options: IRslQuickFixOptions = {}
): CodeAction[] {
    return quickFixRegistry.build(module, params, options);
}

/**
 * «Удалить лишнюю ";"» после заголовка блока.
 *
 * Диагностика указывает ровно на эту точку с запятой, поэтому правка
 * однозначна: убрать символ. Тело блока при этом начинает зависеть от
 * условия — именно этого обычно и хотели.
 */
function createRemoveHeaderSemicolonAction(
    module: IIndexedModule,
    diagnostic: Diagnostic
): CodeAction | undefined {
    const tokens = module.lex.tokens;
    const offset = offsetOfPosition(module, diagnostic.range.start);
    const semicolon = tokens.find(token =>
        token.start <= offset && offset < token.end
    );

    if (!semicolon || semicolon.kind !== "symbol" ||
        semicolon.raw !== ";") {
        return undefined;
    }

    const edit: TextEdit = TextEdit.del({
        start: positionOfOffset(module, semicolon.start),
        end: positionOfOffset(module, semicolon.end)
    });

    return {
        title: "Удалить лишнюю \";\"",
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        isPreferred: true,
        edit: {
            changes: { [module.uri]: [edit] }
        } as WorkspaceEdit
    };
}

/**
 * «Удалить лишнюю точку» для `obj..field`.
 *
 * Предлагается только когда последовательность однозначна: ровно две точки
 * подряд между именами. Три точки или точка перед скобкой — это уже не
 * опечатка одного символа, и угадывать замысел нельзя.
 */
function createRemoveExtraDotAction(
    module: IIndexedModule,
    diagnostic: Diagnostic
): CodeAction | undefined {
    const tokens = module.lex.tokens;
    const offset = offsetOfPosition(module, diagnostic.range.start);
    const index = tokens.findIndex(token =>
        token.start <= offset && offset < token.end
    );

    if (index < 1) {
        return undefined;
    }

    const dot = tokens[index];

    if (dot.kind !== "symbol" || dot.raw !== ".") {
        return undefined;
    }

    /*
     * Диагностика указывает на первую точку пары, поэтому вторая ищется как
     * следующий значимый токен. Ровно две точки — опечатка одного символа;
     * три — уже нет, и угадывать замысел нельзя.
     */
    const next = nextSignificant(tokens, index);
    const previous = previousSignificant(tokens, index);
    const isDot = (at: number): boolean => at >= 0 &&
        tokens[at].kind === "symbol" && tokens[at].raw === ".";

    if (!isDot(next) && !isDot(previous)) {
        return undefined;
    }

    /* Пара найдена: лишняя точка — вторая из них. */
    const second = isDot(next) ? next : index;
    const first = isDot(next) ? index : previous;
    const beyond = nextSignificant(tokens, second);

    if (isDot(beyond) || isDot(previousSignificant(tokens, first))) {
        return undefined;
    }

    const extra = tokens[second];
    const edit: TextEdit = TextEdit.del({
        start: positionOfOffset(module, extra.start),
        end: positionOfOffset(module, extra.end)
    });

    return {
        title: "Удалить лишнюю точку",
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        isPreferred: true,
        edit: {
            changes: { [module.uri]: [edit] }
        } as WorkspaceEdit
    };
}

/*
 * Слова, открывающие блок.
 *
 * Список тот же, что у проверки парности END: расходиться им нельзя, иначе
 * исправление предлагалось бы там, где сама проверка блока не видит.
 */
const BLOCK_OPENERS = new Set([
    "macro",
    "class",
    "if",
    "while",
    "for",
    "with"
]);

/**
 * «Добавить end;» для незакрытого блока.
 *
 * Предлагается ТОЛЬКО когда незакрыт ровно один блок: тогда и место вставки, и
 * отступ однозначны. При двух незакрытых блоках закрывать наугад нельзя —
 * получится код, который компилируется иначе, чем задумано.
 */
function createCloseBlockAction(
    module: IIndexedModule,
    diagnostic: Diagnostic,
    keywordCase?: string
): CodeAction | undefined {
    const unclosed = findUnclosedBlocks(module);

    if (unclosed.length !== 1) {
        return undefined;
    }

    const source = module.source;
    const opener = unclosed[0];
    const lineStart = source.lastIndexOf("\n", Math.max(0, opener - 1)) + 1;
    const indent = /^[ \t]*/.exec(source.slice(lineStart, opener))?.[0] || "";
    const eol = module.lex.eol || "\n";
    /* Вставка в конец текста: ниже незакрытого блока ничего нет по определению. */
    const tail = source.replace(/\s+$/, "").length;
    const position = positionOfOffset(module, tail);
    const blockEnd = applyRslKeywordCase(RSL_BLOCK_END, keywordCase);
    const closing = eol + indent + blockEnd + eol;

    return {
        title: "Добавить " + blockEnd,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        isPreferred: true,
        edit: {
            changes: {
                [module.uri]: [TextEdit.insert(position, closing)]
            }
        } as WorkspaceEdit
    };
}

/** Смещения открывающих слов, которым не хватило END. */
function findUnclosedBlocks(module: IIndexedModule): number[] {
    const stack: number[] = [];

    for (const token of module.lex.tokens) {
        if (token.kind !== "identifier") {
            continue;
        }

        const word = token.value.toLowerCase();

        if (BLOCK_OPENERS.has(word)) {
            stack.push(token.start);
            continue;
        }

        if (word === "end") {
            stack.pop();
        }
    }

    return stack;
}

function nextSignificant(
    tokens: readonly { kind: string }[],
    index: number
): number {
    for (let at = index + 1; at < tokens.length; at++) {
        const kind = tokens[at].kind;

        if (
            kind !== "whitespace" && kind !== "newline" &&
            kind !== "comment" && kind !== "bom"
        ) {
            return at;
        }
    }

    return -1;
}

function previousSignificant(
    tokens: readonly { kind: string }[],
    index: number
): number {
    for (let at = index - 1; at >= 0; at--) {
        const kind = tokens[at].kind;

        if (
            kind !== "whitespace" && kind !== "newline" &&
            kind !== "comment" && kind !== "bom"
        ) {
            return at;
        }
    }

    return -1;
}

function offsetOfPosition(
    module: IIndexedModule,
    position: Position
): number {
    const lineStarts = module.lex.lineStarts;
    const line = Math.max(0, Math.min(position.line, lineStarts.length - 1));

    return lineStarts[line] + position.character;
}

function positionOfOffset(module: IIndexedModule, offset: number): Position {
    const lineStarts = module.lex.lineStarts;
    let line = 0;

    while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) {
        line++;
    }

    return Position.create(line, offset - lineStarts[line]);
}

function createSplitLongStringAction(
    module: IIndexedModule,
    diagnostic: Diagnostic
): CodeAction | undefined {
    const data = diagnostic.data as IDiagnosticData | undefined;
    if (!data?.replacement) {
        return undefined;
    }
    const start = typeof data.start === "number"
        ? data.start
        : offsetAt(module, diagnostic.range.start);
    const end = typeof data.end === "number"
        ? data.end
        : offsetAt(module, diagnostic.range.end);
    return {
        title: "Разбить строковый литерал на допустимые части",
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        isPreferred: true,
        edit: {
            changes: {
                [module.uri]: [{
                    range: offsetRange(module, start, end),
                    newText: data.replacement
                }]
            }
        }
    };
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

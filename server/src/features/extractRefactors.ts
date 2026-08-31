import {
    CodeActionKind,
    type TextEdit,
    type WorkspaceEdit
} from "vscode-languageserver";

import { LITERAL_KEYWORDS, WORD_OPERATORS } from "../language/rslLanguageReference";
import { normalizeIdentifier, type IRslToken } from "../lexer";
import type { IIndexedModule } from "../workspaceIndex";
import {
    freeRslName,
    keyword,
    lineIndent,
    offsetRange,
    singleFileEdit,
    type IRslRefactor,
    type IRslRefactorContext
} from "./refactorRegistry";
import {
    enclosingRslProcedure,
    rslNamesInScope,
    rslReferencesTo,
    rslStatementAround,
    rslTokensIn,
    startsRslLine,
    RSL_STATEMENT_WORDS
} from "./refactorScope";

/**
 * Extract Variable и Inline Variable.
 *
 * Оба действия предлагаются только там, где перенос доказуемо ничего не
 * меняет. Что именно проверяется, написано у каждого правила; общее правило
 * одно: сомнение — повод не предлагать действие вовсе. Рефакторинг, который
 * иногда портит код, хуже отсутствующего: за отсутствующим человек идёт
 * править руками, а испорченное он находит на рабочем месте.
 */

const WORD_OPERATOR_SET = new Set<string>(WORD_OPERATORS);
const LITERAL_SET = new Set<string>(LITERAL_KEYWORDS);

/** Выделение без пробелов по краям. */
function trimmed(
    module: IIndexedModule,
    start: number,
    end: number
): { start: number; end: number } {
    const source = module.source;
    let from = Math.max(0, Math.min(start, source.length));
    let to = Math.max(from, Math.min(end, source.length));

    while (from < to && /\s/u.test(source.charAt(from))) {
        from++;
    }

    while (to > from && /\s/u.test(source.charAt(to - 1))) {
        to--;
    }

    return { start: from, end: to };
}

/**
 * Годится ли выделенное на роль выражения.
 *
 * Скобки обязаны быть закрыты внутри выделения, ключевых слов оператора быть
 * не должно, `;` — тоже. Отдельно запрещена передача по ссылке: `@value` —
 * это не значение, а адрес, и вычислить его заранее в переменную нельзя.
 */
function looksLikeExpression(tokens: readonly IRslToken[]): boolean {
    if (tokens.length === 0) {
        return false;
    }

    let depth = 0;

    for (const token of tokens) {
        if (token.kind === "symbol") {
            if (token.raw === "(" || token.raw === "[") {
                depth++;
            } else if (token.raw === ")" || token.raw === "]") {
                depth--;

                if (depth < 0) {
                    return false;
                }
            } else if (token.raw === ";" || token.raw === "@") {
                return false;
            } else if (token.raw === "=" && depth === 0) {
                /* Присваивание — оператор, а не выражение. */
                return false;
            }

            continue;
        }

        if (
            token.kind === "identifier" &&
            RSL_STATEMENT_WORDS.has(normalizeIdentifier(token.value))
        ) {
            return false;
        }
    }

    if (depth !== 0) {
        return false;
    }

    const first = tokens[0];
    const last = tokens[tokens.length - 1];

    /* Выражение не начинается запятой и не кончается ею или оператором. */
    return !isDangling(first) && !isDangling(last);
}

function isDangling(token: IRslToken): boolean {
    if (token.kind === "symbol") {
        return token.raw !== "(" && token.raw !== ")" &&
            token.raw !== "[" && token.raw !== "]";
    }

    return token.kind === "identifier" &&
        WORD_OPERATOR_SET.has(normalizeIdentifier(token.value));
}

/** Одиночное имя или литерал: заводить под него переменную незачем. */
function isTrivial(tokens: readonly IRslToken[]): boolean {
    if (tokens.length !== 1) {
        return false;
    }

    const token = tokens[0];

    return token.kind === "number" ||
        token.kind === "string" ||
        (token.kind === "identifier" &&
            !LITERAL_SET.has(normalizeIdentifier(token.value)));
}

export const extractVariableRefactor: IRslRefactor = {
    id: "extract.variable",
    kind: CodeActionKind.RefactorExtract,
    applies: context => prepareExtractVariable(context)
        ? [{ title: "RSL: вынести выражение в переменную", preferred: true }]
        : [],
    resolve: context => {
        const prepared = prepareExtractVariable(context);

        if (!prepared) {
            return undefined;
        }

        const { module } = context;
        const name = freeRslName(
            "value",
            rslNamesInScope(module, prepared.procedure)
        );
        const eol = module.lex.eol || "\n";
        const declaration = prepared.indent +
            keyword("Var", context.options) + " " + name + " = " +
            module.source.slice(prepared.start, prepared.end) + ";" + eol;
        const edits: TextEdit[] = [
            {
                range: offsetRange(
                    module,
                    prepared.statementLine,
                    prepared.statementLine
                ),
                newText: declaration
            },
            {
                range: offsetRange(module, prepared.start, prepared.end),
                newText: name
            }
        ];

        return singleFileEdit(module, edits);
    }
};

interface IExtractVariablePlan {
    start: number;
    end: number;
    /** Начало строки оператора: перед ней встанет объявление. */
    statementLine: number;
    indent: string;
    procedure: ReturnType<typeof enclosingRslProcedure>;
}

function prepareExtractVariable(
    context: IRslRefactorContext
): IExtractVariablePlan | undefined {
    const { module } = context;
    const { start, end } = trimmed(context.module, context.start, context.end);

    if (end <= start) {
        return undefined;
    }

    const tokens = rslTokensIn(module.syntax.tokens, start, end);

    /* Выделение обязано совпасть с токенами целиком, а не разрезать их. */
    if (
        tokens.length === 0 ||
        tokens[0].start !== start ||
        tokens[tokens.length - 1].end !== end ||
        isTrivial(tokens) ||
        !looksLikeExpression(tokens)
    ) {
        return undefined;
    }

    const procedure = enclosingRslProcedure(module, start);

    if (!procedure) {
        /* Вне процедуры объявление ставить некуда. */
        return undefined;
    }

    const statement = rslStatementAround(module, start);

    if (!statement || statement.start > start || statement.end < end) {
        return undefined;
    }

    /*
     * Оператор обязан начинаться со своей строки.
     *
     * Иначе объявление, вставленное строкой выше, окажется не там: у
     * `if (flag) total = a + b;` строка выше — уже вне условия.
     */
    if (!startsRslLine(module, statement.start)) {
        return undefined;
    }

    return {
        start,
        end,
        statementLine: statement.start - lineIndent(module, statement.start).length,
        indent: lineIndent(module, statement.start),
        procedure
    };
}

/* ── Inline Variable ────────────────────────────────────────────────────── */

interface IInlineVariablePlan {
    /** Границы объявления вместе с точкой с запятой. */
    statement: { start: number; end: number };
    /** Границы значения. */
    value: { start: number; end: number };
    /** Нужны ли скобки вокруг подставляемого значения. */
    parenthesize: boolean;
    references: IRslToken[];
    name: string;
}

export const inlineVariableRefactor: IRslRefactor = {
    id: "inline.variable",
    kind: CodeActionKind.RefactorInline,
    applies: context => {
        const prepared = prepareInlineVariable(context);

        return prepared
            ? [{
                title: "RSL: подставить значение переменной " + prepared.name
            }]
            : [];
    },
    resolve: context => {
        const prepared = prepareInlineVariable(context);

        if (!prepared) {
            return undefined;
        }

        const { module } = context;
        const value = module.source.slice(
            prepared.value.start,
            prepared.value.end
        );
        const text = prepared.parenthesize ? "(" + value + ")" : value;
        const edits: TextEdit[] = prepared.references.map(token => ({
            range: offsetRange(module, token.start, token.end),
            newText: text
        }));

        edits.push({
            range: offsetRange(
                module,
                prepared.statement.start -
                    lineIndent(module, prepared.statement.start).length,
                lineBreakAfter(module, prepared.statement.end)
            ),
            newText: ""
        });

        return singleFileEdit(module, edits) as WorkspaceEdit;
    }
};

function prepareInlineVariable(
    context: IRslRefactorContext
): IInlineVariablePlan | undefined {
    const { module } = context;
    const tokens = module.syntax.tokens;
    const at = tokens.findIndex(token =>
        token.kind === "identifier" &&
        token.start <= context.start &&
        context.start <= token.end);

    if (at < 0) {
        return undefined;
    }

    const name = tokens[at].value;
    const procedure = enclosingRslProcedure(module, tokens[at].start);

    if (!procedure) {
        return undefined;
    }

    const declaration = findDeclaration(module, procedure, name);

    if (!declaration) {
        return undefined;
    }

    const references = rslReferencesTo(module, procedure, name).filter(token =>
        token.start < declaration.statement.start ||
        token.start >= declaration.statement.end);

    if (references.length === 0) {
        return undefined;
    }

    /*
     * Присваивание тому же имени где-то ещё делает подстановку неверной:
     * значение переменной к моменту чтения уже другое.
     */
    if (references.some(token => isAssignmentTarget(tokens, token))) {
        return undefined;
    }

    /* Передача по ссылке пишет в переменную мимо нас. */
    if (references.some(token => isReferenceArgument(tokens, token))) {
        return undefined;
    }

    const valueTokens = rslTokensIn(
        tokens,
        declaration.value.start,
        declaration.value.end
    );

    if (valueTokens.length === 0 || !looksLikeExpression(valueTokens)) {
        return undefined;
    }

    /*
     * Значение с вызовом или индексом подставляется только в одно место:
     * иначе побочное действие повторится столько раз, сколько было чтений.
     */
    if (references.length > 1 && !isPureValue(valueTokens)) {
        return undefined;
    }

    return {
        statement: declaration.statement,
        value: declaration.value,
        parenthesize: valueTokens.length > 1,
        references,
        name
    };
}

/**
 * Объявление `Var name = значение;` — единственное и с одним именем.
 *
 * `Var a, b;` и `Var a;` без значения не подходят: подставлять нечего, а
 * вырезать одно имя из списка — уже другая правка.
 */
function findDeclaration(
    module: IIndexedModule,
    procedure: { range: { start: number; end: number } },
    name: string
): { statement: { start: number; end: number }; value: { start: number; end: number } } | undefined {
    const tokens = module.syntax.tokens;
    const wanted = normalizeIdentifier(name);
    let found;

    for (let index = 0; index + 3 < tokens.length; index++) {
        const word = tokens[index];

        if (
            word.kind !== "identifier" ||
            normalizeIdentifier(word.value) !== "var" ||
            word.start < procedure.range.start ||
            word.end > procedure.range.end ||
            tokens[index + 1].kind !== "identifier" ||
            normalizeIdentifier(tokens[index + 1].value) !== wanted ||
            tokens[index + 2].kind !== "symbol" ||
            tokens[index + 2].raw !== "="
        ) {
            continue;
        }

        const statement = rslStatementAround(module, word.start);

        if (
            !statement ||
            statement.start !== word.start ||
            !startsRslLine(module, statement.start)
        ) {
            return undefined;
        }

        /* Точка с запятой в значение не входит: statement.end стоит за ней. */
        const value = rslTokensIn(
            tokens,
            tokens[index + 3].start,
            statement.end - 1
        );

        if (value.length === 0) {
            return undefined;
        }

        if (found) {
            /* Два объявления одного имени: какое из них подставлять — неясно. */
            return undefined;
        }

        found = {
            statement,
            value: {
                start: value[0].start,
                end: value[value.length - 1].end
            }
        };
    }

    return found;
}

/** Стоит ли имя слева от знака присваивания. */
function isAssignmentTarget(
    tokens: readonly IRslToken[],
    token: IRslToken
): boolean {
    const at = tokens.indexOf(token);
    const next = tokens[at + 1];

    return !!next && next.kind === "symbol" && next.raw === "=";
}

/** Передаётся ли имя по ссылке: `@value`. */
function isReferenceArgument(
    tokens: readonly IRslToken[],
    token: IRslToken
): boolean {
    const at = tokens.indexOf(token);
    const previous = tokens[at - 1];

    return !!previous && previous.kind === "symbol" && previous.raw === "@";
}

/** Значение без вызовов, индексов и обращений к членам. */
function isPureValue(tokens: readonly IRslToken[]): boolean {
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind !== "symbol") {
            continue;
        }

        if (token.raw === "." || token.raw === "[") {
            return false;
        }

        if (token.raw === "(" && index > 0) {
            const previous = tokens[index - 1];

            if (
                previous.kind === "identifier" &&
                !WORD_OPERATOR_SET.has(normalizeIdentifier(previous.value))
            ) {
                return false;
            }
        }
    }

    return true;
}

function lineBreakAfter(module: IIndexedModule, offset: number): number {
    const source = module.source;

    if (source.startsWith("\r\n", offset)) {
        return offset + 2;
    }

    return source.charAt(offset) === "\n" ? offset + 1 : offset;
}

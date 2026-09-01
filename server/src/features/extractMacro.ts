import {
    CodeActionKind,
    CompletionItemKind,
    type WorkspaceEdit
} from "vscode-languageserver";

import {
    BLOCK_BOUNDARY_KEYWORDS,
    BLOCK_START_KEYWORDS
} from "../language/rslLanguageReference";
import { normalizeIdentifier, type IRslToken , lowerBoundTokenIndex } from "../lexer";
import type { RslSymbol } from "../symbols/rslSymbol";
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
    rslTokensIn,
    startsRslLine
} from "./refactorScope";

/**
 * Вынести выделенные операторы в отдельную процедуру.
 *
 * Действие предлагается только там, где перенос доказуемо ничего не меняет.
 * Отказы важнее самой правки, поэтому они перечислены здесь целиком:
 *
 *   выделение не совпадает с целыми операторами или разрезает блок;
 *   в выделении есть RETURN, BREAK, CONTINUE или EXIT — управление ушло бы из
 *   новой процедуры, а не из старой;
 *   переменная, объявленная внутри выделения, читается после него: её
 *   объявление уехало бы вместе с текстом;
 *   выделение не начинается со своей строки.
 *
 * Переменные, которые выделение читает, становятся параметрами. Если оно
 * пишет в переменную, читаемую дальше, эта переменная возвращается:
 * `total = Extracted(a, total);`. Двух таких сразу быть не может — тогда
 * действие не предлагается.
 *
 * Передачей по ссылке это не делается, и вот почему. В RSL ссылочный параметр
 * объявляется как `имя:@тип`, а тип обязателен: `Macro Extracted(@total)` —
 * синтаксическая ошибка, и на проекте нет ни одного объявления без типа.
 * Подставить тип за автора можно только угадав его, а угаданный тип в
 * сигнатуре хуже отсутствующего действия.
 */

const BLOCK_START = new Set<string>(BLOCK_START_KEYWORDS);
const BLOCK_END = new Set<string>(BLOCK_BOUNDARY_KEYWORDS);

/** Слова, уводящие управление за пределы выделения. */
const CONTROL_WORDS = new Set(["return", "break", "continue", "exit"]);

/**
 * Объявления, которые нельзя переносить.
 *
 * VAR сюда не входит: перенос локальной переменной разбирается отдельно, по
 * тому, читают ли её после выделения. Остальное меняет область видимости само
 * по себе — `private array ar1name;` в LN_UNIFORM.mac объявляет модульный
 * массив, и в процедуре он значит уже не то.
 */
const FORBIDDEN_DECLARATIONS = new Set([
    "macro",
    "class",
    "const",
    "file",
    "record",
    "array",
    "local",
    "private"
]);

const LOCAL_KINDS = new Set<number>([
    CompletionItemKind.Variable,
    CompletionItemKind.Constant
]);

interface IExtractMacroPlan {
    start: number;
    end: number;
    indent: string;
    procedure: RslSymbol;
    /** Параметры в порядке первого появления. */
    parameters: string[];
    /** Переменная, которую процедура возвращает; её может и не быть. */
    returned?: string;
}

export const extractMacroRefactor: IRslRefactor = {
    id: "extract.macro",
    kind: CodeActionKind.RefactorExtract,
    applies: context => prepareExtractMacro(context)
        ? [{ title: "RSL: вынести операторы в процедуру" }]
        : [],
    resolve: context => buildExtractMacro(context)
};

function buildExtractMacro(
    context: IRslRefactorContext
): WorkspaceEdit | undefined {
    const plan = prepareExtractMacro(context);

    if (!plan) {
        return undefined;
    }

    const { module } = context;
    const name = freeRslName(
        "Extracted",
        rslNamesInScope(module, plan.procedure)
    );
    const eol = module.lex.eol || "\n";
    const parameters = plan.parameters.join(", ");
    /*
     * Тело берётся с начала строки, а не с первого токена: иначе первая
     * строка приезжает без отступа, а остальные — со своим.
     */
    const body = module.source.slice(
        plan.start - plan.indent.length,
        plan.end
    );
    const outerIndent = lineIndent(module, plan.procedure.range.start);
    const inner = outerIndent + (context.options.indent || "    ");
    const after = tailOffset(module, plan.procedure);
    const lines = [
        "",
        outerIndent + keyword("Macro", context.options) + " " + name +
            "(" + parameters + ")",
        reindent(body, plan.indent, inner, eol)
    ];

    if (plan.returned) {
        lines.push(
            inner + keyword("return", context.options) + " " +
                plan.returned + ";"
        );
    }

    lines.push(outerIndent + keyword("End", context.options) + ";");

    const call = name + "(" + parameters + ");";

    return singleFileEdit(module, [
        {
            range: offsetRange(module, plan.start, plan.end),
            newText: plan.returned ? plan.returned + " = " + call : call
        },
        {
            range: offsetRange(module, after, after),
            newText: lines.join(eol) + eol
        }
    ]);
}

/** Смещение сразу за END процедуры, с начала следующей строки. */
function tailOffset(module: IIndexedModule, procedure: RslSymbol): number {
    const lineBreak = module.source.indexOf("\n", procedure.range.end);

    return lineBreak < 0 ? module.source.length : lineBreak + 1;
}

/** Тот же текст с другим отступом первого уровня. */
function reindent(
    body: string,
    from: string,
    to: string,
    eol: string
): string {
    return body
        .split(/\r?\n/u)
        .map(line => line.startsWith(from) ? to + line.slice(from.length) : line)
        .join(eol);
}

function prepareExtractMacro(
    context: IRslRefactorContext
): IExtractMacroPlan | undefined {
    const { module } = context;
    const procedure = enclosingRslProcedure(module, context.start);

    if (!procedure || context.end <= context.start) {
        return undefined;
    }

    const bounds = constructSpan(module, context.start, context.end);

    if (
        !bounds ||
        !startsRslLine(module, bounds.start) ||
        /* Выделение обязано лежать в теле процедуры целиком. */
        bounds.start <= procedure.range.start ||
        bounds.end >= procedure.range.end
    ) {
        return undefined;
    }

    const tokens = rslTokensIn(module.syntax.tokens, bounds.start, bounds.end);

    if (tokens.length === 0 || !blocksBalanced(tokens)) {
        return undefined;
    }

    if (tokens.some(token => {
        if (token.kind !== "identifier") {
            return false;
        }

        const word = normalizeIdentifier(token.value);

        return CONTROL_WORDS.has(word) || FORBIDDEN_DECLARATIONS.has(word);
    })) {
        return undefined;
    }

    const locals = localsOf(procedure);
    const inside = classify(tokens, locals);

    /* Объявленное внутри и читаемое снаружи уехало бы вместе с текстом. */
    const outside = referencedOutside(module, procedure, bounds);

    for (const name of inside.declared) {
        if (outside.has(name)) {
            return undefined;
        }
    }

    const parameters: string[] = [];
    let returned: string | undefined;

    for (const name of inside.used) {
        if (inside.declared.has(name)) {
            continue;
        }

        const local = locals.get(name);

        if (!local || local.range.start > bounds.start) {
            /* Не локальная переменная процедуры: глобальное имя видно и там. */
            continue;
        }

        parameters.push(local.name);

        if (!inside.written.has(name) || !outside.has(name)) {
            continue;
        }

        if (returned) {
            /*
             * Двух возвращаемых значений у процедуры не бывает, а ссылочный
             * параметр требует типа, которого здесь взять негде.
             */
            return undefined;
        }

        returned = local.name;
    }

    return {
        start: bounds.start,
        end: bounds.end,
        indent: lineIndent(module, bounds.start),
        procedure,
        parameters,
        returned
    };
}

/** Объявления процедуры по нормализованному имени. */
function localsOf(procedure: RslSymbol): Map<string, RslSymbol> {
    const result = new Map<string, RslSymbol>();

    for (const child of procedure.children) {
        if (LOCAL_KINDS.has(child.kind)) {
            result.set(normalizeIdentifier(child.name), child);
        }
    }

    return result;
}

/**
 * Границы целых конструкций, покрывающих выделение.
 *
 * Конструкция — это оператор или блок целиком: выносить `if` вместе с его
 * телом и `end;` можно, половину `if` — нельзя. Отсюда четыре требования:
 * выделение начинается именем, стоит в начале своей строки, идёт сразу за
 * границей предыдущей конструкции и кончается точкой с запятой.
 *
 * Последние два не формальность. Без них выделение второй строки в
 * `total = a +` / `  b;` прошло бы все прочие проверки и вынесло бы в
 * процедуру огрызок выражения.
 */
function constructSpan(
    module: IIndexedModule,
    start: number,
    end: number
): { start: number; end: number } | undefined {
    const tokens = module.syntax.tokens;
    /* Нижняя граница участка бинарным поиском, а не проходом с начала. */
    const firstIndex = lowerBoundTokenIndex(tokens, start);

    if (firstIndex >= tokens.length) {
        return undefined;
    }

    if (firstIndex < 0) {
        return undefined;
    }

    let lastIndex = -1;

    for (let index = firstIndex; index < tokens.length; index++) {
        if (tokens[index].end <= end) {
            lastIndex = index;
        } else {
            break;
        }
    }

    if (lastIndex < firstIndex) {
        return undefined;
    }

    /* Точка с запятой в выделение могла не попасть: дотянем до неё. */
    while (isSemicolon(tokens[lastIndex + 1])) {
        lastIndex++;
    }

    if (
        tokens[firstIndex].kind !== "identifier" ||
        !isSemicolon(tokens[lastIndex]) ||
        !opensConstruct(tokens[firstIndex - 1])
    ) {
        return undefined;
    }

    return { start: tokens[firstIndex].start, end: tokens[lastIndex].end };
}

function isSemicolon(token: IRslToken | undefined): boolean {
    return !!token && token.kind === "symbol" && token.raw === ";";
}

/** Кончилась ли предыдущая конструкция на этом токене. */
function opensConstruct(token: IRslToken | undefined): boolean {
    if (!token) {
        return true;
    }

    if (token.kind === "symbol") {
        /* `;` завершает оператор, `)` — заголовок блока. */
        return token.raw === ";" || token.raw === ")";
    }

    return token.kind === "identifier" &&
        BLOCK_END.has(normalizeIdentifier(token.value));
}

/** Блоки внутри выделения открыты и закрыты в нём же. */
function blocksBalanced(tokens: readonly IRslToken[]): boolean {
    let depth = 0;

    for (const token of tokens) {
        if (token.kind !== "identifier") {
            continue;
        }

        const word = normalizeIdentifier(token.value);

        if (BLOCK_START.has(word)) {
            depth++;
        } else if (word === "end") {
            depth--;

            if (depth < 0) {
                return false;
            }
        } else if (BLOCK_END.has(word) && depth === 0) {
            /* ELSE или ELIF без своего IF: выделение разрезало ветвление. */
            return false;
        }
    }

    return depth === 0;
}

/** Что выделение объявляет, читает и во что пишет. */
function classify(
    tokens: readonly IRslToken[],
    locals: ReadonlyMap<string, RslSymbol>
): { declared: Set<string>; used: string[]; written: Set<string> } {
    const declared = new Set<string>();
    const written = new Set<string>();
    const used: string[] = [];
    const seen = new Set<string>();

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind !== "identifier") {
            continue;
        }

        const word = normalizeIdentifier(token.value);
        const previous = tokens[index - 1];
        const next = tokens[index + 1];

        if (
            previous &&
            previous.kind === "symbol" &&
            previous.raw === "." &&
            previous.end === token.start
        ) {
            /* Член объекта — другое имя. */
            continue;
        }

        if (
            previous &&
            previous.kind === "identifier" &&
            normalizeIdentifier(previous.value) === "var"
        ) {
            declared.add(word);

            continue;
        }

        if (!locals.has(word)) {
            continue;
        }

        if (next && next.kind === "symbol" && next.raw === "=") {
            written.add(word);
        }

        /*
         * Передача по ссылке — это и чтение, и запись: вызванная процедура
         * может сделать с переменной что угодно.
         */
        if (previous && previous.kind === "symbol" && previous.raw === "@") {
            written.add(word);
        }

        if (!seen.has(word)) {
            seen.add(word);
            used.push(word);
        }
    }

    return { declared, used, written };
}

/** Имена процедуры, которые встречаются вне выделения. */
function referencedOutside(
    module: IIndexedModule,
    procedure: RslSymbol,
    bounds: { start: number; end: number }
): Set<string> {
    const result = new Set<string>();

    for (const token of module.syntax.tokens) {
        if (
            token.kind !== "identifier" ||
            token.start < procedure.range.start ||
            token.end > procedure.range.end ||
            (token.start >= bounds.start && token.end <= bounds.end)
        ) {
            continue;
        }

        result.add(normalizeIdentifier(token.value));
    }

    return result;
}

import {
    isRslKeyword,
    isRslSystemConstant,
    isRslType
} from "../language/rslLanguageReference";
import { normalizeIdentifier, type IRslToken } from "../lexer";
import type { IRslSyntaxNode } from "../syntaxParser";
import {
    isRslSpecialVariableReference
} from "../systemSpecialVariables";
import type { IIndexedModule } from "../workspaceIndex";

/**
 * Общие факты об именах и областях для проверок имён.
 *
 * Ими пользуются две разные проверки: «переменная не объявлена» (цели
 * присваивания, локальная фаза) и «идентификатор не определён» (все имена,
 * межфайловая фаза). Пока они жили одной функцией, общее и частное были
 * перемешаны, и правило одной проверки — например требование полного
 * Import-контекста — молча выключало другую.
 */

export interface IRslOffsetRange {
    start: number;
    end: number;
}

/**
 * Области, в которых есть настоящее объявление VAR.
 *
 * Считается по дереву разбора: только узел объявления переменной, а не слово
 * «var» в тексте. Областью считается ближайшая Macro или Class, а для
 * объявлений верхнего уровня — файл целиком: объявление модуля видно из любой
 * его процедуры, а объявление в соседней процедуре — нет.
 *
 * Диапазоны отдаются отсортированными и склеенными: по ним потом двигается
 * один курсор. Границы сравниваются целиком — по началу И концу: область файла
 * и первая процедура файла могут начинаться с одного и того же нуля, и по
 * одному началу они склеивались в одну.
 */
export function collectRslVarScopes(
    module: IIndexedModule
): readonly IRslOffsetRange[] {
    const candidates: {
        declarationStart: number;
        scope: IRslOffsetRange;
    }[] = [];
    const wholeFile = { start: 0, end: module.source.length };

    const visit = (
        node: IRslSyntaxNode,
        scope: IRslOffsetRange
    ): void => {
        for (const child of node.children) {
            if (
                child.kind === "VariableDeclaration" &&
                child.name === "var" &&
                child.children.length > 0
            ) {
                candidates.push({
                    declarationStart: child.start,
                    scope
                });
            }

            visit(
                child,
                child.kind === "MacroDeclaration" ||
                    child.kind === "ClassDeclaration"
                    ? { start: child.start, end: child.end }
                    : scope
            );
        }
    };

    visit(module.syntax.root, wholeFile);

    if (candidates.length === 0) {
        return [];
    }

    const afterDot = collectOffsetsAfterDot(module.syntax.tokens);
    const ranges: IRslOffsetRange[] = [];
    const seen = new Set<string>();

    for (const candidate of candidates) {
        /*
         * `obj.Var()` — обращение к члену с именем Var, и терпимый к ошибкам
         * разбор восстанавливается на нём узлом объявления. Объявлением это не
         * считается.
         */
        if (afterDot.has(candidate.declarationStart)) {
            continue;
        }

        const key = candidate.scope.start + ":" + candidate.scope.end;

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        ranges.push(candidate.scope);
    }

    return mergeRanges(ranges);
}

/**
 * Попадает ли смещение в область с объявлением VAR.
 *
 * Двоичный поиск, а не перебор: диапазоны отсортированы и склеены, а звать эту
 * проверку приходится на каждую цель присваивания.
 */
export function isInsideVarScope(
    scopes: readonly IRslOffsetRange[],
    offset: number
): boolean {
    let low = 0;
    let high = scopes.length - 1;

    while (low <= high) {
        const middle = (low + high) >> 1;
        const range = scopes[middle];

        if (offset < range.start) {
            high = middle - 1;
            continue;
        }

        if (offset > range.end) {
            low = middle + 1;
            continue;
        }

        return true;
    }

    return false;
}

/** Смещения имён, стоящих сразу после точки: один проход по токенам. */
export function collectOffsetsAfterDot(
    tokens: readonly IRslToken[]
): ReadonlySet<number> {
    const result = new Set<number>();
    let afterDot = false;

    for (const token of tokens) {
        if (
            token.kind === "whitespace" || token.kind === "comment" ||
            token.kind === "bom"
        ) {
            continue;
        }

        if (afterDot) {
            result.add(token.start);
        }

        afterDot = token.kind === "symbol" && token.raw === ".";
    }

    return result;
}

/** Диапазоны по возрастанию, пересекающиеся склеены. */
function mergeRanges(
    ranges: readonly IRslOffsetRange[]
): readonly IRslOffsetRange[] {
    const sorted = [...ranges].sort((left, right) =>
        left.start - right.start || left.end - right.end
    );
    const result: IRslOffsetRange[] = [];

    for (const range of sorted) {
        const last = result[result.length - 1];

        if (last && range.start <= last.end) {
            last.end = Math.max(last.end, range.end);
            continue;
        }

        result.push({ start: range.start, end: range.end });
    }

    return result;
}

/**
 * Начала имён всех объявлений документа.
 *
 * Только selectionRange: там и стоит имя. range у Macro начинается на ключевом
 * слове, и добавлять его значило бы глушить проверку по случайному совпадению
 * позиций.
 */
export function collectRslDeclarationStarts(
    module: IIndexedModule
): ReadonlySet<number> {
    const result = new Set<number>();
    const walk = (symbol: IIndexedModule["symbolTree"]): void => {
        for (const child of symbol.children) {
            result.add(child.selectionRange.start);
            walk(child);
        }
    };

    walk(module.symbolTree);
    return result;
}

export function collectRslImportRanges(
    module: IIndexedModule
): readonly IRslOffsetRange[] {
    return module.syntax.root.children
        .filter(node => node.kind === "ImportDeclaration")
        .map(node => ({ start: node.start, end: node.end }));
}

/** Попадает ли токен в диапазон Import, на котором стоит указатель. */
export function isInsideRslImport(
    ranges: readonly IRslOffsetRange[],
    index: number,
    token: IRslToken
): boolean {
    const range = ranges[index];
    return !!range && range.start <= token.start && token.end <= range.end;
}

/** Имя ближайшей области: Macro, метод или класс; пусто для модуля. */
export function rslScopeNameAt(module: IIndexedModule, offset: number): string {
    let name = "";
    let current = module.symbolTree;

    for (;;) {
        const nested = current.children.find(child =>
            child.isContainer &&
            child.range.start <= offset &&
            offset <= child.range.end
        );

        if (!nested) {
            return name;
        }
        name = name ? `${name}.${nested.name}` : nested.name;
        current = nested;
    }
}

/**
 * Идентификатор в позиции выражения.
 *
 * Исключается всё, что выражением не является: имя объявления, тип после ':',
 * имя после точки, имя внутри Import, ключевое слово, системная константа и
 * общесистемная спецпеременная.
 */
export function isRslExpressionIdentifier(
    tokens: readonly IRslToken[],
    index: number,
    declarationStarts: ReadonlySet<number>
): boolean {
    const token = tokens[index];
    const word = normalizeIdentifier(token.value);

    /*
     * Спецпеременная — любое имя в фигурных скобках, и объявлять её в макросе
     * не требуется: значение подставляет система. Прежде исключение делалось
     * только для двадцати восьми общесистемных, поэтому {GROUP_MODE} из
     * SbCrdInter и заведённая банком {Филиал} объявлялись «необъявленными».
     */
    if (
        isRslKeyword(word) ||
        isRslType(word) ||
        isRslSystemConstant(word) ||
        isRslSpecialVariableReference(token.raw)
    ) {
        return false;
    }

    /* Имя объявления: сам VAR его и объявляет. */
    if (declarationStarts.has(token.start)) {
        return false;
    }

    const previous = previousRslCode(tokens, index);

    /* Имя после точки — поле или метод; состав объекта нам неизвестен. */
    if (previous?.kind === "symbol" && previous.raw === ".") {
        return false;
    }

    /*
     * Имя после ':' — тип, а не переменная. Ссылочный параметр `@name`
     * переменной как раз является, поэтому '@' здесь не отсекается.
     */
    if (previous?.kind === "symbol" && previous.raw === ":") {
        return false;
    }

    /* Имя сразу за ключевым словом объявления: объявление, а не выражение. */
    if (
        previous?.kind === "identifier" &&
        isDeclarationIntroducer(previous.value)
    ) {
        return false;
    }

    return true;
}

/**
 * Имя слева от «=», начинающее инструкцию.
 *
 * Именно так в RSL появляется переменная без VAR: `sss = "ddfdf"`. От
 * сравнения `==` отличается самим оператором, а от `a.b = 1` и
 * `arr[i] = 1` — тем, что слева стоит одно имя.
 */
export function isRslSimpleAssignmentTarget(
    tokens: readonly IRslToken[],
    index: number
): boolean {
    const next = nextRslCode(tokens, index);

    if (!next || next.kind !== "symbol" || next.raw !== "=") {
        return false;
    }

    const previous = previousRslCode(tokens, index);

    if (!previous) {
        return true;
    }

    if (previous.kind === "symbol") {
        return previous.raw === ";";
    }

    if (previous.kind === "identifier" &&
        isBlockBoundaryWord(previous.value)) {
        return true;
    }

    /* Инструкция с новой строки: точка с запятой выше пропущена. */
    return previous.endLine < tokens[index].line;
}

function isBlockBoundaryWord(value: string): boolean {
    const word = normalizeIdentifier(value);

    return word === "end" || word === "else" || word === "elif" ||
        word === "onerror" || word === "then";
}

function isDeclarationIntroducer(value: string): boolean {
    const word = normalizeIdentifier(value);
    return word === "var" || word === "const" || word === "array" ||
        word === "file" || word === "record" || word === "macro" ||
        word === "class";
}

export function nextRslCode(
    tokens: readonly IRslToken[],
    index: number
): IRslToken | undefined {
    for (let current = index + 1; current < tokens.length; current++) {
        const token = tokens[current];

        if (isCodeToken(token)) {
            return token;
        }
    }

    return undefined;
}

export function previousRslCode(
    tokens: readonly IRslToken[],
    index: number
): IRslToken | undefined {
    const found = previousRslCodeIndex(tokens, index);

    return found >= 0 ? tokens[found] : undefined;
}

/** Индекс предыдущего значащего токена; -1 — его нет. */
export function previousRslCodeIndex(
    tokens: readonly IRslToken[],
    index: number
): number {
    for (let current = index - 1; current >= 0; current--) {
        if (isCodeToken(tokens[current])) {
            return current;
        }
    }

    return -1;
}

function isCodeToken(token: IRslToken): boolean {
    return token.kind !== "comment" &&
        token.kind !== "whitespace" &&
        token.kind !== "newline" &&
        token.kind !== "bom";
}

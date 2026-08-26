import * as fs from "fs";

import { CompletionItemKind } from "vscode-languageserver";

import {
    isRslKeyword,
    isRslSystemConstant,
    isRslType
} from "../language/rslLanguageReference";
import { normalizeIdentifier, type IRslToken } from "../lexer";
import type { RslSymbol } from "../symbols/rslSymbol";
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
 * Имя слева от «=», начинающее инструкцию: `sss = "ddfdf"`.
 *
 * Именно так в RSL появляется переменная без VAR. От сравнения `==`
 * отличается самим оператором, а от `a.b = 1`, `arr[i] = 1` и
 * `Call() = 1` — тем, что слева стоит одно имя: у них перед «=» стоят
 * «.», «]» и «)» соответственно, а перед самим именем — не начало
 * инструкции.
 *
 * Порядок условий значим. Сначала перевод строки: новая строка — новая
 * инструкция, даже если точка с запятой выше пропущена. Прежде первым
 * проверялся предыдущий символ, и всё, что стоит после закрывающей
 * скобки условия, проверку не проходило — ни `if (known == 1)` с
 * присваиванием на следующей строке, ни однострочный вариант.
 *
 * Дерево выражений тут не поможет: на рабочем пути оно не строится
 * (buildExpressionTree: false), и узла AssignmentExpression в модели
 * открытого файла нет.
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

    /* Инструкция с новой строки. */
    if (previous.endLine < tokens[index].line) {
        return true;
    }

    if (previous.kind === "symbol") {
        /*
         * Закрывающая скобка — это конец заголовка if, while или for,
         * за которым начинается тело: `if (known == 1) Typo = known;`.
         */
        return previous.raw === ";" || previous.raw === ")";
    }

    return previous.kind === "identifier" &&
        isBlockBoundaryWord(previous.value);
}

/** Слово, за которым начинается инструкция тела блока. */
function isBlockBoundaryWord(value: string): boolean {
    const word = normalizeIdentifier(value);

    return word === "end" || word === "else" || word === "elif" ||
        word === "onerror";
}

function nextRslCode(
    tokens: readonly IRslToken[],
    index: number
): IRslToken | undefined {
    for (let current = index + 1; current < tokens.length; current++) {
        if (isCodeToken(tokens[current])) {
            return tokens[current];
        }
    }

    return undefined;
}

function isDeclarationIntroducer(value: string): boolean {
    const word = normalizeIdentifier(value);
    return word === "var" || word === "const" || word === "array" ||
        word === "file" || word === "record" || word === "macro" ||
        word === "class";
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

/**
 * Область файла: где начинается, где кончается и что в ней объявлено.
 *
 * Имена объявленных переменных лежат множеством, вложенные области —
 * отсортированным массивом. Обход детей перебором стоил бы столько же, сколько
 * их в области, а у модуля с четырьмя тысячами процедур это четыре тысячи
 * сравнений на КАЖДУЮ цель присваивания.
 */
interface IRslScopeNode {
    symbol: RslSymbol;
    start: number;
    end: number;
    name: string;
    variables: Set<string>;
    /**
     * Написание имени: нормализованное имя — как оно объявлено.
     *
     * Поиск в RSL регистронезависим, поэтому variables хранит имена
     * приведёнными. Но предложение «заменить на» вставляет имя в код, и
     * вставлять его в нижнем регистре нельзя: в файле объявлено
     * `documentNumber`, а исправление писало `documentnumber`.
     */
    displayNames: Map<string, string>;
    children: readonly IRslScopeNode[];
}

/**
 * Факты файла, общие для всех целей присваивания.
 *
 * Считаются один раз: обход дерева ради областей с VAR и обход объявлений — по
 * несколько миллисекунд на большом файле, а целей присваивания в нём тысячи.
 */
export interface IRslAssignmentCheckFacts {
    varScopes: readonly IRslOffsetRange[];
    declarationStarts: ReadonlySet<number>;
    knownGlobals: ReadonlySet<string>;
    scopes: IRslScopeNode;
    /**
     * Инициализаторы циклов: `for (i = 0; …)` — до первой «;».
     *
     * Только там присваивание вводит переменную цикла. Условие и шаг —
     * обычный код: пока объявлением считался весь заголовок, опечатка в
     * `for (i = 0; typo < 3; typo = typo + 1)` скрывалась целиком.
     */
    forInitializers: readonly IRslOffsetRange[];
}

export function createRslAssignmentCheckFacts(
    module: IIndexedModule,
    knownGlobalsFile?: string
): IRslAssignmentCheckFacts {
    const scopes = buildScopeNode(module.symbolTree, "");
    const loops = collectRslForLoops(module);

    for (const variable of loops.variables) {
        const chain = scopeChainAt(scopes, variable.start);
        const scope = chain[chain.length - 1];

        if (scope) {
            const normalized = normalizeIdentifier(variable.name);

            scope.variables.add(normalized);

            if (!scope.displayNames.has(normalized)) {
                scope.displayNames.set(normalized, variable.name);
            }
        }
    }

    return {
        varScopes: collectRslVarScopes(module),
        declarationStarts: collectRslDeclarationStarts(module),
        knownGlobals: readKnownGlobals(knownGlobalsFile),
        scopes,
        forInitializers: loops.initializers
    };
}

/** Дерево областей файла с именами объявленных в них переменных. */
function buildScopeNode(symbol: RslSymbol, path: string): IRslScopeNode {
    const variables = new Set<string>();
    const displayNames = new Map<string, string>();
    const children: IRslScopeNode[] = [];

    for (const child of symbol.children) {
        if (isRslVariableSymbol(child)) {
            const normalized = normalizeIdentifier(child.name);

            variables.add(normalized);

            if (!displayNames.has(normalized)) {
                displayNames.set(normalized, child.name);
            }
        }

        if (child.isContainer) {
            children.push(buildScopeNode(
                child,
                path ? `${path}.${child.name}` : child.name
            ));
        }
    }

    children.sort((left, right) => left.start - right.start);

    return {
        symbol,
        start: symbol.range.start,
        end: symbol.range.end,
        name: path,
        variables,
        displayNames,
        children
    };
}

/**
 * Инициализаторы циклов for и введённые в них переменные.
 *
 * Один проход по потоку токенов на весь файл. Прежде диапазон каждого
 * заголовка искался просмотром токенов ОТ НАЧАЛА ФАЙЛА, и на файле с
 * циклами это снова стало квадратичным: 2,3 мс на 250 циклах и 84 мс на
 * двух тысячах — учетверение времени на каждое удвоение.
 *
 * Переменной цикла считается только имя из инициализатора — до первой «;»
 * внутри скобок. Условие и шаг проверяются как обычный код.
 */
export function collectRslForLoops(module: IIndexedModule): {
    initializers: readonly IRslOffsetRange[];
    variables: readonly { start: number; name: string }[];
} {
    const starts = collectForStatementStarts(module.syntax.root);

    if (starts.length === 0) {
        return { initializers: [], variables: [] };
    }

    const tokens = module.syntax.tokens;
    const initializers: IRslOffsetRange[] = [];
    const variables: { start: number; name: string }[] = [];
    /* Открытый заголовок: ждём его скобок. Вложенных заголовков не бывает. */
    let open: {
        depth: number;
        from: number;
        inInitializer: boolean;
    } | undefined;
    let next = 0;

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        while (next < starts.length && starts[next] <= token.start) {
            /*
             * Дошли до ключевого слова FOR. Заголовок открывается только
             * если скобка стоит СРАЗУ за ним.
             *
             * RSL допускает бесконечный цикл без заголовка — `for` … `end;`.
             * Пока автомат ждал первую скобку где угодно, он принимал за
             * заголовок скобки первой команды тела: в `for` + `Foo(parm =
             * known);` присваивание внутри вызова становилось
             * «инициализатором», а `parm` — переменной цикла, и опечатка
             * пропадала из Problems целиком.
             */
            const following = tokens[index + 1];

            open = following &&
                following.kind === "symbol" && following.raw === "("
                ? { depth: 0, from: -1, inInitializer: false }
                : undefined;
            next++;
        }

        if (!open) {
            continue;
        }

        if (token.kind === "symbol") {
            if (token.raw === "(") {
                open.depth++;

                if (open.depth === 1) {
                    open.from = token.end;
                    open.inInitializer = true;
                }

                continue;
            }

            if (token.raw === ";" && open.depth === 1 && open.inInitializer) {
                initializers.push({ start: open.from, end: token.start });
                open.inInitializer = false;
                continue;
            }

            if (token.raw === ")") {
                open.depth--;

                if (open.depth <= 0) {
                    /* Заголовок без «;»: инициализатор — всё, что в скобках. */
                    if (open.inInitializer && open.from >= 0) {
                        initializers.push({
                            start: open.from,
                            end: token.start
                        });
                    }

                    open = undefined;
                }

                continue;
            }

            continue;
        }

        if (
            token.kind !== "identifier" ||
            !open.inInitializer ||
            open.depth !== 1
        ) {
            continue;
        }

        /* Токены синтаксического потока идут без пробелов и комментариев. */
        const following = tokens[index + 1];

        if (following && following.kind === "symbol" &&
            following.raw === "=") {
            variables.push({
                start: token.start,
                name: normalizeIdentifier(token.value)
            });
        }
    }

    initializers.sort((left, right) => left.start - right.start);

    return { initializers, variables };
}

/** Смещения ключевых слов FOR по возрастанию: один обход дерева. */
function collectForStatementStarts(root: IRslSyntaxNode): number[] {
    const result: number[] = [];

    const visit = (node: IRslSyntaxNode): void => {
        if (node.kind === "ForStatement") {
            result.push(node.start);
        }

        for (const child of node.children) {
            visit(child);
        }
    };

    visit(root);
    result.sort((left, right) => left - right);

    return result;
}


/**
 * Цепочка областей от модуля до самой внутренней, содержащей смещение.
 *
 * Спуск двоичным поиском: у модуля с тысячами процедур перебор детей стоил бы
 * столько же, сколько процедур, и проверка становилась квадратичной — на 646 КБ
 * это 5,9 секунды вместо 0,2.
 */
function scopeChainAt(
    root: IRslScopeNode,
    offset: number
): readonly IRslScopeNode[] {
    const chain: IRslScopeNode[] = [root];
    let current = root;

    for (;;) {
        const next = childAt(current.children, offset);

        if (!next) {
            return chain;
        }

        chain.push(next);
        current = next;
    }
}

function childAt(
    children: readonly IRslScopeNode[],
    offset: number
): IRslScopeNode | undefined {
    let low = 0;
    let high = children.length - 1;

    while (low <= high) {
        const middle = (low + high) >> 1;
        const child = children[middle];

        if (offset < child.start) {
            high = middle - 1;
            continue;
        }

        if (offset > child.end) {
            low = middle + 1;
            continue;
        }

        return child;
    }

    return undefined;
}


/**
 * Объявлена ли в этой области переменная с таким именем.
 *
 * Спрашивают обе проверки. Строгой это нужно, чтобы не сообщать о
 * переменной, которую сама же область и объявляет: `x = 1; Var x;` — это
 * вопрос проверки «использование выше объявления», а не «имя не
 * определено», и переменная заголовка `for (i = 0; …)` объявлена не хуже.
 */
export function isRslDeclaredVariableName(
    facts: IRslAssignmentCheckFacts,
    offset: number,
    name: string
): boolean {
    const wanted = normalizeIdentifier(name);

    return scopeChainAt(facts.scopes, offset)
        .some(scope => scope.variables.has(wanted));
}

/** Ближайший объемлющий класс: его база даёт унаследованные поля. */
export function enclosingRslClassScope(
    facts: IRslAssignmentCheckFacts,
    offset: number
): RslSymbol | undefined {
    const chain = scopeChainAt(facts.scopes, offset);

    for (let index = chain.length - 1; index >= 0; index--) {
        if (chain[index].symbol.kind === CompletionItemKind.Class) {
            return chain[index].symbol;
        }
    }

    return undefined;
}

/**
 * Имена переменных, видимых в этой точке.
 *
 * Нужны Quick Fix: подобрать ближайшее по написанию имя можно только среди
 * переменных и параметров — процедура или класс целью присваивания не станут.
 */
export function visibleRslVariableNames(
    facts: IRslAssignmentCheckFacts,
    offset: number
): string[] {
    const result = new Set<string>();

    for (const scope of scopeChainAt(facts.scopes, offset)) {
        for (const name of scope.variables) {
            /* Имя отдаётся в том написании, в каком объявлено. */
            result.add(scope.displayNames.get(name) || name);
        }
    }

    return [...result].sort();
}

/** Имя области для находки: `Holder.Method`. */
export function rslScopePathAt(
    facts: IRslAssignmentCheckFacts,
    offset: number
): string {
    const chain = scopeChainAt(facts.scopes, offset);

    return chain.length > 0 ? chain[chain.length - 1].name : "";
}

export function isRslVariableSymbol(
    symbol: { kind: CompletionItemKind }
): boolean {
    return symbol.kind === CompletionItemKind.Variable ||
        symbol.kind === CompletionItemKind.Property ||
        symbol.kind === CompletionItemKind.Field;
}

/*
 * Список известных имён кэшируется по пути и времени правки: он читается на
 * каждую проверку файла, а меняется вручную и редко.
 */
interface IKnownGlobalsCacheEntry {
    modifiedMs: number;
    size: number;
    names: ReadonlySet<string>;
}

const knownGlobalsCache = new Map<string, IKnownGlobalsCacheEntry>();
const EMPTY_NAMES: ReadonlySet<string> = new Set<string>();

export function readKnownGlobals(filePath?: string): ReadonlySet<string> {
    if (!filePath) {
        return EMPTY_NAMES;
    }

    try {
        const stats = fs.statSync(filePath);
        const cached = knownGlobalsCache.get(filePath);

        if (
            cached &&
            cached.modifiedMs === stats.mtimeMs &&
            cached.size === stats.size
        ) {
            return cached.names;
        }

        const names = new Set<string>();

        for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
            const value = line.replace(/#.*$/, "").trim();

            if (value) {
                names.add(normalizeIdentifier(value));
            }
        }

        knownGlobalsCache.set(filePath, {
            modifiedMs: stats.mtimeMs,
            size: stats.size,
            names
        });
        return names;
    } catch (_error) {
        /*
         * Нечитаемый файл списка не должен ни ронять сервер, ни превращаться в
         * поток ложных предупреждений: считаем, что список пуст.
         */
        return EMPTY_NAMES;
    }
}

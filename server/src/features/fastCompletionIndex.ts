import { CompletionItem, CompletionItemKind } from "vscode-languageserver";

import {
    BLOCK_START_KEYWORDS,
    END_KEYWORD,
    isDeclarationModifier
} from "../language/rslLanguageReference";
import {
    cachedSignificantTokens,
    normalizeIdentifier,
    type IRslToken
} from "../lexer";
import type { IFastDocumentSnapshot } from "../services/fastDocumentSnapshot";

/**
 * Область видимости: тело Macro, метода или класса.
 *
 * Хранятся только границы и ссылка на объемлющую область — этого достаточно,
 * чтобы по смещению курсора восстановить цепочку видимости.
 */
export interface IFastScope {
    start: number;
    end: number;
    /** Индекс объемлющей области; -1 — верхний уровень модуля. */
    parent: number;
    kind: "macro" | "class";
}

/** Объявление имени: переменная, константа, параметр или поле класса. */
export interface IFastBinding {
    name: string;
    /** Индекс области; -1 — верхний уровень модуля. */
    scope: number;
    /** Написанный или выведенный тип; пусто, если тип неизвестен. */
    typeName: string;
    start: number;
    isConstant: boolean;
}

export interface IFastClassMember {
    name: string;
    kind: "macro" | "variable";
    typeName: string;
    isPrivate: boolean;
}

export interface IFastClassInfo {
    start: number;
    end: number;
    members: IFastClassMember[];
}

/** Что известно об имени в этой точке. */
export interface IFastNameLookup {
    /** Объявление найдено: внешнее одноимённое затенено и смотреть его нельзя. */
    declared: boolean;
    typeName: string;
}

/**
 * Всё, что нужно Completion до готовности полной модели, посчитанное один раз
 * на версию текста.
 *
 * Прежде каждый запрос заново извлекал объявления всего файла: на модуле 400 КБ
 * это 19 мс в медиане и до 34 мс в худшем случае — и только подготовка, до
 * сборки самого списка. Ввод идёт посимвольно, и эта работа повторялась на
 * каждое нажатие клавиши.
 *
 * Состав нарочно компактный: имена, границы и типы, без дескрипторов и без
 * ссылок на токены. Дескрипторы держать нельзя — на файле 1,1 МБ это около
 * 7 МиБ на документ.
 */
export interface IFastCompletionIndex {
    /**
     * Поток токенов, по которому индекс построен.
     *
     * Он и есть признак версии содержимого: каждое лексирование возвращает
     * новый массив. Пары URI и номера версии для этого мало — номер начинается
     * заново, когда файл закрыли и открыли снова, и тогда к новому тексту
     * прилагался бы прежний индекс.
     */
    tokens: readonly IRslToken[];
    version: number;
    scopes: IFastScope[];
    /** Объявления по нормализованному имени; порядок — по тексту. */
    bindings: Map<string, IFastBinding[]>;
    /** Классы файла по нормализованному имени; несколько — неоднозначность. */
    classes: Map<string, IFastClassInfo[]>;
    imports: string[];
    /** Классы и процедуры файла: они видны из любой его точки. */
    globalItems: CompletionItem[];
    /**
     * Объявления по областям; ключ -1 — верхний уровень модуля.
     *
     * Хранятся сами объявления, а не готовые элементы списка: элементов на файл
     * в 400 КБ около пятнадцати тысяч, и создавать их при построении значит
     * платить за все области ради одной, в которой стоит курсор.
     */
    scopeBindings: Map<number, IFastBinding[]>;
    /**
     * Методы по областям классов.
     *
     * Их немного — по одному на метод, — поэтому готовые элементы списка здесь
     * дешевле, чем восстановление на каждый запрос.
     */
    scopeMethods: Map<number, CompletionItem[]>;
}

/*
 * Индексы живут ровно у тех документов, в которых сейчас печатают.
 *
 * Записей немного: смысл кэша — обслужить поток нажатий в одном файле, а не
 * хранить проект.
 */
const INDEX_LIMIT = 4;
const indexByUri = new Map<string, IFastCompletionIndex>();

/** Индекс этой версии; строится при первом обращении. */
export function getFastCompletionIndex(
    snapshot: IFastDocumentSnapshot
): IFastCompletionIndex {
    const known = indexByUri.get(snapshot.uri);

    if (known && known.tokens === snapshot.lex.tokens) {
        return known;
    }

    const built = buildFastCompletionIndex(snapshot);
    indexByUri.delete(snapshot.uri);
    indexByUri.set(snapshot.uri, built);

    while (indexByUri.size > INDEX_LIMIT) {
        const oldest = indexByUri.keys().next().value as string | undefined;

        if (oldest === undefined) {
            break;
        }
        indexByUri.delete(oldest);
    }

    return built;
}

/**
 * Освобождает индекс документа.
 *
 * Вызывается, когда готова полная модель: приблизительный ответ больше не
 * нужен, а держать его до следующей правки значит держать память зря.
 */
export function dropFastCompletionIndex(uri: string): void {
    indexByUri.delete(uri);
}

/** Области, содержащие смещение, от внутренней к внешней. */
export function scopeChainAt(
    index: IFastCompletionIndex,
    offset: number
): number[] {
    let innermost = -1;

    for (let position = 0; position < index.scopes.length; position++) {
        const scope = index.scopes[position];

        if (scope.start > offset) {
            break;
        }

        if (offset <= scope.end) {
            /* Области перечислены по тексту: вложенная идёт после объемлющей. */
            innermost = position;
        }
    }

    const chain: number[] = [];

    for (
        let current = innermost;
        current >= 0;
        current = index.scopes[current].parent
    ) {
        chain.push(current);
    }

    return chain;
}

/**
 * Ближайшее видимое объявление имени.
 *
 * Именно ближайшее, а не первое подходящее: нетипизированный параметр или
 * локальная переменная затеняют внешнее имя, и тип внешнего к этой точке
 * отношения не имеет. Прежний поиск шёл по тексту назад и брал первое
 * объявление, у которого тип нашёлся, — то есть проходил сквозь затенение.
 */
export function lookupFastName(
    index: IFastCompletionIndex,
    name: string,
    offset: number
): IFastNameLookup {
    const candidates = index.bindings.get(normalizeIdentifier(name));

    if (!candidates) {
        return { declared: false, typeName: "" };
    }

    for (const scope of scopeChainAt(index, offset)) {
        const found = nearestBinding(candidates, scope, offset);

        if (found) {
            return { declared: true, typeName: found.typeName };
        }
    }

    const moduleLevel = nearestBinding(candidates, -1, offset);

    return moduleLevel
        ? { declared: true, typeName: moduleLevel.typeName }
        : { declared: false, typeName: "" };
}

/**
 * Последнее объявление имени в области, стоящее не позже точки.
 *
 * Не позже — потому что выше объявления имя в этой области ещё не видно. Если
 * все объявления ниже, берётся первое из них: обращение до объявления
 * ошибочно, но затенение оно всё равно создаёт.
 */
function nearestBinding(
    candidates: readonly IFastBinding[],
    scope: number,
    offset: number
): IFastBinding | undefined {
    let result: IFastBinding | undefined;

    for (const candidate of candidates) {
        if (candidate.scope !== scope) {
            continue;
        }

        if (candidate.start <= offset) {
            result = candidate;
        } else if (!result) {
            result = candidate;
            break;
        }
    }

    return result;
}

/** Класс файла по имени; undefined, если его нет или имя неоднозначно. */
export function findFastClass(
    index: IFastCompletionIndex,
    className: string
): IFastClassInfo | undefined {
    const found = index.classes.get(normalizeIdentifier(className));

    /*
     * Неоднозначное имя не разрешается вовсе: показать члены первого
     * попавшегося класса значит подсказать наугад, а выбор компилятора здесь,
     * без полной модели, неизвестен.
     */
    return found && found.length === 1 ? found[0] : undefined;
}

/** Имена, видимые в этой точке: общие плюс собственные объемлющих областей. */
export function visibleFastItems(
    index: IFastCompletionIndex,
    offset: number
): CompletionItem[] {
    const result = index.globalItems.slice();
    const chain = scopeChainAt(index, offset);
    chain.push(-1);

    for (const scope of chain) {
        const methods = index.scopeMethods.get(scope);

        if (methods) {
            result.push(...methods);
        }

        for (const binding of index.scopeBindings.get(scope) || []) {
            result.push({
                label: binding.name,
                kind: binding.isConstant
                    ? CompletionItemKind.Constant
                    : CompletionItemKind.Variable,
                detail: binding.typeName || undefined
            });
        }
    }

    return result;
}

/** Открытый блок: у Macro и Class есть область, у IF и WHILE — нет. */
interface IOpenBlock {
    scope: number;
    classInfo?: IFastClassInfo;
}

type AddBinding = (
    name: string,
    typeName: string,
    start: number,
    isConstant: boolean,
    isPrivate: boolean
) => void;

/**
 * Один проход по значимым токенам.
 *
 * Общий извлекатель объявлений здесь намеренно не используется: он сам стоит
 * около 19 мс на модуле 400 КБ, а его результата всё равно не хватает —
 * локальных переменных Macro он не сохраняет, у параметров теряет написанный
 * тип, а начальное значение показывает как variant. Строить индекс поверх него
 * значило бы заплатить дважды и всё равно досканировать файл.
 */
function buildFastCompletionIndex(
    snapshot: IFastDocumentSnapshot
): IFastCompletionIndex {
    const tokens = cachedSignificantTokens(snapshot.lex.tokens);
    const scopes: IFastScope[] = [];
    const classes = new Map<string, IFastClassInfo[]>();
    const bindings = new Map<string, IFastBinding[]>();
    const globalItems: CompletionItem[] = [];
    const scopeBindings = new Map<number, IFastBinding[]>();
    const imports: string[] = [];
    const blocks: IOpenBlock[] = [];
    let modifier = "";

    const currentScope = (): number =>
        blocks.length > 0 ? blocks[blocks.length - 1].scope : -1;

    const enclosingClass = (): IFastClassInfo | undefined => {
        for (let level = blocks.length - 1; level >= 0; level--) {
            const info = blocks[level].classInfo;

            if (info) {
                return info;
            }
        }

        return undefined;
    };

    const scopeMethods = new Map<number, CompletionItem[]>();
    /* Метод класса виден по имени только внутри своего класса. */
    const addItem = (scope: number, item: CompletionItem): void => {
        const own = scopeMethods.get(scope);

        if (own) {
            own.push(item);
        } else {
            scopeMethods.set(scope, [item]);
        }
    };

    const addBinding: AddBinding = (
        name,
        typeName,
        start,
        isConstant,
        isPrivate
    ) => {
        const scope = currentScope();
        const key = normalizeIdentifier(name);
        const list = bindings.get(key);
        const binding: IFastBinding = {
            name,
            scope,
            typeName,
            start,
            isConstant
        };

        if (list) {
            list.push(binding);
        } else {
            bindings.set(key, [binding]);
        }

        const inScope = scopeBindings.get(scope);

        if (inScope) {
            inScope.push(binding);
        } else {
            scopeBindings.set(scope, [binding]);
        }

        const owner = blocks.length > 0
            ? blocks[blocks.length - 1].classInfo
            : undefined;

        if (owner) {
            /* Объявление прямо в теле класса — это его поле. */
            owner.members.push({
                name,
                kind: "variable",
                typeName,
                isPrivate
            });
        }

    };

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind !== "identifier") {
            continue;
        }

        const word = normalizeIdentifier(token.value);

        if (word === END_KEYWORD) {
            const block = blocks.pop();

            if (block) {
                scopes[block.scope].end = token.end;

                if (block.classInfo) {
                    block.classInfo.end = token.end;
                }
            }
            modifier = "";
            continue;
        }

        if (isDeclarationModifier(word)) {
            modifier = word;
            continue;
        }

        if (word === "macro" || word === "class") {
            index = openScope(tokens, index, word, {
                scopes,
                blocks,
                classes,
                globalItems,
                addItem,
                addBinding,
                owner: enclosingClass()
            });
            modifier = "";
            continue;
        }

        if (BLOCK_START_KEYWORDS.includes(word)) {
            /* IF, WHILE, FOR и WITH тоже закрываются END, но области не дают. */
            blocks.push({ scope: currentScope() });
            modifier = "";
            continue;
        }

        if (word === "var" || word === "const") {
            index = readDeclarationList(
                tokens,
                index,
                word === "const",
                modifier === "private" || modifier === "local",
                addBinding
            );
            modifier = "";
            continue;
        }

        if (word === "import") {
            index = readImport(tokens, index, imports);
        }
        modifier = "";
    }

    /* Незакрытые блоки: файл в правке, и END ещё не набран. */
    for (const block of blocks) {
        scopes[block.scope].end = snapshot.text.length;

        if (block.classInfo) {
            block.classInfo.end = snapshot.text.length;
        }
    }

    snapshot.imports = imports;

    return {
        tokens: snapshot.lex.tokens,
        version: snapshot.version,
        scopes,
        bindings,
        classes,
        imports,
        globalItems: deduplicateByLabel(globalItems),
        scopeBindings,
        scopeMethods
    };
}

interface IScopeContext {
    scopes: IFastScope[];
    blocks: IOpenBlock[];
    classes: Map<string, IFastClassInfo[]>;
    globalItems: CompletionItem[];
    addItem(scope: number, item: CompletionItem): void;
    addBinding: AddBinding;
    owner: IFastClassInfo | undefined;
}

/** Заголовок Macro или Class: область, имя, параметры и членство в классе. */
function openScope(
    tokens: readonly IRslToken[],
    keywordIndex: number,
    word: string,
    context: IScopeContext
): number {
    const { scopes, blocks, classes, globalItems } = context;
    const parent = blocks.length > 0 ? blocks[blocks.length - 1].scope : -1;
    const scope = scopes.length;
    const start = tokens[keywordIndex].start;
    scopes.push({
        start,
        end: start,
        parent,
        kind: word === "class" ? "class" : "macro"
    });

    let index = keywordIndex + 1;

    /* Базовый класс в скобках перед именем. */
    if (
        word === "class" &&
        tokens[index] &&
        tokens[index].kind === "symbol" &&
        tokens[index].raw === "("
    ) {
        index = skipParens(tokens, index) + 1;
    }

    const nameToken = tokens[index];
    const name = nameToken && nameToken.kind === "identifier"
        ? nameToken.value
        : "";

    if (name) {
        index++;
    }

    if (word === "class") {
        const info: IFastClassInfo = { start, end: start, members: [] };
        const key = normalizeIdentifier(name);
        const list = classes.get(key);

        if (list) {
            list.push(info);
        } else {
            classes.set(key, [info]);
        }

        if (name) {
            globalItems.push({ label: name, kind: CompletionItemKind.Class });
        }
        blocks.push({ scope, classInfo: info });
        return index - 1;
    }

    if (name && context.owner) {
        /*
         * Метод виден по имени только внутри своего класса: снаружи его
         * вызывают через объект.
         */
        context.owner.members.push({
            name,
            kind: "macro",
            typeName: "",
            isPrivate: false
        });
        context.addItem(parent, {
            label: name,
            kind: CompletionItemKind.Method
        });
    } else if (name) {
        globalItems.push({ label: name, kind: CompletionItemKind.Function });
    }

    blocks.push({ scope });

    /* Параметры принадлежат уже открытой области процедуры. */
    if (
        tokens[index] &&
        tokens[index].kind === "symbol" &&
        tokens[index].raw === "("
    ) {
        return readParameterList(tokens, index, context.addBinding);
    }

    return index - 1;
}

function skipParens(
    tokens: readonly IRslToken[],
    openIndex: number
): number {
    let depth = 0;

    for (let index = openIndex; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind !== "symbol") {
            continue;
        }

        if (token.raw === "(") {
            depth++;
        } else if (token.raw === ")") {
            depth--;

            if (depth === 0) {
                return index;
            }
        }
    }

    return openIndex;
}

/** Объявление вида Var a: TFile, b = TStringList(); до точки с запятой. */
function readDeclarationList(
    tokens: readonly IRslToken[],
    keywordIndex: number,
    isConstant: boolean,
    isPrivate: boolean,
    add: AddBinding
): number {
    let index = keywordIndex + 1;

    while (index < tokens.length) {
        const name = tokens[index];

        if (name.kind !== "identifier") {
            break;
        }

        const after = tokens[index + 1];
        let typeName = "";

        if (after && after.kind === "symbol" && after.raw === ":") {
            const written = tokens[index + 2];

            if (written && written.kind === "identifier") {
                typeName = written.value;
            }
        } else if (after && after.kind === "symbol" && after.raw === "=") {
            typeName = initializerTypeName(tokens, index + 2);
        }

        add(name.value, typeName, name.start, isConstant, isPrivate);
        index++;

        /* До следующего имени: выражение начального значения пропускается. */
        while (
            index < tokens.length &&
            !(tokens[index].kind === "symbol" &&
                (tokens[index].raw === "," || tokens[index].raw === ";"))
        ) {
            index++;
        }

        if (index >= tokens.length || tokens[index].raw === ";") {
            break;
        }
        index++;
    }

    return index;
}

/**
 * Тип из начального значения: "= TStringList" и "= TStringList()".
 *
 * Это те два случая, в которых тип виден без анализа. Всё сложнее — вызов
 * процедуры, член другого объекта, выражение — остаётся полной модели.
 */
function initializerTypeName(
    tokens: readonly IRslToken[],
    valueIndex: number
): string {
    const value = tokens[valueIndex];

    if (!value || value.kind !== "identifier") {
        return "";
    }

    const after = tokens[valueIndex + 1];
    const isCallOrEnd = !after ||
        (after.kind === "symbol" &&
            (after.raw === "(" || after.raw === ";" || after.raw === ","));

    return isCallOrEnd ? value.value : "";
}

/** Список параметров вместе с написанными типами. */
function readParameterList(
    tokens: readonly IRslToken[],
    openIndex: number,
    add: AddBinding
): number {
    let index = openIndex + 1;

    while (index < tokens.length) {
        const token = tokens[index];

        if (token.kind === "symbol" && token.raw === ")") {
            return index;
        }

        if (token.kind !== "identifier") {
            index++;
            continue;
        }

        const after = tokens[index + 1];
        let typeName = "";

        if (after && after.kind === "symbol" && after.raw === ":") {
            const written = tokens[index + 2];

            if (written && written.kind === "identifier") {
                typeName = written.value;
            }
        }

        add(token.value, typeName, token.start, false, false);

        while (
            index < tokens.length &&
            !(tokens[index].kind === "symbol" &&
                (tokens[index].raw === "," || tokens[index].raw === ")"))
        ) {
            index++;
        }

        if (
            index < tokens.length &&
            tokens[index].kind === "symbol" &&
            tokens[index].raw === ","
        ) {
            index++;
        }
    }

    return index;
}

/** Имя модуля идёт сразу за словом Import и заканчивается точкой с запятой. */
function readImport(
    tokens: readonly IRslToken[],
    keywordIndex: number,
    imports: string[]
): number {
    const parts: string[] = [];
    let index = keywordIndex + 1;

    while (index < tokens.length) {
        const token = tokens[index];

        if (token.kind === "symbol" && token.raw === ";") {
            break;
        }

        parts.push(token.kind === "string" ? token.value : token.raw);
        index++;
    }

    const name = parts.join("").trim();

    if (name) {
        imports.push(name);
    }

    return index;
}

function deduplicateByLabel(
    items: readonly CompletionItem[]
): CompletionItem[] {
    const seen = new Map<string, CompletionItem>();

    for (const item of items) {
        const key = item.label.toLowerCase();

        if (!seen.has(key)) {
            seen.set(key, item);
        }
    }

    return Array.from(seen.values());
}

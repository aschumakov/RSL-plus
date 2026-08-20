import { CompletionItem, CompletionItemKind } from "vscode-languageserver";

import {
    BLOCK_START_KEYWORDS,
    DECLARATION_KEYWORDS,
    END_KEYWORD,
    isDeclarationModifier
} from "../language/rslLanguageReference";
import {
    cachedSignificantTokens,
    normalizeIdentifier,
    type IRslToken
} from "../lexer";
import { moduleReferenceKey } from "../indexing/moduleNames";
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
    /** Имя базового класса; пусто, если базы нет. */
    baseName: string;
    members: IFastClassMember[];
}

/**
 * Подпись процедуры этой версии текста.
 *
 * Нужна подсказке параметров: брать её у последней разобранной модели нельзя —
 * модель отстаёт на правку, и после переименования параметра подсказка
 * показывала прежний список.
 */
export interface IFastSignature {
    name: string;
    /** Параметры как они написаны: имя и, если указан, тип. */
    parameters: string[];
    /** Индекс области; -1 — процедура верхнего уровня модуля. */
    scope: number;
    /** Метод класса: снаружи вызывается только через объект. */
    isMethod: boolean;
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
    /** Подписи процедур и методов по нормализованному имени. */
    signatures: Map<string, IFastSignature[]>;
}

/* Слова, которые начинают объявление даже посреди строки. */
const DECLARATION_WORDS = new Set(DECLARATION_KEYWORDS);

/* Из них имена переменных вводят все, кроме MACRO и CLASS: у тех свои области. */
const DECLARES_NAMES = new Set(
    DECLARATION_KEYWORDS.filter(word => word !== "macro" && word !== "class")
);

/*
 * Индексы живут ровно у тех документов, в которых сейчас печатают.
 *
 * Порядок — по давности ОБРАЩЕНИЯ, а не создания: Map с переустановкой ключа
 * при попадании даёт настоящий LRU. Простая очередь этого не давала — активный
 * файл оставался самым давним и вытеснялся, хотя им и пользовались.
 *
 * Вес считается по тому, что принадлежит самому индексу: границы областей,
 * объявления, члены классов и элементы списка. Поток токенов сюда не входит —
 * его держит быстрый снимок документа, и вытеснение индекса его не освобождает:
 * по замеру на файле 253 КБ индекс отдаёт около 0,3 МиБ из 3, остальное живёт
 * вместе со снимком.
 */
const INDEX_BUDGET_ENTRIES = 120000;
const indexByUri = new Map<string, IFastCompletionIndex>();

/** Приблизительный вес индекса в записях. */
function indexWeight(index: IFastCompletionIndex): number {
    let members = 0;

    for (const list of index.classes.values()) {
        for (const info of list) {
            members += info.members.length;
        }
    }

    let scoped = 0;

    for (const list of index.scopeBindings.values()) {
        scoped += list.length;
    }

    let methods = 0;

    for (const list of index.scopeMethods.values()) {
        methods += list.length;
    }

    return index.scopes.length +
        index.globalItems.length +
        index.imports.length +
        members +
        scoped +
        methods;
}

/** Индекс этой версии; строится при первом обращении. */
export function getFastCompletionIndex(
    snapshot: IFastDocumentSnapshot
): IFastCompletionIndex {
    const known = indexByUri.get(snapshot.uri);

    if (known && known.tokens === snapshot.lex.tokens) {
        /* Попадание обновляет давность: иначе это очередь, а не LRU. */
        indexByUri.delete(snapshot.uri);
        indexByUri.set(snapshot.uri, known);
        return known;
    }

    const built = buildFastCompletionIndex(snapshot);
    indexByUri.delete(snapshot.uri);
    indexByUri.set(snapshot.uri, built);

    let weight = 0;

    for (const value of indexByUri.values()) {
        weight += indexWeight(value);
    }

    /* Самый давний по обращению уходит первым: Map хранит порядок вставки. */
    while (weight > INDEX_BUDGET_ENTRIES && indexByUri.size > 1) {
        const oldest = indexByUri.keys().next().value as string | undefined;

        if (oldest === undefined) {
            break;
        }

        const dropped = indexByUri.get(oldest);
        weight -= dropped ? indexWeight(dropped) : 0;
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
    className: string,
    offset: number
): IFastClassInfo | undefined {
    const found = index.classes.get(normalizeIdentifier(className));

    if (!found || found.length === 0) {
        return undefined;
    }

    if (found.length === 1) {
        return found[0];
    }

    /*
     * Одно имя на два объявления. Внутри одного из них выбор очевиден — это
     * оно; снаружи выбор компилятора без полной модели неизвестен, и показать
     * члены наугад хуже, чем не показать ничего.
     */
    return found.find(info => offset >= info.start && offset <= info.end);
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

/**
 * Открытый блок.
 *
 * Своя область есть только у Macro и Class. IF, WHILE, FOR и WITH тоже
 * закрываются словом END, но собственных имён не вводят, поэтому запоминаются
 * лишь для того, чтобы их END не закрыл чужую область.
 */
interface IOpenBlock {
    /** Индекс области; -1 — блок без собственной области. */
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
    const signatures = new Map<string, IFastSignature[]>();
    const imports: string[] = [];
    const blocks: IOpenBlock[] = [];
    let modifier = "";

    /** Ближайшая область: блоки без собственной области пропускаются. */
    const currentScope = (): number => {
        for (let level = blocks.length - 1; level >= 0; level--) {
            if (blocks[level].scope >= 0) {
                return blocks[level].scope;
            }
        }

        return -1;
    };

    /**
     * Класс, которому принадлежит объявляемая здесь процедура.
     *
     * Именно НЕПОСРЕДСТВЕННО объемлющий, а не любой вышестоящий: Macro внутри
     * метода — локальная процедура, а не второй метод класса. Прежний поиск шёл
     * вверх по всем блокам, и вложенная Macro становилась членом класса.
     */
    const owningClass = (): IFastClassInfo | undefined => {
        for (let level = blocks.length - 1; level >= 0; level--) {
            if (blocks[level].scope >= 0) {
                return blocks[level].classInfo;
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

        const owner = owningClass();

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

    /*
     * Ключевое слово опознаётся только там, где оно действительно ключевое.
     *
     * Те же три ограничения, что и у полного извлекателя объявлений: слово
     * должно начинать предложение, не стоять после точки и не быть внутри
     * скобок. Без них имя поля записи в obj.End закрывало Macro, а obj.Class
     * открывало новую область — на обычном коде подсказки просто пропадали.
     */
    let canStartStatement = true;
    let groupDepth = 0;
    let afterDot = false;
    let currentLine = -1;

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.line !== currentLine) {
            currentLine = token.line;
            canStartStatement = true;
            /*
             * Признак «после точки» не переживает перевод строки. Полный
             * извлекатель гасит его самим токеном перевода, а здесь их нет:
             * обход идёт по значимым токенам. Без сброса незаконченная строка
             * вида "self." — то есть ровно та, в которой и вызывают подсказку —
             * превращала следующее END в имя поля, и блок оставался незакрытым.
             */
            afterDot = false;
        }

        if (token.kind === "symbol") {
            if (token.raw === "(" || token.raw === "[" || token.raw === "{") {
                groupDepth++;
            } else if (
                token.raw === ")" || token.raw === "]" || token.raw === "}"
            ) {
                groupDepth = Math.max(0, groupDepth - 1);
            }

            if (token.raw === ";") {
                canStartStatement = true;
                /* Незакрытая скобка не должна глушить весь остаток файла. */
                groupDepth = 0;
            } else if (token.raw !== ",") {
                canStartStatement = false;
            }

            afterDot = token.raw === ".";
            continue;
        }

        if (token.kind !== "identifier") {
            canStartStatement = false;
            afterDot = false;
            continue;
        }

        const word = normalizeIdentifier(token.value);
        const previousAfterDot = afterDot;
        afterDot = false;

        /*
         * END обрабатывается до проверки начала инструкции: он закрывает
         * блок и посреди строки — например в
         * if (...) return X end;. Единственное ограничение — точка перед
         * ним: obj.End — это имя поля.
         */
        if (word === END_KEYWORD) {
            canStartStatement = false;
            modifier = "";

            if (previousAfterDot) {
                continue;
            }

            const closed = blocks.pop();

            if (closed && closed.scope >= 0) {
                scopes[closed.scope].end = token.end;

                if (closed.classInfo) {
                    closed.classInfo.end = token.end;
                }
            }
            continue;
        }

        /*
         * Остальные слова обязаны начинать инструкцию. Исключение — те же,
         * что и у полного извлекателя: объявление и Import опознаются и
         * посреди строки, но только вне скобок и не после точки.
         */
        if (
            !canStartStatement &&
            !(
                groupDepth === 0 &&
                !previousAfterDot &&
                (DECLARATION_WORDS.has(word) || word === "import")
            )
        ) {
            canStartStatement = false;
            modifier = "";
            continue;
        }

        if (previousAfterDot || groupDepth > 0) {
            canStartStatement = false;
            modifier = "";
            continue;
        }

        canStartStatement = false;

        if (isDeclarationModifier(word)) {
            modifier = word;
            /* Модификатор относится к следующему слову той же инструкции. */
            canStartStatement = true;
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
                signatures,
                owner: owningClass(),
                isPrivate: modifier === "private" || modifier === "local"
            });
            modifier = "";
            continue;
        }

        if (BLOCK_START_KEYWORDS.includes(word)) {
            /*
             * IF, WHILE, FOR и WITH тоже закрываются END, но собственной
             * области не вводят. Прежде такой блок запоминал ЧУЖУЮ область и
             * его END закрывал её: на верхнем уровне это обращение к
             * scopes[-1] и исключение, внутри Macro — преждевременный конец
             * этой Macro.
             */
            blocks.push({ scope: -1 });
            modifier = "";
            continue;
        }

        /*
         * Имена вводят не только VAR и CONST: ARRAY, FILE и RECORD — тоже
         * объявления, и в реальном коде поля класса объявляют через ARRAY.
         */
        if (DECLARES_NAMES.has(word)) {
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
        if (block.scope < 0) {
            continue;
        }

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
        scopeMethods,
        signatures
    };
}

interface IScopeContext {
    scopes: IFastScope[];
    blocks: IOpenBlock[];
    classes: Map<string, IFastClassInfo[]>;
    globalItems: CompletionItem[];
    addItem(scope: number, item: CompletionItem): void;
    addBinding: AddBinding;
    /** Подписи процедур этой версии: их собирает openScope. */
    signatures: Map<string, IFastSignature[]>;
    /** Класс, которому принадлежит объявление; undefined — это не метод. */
    owner: IFastClassInfo | undefined;
    isPrivate: boolean;
}

/** Заголовок Macro или Class: область, имя, параметры и членство в классе. */
function openScope(
    tokens: readonly IRslToken[],
    keywordIndex: number,
    word: string,
    context: IScopeContext
): number {
    /* Параметры процедуры запоминаются по ходу чтения списка. */
    const parameters: string[] = [];
    const { scopes, blocks, classes, globalItems } = context;
    /* Родитель — ближайшая настоящая область: IF и WHILE её не создают. */
    let parent = -1;

    for (let level = blocks.length - 1; level >= 0; level--) {
        if (blocks[level].scope >= 0) {
            parent = blocks[level].scope;
            break;
        }
    }
    const start = tokens[keywordIndex].start;
    let index = keywordIndex + 1;

    /* Базовый класс в скобках перед именем: class (TRsbPanel) tPanel. */
    let baseName = "";

    if (
        word === "class" &&
        tokens[index] &&
        tokens[index].kind === "symbol" &&
        tokens[index].raw === "("
    ) {
        const closing = skipParens(tokens, index);

        for (let inside = index + 1; inside < closing; inside++) {
            if (tokens[inside].kind === "identifier") {
                baseName = tokens[inside].value;
                break;
            }
        }

        index = closing + 1;
    }

    const nameToken = tokens[index];
    const name = nameToken && nameToken.kind === "identifier"
        ? nameToken.value
        : "";

    /*
     * Имени ещё нет — заголовок как раз набирают. Область без имени не
     * создаётся: членов и подсказок она не даёт, а её END закрывал бы чужой
     * блок. Полный извлекатель поступает так же.
     */
    if (!name) {
        return keywordIndex;
    }
    index++;
    const scope = scopes.length;
    scopes.push({
        start,
        end: start,
        parent,
        kind: word === "class" ? "class" : "macro"
    });

    if (word === "class") {
        const info: IFastClassInfo = {
            start,
            end: start,
            baseName,
            members: []
        };
        const key = normalizeIdentifier(name);
        const list = classes.get(key);

        if (list) {
            list.push(info);
        } else {
            classes.set(key, [info]);
        }

        globalItems.push({ label: name, kind: CompletionItemKind.Class });

        if (context.owner) {
            /* Класс, объявленный в теле класса, — его член. */
            context.owner.members.push({
                name,
                kind: "variable",
                typeName: name,
                isPrivate: context.isPrivate
            });
        }

        blocks.push({ scope, classInfo: info });
        return index - 1;
    }

    if (context.owner) {
        /*
         * Метод виден по имени только внутри своего класса: снаружи его
         * вызывают через объект.
         */
        context.owner.members.push({
            name,
            kind: "macro",
            typeName: "",
            isPrivate: context.isPrivate
        });

        if (!context.isPrivate || parent >= 0) {
            context.addItem(parent, {
                label: name,
                kind: CompletionItemKind.Method
            });
        }
    } else if (parent >= 0) {
        /*
         * Macro внутри другой Macro — локальная процедура: она видна только в
         * объемлющей области. Прежде такая процедура попадала в общий список и
         * предлагалась по всему файлу.
         */
        context.addItem(parent, {
            label: name,
            kind: CompletionItemKind.Function
        });
    } else {
        globalItems.push({ label: name, kind: CompletionItemKind.Function });
    }

    blocks.push({ scope });

    /* Параметры принадлежат уже открытой области процедуры. */
    if (
        tokens[index] &&
        tokens[index].kind === "symbol" &&
        tokens[index].raw === "("
    ) {
        const after = readParameterList(
            tokens,
            index,
            (name, typeName, start, isConstant, isPrivate) => {
                parameters.push(typeName ? name + ":" + typeName : name);
                context.addBinding(name, typeName, start, isConstant, isPrivate);
            }
        );
        rememberSignature(context, name, parent, parameters);

        return after;
    }

    rememberSignature(context, name, parent, parameters);

    return index - 1;
}

/** Запоминает подпись процедуры этой версии текста. */
function rememberSignature(
    context: IScopeContext,
    name: string,
    parent: number,
    parameters: readonly string[]
): void {
    const key = normalizeIdentifier(name);

    if (!key) {
        return;
    }

    const signature: IFastSignature = {
        name,
        parameters: [...parameters],
        scope: parent,
        isMethod: !!context.owner
    };
    const list = context.signatures.get(key);

    if (list) {
        list.push(signature);
    } else {
        context.signatures.set(key, [signature]);
    }
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

/**
 * Слово, на котором объявление заведомо кончилось.
 *
 * Имя после точки ключевым словом не считается — то же правило, что и в главном
 * цикле. Без него Var x = obj.End; заканчивал объявление на слове End, и это
 * слово доставалось главному циклу как закрытие блока: Macro закрывалась
 * посреди себя, а obj.Class открывал ложный класс.
 */
function endsDeclaration(
    tokens: readonly IRslToken[],
    index: number
): boolean {
    const token = tokens[index];

    if (!token || token.kind !== "identifier") {
        return false;
    }

    const previous = tokens[index - 1];

    /*
     * Точка влияет только на имя той же строки. Незаконченная строка вида
     * Var x = obj. — обычное состояние при наборе, и следующее END должно
     * закрывать блок, а не считаться членом объекта.
     */
    if (
        previous &&
        previous.kind === "symbol" &&
        previous.raw === "." &&
        previous.line === token.line
    ) {
        return false;
    }

    const word = normalizeIdentifier(token.value);

    return word === END_KEYWORD ||
        word === "import" ||
        isDeclarationModifier(word) ||
        DECLARATION_WORDS.has(word) ||
        BLOCK_START_KEYWORDS.includes(word);
}

/**
 * Написанный тип после двоеточия.
 *
 * Знак @ перед именем типа означает передачу по ссылке и к самому типу
 * отношения не имеет, поэтому пропускается.
 */
function writtenTypeName(
    tokens: readonly IRslToken[],
    colonIndex: number
): string {
    let index = colonIndex + 1;

    if (
        tokens[index] &&
        tokens[index].kind === "symbol" &&
        tokens[index].raw === "@"
    ) {
        index++;
    }

    const written = tokens[index];
    return written && written.kind === "identifier" ? written.value : "";
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

        if (name.kind !== "identifier" || endsDeclaration(tokens, index)) {
            /*
             * Служебное слово принадлежит уже следующей инструкции: вернуть
             * нужно позицию ПЕРЕД ним, иначе главный цикл его перескочит и
             * END не закроет блок.
             */
            return index - 1;
        }

        const after = tokens[index + 1];
        let typeName = "";

        if (after && after.kind === "symbol" && after.raw === ":") {
            typeName = writtenTypeName(tokens, index + 1);
        } else if (after && after.kind === "symbol" && after.raw === "=") {
            typeName = initializerTypeName(tokens, index + 2);
        }

        add(name.value, typeName, name.start, isConstant, isPrivate);
        index++;

        /*
         * До следующего имени. Запятая считается разделителем объявлений
         * только вне скобок: в Var x = Make(a, b) запятая принадлежит
         * вызову, и b объявлением не является.
         */
        let depth = 0;

        while (index < tokens.length) {
            const token = tokens[index];

            if (token.kind === "symbol") {
                if (
                    token.raw === "(" || token.raw === "[" ||
                    token.raw === "{"
                ) {
                    depth++;
                } else if (
                    token.raw === ")" || token.raw === "]" ||
                    token.raw === "}"
                ) {
                    depth = Math.max(0, depth - 1);
                } else if (
                    depth === 0 &&
                    (token.raw === "," || token.raw === ";")
                ) {
                    break;
                }
            } else if (depth === 0 && endsDeclaration(tokens, index)) {
                /*
                 * Точку с запятой в конце объявления ставят не всегда:
                 * Var A = 1, B = 2 end; встречается в реальном коде. Без этой
                 * проверки END доставался списку объявлений и класс оставался
                 * незакрытым до конца файла.
                 */
                return index - 1;
            }

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
            typeName = writtenTypeName(tokens, index + 1);
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

/**
 * Имена модулей после слова Import и до точки с запятой.
 *
 * Их может быть несколько через запятую, и путь может быть строкой:
 * Import common, "foldercards.mac"; — это два модуля, а не один с
 * запятой в имени. Прежде всё до точки с запятой склеивалось в одну строку,
 * и ни один из модулей не находился.
 */
function readImport(
    tokens: readonly IRslToken[],
    keywordIndex: number,
    imports: string[]
): number {
    let parts: string[] = [];
    let index = keywordIndex + 1;

    const flush = (): void => {
        const name = parts.join("").trim();
        parts = [];

        /*
         * Повтор того же модуля отбрасывается — так же, как это делает общий
         * извлекатель. Список уходит в разрешение модулей, и он обязан
         * совпадать с тем, что построит полный путь.
         */
        if (name && !imports.some(known => moduleReferenceKey(known) === moduleReferenceKey(name))) {
            imports.push(name);
        }
    };

    while (index < tokens.length) {
        const token = tokens[index];

        if (token.kind === "symbol" && token.raw === ";") {
            break;
        }

        if (token.kind === "symbol" && token.raw === ",") {
            flush();
            index++;
            continue;
        }

        /*
         * Точку с запятой пользователь ещё не набрал — и именно в этот момент
         * подсказка и нужна. Без остановки на следующем служебном слове весь
         * остаток файла становился одним именем модуля: Import lib с новой
         * строки давал импорт libMacroWork()End, и ни одной области.
         */
        if (endsDeclaration(tokens, index)) {
            flush();
            return index - 1;
        }

        parts.push(token.kind === "string" ? token.value : token.raw);
        index++;
    }

    flush();
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

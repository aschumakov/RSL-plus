import {
    CompletionItem,
    CompletionItemKind
} from "vscode-languageserver";

import {
    DEFAULT_WHITESPACES,
    STOP_CHARS,
    varType,
    kwdNum,
    SkipComment,
    OLC,
    MLC_O,
    MLC_C,
    DIGITS
} from "./enums";

import {
    ArrayClass,
    getDefaults
} from "./defaults";

import {
    getTree
} from "./server";

import {
    lexRsl
} from "./lexer";

import {
    IFAStruct,
    If_s,
    IArray,
    IRange,
    CAbstractBase,
    IToken,
    TokenKind
} from "./interfaces";


/**
 * RSL parser revision:
 * 2026-07-17-v3-backslash-parity
 *
 * В этой версии кавычки всегда являются границами токена.
 * Это важно для конструкций вида:
 * "select ...@" + DBLink + " where ..."
 */
export const RSL_PARSER_VERSION =
    "2026-07-20-v5-shared-lexer";

/**
 * Внутреннее описание токена.
 *
 * range содержит позиции относительно source текущего CBase.
 */
interface IParserToken extends IToken {
    kind: TokenKind;
}


class CArray implements IArray {
    _it: Array<string>;

    constructor() {
        this._it = new Array<string>();
    }

    is(it: string): If_s<number> {
        const normalized = (it || "").toLowerCase();
        const result = this._it.indexOf(normalized);

        return {
            first: result >= 0,
            second: result
        };
    }

    str(num: number): string {
        return this._it[num];
    }
}


class CEnds extends CArray {
    constructor() {
        super();

        this._it[0] = "class";
        this._it[1] = "macro";
        this._it[2] = "if";
        this._it[3] = "for";
        this._it[4] = "while";
    }
}


class Ctypes extends CArray {
    constructor() {
        super();

        this._it[varType._variant] = "variant";
        this._it[varType._integer] = "integer";
        this._it[varType._double] = "double";
        this._it[varType._doublel] = "doublel";
        this._it[varType._string] = "string";
        this._it[varType._bool] = "bool";
        this._it[varType._date] = "date";
        this._it[varType._time] = "time";
        this._it[varType._datetime] = "datetime";
        this._it[varType._memaddr] = "memaddr";
        this._it[varType._procref] = "procref";
        this._it[varType._methodref] = "methodref";
        this._it[varType._decimal] = "decimal";
        this._it[varType._numeric] = "numeric";
        this._it[varType._money] = "money";
        this._it[varType._moneyl] = "moneyl";
        this._it[varType._specval] = "specval";
    }
}


class Ckeywords extends CArray {
    constructor() {
        super();

        this._it[kwdNum._array] = "array";
        this._it[kwdNum._end] = "end";
        this._it[kwdNum._or] = "or";
        this._it[kwdNum._break] = "break";
        this._it[kwdNum._file] = "file";
        this._it[kwdNum._private] = "private";
        this._it[kwdNum._class] = "class";
        this._it[kwdNum._for] = "for";
        this._it[kwdNum._record] = "record";
        this._it[kwdNum._const] = "const";
        this._it[kwdNum._if] = "if";
        this._it[kwdNum._return] = "return";
        this._it[kwdNum._continue] = "continue";
        this._it[kwdNum._import] = "import";
        this._it[kwdNum._var] = "var";
        this._it[kwdNum._cpdos] = "cpdos";
        this._it[kwdNum._local] = "local";
        this._it[kwdNum._while] = "while";
        this._it[kwdNum._cpwin] = "cpwin";
        this._it[kwdNum._macro] = "macro";
        this._it[kwdNum._with] = "with";
        this._it[kwdNum._elif] = "elif";
        this._it[kwdNum._not] = "not";
        this._it[kwdNum._else] = "else";
        this._it[kwdNum._onerror] = "onerror";
        this._it[kwdNum._olc] = OLC;
        this._it[kwdNum._mlc_o] = MLC_O;
        this._it[kwdNum._mlc_c] = MLC_C;
    }
}


class CstrItemKind extends CArray {
    constructor() {
        super();

        this._it[CompletionItemKind.Text] = "Текст";
        this._it[CompletionItemKind.Method] = "Метод";
        this._it[CompletionItemKind.Function] = "Функция";
        this._it[CompletionItemKind.Constructor] = "Конструктор";
        this._it[CompletionItemKind.Field] = "Поле";
        this._it[CompletionItemKind.Variable] = "Переменная";
        this._it[CompletionItemKind.Class] = "Класс";
        this._it[CompletionItemKind.Interface] = "Интерфейс";
        this._it[CompletionItemKind.Module] = "Модуль";
        this._it[CompletionItemKind.Property] = "Свойство";
        this._it[CompletionItemKind.Unit] = "Unit";
        this._it[CompletionItemKind.Value] = "Значение";
        this._it[CompletionItemKind.Enum] = "Перечисление";
        this._it[CompletionItemKind.Keyword] = "Ключевое слово";
        this._it[CompletionItemKind.Snippet] = "Сниппет";
        this._it[CompletionItemKind.Color] = "Цвет";
        this._it[CompletionItemKind.File] = "Файл";
        this._it[CompletionItemKind.Reference] = "Ссылка";
        this._it[CompletionItemKind.Folder] = "Папка";
        this._it[CompletionItemKind.EnumMember] = "Член перечисления";
        this._it[CompletionItemKind.Constant] = "Константа";
        this._it[CompletionItemKind.Struct] = "Структура";
        this._it[CompletionItemKind.Event] = "Событие";
        this._it[CompletionItemKind.Operator] = "Оператор";
        this._it[CompletionItemKind.TypeParameter] = "Параметр типа";
    }
}


function getStrItemKind(kind: number): string {
    return STR_ITEM_KIND.str(kind);
}


function getTypeStr(typeNum: varType): string {
    return TYPES.str(typeNum);
}


function processImportNames(value: string): string[] {
    const names = value.split(",");
    const result: string[] = [];

    names.forEach(rawName => {
        let name = rawName.trim();

        if (name.length === 0) {
            return;
        }

        if (
            name.length >= 2 &&
            name.charAt(0) === "\"" &&
            name.charAt(name.length - 1) === "\""
        ) {
            name = name.substring(1, name.length - 1).trim();
        }

        if (name.length > 0) {
            result.push(name);
        }
    });

    return result;
}


export const tokensWithEnd: CEnds = new CEnds();
export const TYPES: Ctypes = new Ctypes();
export const KEYWORDS: Ckeywords = new Ckeywords();
export const STR_ITEM_KIND: CstrItemKind = new CstrItemKind();


export class CVar extends CAbstractBase {
    private value: string;

    constructor(
        name: string,
        privateFlag: boolean,
        isConstant: boolean,
        isProperty: boolean
    ) {
        super();

        this.value = "";
        this.name = name;
        this.private_ = privateFlag;
        this.objKind = isProperty
            ? CompletionItemKind.Property
            : (
                isConstant
                    ? CompletionItemKind.Constant
                    : CompletionItemKind.Variable
            );
        this.insertedText = name;
    }

    setValue(value: string): void {
        this.value = value;
    }

    updateCIInfo(): void {
        this.detail = `${getStrItemKind(this.objKind)}: ${this.name}`;

        if (this.value.length > 0) {
            this.detail += ` = ${this.value}`;
        }

        this.detail += `,\nтип ${this.varType_}`;
    }

    isActual(pos: number): boolean {
        return this.range.end < pos;
    }

    RecursiveFind(_name: string): CAbstractBase | undefined {
        return undefined;
    }

    reParsing(): void {
        // Для переменной повторный разбор не требуется.
    }
}


/**
 * Базовый объект синтаксического дерева.
 *
 * source — фрагмент исходного файла.
 * offset — абсолютная позиция source[0] в документе.
 */
export class CBase extends CAbstractBase {
    protected childs: Array<CBase>;
    protected source: string;
    protected paramStr: string;
    protected position: number;
    protected savedPos: number;
    protected offset: number;
    private tokenCache: IParserToken[];

    constructor(
        src: string,
        offset: number,
        objKind: CompletionItemKind = CompletionItemKind.Unit
    ) {
        super();

        this.childs = new Array<CBase>();
        this.source = src || "";
        this.paramStr = "";
        this.position = 0;
        this.savedPos = 0;
        this.offset = offset;
        this.tokenCache = new Array<IParserToken>();
        this.objKind = objKind;
        this.range = {
            start: offset,
            end: offset + this.source.length
        };

        this.parse();
        this.tokenCache = this.buildTokenCache();
    }

    updateCIInfo(): void {
        // Корневой узел не отображается как CompletionItem.
    }

    isActual(pos: number): boolean {
        return this.range.start < pos && pos < this.range.end;
    }

    RecursiveFind(name: string): CBase | undefined {
        const normalizedName = (name || "").toLowerCase();

        for (const child of this.childs) {
            if (child.Name.toLowerCase() === normalizedName) {
                return child;
            }

            const nested = child.RecursiveFind(name);

            if (nested !== undefined) {
                return nested;
            }
        }

        return undefined;
    }

    reParsing(): void {
        this.position = 0;
        this.parse();
        this.tokenCache = this.buildTokenCache();
    }

    getChilds(): Array<CBase> {
        return this.childs;
    }

    addChild(node: CBase): void {
        this.childs.push(node);
    }

    setType(type: string): void {
        this.varType_ = type;
    }

    getActualChilds(position: number): Array<CBase> {
        const answer: Array<CBase> = new Array<CBase>();

        if (position !== 0) {
            this.childs.forEach(parent => {
                if (parent.Range.end < position) {
                    answer.push(parent);
                }

                if (parent.isActual(position) && parent.isObject()) {
                    parent.childs.forEach(child => {
                        answer.push(child);
                    });
                }
            });
        } else {
            this.childs.forEach(parent => {
                if (!parent.Private) {
                    answer.push(parent);
                }
            });
        }

        return answer;
    }

    /**
     * Возвращает токен в заданной абсолютной позиции.
     *
     * Токены строятся один раз вместе с деревом. Поиск выполняется
     * бинарно, поэтому hover/completion не сканируют файл от начала.
     */
    getCurrentToken(
        absolutePosition: number,
        _savePosition: boolean = true
    ): IToken | undefined {
        const localPosition =
            absolutePosition - this.offset;

        if (
            localPosition < 0 ||
            localPosition > this.source.length ||
            this.tokenCache.length === 0
        ) {
            return undefined;
        }

        let left = 0;
        let right = this.tokenCache.length - 1;
        let candidateIndex = -1;

        /*
         * Ищем последний токен, начало которого не правее курсора.
         */
        while (left <= right) {
            const middle =
                Math.floor((left + right) / 2);

            const token = this.tokenCache[middle];

            if (token.range.start <= localPosition) {
                candidateIndex = middle;
                left = middle + 1;
            } else {
                right = middle - 1;
            }
        }

        if (candidateIndex < 0) {
            return undefined;
        }

        const candidate =
            this.tokenCache[candidateIndex];

        /*
         * end хранится как позиция сразу после токена. Сохраняем
         * совместимость со старым поведением: курсор ровно после
         * идентификатора всё ещё относится к этому идентификатору.
         */
        if (localPosition <= candidate.range.end) {
            return candidate;
        }

        return undefined;
    }

    /**
     * Создаёт полный лексический кэш, включая комментарии,
     * строки и квадратные текстовые блоки.
     *
     * Основной parse() может пропускать комментарии, поэтому кэш
     * строится отдельным линейным проходом после создания дерева.
     */
    private buildTokenCache(): IParserToken[] {
        return lexRsl(this.source).tokens
            .filter(token =>
                token.kind !== "whitespace" &&
                token.kind !== "newline" &&
                token.kind !== "bom"
            )
            .map(token => ({
                str: token.kind === "square"
                    ? "[]"
                    : token.raw,
                range: {
                    start: token.start,
                    end: token.end
                },
                kind: token.kind === "identifier" ||
                    token.kind === "number" ||
                    token.kind === "symbol"
                        ? "code"
                        : token.kind
            } as IParserToken));
    }

    ChildsCIInfo(
        isCheckPrivate: boolean = false,
        position: number = 0,
        isCheckActual: boolean = false
    ): Array<CompletionItem> {
        const answer: Array<CompletionItem> =
            new Array<CompletionItem>();

        this.childs.forEach(element => {
            if (isCheckActual) {
                if (element.Range.end < position) {
                    if (!isCheckPrivate || !element.Private) {
                        answer.push(element.CIInfo);
                    }
                } else if (element.isActual(position)) {
                    element.ChildsCIInfo().forEach(info => {
                        answer.push(info);
                    });
                }

                return;
            }

            if (!isCheckPrivate || !element.Private) {
                answer.push(element.CIInfo);
            }
        });

        if (this.ObjKind === CompletionItemKind.Class) {
            const currentClass = this as unknown as CClass;
            const parentName = currentClass.getParentName();
            let parent: CBase | undefined;

            if (parentName.length > 0) {
                const tree = getTree() || [];

                for (const module of tree) {
                    parent = module.object.RecursiveFind(parentName);

                    if (parent !== undefined) {
                        break;
                    }
                }
            }

            if (parent !== undefined) {
                parent.childs.forEach(child => {
                    if (!child.Private) {
                        answer.push(child.CIInfo);
                    }
                });
            }
        }

        return answer;
    }

    protected getKeywordNum(token: string): If_s<number> {
        return KEYWORDS.is((token || "").toLowerCase());
    }

    protected CurIndex(index: number): string {
        if (index < 0 || index >= this.source.length) {
            return "";
        }

        return this.source.charAt(index);
    }

    protected get CurrentChar(): string {
        return this.CurIndex(this.position);
    }

    protected get Pos(): number {
        return this.position;
    }

    protected get End(): boolean {
        return this.position >= this.source.length;
    }

    protected Next(): void {
        if (!this.End) {
            this.position++;
        }
    }

    protected Skip(): void {
        while (
            !this.End &&
            DEFAULT_WHITESPACES.indexOf(this.CurrentChar) >= 0
        ) {
            this.Next();
        }
    }

    protected IsStopChar(): boolean {
        return STOP_CHARS.indexOf(this.CurrentChar) >= 0;
    }

    protected RestorePos(): void {
        this.position = this.savedPos;
    }

    protected SavePos(): void {
        this.savedPos = this.position;
    }

    /**
     * Находит тело macro/class до соответствующего End.
     *
     * NextToken возвращает строки и [многострочные блоки] единым
     * непрозрачным токеном, поэтому End внутри SQL/PLSQL здесь
     * не влияет на глубину RSL-блоков.
     */
    protected getObjectBody(): string {
        const bodyStart = this.Pos;
        let openedBlocks = 1;
        let closedBlocks = 0;

        while (
            openedBlocks !== closedBlocks &&
            !this.End
        ) {
            const token = this.NextToken();
            const normalized = token.str.toLowerCase();

            if (token.str.length === 0) {
                break;
            }

            if (
                (token as IParserToken).kind === "string" ||
                (token as IParserToken).kind === "square"
            ) {
                continue;
            }

            if (tokensWithEnd.is(normalized).first) {
                openedBlocks++;
            } else if (normalized === "end") {
                closedBlocks++;
            }
        }

        return this.source.substring(bodyStart, this.Pos);
    }

    /**
     * Читает следующий токен.
     *
     * Особые области:
     * - "строка" возвращается одним токеном;
     * - однострочные и многострочные комментарии пропускаются при SkipComment.yes;
     * - [ ... ] возвращается одним токеном kind=square;
     * - End внутри особых областей никогда не становится RSL-токеном.
     */
    protected NextToken(
        skipComment: SkipComment = SkipComment.yes
    ): IParserToken {
        while (true) {
            this.Skip();

            const start = this.Pos;

            if (this.End) {
                return {
                    str: "",
                    range: {
                        start,
                        end: start
                    },
                    kind: "code"
                };
            }

            if (this.startsWithAt(OLC, this.Pos)) {
                this.position += OLC.length;

                if (skipComment === SkipComment.no) {
                    return {
                        str: OLC,
                        range: {
                            start,
                            end: this.Pos
                        },
                        kind: "code"
                    };
                }

                this.GetOLC();
                continue;
            }

            if (this.startsWithAt(MLC_O, this.Pos)) {
                this.position += MLC_O.length;

                if (skipComment === SkipComment.no) {
                    return {
                        str: MLC_O,
                        range: {
                            start,
                            end: this.Pos
                        },
                        kind: "code"
                    };
                }

                this.GetMLC();
                continue;
            }

            if (this.CurrentChar === "[") {
                this.skipSquareTextBlock();

                return {
                    str: "[]",
                    range: {
                        start,
                        end: this.Pos
                    },
                    kind: "square"
                };
            }

            if (
                this.CurrentChar === "\"" ||
                this.CurrentChar === "'"
            ) {
                const quote = this.CurrentChar;

                /*
                 * В RSL кавычка экранируется обратной косой чертой.
                 * Решение о закрытии строки принимается по чётности
                 * количества подряд идущих \ перед кавычкой.
                 */
                this.skipQuotedString(
                    quote,
                    true,
                    false
                );

                return {
                    str: this.source.substring(start, this.Pos),
                    range: {
                        start,
                        end: this.Pos
                    },
                    kind: "string"
                };
            }

            if (this.IsStopChar()) {
                const value = this.CurrentChar;
                this.Next();

                return {
                    str: value,
                    range: {
                        start,
                        end: this.Pos
                    },
                    kind: "code"
                };
            }

            while (
                !this.End &&
                !this.IsStopChar() &&
                this.CurrentChar !== "\"" &&
                this.CurrentChar !== "'" &&
                !this.startsWithAt(OLC, this.Pos) &&
                !this.startsWithAt(MLC_O, this.Pos)
            ) {
                this.Next();
            }

            return {
                str: this.source.substring(start, this.Pos),
                range: {
                    start,
                    end: this.Pos
                },
                kind: "code"
            };
        }
    }

    protected IsToken(value: string): boolean {
        if (value.length === 0) {
            return false;
        }

        const keyword = KEYWORDS.is(value.toLowerCase());

        if (keyword.first) {
            return this.IsStopChar();
        }

        return this.IsStopChar();
    }

    /**
     * Проверяет строку без создания временных substring.
     */
    private startsWithAt(value: string, position: number): boolean {
        if (position < 0) {
            return false;
        }

        return this.source.substr(position, value.length) === value;
    }

    /**
     * Пропускает строковый литерал.
     *
     * Правило экранирования RSL:
     * - \"  — кавычка экранирована;
     * - \\" — две обратные косые черты, затем конец строки;
     * - \\\" — кавычка снова экранирована.
     *
     * Иными словами, кавычка экранирована только при нечётном
     * количестве подряд идущих обратных косых черт перед ней.
     *
     * doubledQuoteEscapes используется для SQL/PLSQL внутри [ ... ],
     * где одинарная кавычка обычно экранируется как ''.
     */
    private skipQuotedString(
        quote: string,
        backslashEscapes: boolean,
        doubledQuoteEscapes: boolean
    ): void {
        if (this.CurrentChar !== quote) {
            return;
        }

        this.Next();

        while (!this.End) {
            if (this.CurrentChar !== quote) {
                this.Next();
                continue;
            }

            if (
                backslashEscapes &&
                this.isEscapedByBackslashes(this.Pos)
            ) {
                /*
                 * Кавычка является частью строки.
                 * Переходим за неё; обратные косые черты уже были
                 * просмотрены на предыдущих итерациях.
                 */
                this.Next();
                continue;
            }

            if (
                doubledQuoteEscapes &&
                this.CurIndex(this.Pos + 1) === quote
            ) {
                this.position += 2;
                continue;
            }

            this.Next();
            return;
        }
    }

    /**
     * Проверяет чётность последовательности обратных косых черт
     * непосредственно перед символом в position.
     */
    private isEscapedByBackslashes(
        position: number
    ): boolean {
        let backslashCount = 0;
        let index = position - 1;

        while (
            index >= 0 &&
            this.CurIndex(index) === "\\"
        ) {
            backslashCount++;
            index--;
        }

        return backslashCount % 2 === 1;
    }

    /**
     * Пропускает [многострочный текст].
     *
     * Поддерживает:
     * - вложенные квадратные скобки;
     * - одинарные и двойные SQL-строки;
     * - -- и // однострочные комментарии;
     * - многострочные SQL-комментарии.
     *
     * Поэтому PL/SQL BEGIN/END внутри блока не участвует
     * в построении структуры RSL.
     */
    private skipSquareTextBlock(): void {
        if (this.CurrentChar !== "[") {
            return;
        }

        let depth = 1;
        this.Next();

        while (!this.End && depth > 0) {
            const currentChar = this.CurIndex(this.Pos);

            if (this.startsWithAt("--", this.Pos)) {
                this.position += 2;
                this.skipToLineEnd();
                continue;
            }

            if (this.startsWithAt(OLC, this.Pos)) {
                this.position += OLC.length;
                this.skipToLineEnd();
                continue;
            }

            if (this.startsWithAt(MLC_O, this.Pos)) {
                this.position += MLC_O.length;
                this.GetMLC();
                continue;
            }

            if (currentChar === "'") {
                this.skipQuotedString("'", false, true);
                continue;
            }

            if (currentChar === "\"") {
                this.skipQuotedString("\"", false, true);
                continue;
            }

            if (currentChar === "[") {
                depth++;
                this.Next();
                continue;
            }

            if (currentChar === "]") {
                depth--;
                this.Next();
                continue;
            }

            this.Next();
        }
    }

    private skipToLineEnd(): void {
        while (
            !this.End &&
            this.CurrentChar !== "\r" &&
            this.CurrentChar !== "\n"
        ) {
            this.Next();
        }
    }

    /**
     * Создаёт переменную, объявленную непосредственно в заголовке FOR.
     *
     * Поддерживаются обе формы RSL:
     *
     *     for (Var i, 0, count - 1, 1)
     *     for (Var item, items)
     *
     * VAR относится только к первому аргументу. Остальные выражения
     * заголовка цикла не являются объявлениями.
     */
    protected CreateForVariable(
        isPrivate: boolean,
        offset: number
    ): void {
        const nameToken = this.NextToken();

        if (
            nameToken.kind !== "code" ||
            !this.isIdentifier(nameToken.str)
        ) {
            return;
        }

        const variable = new CVar(
            nameToken.str,
            isPrivate,
            false,
            this.ObjKind === CompletionItemKind.Class
        );

        variable.setRange({
            start: nameToken.range.start + offset,
            end: nameToken.range.end + offset
        });

        this.addChild(variable as unknown as CBase);
    }

    /**
     * Создаёт переменные из объявления:
     *
     * var a, b: integer;
     * const c = 10;
     *
     * Запятые внутри вызовов функций не разделяют объявления.
     */
    protected CreateVariable(
        isPrivate: boolean,
        offset: number,
        isConstant: boolean = false
    ): void {
        const declarationTokens: IParserToken[] = [];
        let parenthesisDepth = 0;

        while (!this.End) {
            const token = this.NextToken();

            if (token.str.length === 0) {
                break;
            }

            if (
                token.kind === "code" &&
                token.str === "("
            ) {
                parenthesisDepth++;
            } else if (
                token.kind === "code" &&
                token.str === ")" &&
                parenthesisDepth > 0
            ) {
                parenthesisDepth--;
            }

            if (
                token.kind === "code" &&
                token.str === ";" &&
                parenthesisDepth === 0
            ) {
                break;
            }

            declarationTokens.push(token);
        }

        const segments: IParserToken[][] = [];
        let current: IParserToken[] = [];
        parenthesisDepth = 0;

        declarationTokens.forEach(token => {
            if (token.kind === "code" && token.str === "(") {
                parenthesisDepth++;
            } else if (
                token.kind === "code" &&
                token.str === ")" &&
                parenthesisDepth > 0
            ) {
                parenthesisDepth--;
            }

            if (
                token.kind === "code" &&
                token.str === "," &&
                parenthesisDepth === 0
            ) {
                if (current.length > 0) {
                    segments.push(current);
                }

                current = [];
                return;
            }

            current.push(token);
        });

        if (current.length > 0) {
            segments.push(current);
        }

        segments.forEach(segment => {
            this.createVariableFromSegment(
                segment,
                isPrivate,
                isConstant,
                offset
            );
        });
    }

    private createVariableFromSegment(
        segment: IParserToken[],
        isPrivate: boolean,
        isConstant: boolean,
        offset: number
    ): void {
        const nameToken = segment.find(token =>
            token.kind === "code" &&
            this.isIdentifier(token.str)
        );

        if (nameToken === undefined) {
            return;
        }

        const variable = new CVar(
            nameToken.str,
            isPrivate,
            isConstant,
            this.ObjKind === CompletionItemKind.Class
        );

        variable.setRange({
            start: nameToken.range.start + offset,
            end: nameToken.range.end + offset
        });

        for (let index = 0; index < segment.length; index++) {
            const token = segment[index];

            if (
                token.kind !== "code" ||
                (token.str !== ":" && token.str !== "=")
            ) {
                continue;
            }

            const valueToken = segment[index + 1];

            if (valueToken === undefined) {
                continue;
            }

            if (token.str === ":") {
                variable.setType(
                    this.GetDataType(valueToken.str).second
                );
            } else {
                let valueText = valueToken.str;

                /*
                 * После добавления операторов в STOP_CHARS знак
                 * отрицательного числа является отдельным токеном.
                 */
                if (
                    (valueText === "-" || valueText === "+") &&
                    segment[index + 2] !== undefined
                ) {
                    valueText +=
                        segment[index + 2].str;
                }

                variable.setValue(valueText);

                if (
                    variable.Type ===
                    getTypeStr(varType._variant)
                ) {
                    const detectedType =
                        this.GetDataType(valueText);

                    if (detectedType.first) {
                        variable.setType(
                            detectedType.second
                        );
                    }
                }
            }

            break;
        }

        this.addChild(variable as unknown as CBase);
    }

    private isIdentifier(value: string): boolean {
        return /^[@A-Za-zА-Яа-яЁё_][@A-Za-zА-Яа-яЁё0-9_]*$/.test(
            value
        );
    }

    /**
     * Читает однострочный комментарий.
     *
     * Исправление: учитываются и CRLF, и LF.
     */
    protected GetOLC(): string {
        let comment = "";

        while (
            !this.End &&
            this.CurrentChar !== "\r" &&
            this.CurrentChar !== "\n"
        ) {
            comment += this.CurrentChar;
            this.Next();
        }

        return comment;
    }

    /**
     * Читает многострочный комментарий и оставляет position
     * сразу после закрывающего маркера многострочного комментария.
     */
    protected GetMLC(): string {
        let comment = "";

        while (!this.End) {
            if (this.startsWithAt(MLC_C, this.Pos)) {
                this.position += MLC_C.length;
                return comment;
            }

            comment += this.CurrentChar;
            this.Next();
        }

        return comment;
    }

    /**
     * Пропускает комментарий без дополнительного смещения.
     *
     * В старом коде после GetMLC() выполнялись ещё два Next(),
     * из-за чего съедались первые два символа следующего токена.
     */
    protected SkipToEndComment(
        isOLC: boolean = false
    ): void {
        if (isOLC) {
            this.GetOLC();
        } else {
            this.GetMLC();
        }

        this.Skip();
    }

    protected GetDataType(token: string): If_s<string> {
        const defaultType = getTypeStr(varType._variant);
        const answer: If_s<string> = {
            first: false,
            second: defaultType
        };

        if (token === undefined || token.length === 0) {
            return answer;
        }

        let normalized = token.toLowerCase();

        if (normalized.charAt(0) === "@") {
            normalized = normalized.substring(1);
        }

        const standardType = TYPES.is(normalized);

        if (standardType.first) {
            answer.first = true;
            answer.second = getTypeStr(
                standardType.second as varType
            );

            return answer;
        }

        if (
            normalized.charAt(0) === "\"" ||
            normalized.charAt(0) === "'" ||
            normalized === "[]"
        ) {
            answer.first = true;
            answer.second = getTypeStr(varType._string);

            return answer;
        }

        const numericStart =
            normalized.charAt(0) === "-" ||
            normalized.charAt(0) === "+"
                ? normalized.charAt(1)
                : normalized.charAt(0);

        if (DIGITS.indexOf(numericStart) >= 0) {
            answer.first = true;
            answer.second = getTypeStr(varType._integer);

            return answer;
        }

        if (
            normalized === "true" ||
            normalized === "false"
        ) {
            answer.first = true;
            answer.second = getTypeStr(varType._bool);

            return answer;
        }

        const tree: Array<IFAStruct> = getTree() || [];
        let foundObject: CAbstractBase | undefined;

        for (const module of tree) {
            foundObject = module.object.RecursiveFind(normalized);

            if (foundObject !== undefined) {
                break;
            }
        }

        if (foundObject !== undefined) {
            answer.first = true;
            answer.second = foundObject.Type;

            return answer;
        }

        const defaults: ArrayClass = getDefaults();
        const defaultObject = defaults.find(normalized);

        if (defaultObject !== undefined) {
            answer.first = true;
            answer.second = defaultObject.returnType();
        }

        return answer;
    }

    protected CreateMacro(
        isPrivate: boolean,
        keywordToken: IParserToken
    ): void {
        const nameToken = this.NextToken();

        if (
            nameToken.str.length === 0 ||
            !this.isIdentifier(nameToken.str)
        ) {
            return;
        }

        const bodyStart = this.Pos;
        const body = this.getObjectBody();
        const objectEnd = this.Pos;

        const range: IRange = {
            start: this.offset + keywordToken.range.start,
            end: this.offset + objectEnd
        };

        const macro = new CMacro(
            body,
            this.offset + bodyStart,
            nameToken.str,
            isPrivate,
            range,
            this.ObjKind === CompletionItemKind.Class
        );

        this.addChild(macro);
    }

    protected CreateClass(
        isPrivate: boolean,
        keywordToken: IParserToken
    ): void {
        let parentName = "";
        let nameToken = this.NextToken();

        /*
         * Сохраняется поддержка старого синтаксиса:
         * class (Parent) Child
         */
        if (nameToken.str === "(") {
            const parentToken = this.NextToken();
            parentName = parentToken.str;

            const closeToken = this.NextToken();

            if (closeToken.str !== ")") {
                // Неверная сигнатура: продолжаем в режиме best effort.
            }

            nameToken = this.NextToken();
        }

        if (
            nameToken.str.length === 0 ||
            !this.isIdentifier(nameToken.str)
        ) {
            return;
        }

        const bodyStart = this.Pos;
        const body = this.getObjectBody();
        const objectEnd = this.Pos;

        const range: IRange = {
            start: this.offset + keywordToken.range.start,
            end: this.offset + objectEnd
        };

        const classObject = new CClass(
            body,
            this.offset + bodyStart,
            nameToken.str,
            parentName,
            isPrivate,
            range
        );

        this.addChild(classObject);
    }

    protected CreateImport(): void {
        /*
         * Parser только пропускает директиву Import. Извлечение имён,
         * загрузка файлов и построение графа зависимостей выполняются
         * WorkspaceIndex в language server.
         */
        while (!this.End && this.CurrentChar !== ";") {
            this.Next();
        }

        if (this.CurrentChar === ";") {
            this.Next();
        }
    }

    /**
     * Разбирает параметры macro из начального блока (...).
     */
    private parseSignature(): void {
        this.Skip();

        if (this.CurrentChar !== "(") {
            return;
        }

        const signatureStart = this.Pos;
        const parametersStart = signatureStart + 1;

        let depth = 0;
        let closePosition = -1;

        while (!this.End) {
            const token = this.NextToken(SkipComment.no);

            if (token.str.length === 0) {
                break;
            }

            if (token.kind === "code" && token.str === "(") {
                depth++;
                continue;
            }

            if (token.kind === "code" && token.str === ")") {
                depth--;

                if (depth === 0) {
                    closePosition = token.range.start;
                    break;
                }
            }
        }

        if (closePosition < 0) {
            this.paramStr = this.source.substring(signatureStart);
            return;
        }

        this.paramStr = this.source.substring(
            signatureStart,
            this.Pos
        );

        const parametersText = this.source.substring(
            parametersStart,
            closePosition
        );

        this.createParameterVariables(
            parametersText,
            this.offset + parametersStart
        );

        /*
         * Возвращаемый тип macro:
         * macro Test(): integer
         */
        const afterSignature = this.Pos;
        const nextToken = this.NextToken(SkipComment.no);

        if (nextToken.str === ":") {
            const typeToken = this.NextToken();

            if (typeToken.str.length > 0) {
                this.setType(this.GetDataType(typeToken.str).second);
            }
        } else if (
            nextToken.str === OLC ||
            nextToken.str === MLC_O
        ) {
            const description = nextToken.str === OLC
                ? this.GetOLC()
                : this.GetMLC();

            this.Description(description);
        } else {
            this.position = afterSignature;
        }
    }

    private createParameterVariables(
        parametersText: string,
        absoluteOffset: number
    ): void {
        const segments = this.splitTopLevelParameters(parametersText);
        let searchFrom = 0;

        segments.forEach(segment => {
            const match = segment.match(
                /[@A-Za-zА-Яа-яЁё_][@A-Za-zА-Яа-яЁё0-9_]*/
            );

            if (match === null || match.index === undefined) {
                searchFrom += segment.length + 1;
                return;
            }

            const name = match[0];
            const relativeNamePosition =
                parametersText.indexOf(name, searchFrom);

            if (relativeNamePosition < 0) {
                searchFrom += segment.length + 1;
                return;
            }

            const variable = new CVar(
                name,
                true,
                false,
                false
            );

            variable.setRange({
                start: absoluteOffset + relativeNamePosition,
                end:
                    absoluteOffset +
                    relativeNamePosition +
                    name.length
            });

            const typeMatch = segment.match(
                /:\s*([@A-Za-zА-Яа-яЁё_][@A-Za-zА-Яа-яЁё0-9_]*)/
            );

            if (typeMatch !== null) {
                variable.setType(
                    this.GetDataType(typeMatch[1]).second
                );
            }

            this.addChild(variable as unknown as CBase);
            searchFrom = relativeNamePosition + name.length;
        });
    }

    private splitTopLevelParameters(value: string): string[] {
        const result: string[] = [];
        let current = "";
        let parenthesisDepth = 0;
        let bracketDepth = 0;
        let quote = "";

        for (let index = 0; index < value.length; index++) {
            const char = value.charAt(index);
            const next = value.charAt(index + 1);

            if (quote.length > 0) {
                current += char;

                if (char === quote) {
                    if (next === quote) {
                        current += next;
                        index++;
                    } else {
                        quote = "";
                    }
                } else if (char === "\\" && next !== "") {
                    current += next;
                    index++;
                }

                continue;
            }

            if (char === "\"" || char === "'") {
                quote = char;
                current += char;
                continue;
            }

            if (char === "(") {
                parenthesisDepth++;
                current += char;
                continue;
            }

            if (char === ")" && parenthesisDepth > 0) {
                parenthesisDepth--;
                current += char;
                continue;
            }

            if (char === "[") {
                bracketDepth++;
                current += char;
                continue;
            }

            if (char === "]" && bracketDepth > 0) {
                bracketDepth--;
                current += char;
                continue;
            }

            if (
                char === "," &&
                parenthesisDepth === 0 &&
                bracketDepth === 0
            ) {
                result.push(current);
                current = "";
                continue;
            }

            current += char;
        }

        if (current.length > 0) {
            result.push(current);
        }

        return result;
    }

    /**
     * Основной разбор scope.
     *
     * Все ключевые слова внутри строк, комментариев и [ ... ]
     * скрыты токенизатором и сюда не попадают.
     */
    protected parse(): void {
        this.childs = new Array<CBase>();
        this.position = 0;

        this.parseSignature();

        let previousToken = "";
        let tokenBeforePrevious = "";

        while (!this.End) {
            const token = this.NextToken();

            if (token.str.length === 0) {
                break;
            }

            const normalizedToken = token.str.toLowerCase();
            const isForVariable =
                normalizedToken === "var" &&
                previousToken === "(" &&
                tokenBeforePrevious === "for";
            const action = this.getKeywordNum(token.str);

            if (!action.first) {
                tokenBeforePrevious = previousToken;
                previousToken = normalizedToken;
                continue;
            }

            if (isForVariable) {
                this.CreateForVariable(false, this.offset);
                tokenBeforePrevious = previousToken;
                previousToken = normalizedToken;
                continue;
            }

            if (
                action.second === kwdNum._local ||
                action.second === kwdNum._private
            ) {
                const declarationToken = this.NextToken();
                const declaration =
                    this.getKeywordNum(declarationToken.str);

                if (declaration.first) {
                    switch (declaration.second) {
                        case kwdNum._const:
                            this.CreateVariable(
                                true,
                                this.offset,
                                true
                            );
                            break;

                        case kwdNum._var:
                            this.CreateVariable(
                                true,
                                this.offset
                            );
                            break;

                        case kwdNum._macro:
                            this.CreateMacro(
                                true,
                                declarationToken
                            );
                            break;

                        case kwdNum._class:
                            this.CreateClass(
                                true,
                                declarationToken
                            );
                            break;

                        default:
                            break;
                    }
                }

                tokenBeforePrevious = normalizedToken;
                previousToken = declarationToken.str.toLowerCase();
                continue;
            }

            switch (action.second) {
                case kwdNum._const:
                    this.CreateVariable(
                        false,
                        this.offset,
                        true
                    );
                    break;

                case kwdNum._var:
                    this.CreateVariable(
                        false,
                        this.offset
                    );
                    break;

                case kwdNum._macro:
                    this.CreateMacro(false, token);
                    break;

                case kwdNum._import:
                    this.CreateImport();
                    break;

                case kwdNum._class:
                    this.CreateClass(false, token);
                    break;

                default:
                    break;
            }

            tokenBeforePrevious = previousToken;
            previousToken = normalizedToken;
        }
    }
}


/**
 * Макрос или метод класса.
 */
class CMacro extends CBase {
    constructor(
        src: string,
        sourceOffset: number,
        name: string,
        privateFlag: boolean,
        range: IRange,
        isMethod: boolean
    ) {
        super(
            src,
            sourceOffset,
            isMethod
                ? CompletionItemKind.Method
                : CompletionItemKind.Function
        );

        this.name = name;
        this.private_ = privateFlag;
        this.range = range;
        this.insertedText = `${name}()`;
    }

    updateCIInfo(): void {
        this.detail = `${getStrItemKind(this.objKind)}: `;
        this.detail +=
            `${this.name}${this.paramStr}.\n` +
            `Возвращаемый тип: ${this.Type}`;
    }
}


/**
 * Класс RSL.
 */
class CClass extends CBase {
    private parentName: string;

    constructor(
        src: string,
        sourceOffset: number,
        name: string,
        parentName: string,
        privateFlag: boolean,
        range: IRange
    ) {
        super(
            src,
            sourceOffset,
            CompletionItemKind.Class
        );

        this.name = name;
        this.parentName = parentName;
        this.private_ = privateFlag;
        this.insertedText = name;
        this.varType_ = name;
        this.range = range;
    }

    getParentName(): string {
        return this.parentName;
    }

    updateCIInfo(): void {
        this.detail = `${getStrItemKind(this.objKind)}: `;
        this.detail += this.name;
    }
}

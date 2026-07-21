import {
    CompletionItem,
    CompletionItemKind
} from "vscode-languageserver";

import {
    varType,
    kwdNum,
    OLC,
    MLC_O,
    MLC_C
} from "./enums";

import {
    If_s,
    IArray,
    IRange,
    CAbstractBase,
    IToken,
    TokenKind
} from "./interfaces";

import {
    IRslParseResult,
    IRslSyntaxNode,
    parseRslSyntax
} from "./syntaxParser";

import { IRslToken, normalizeIdentifier } from "./lexer";

/**
 * Версия нового parser + legacy symbol-tree adapter.
 * common.ts больше не содержит собственного tokenizer/NextToken.
 */
export const RSL_PARSER_VERSION =
    "2026-07-21-v6-syntax-tree-adapter";

interface IParserToken extends IToken {
    kind: TokenKind;
}

interface ISymbolModule {
    object: CBase;
}

let symbolTreeProvider: () => ISymbolModule[] = () => [];

/**
 * Убирает обратную зависимость common.ts -> server.ts.
 * Language server подключает workspace index после своей инициализации.
 */
export function configureSymbolTreeProvider(
    provider: () => ISymbolModule[]
): void {
    symbolTreeProvider = provider || (() => []);
}

class CArray implements IArray {
    _it: Array<string>;

    constructor() {
        this._it = new Array<string>();
    }

    is(it: string): If_s<number> {
        const normalized = normalizeIdentifier(it);
        const result = this._it.indexOf(normalized);

        return {
            first: result >= 0,
            second: result
        };
    }

    str(num: number): string {
        return this._it[num];
    }

    protected add(value: string): void {
        const normalized = normalizeIdentifier(value);

        if (this._it.indexOf(normalized) < 0) {
            this._it.push(normalized);
        }
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

        /* Слова из официального списка, не имеющие номера в старом enum. */
        [
            "and", "this", "true", "false", "null", "for"
        ].forEach(value => this.add(value));
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
            : isConstant
                ? CompletionItemKind.Constant
                : CompletionItemKind.Variable;
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
        // Переменная строится из syntax tree и отдельно не разбирается.
    }
}

/**
 * Совместимое дерево символов для существующих provider-ов расширения.
 * Оно больше не разбирает исходный текст самостоятельно: все узлы создаёт
 * LegacySymbolTreeAdapter поверх IRslSyntaxNode.
 */
export class CBase extends CAbstractBase {
    protected childs: Array<CBase>;
    protected source: string;
    protected paramStr: string;
    protected offset: number;
    private tokenCache: IParserToken[];
    private syntaxResult?: IRslParseResult;

    constructor(
        src: string,
        offset: number,
        objKind: CompletionItemKind = CompletionItemKind.Unit,
        buildFromSyntax: boolean = true
    ) {
        super();
        this.childs = new Array<CBase>();
        this.source = src || "";
        this.paramStr = "";
        this.offset = offset || 0;
        this.tokenCache = new Array<IParserToken>();
        this.objKind = objKind;
        this.range = {
            start: this.offset,
            end: this.offset + this.source.length
        };

        if (buildFromSyntax) {
            this.applySyntax(parseRslSyntax(
                this.source,
                undefined,
                { buildExpressionTree: false }
            ));
        }
    }

    /**
     * Облегчённый разбор закрытого импортируемого модуля. Для него не нужны
     * пробелы/переводы строк в token cache и подробное дерево выражений.
     */
    static forExternalModule(source: string, offset: number = 0): CBase {
        const root = CBase.fromSyntax(
            source,
            offset,
            parseRslSyntax(source, undefined, {
                buildExpressionTree: false,
                includeTrivia: false
            }),
            false,
            true
        );
        root.compactExternalSyntaxResult();
        root.releaseSourceTree();
        return root;
    }

    static fromSyntax(
        source: string,
        offset: number,
        syntax: IRslParseResult,
        buildTokenCache: boolean = true,
        externalSymbolsOnly: boolean = false
    ): CBase {
        const root = new CBase(
            source,
            offset,
            CompletionItemKind.Unit,
            false
        );
        root.applySyntax(
            syntax,
            buildTokenCache,
            externalSymbolsOnly
        );
        return root;
    }

    getSyntaxResult(): IRslParseResult | undefined {
        return this.syntaxResult;
    }

    updateCIInfo(): void {
        // Корневой узел не отображается как CompletionItem.
    }

    isActual(pos: number): boolean {
        return this.range.start < pos && pos < this.range.end;
    }

    RecursiveFind(name: string): CBase | undefined {
        const normalizedName = normalizeIdentifier(name);

        for (const child of this.childs) {
            if (normalizeIdentifier(child.Name) === normalizedName) {
                return child;
            }

            if (!child.isObject()) {
                continue;
            }

            const nested = child.RecursiveFind(name);

            if (nested !== undefined) {
                return nested;
            }
        }

        return undefined;
    }

    reParsing(): void {
        this.applySyntax(parseRslSyntax(
            this.source,
            undefined,
            { buildExpressionTree: false }
        ));
    }

    getChilds(): Array<CBase> {
        return this.childs;
    }

    addChild(node: CBase): void {
        this.childs.push(node);
    }

    setType(type: string): void {
        this.varType_ = type || getTypeStr(varType._variant);
    }

    getActualChilds(position: number): Array<CBase> {
        const answer: Array<CBase> = new Array<CBase>();

        if (position !== 0) {
            this.childs.forEach(parent => {
                if (parent.Range.end < position) {
                    answer.push(parent);
                }

                if (parent.isActual(position) && parent.isObject()) {
                    parent.childs.forEach(child => answer.push(child));
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

    getCurrentToken(
        absolutePosition: number,
        _savePosition: boolean = true
    ): IToken | undefined {
        if (this.tokenCache.length === 0) {
            return undefined;
        }

        let left = 0;
        let right = this.tokenCache.length - 1;
        let candidateIndex = -1;

        while (left <= right) {
            const middle = Math.floor((left + right) / 2);
            const token = this.tokenCache[middle];

            if (token.range.start <= absolutePosition) {
                candidateIndex = middle;
                left = middle + 1;
            } else {
                right = middle - 1;
            }
        }

        if (candidateIndex < 0) {
            return undefined;
        }

        const candidate = this.tokenCache[candidateIndex];
        return absolutePosition <= candidate.range.end
            ? candidate
            : undefined;
    }

    ChildsCIInfo(
        isCheckPrivate: boolean = false,
        position: number = 0,
        isCheckActual: boolean = false
    ): Array<CompletionItem> {
        const answer: Array<CompletionItem> = [];

        this.childs.forEach(element => {
            if (isCheckActual) {
                if (element.Range.end < position) {
                    if (!isCheckPrivate || !element.Private) {
                        answer.push(element.CIInfo);
                    }
                } else if (element.isActual(position) && element.isObject()) {
                    element.ChildsCIInfo().forEach(info => answer.push(info));
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
                for (const module of symbolTreeProvider()) {
                    parent = module.object.RecursiveFind(parentName);
                    if (parent !== undefined) {
                        break;
                    }
                }
            }

            if (parent !== undefined) {
                parent.getChilds().forEach(child => {
                    if (!child.Private) {
                        answer.push(child.CIInfo);
                    }
                });
            }
        }

        return answer;
    }

    private applySyntax(
        result: IRslParseResult,
        buildTokenCache: boolean = true,
        externalSymbolsOnly: boolean = false
    ): void {
        this.syntaxResult = result;
        this.childs = [];
        this.range = {
            start: this.offset,
            end: this.offset + this.source.length
        };
        this.tokenCache = buildTokenCache
            ? this.buildTokenCache(result.lex.tokens)
            : [];

        const adapter = new LegacySymbolTreeAdapter(
            this.source,
            this.offset,
            externalSymbolsOnly
        );
        adapter.populate(this, result.root);
    }

    /** Импортированный модуль не удерживает полное statement AST. */
    private compactExternalSyntaxResult(): void {
        const syntax = this.syntaxResult;

        if (!syntax) {
            return;
        }

        this.syntaxResult = {
            root: {
                ...syntax.root,
                children: syntax.root.children.filter(child =>
                    child.kind === "ImportDeclaration"
                ),
                tokens: []
            },
            diagnostics: [],
            tokens: syntax.tokens,
            lex: syntax.lex
        };
    }

    /** Импортированный модуль не удерживает полный исходник в каждом CBase. */
    private releaseSourceTree(): void {
        this.source = "";

        /*
         * В childs исторически хранятся и CBase, и CVar: переменные
         * добавляются через приведение типа для совместимости старого API.
         * Поэтому рекурсивная очистка допустима только для реальных CBase.
         */
        this.childs.forEach(child => {
            if (child instanceof CBase) {
                child.releaseSourceTree();
            }
        });
    }

    private buildTokenCache(tokens: IRslToken[]): IParserToken[] {
        const result: IParserToken[] = [];

        for (const token of tokens) {
            if (
                token.kind === "whitespace" ||
                token.kind === "newline" ||
                token.kind === "bom"
            ) {
                continue;
            }

            result.push({
                str: token.kind === "square" ? "[]" : token.raw,
                range: {
                    start: token.start + this.offset,
                    end: token.end + this.offset
                },
                kind: token.kind === "identifier" ||
                    token.kind === "number" ||
                    token.kind === "symbol"
                        ? "code"
                        : token.kind
            } as IParserToken);
        }

        return result;
    }
}

/**
 * Преобразует новое полное syntax tree в прежнюю модель CBase/CVar.
 * Блоки IF/FOR/WHILE не создают области видимости в RSL, поэтому объявления
 * из них добавляются в ближайший модуль, MACRO или конструктор CLASS.
 */
class LegacySymbolTreeAdapter {
    constructor(
        private source: string,
        private offset: number,
        private externalSymbolsOnly: boolean = false
    ) {}

    populate(scope: CBase, root: IRslSyntaxNode): void {
        root.children.forEach(node => this.visit(scope, node));
    }

    private visit(scope: CBase, node: IRslSyntaxNode): void {
        switch (node.kind) {
            case "VariableDeclaration":
            case "ArrayDeclaration":
                /*
                 * Во внешнем модуле сохраняем только доступные объявления.
                 * Локальные переменные внутри Macro остаются в компактном
                 * symbol tree для RecursiveFind/навигации, но их выражения и
                 * операторы в дерево не попадают.
                 */
                if (this.externalSymbolsOnly && !!node.modifier) {
                    return;
                }
                this.addVariableDeclaration(scope, node);
                return;

            case "FileDeclaration":
            case "RecordDeclaration":
                if (this.externalSymbolsOnly && !!node.modifier) {
                    return;
                }
                this.addObjectDeclaration(scope, node);
                return;

            case "MacroDeclaration":
                if (this.externalSymbolsOnly && !!node.modifier) {
                    return;
                }
                this.addMacro(scope, node);
                return;

            case "ClassDeclaration":
                if (this.externalSymbolsOnly && !!node.modifier) {
                    return;
                }
                this.addClass(scope, node);
                return;

            case "VariableDeclarator":
                if (node.variableRole === "for") {
                    this.addVariable(scope, node, false, false, false);
                } else if (node.variableRole === "onerror") {
                    this.addVariable(scope, node, false, true, false);
                }
                return;

            case "Parameter":
            case "ImportDeclaration":
            case "ImportItem":
                return;

            default:
                if (!this.externalSymbolsOnly) {
                    node.children.forEach(child => this.visit(scope, child));
                }
        }
    }

    private addVariableDeclaration(
        scope: CBase,
        declaration: IRslSyntaxNode
    ): void {
        const isConstant = declaration.name === "const";
        const privateFlag = declaration.modifier !== undefined;
        const isProperty =
            scope.ObjKind === CompletionItemKind.Class &&
            declaration.modifier !== "local";

        declaration.children
            .filter(child => child.kind === "VariableDeclarator")
            .forEach(child => this.addVariable(
                scope,
                child,
                isConstant,
                privateFlag,
                isProperty
            ));
    }

    private addObjectDeclaration(
        scope: CBase,
        node: IRslSyntaxNode
    ): void {
        const privateFlag = node.modifier !== undefined;
        const isProperty =
            scope.ObjKind === CompletionItemKind.Class &&
            node.modifier !== "local";
        this.addVariable(
            scope,
            node,
            false,
            privateFlag,
            isProperty
        );
    }

    private addMacro(scope: CBase, node: IRslSyntaxNode): void {
        if (!node.name) {
            return;
        }

        const isMethod =
            scope.ObjKind === CompletionItemKind.Class &&
            node.modifier !== "local";
        const macro = new CMacro(
            this.source,
            node.name,
            node.modifier !== undefined,
            this.absoluteRange(node),
            isMethod,
            this.parameterText(node),
            node.typeName || getTypeStr(varType._variant)
        );
        scope.addChild(macro);

        node.children
            .filter(child => child.kind === "Parameter")
            .forEach(parameter => this.addVariable(
                macro,
                parameter,
                false,
                true,
                false
            ));

        const bodyChildren = node.children
            .filter(child => child.kind !== "Parameter");

        if (this.externalSymbolsOnly) {
            bodyChildren.forEach(child =>
                this.visitExternalDeclarations(macro, child)
            );
        } else {
            bodyChildren.forEach(child => this.visit(macro, child));
        }
    }

    /**
     * Обходит только контейнеры syntax tree и извлекает объявления.
     * Statement/expression-узлы сами в legacy symbol tree не создаются.
     */
    private visitExternalDeclarations(
        scope: CBase,
        node: IRslSyntaxNode
    ): void {
        switch (node.kind) {
            case "VariableDeclaration":
            case "ArrayDeclaration":
            case "FileDeclaration":
            case "RecordDeclaration":
            case "MacroDeclaration":
            case "ClassDeclaration":
                this.visit(scope, node);
                return;

            default:
                node.children.forEach(child =>
                    this.visitExternalDeclarations(scope, child)
                );
        }
    }

    private addClass(scope: CBase, node: IRslSyntaxNode): void {
        if (!node.name) {
            return;
        }

        const classObject = new CClass(
            this.source,
            node.name,
            node.baseClassName || "",
            node.modifier !== undefined,
            this.absoluteRange(node)
        );
        scope.addChild(classObject);

        node.children
            .filter(child => child.kind === "Parameter")
            .forEach(parameter => this.addVariable(
                classObject,
                parameter,
                false,
                true,
                false
            ));

        node.children
            .filter(child => child.kind !== "Parameter")
            .forEach(child => this.visit(classObject, child));
    }

    private addVariable(
        scope: CBase,
        node: IRslSyntaxNode,
        isConstant: boolean,
        privateFlag: boolean,
        isProperty: boolean
    ): void {
        if (!node.name) {
            return;
        }

        const variable = new CVar(
            node.name,
            privateFlag,
            isConstant,
            isProperty
        );
        variable.setRange({
            start: node.start + this.offset,
            end: this.nameEnd(node) + this.offset
        });

        if (node.typeName) {
            variable.setType(this.normalizeType(node.typeName));
        } else {
            variable.setType(this.inferInitializerType(node));
        }

        const value = this.initializerText(node);
        if (value) {
            variable.setValue(value);
        }

        scope.addChild(variable as unknown as CBase);
    }

    private parameterText(node: IRslSyntaxNode): string {
        if (
            node.parameterListStart === undefined ||
            node.parameterListEnd === undefined
        ) {
            return "";
        }

        return this.source.substring(
            node.parameterListStart,
            node.parameterListEnd
        );
    }

    private initializerText(node: IRslSyntaxNode): string {
        if (
            node.valueStart === undefined ||
            node.valueEnd === undefined
        ) {
            return "";
        }

        const value = this.source.substring(
            node.valueStart,
            node.valueEnd
        ).replace(/\s+/g, " ").trim();

        return value.length > 120
            ? value.substring(0, 117) + "..."
            : value;
    }

    private inferInitializerType(node: IRslSyntaxNode): string {
        const valueTokens = node.tokens.filter(token =>
            node.valueStart !== undefined &&
            node.valueEnd !== undefined &&
            token.start >= node.valueStart &&
            token.end <= node.valueEnd
        );
        const first = valueTokens[0];

        if (!first) {
            return getTypeStr(varType._variant);
        }

        if (first.kind === "string" || first.kind === "square") {
            return getTypeStr(varType._string);
        }

        if (first.kind === "number") {
            return getTypeStr(varType._integer);
        }

        if (
            first.kind === "identifier" &&
            (normalizeIdentifier(first.value) === "true" ||
                normalizeIdentifier(first.value) === "false")
        ) {
            return getTypeStr(varType._bool);
        }

        return getTypeStr(varType._variant);
    }

    private normalizeType(value: string): string {
        const normalized = normalizeIdentifier(value).replace(/^@/, "");
        const standard = TYPES.is(normalized);
        return standard.first
            ? TYPES.str(standard.second)
            : value.replace(/^@/, "");
    }

    private nameEnd(node: IRslSyntaxNode): number {
        const name = normalizeIdentifier(node.name || "");
        const token = node.tokens.find(candidate =>
            candidate.kind === "identifier" &&
            normalizeIdentifier(candidate.value) === name
        );
        return token ? token.end : node.end;
    }

    private absoluteRange(node: IRslSyntaxNode): IRange {
        return {
            start: node.start + this.offset,
            end: node.end + this.offset
        };
    }
}

/** Макрос или метод класса. */
class CMacro extends CBase {
    constructor(
        source: string,
        name: string,
        privateFlag: boolean,
        range: IRange,
        isMethod: boolean,
        parameterText: string,
        returnType: string
    ) {
        super(
            source,
            0,
            isMethod
                ? CompletionItemKind.Method
                : CompletionItemKind.Function,
            false
        );
        this.name = name;
        this.private_ = privateFlag;
        this.range = range;
        this.paramStr = parameterText;
        this.varType_ = returnType || getTypeStr(varType._variant);
        this.insertedText = `${name}()`;
    }

    updateCIInfo(): void {
        this.detail = `${getStrItemKind(this.objKind)}: `;
        this.detail +=
            `${this.name}${this.paramStr}.\n` +
            `Возвращаемый тип: ${this.Type}`;
    }
}

/** Класс RSL. */
class CClass extends CBase {
    private parentName: string;

    constructor(
        source: string,
        name: string,
        parentName: string,
        privateFlag: boolean,
        range: IRange
    ) {
        super(
            source,
            0,
            CompletionItemKind.Class,
            false
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
        this.detail = `${getStrItemKind(this.objKind)}: ${this.name}`;
    }
}
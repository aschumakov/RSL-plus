import {
    IRslLexResult,
    IRslToken,
    lexRsl,
    normalizeIdentifier
} from "./lexer";

export type RslSyntaxKind =
    | "CompilationUnit" | "ImportDeclaration" | "ImportItem"
    | "VariableDeclaration" | "VariableDeclarator"
    | "MacroDeclaration" | "ClassDeclaration" | "Parameter"
    | "IfStatement" | "ElseIfClause" | "ElseClause"
    | "WhileStatement" | "ForStatement" | "OnErrorClause"
    | "ReturnStatement" | "BreakStatement" | "ContinueStatement"
    | "ExpressionStatement" | "EmptyStatement" | "UnknownStatement";

export type RslDeclarationModifier = "local" | "private";
export type RslVariableRole = "variable" | "parameter" | "for" | "onerror";

export interface IRslSyntaxDiagnostic {
    code: string;
    message: string;
    start: number;
    end: number;
}

export interface IRslSyntaxNode {
    kind: RslSyntaxKind;
    start: number;
    end: number;
    children: IRslSyntaxNode[];
    tokens: IRslToken[];
    name?: string;
    modifier?: RslDeclarationModifier;
    typeName?: string;
    baseClassName?: string;
    variableRole?: RslVariableRole;
    parameterListStart?: number;
    parameterListEnd?: number;
    valueStart?: number;
    valueEnd?: number;
    missingSemicolon?: boolean;
}

export interface IRslParseResult {
    root: IRslSyntaxNode;
    diagnostics: IRslSyntaxDiagnostic[];
    /** Токены, которые участвуют в синтаксическом разборе. */
    tokens: IRslToken[];
    /** Полный результат единственного общего lexer-прохода. */
    lex: IRslLexResult;
}

interface IParameterListResult {
    nodes: IRslSyntaxNode[];
    start?: number;
    end?: number;
}

const RESERVED = new Set([
    "and", "if", "record", "array", "import", "return", "const", "macro",
    "this", "class", "not", "true", "elif", "null", "var", "end",
    "onerror", "with", "false", "or", "while", "file", "local", "private",
    "break", "continue", "for"
]);

const BLOCK_BOUNDARIES = new Set(["end", "elif", "else", "onerror"]);
const STATEMENT_KEYWORDS = new Set([
    "import", "var", "const", "macro", "class", "if", "while", "for",
    "return", "break", "continue", "local", "private"
]);
const WORD_OPERATORS = new Set(["and", "or", "not"]);
const SYMBOL_OPERATORS = new Set([
    "=", "==", "!=", "<", ">", "<=", ">=", "+", "-", "*", "/", "@",
    "%", "&", "|", "^", "~", "?", ":", ".", ",", "("
]);

/**
 * Строит tolerant syntax tree RSL на единственном общем потоке токенов.
 * Parser сохраняет дерево даже при ошибках и добавляет missing-token
 * diagnostics в точках, где правило языка однозначно.
 */
export function parseRslSyntax(
    source: string,
    lexResult?: IRslLexResult
): IRslParseResult {
    const text = source || "";
    const lex = lexResult || lexRsl(text);
    const tokens = lex.tokens.filter(token =>
        token.kind !== "whitespace" &&
        token.kind !== "newline" &&
        token.kind !== "comment" &&
        token.kind !== "bom"
    );
    const parser = new Parser(tokens, text, lex);
    return parser.parse();
}

/** Возвращает Import из уже построенного syntax tree. */
export function getImportNamesFromSyntax(root: IRslSyntaxNode): string[] {
    return root.children
        .filter(node => node.kind === "ImportDeclaration")
        .reduce((result, declaration) => {
            declaration.children
                .filter(item => item.kind === "ImportItem" && !!item.name)
                .forEach(item => result.push(item.name!));
            return result;
        }, [] as string[]);
}

class Parser {
    private index = 0;
    private diagnostics: IRslSyntaxDiagnostic[] = [];

    constructor(
        private tokens: IRslToken[],
        private source: string,
        private lex: IRslLexResult
    ) {}

    parse(): IRslParseResult {
        /* END на верхнем уровне завершает процедуру инициализации модуля. */
        const children = this.parseStatementList(new Set(["end"]));
        const rootTokens: IRslToken[] = [];

        if (this.word() === "end") {
            rootTokens.push(this.take());
            if (this.isSymbol(";")) {
                rootTokens.push(this.take());
            }
            /* Всё после верхнеуровневого END интерпретатор игнорирует. */
            this.index = this.tokens.length;
        }

        const end = rootTokens.length > 0
            ? rootTokens[rootTokens.length - 1].end
            : children.length > 0
                ? children[children.length - 1].end
                : 0;

        return {
            root: this.node(
                "CompilationUnit",
                0,
                Math.max(end, this.source.length),
                children,
                rootTokens
            ),
            diagnostics: this.diagnostics,
            tokens: this.tokens,
            lex: this.lex
        };
    }

    private parseStatementList(stop: Set<string>): IRslSyntaxNode[] {
        const result: IRslSyntaxNode[] = [];

        while (!this.atEnd()) {
            const word = this.word();

            if (stop.has(word)) {
                break;
            }

            if (this.isSymbol(";")) {
                const token = this.take();
                result.push(this.node(
                    "EmptyStatement",
                    token.start,
                    token.end,
                    [],
                    [token]
                ));
                continue;
            }

            const before = this.index;
            const statement = this.parseStatement();
            result.push(statement);

            if (this.index === before) {
                this.index++;
            }

            this.consumeStatementSeparator(statement, stop);
        }

        return result;
    }

    private parseStatement(): IRslSyntaxNode {
        let modifier: IRslToken | undefined;

        if (this.word() === "local" || this.word() === "private") {
            modifier = this.take();
        }

        const word = this.word();

        switch (word) {
            case "import":
                return this.parseImport(modifier);
            case "var":
                return this.parseVariables(modifier, false);
            case "const":
                return this.parseVariables(modifier, true);
            case "macro":
                return this.parseMacro(modifier);
            case "class":
                return this.parseClass(modifier);
            case "if":
                return this.parseIf();
            case "while":
                return this.parseWhile();
            case "for":
                return this.parseFor();
            case "return":
                return this.parseSimpleKeyword("ReturnStatement");
            case "break":
                return this.parseSimpleKeyword("BreakStatement");
            case "continue":
                return this.parseSimpleKeyword("ContinueStatement");
            default:
                if (modifier) {
                    this.error(
                        "unexpected-modifier",
                        `После ${modifier.raw.toUpperCase()} ожидается VAR, CONST, MACRO или CLASS`,
                        modifier
                    );
                }
                return this.parseExpressionStatement(modifier);
        }
    }

    private parseImport(modifier?: IRslToken): IRslSyntaxNode {
        const start = modifier ? modifier.start : this.current().start;
        const items: IRslSyntaxNode[] = [];
        const used: IRslToken[] = modifier ? [modifier] : [];
        used.push(this.take());

        while (
            !this.atEnd() &&
            !this.isSymbol(";") &&
            !BLOCK_BOUNDARIES.has(this.word())
        ) {
            const itemTokens = this.consumeImportItem();

            if (itemTokens.length === 0) {
                const token = this.current();
                this.error(
                    "expected-import-name",
                    "Ожидается имя импортируемого модуля",
                    token
                );
                this.take();
                continue;
            }

            const name = this.importItemName(itemTokens);
            used.push(...itemTokens);
            items.push(this.node(
                "ImportItem",
                itemTokens[0].start,
                itemTokens[itemTokens.length - 1].end,
                [],
                itemTokens,
                name
            ));

            if (this.isSymbol(",")) {
                used.push(this.take());
                continue;
            }

            /*
             * IMPORT допускает относительные пути без кавычек:
             *
             *     Import lib\\common;
             *
             * Поэтому обратная косая черта, /, точка и прочие части пути
             * входят в один ImportItem. Два самостоятельных имени,
             * разделённых только пробелом, означают пропущенную запятую.
             */
            if (this.canStartImportItem(this.current())) {
                if (STATEMENT_KEYWORDS.has(this.word())) {
                    break;
                }

                this.missing(
                    "missing-comma",
                    "Между импортируемыми модулями пропущена \",\"",
                    this.current().start
                );
                continue;
            }

            break;
        }

        const node = this.node(
            "ImportDeclaration",
            start,
            used.length > 0 ? used[used.length - 1].end : start,
            items,
            used
        );
        node.modifier = this.modifierOf(modifier);
        return node;
    }

    /** Читает одно имя модуля, включая относительный путь и расширение. */
    private consumeImportItem(): IRslToken[] {
        const result: IRslToken[] = [];
        const first = this.current();

        if (first.kind === "string") {
            result.push(this.take());
            return result;
        }

        if (first.kind !== "identifier") {
            return result;
        }

        result.push(this.take());

        while (
            !this.atEnd() &&
            !this.isSymbol(",") &&
            !this.isSymbol(";") &&
            !BLOCK_BOUNDARIES.has(this.word())
        ) {
            const token = this.current();
            const previous = result[result.length - 1];

            if (
                this.canStartImportItem(token) &&
                this.hasWhitespaceBetween(previous, token) &&
                !this.isImportPathConnector(previous)
            ) {
                break;
            }

            result.push(this.take());
        }

        return result;
    }

    private importItemName(tokens: IRslToken[]): string {
        if (tokens.length === 1 && tokens[0].kind === "string") {
            return tokens[0].value.trim();
        }

        return tokens.map(token => token.raw).join("").trim();
    }

    private canStartImportItem(token: IRslToken): boolean {
        return token.kind === "identifier" || token.kind === "string";
    }

    private hasWhitespaceBetween(
        left: IRslToken,
        right: IRslToken
    ): boolean {
        return /\s/.test(this.source.substring(left.end, right.start));
    }

    private isImportPathConnector(token: IRslToken): boolean {
        return token.kind === "symbol" &&
            (token.raw === "\\" || token.raw === "/" ||
                token.raw === "." || token.raw === ":");
    }

    private parseVariables(
        modifier: IRslToken | undefined,
        isConst: boolean
    ): IRslSyntaxNode {
        const start = modifier ? modifier.start : this.current().start;
        const used: IRslToken[] = modifier ? [modifier] : [];
        used.push(this.take());
        const children: IRslSyntaxNode[] = [];

        while (
            !this.atEnd() &&
            !this.isSymbol(";") &&
            !BLOCK_BOUNDARIES.has(this.word())
        ) {
            const name = this.current();

            if (
                name.kind !== "identifier" ||
                RESERVED.has(normalizeIdentifier(name.value))
            ) {
                this.error(
                    "expected-variable-name",
                    "Ожидается имя переменной",
                    name
                );
                break;
            }

            this.take();
            used.push(name);
            const declTokens: IRslToken[] = [name];
            let typeName: string | undefined;
            let valueStart: number | undefined;
            let valueEnd: number | undefined;

            if (this.isSymbol(":")) {
                declTokens.push(this.take());

                if (this.isSymbol("@")) {
                    declTokens.push(this.take());
                }

                if (this.current().kind === "identifier") {
                    const typeToken = this.take();
                    declTokens.push(typeToken);
                    typeName = typeToken.value;
                } else {
                    this.error(
                        "expected-type",
                        "После ':' ожидается имя типа",
                        this.current()
                    );
                }
            }

            if (this.isSymbol("=")) {
                declTokens.push(this.take());
                const expression = this.consumeExpression(
                    new Set([",", ";"]),
                    BLOCK_BOUNDARIES
                );
                declTokens.push(...expression);

                if (expression.length > 0) {
                    valueStart = expression[0].start;
                    valueEnd = expression[expression.length - 1].end;
                }
            }

            const declarator = this.node(
                "VariableDeclarator",
                name.start,
                declTokens[declTokens.length - 1].end,
                [],
                declTokens,
                name.value
            );
            declarator.typeName = typeName;
            declarator.valueStart = valueStart;
            declarator.valueEnd = valueEnd;
            declarator.variableRole = "variable";
            children.push(declarator);
            used.push(...declTokens.slice(1));

            if (this.isSymbol(",")) {
                used.push(this.take());
                continue;
            }

            if (this.isVariableDeclaratorStart()) {
                this.missing(
                    "missing-comma",
                    "Между объявлениями переменных пропущена ','",
                    this.current().start
                );
                continue;
            }

            break;
        }

        const node = this.node(
            "VariableDeclaration",
            start,
            used[used.length - 1].end,
            children,
            used,
            isConst ? "const" : "var"
        );
        node.modifier = this.modifierOf(modifier);
        return node;
    }

    private parseMacro(modifier?: IRslToken): IRslSyntaxNode {
        const start = modifier ? modifier.start : this.current().start;
        const used = modifier ? [modifier, this.take()] : [this.take()];
        const name = this.expectIdentifier("Ожидается имя MACRO");

        if (name) {
            used.push(name);
        }

        const parameters = this.parseParameterList();
        let returnType: string | undefined;

        if (this.isSymbol(":")) {
            used.push(this.take());

            if (this.current().kind === "identifier") {
                const typeToken = this.take();
                used.push(typeToken);
                returnType = typeToken.value;
            } else {
                this.error(
                    "expected-return-type",
                    "После ':' ожидается возвращаемый тип",
                    this.current()
                );
            }
        }

        const body = this.parseStatementList(new Set(["onerror", "end"]));
        const children = [...parameters.nodes, ...body];

        if (this.word() === "onerror") {
            children.push(this.parseOnError());
        }

        const endToken = this.expectWord("end", "Для MACRO не найден END");

        if (endToken) {
            used.push(endToken);
        }

        const node = this.node(
            "MacroDeclaration",
            start,
            endToken ? endToken.end : this.lastEnd(start),
            children,
            used,
            name && name.value
        );
        node.modifier = this.modifierOf(modifier);
        node.typeName = returnType;
        node.parameterListStart = parameters.start;
        node.parameterListEnd = parameters.end;
        return node;
    }

    private parseClass(modifier?: IRslToken): IRslSyntaxNode {
        const start = modifier ? modifier.start : this.current().start;
        const used = modifier ? [modifier, this.take()] : [this.take()];
        let baseClassName: string | undefined;

        if (this.isSymbol("(")) {
            const inherited = this.consumeBalanced("(", ")", used);
            baseClassName = inherited.find(token =>
                token.kind === "identifier"
            )?.value;
        }

        const name = this.expectIdentifier("Ожидается имя CLASS");

        if (name) {
            used.push(name);
        }

        const parameters = this.parseParameterList();
        const body = this.parseStatementList(new Set(["end"]));
        const endToken = this.expectWord("end", "Для CLASS не найден END");

        if (endToken) {
            used.push(endToken);
        }

        const node = this.node(
            "ClassDeclaration",
            start,
            endToken ? endToken.end : this.lastEnd(start),
            [...parameters.nodes, ...body],
            used,
            name && name.value
        );
        node.modifier = this.modifierOf(modifier);
        node.baseClassName = baseClassName;
        node.parameterListStart = parameters.start;
        node.parameterListEnd = parameters.end;
        return node;
    }

    private parseIf(): IRslSyntaxNode {
        const keyword = this.take();
        const used = [keyword];
        this.parseRequiredCondition(used, "IF");
        const children = this.parseStatementList(
            new Set(["elif", "else", "end"])
        );

        while (this.word() === "elif") {
            const start = this.current().start;
            const clauseTokens = [this.take()];
            this.parseRequiredCondition(clauseTokens, "ELIF");
            const body = this.parseStatementList(
                new Set(["elif", "else", "end"])
            );
            children.push(this.node(
                "ElseIfClause",
                start,
                this.lastEnd(start),
                body,
                clauseTokens
            ));
        }

        if (this.word() === "else") {
            const token = this.take();
            const body = this.parseStatementList(new Set(["end"]));
            children.push(this.node(
                "ElseClause",
                token.start,
                this.lastEnd(token.end),
                body,
                [token]
            ));
        }

        const endToken = this.expectWord("end", "Для IF не найден END");

        if (endToken) {
            used.push(endToken);
        }

        return this.node(
            "IfStatement",
            keyword.start,
            endToken ? endToken.end : this.lastEnd(keyword.end),
            children,
            used
        );
    }

    private parseWhile(): IRslSyntaxNode {
        const keyword = this.take();
        const used = [keyword];
        this.parseRequiredCondition(used, "WHILE");
        const body = this.parseStatementList(new Set(["end"]));
        const endToken = this.expectWord("end", "Для WHILE не найден END");

        if (endToken) {
            used.push(endToken);
        }

        return this.node(
            "WhileStatement",
            keyword.start,
            endToken ? endToken.end : this.lastEnd(keyword.end),
            body,
            used
        );
    }

    private parseFor(): IRslSyntaxNode {
        const keyword = this.take();
        const used = [keyword];
        const headerChildren: IRslSyntaxNode[] = [];

        if (this.isSymbol("(")) {
            const header = this.consumeBalanced("(", ")", used);
            this.validateForHeader(header);
            const forVariable = this.findDeclaredForVariable(header);

            if (forVariable) {
                headerChildren.push(forVariable);
            }
        }

        const body = this.parseStatementList(new Set(["end"]));
        const endToken = this.expectWord("end", "Для FOR не найден END");

        if (endToken) {
            used.push(endToken);
        }

        return this.node(
            "ForStatement",
            keyword.start,
            endToken ? endToken.end : this.lastEnd(keyword.end),
            [...headerChildren, ...body],
            used
        );
    }

    private findDeclaredForVariable(
        header: IRslToken[]
    ): IRslSyntaxNode | undefined {
        const openIndex = header.findIndex(token =>
            token.kind === "symbol" && token.raw === "("
        );

        if (openIndex < 0) {
            return undefined;
        }

        const varToken = header[openIndex + 1];
        const nameToken = header[openIndex + 2];

        if (
            !varToken ||
            varToken.kind !== "identifier" ||
            normalizeIdentifier(varToken.value) !== "var" ||
            !nameToken ||
            nameToken.kind !== "identifier" ||
            RESERVED.has(normalizeIdentifier(nameToken.value))
        ) {
            return undefined;
        }

        const variableTokens = [nameToken];
        let typeName: string | undefined;
        let index = openIndex + 3;

        if (
            header[index] &&
            header[index].kind === "symbol" &&
            header[index].raw === ":"
        ) {
            variableTokens.push(header[index]);
            index++;

            if (
                header[index] &&
                header[index].kind === "symbol" &&
                header[index].raw === "@"
            ) {
                variableTokens.push(header[index]);
                index++;
            }

            if (header[index] && header[index].kind === "identifier") {
                variableTokens.push(header[index]);
                typeName = header[index].value;
            }
        }

        const node = this.node(
            "VariableDeclarator",
            nameToken.start,
            variableTokens[variableTokens.length - 1].end,
            [],
            variableTokens,
            nameToken.value
        );
        node.typeName = typeName;
        node.variableRole = "for";
        return node;
    }

    private parseOnError(): IRslSyntaxNode {
        const keyword = this.take();
        const used = [keyword];
        const children: IRslSyntaxNode[] = [];

        if (this.isSymbol("(")) {
            used.push(this.take());
            const name = this.expectIdentifier(
                "В ONERROR ожидается имя переменной ошибки"
            );

            if (name) {
                used.push(name);
                const variable = this.node(
                    "VariableDeclarator",
                    name.start,
                    name.end,
                    [],
                    [name],
                    name.value
                );
                variable.typeName = "TrslError";
                variable.variableRole = "onerror";
                children.push(variable);
            }

            if (this.isSymbol(")")) {
                used.push(this.take());
            } else {
                this.missing(
                    "missing-closing-parenthesis",
                    "В ONERROR пропущена ')'",
                    this.current().start
                );
            }
        }

        children.push(...this.parseStatementList(new Set(["end"])));
        return this.node(
            "OnErrorClause",
            keyword.start,
            this.lastEnd(keyword.end),
            children,
            used
        );
    }

    private parseSimpleKeyword(
        kind: "ReturnStatement" | "BreakStatement" | "ContinueStatement"
    ): IRslSyntaxNode {
        const keyword = this.take();
        const used = [keyword];

        if (kind === "ReturnStatement") {
            used.push(...this.consumeExpression(
                new Set([";"]),
                BLOCK_BOUNDARIES
            ));
        }

        return this.node(
            kind,
            keyword.start,
            used[used.length - 1].end,
            [],
            used
        );
    }

    private parseExpressionStatement(prefix?: IRslToken): IRslSyntaxNode {
        const used = prefix ? [prefix] : [];
        const start = prefix ? prefix.start : this.current().start;
        used.push(...this.consumeExpression(
            new Set([";"]),
            BLOCK_BOUNDARIES
        ));

        if (used.length === 0) {
            used.push(this.take());
        }

        return this.node(
            "ExpressionStatement",
            start,
            used[used.length - 1].end,
            [],
            used
        );
    }

    private parseParameterList(): IParameterListResult {
        if (!this.isSymbol("(")) {
            return { nodes: [] };
        }

        const startToken = this.take();
        const result: IRslSyntaxNode[] = [];

        while (!this.atEnd() && !this.isSymbol(")")) {
            const name = this.current();

            if (
                name.kind !== "identifier" ||
                RESERVED.has(this.word())
            ) {
                this.error(
                    "expected-parameter",
                    "Ожидается имя параметра",
                    name
                );
                this.take();
                continue;
            }

            this.take();
            const used = [name];
            let typeName: string | undefined;

            if (this.isSymbol(":")) {
                used.push(this.take());

                if (this.isSymbol("@")) {
                    used.push(this.take());
                }

                if (this.current().kind === "identifier") {
                    const typeToken = this.take();
                    used.push(typeToken);
                    typeName = typeToken.value;
                } else {
                    this.error(
                        "expected-type",
                        "Ожидается тип параметра",
                        this.current()
                    );
                }
            }

            const parameter = this.node(
                "Parameter",
                name.start,
                used[used.length - 1].end,
                [],
                used,
                name.value
            );
            parameter.typeName = typeName;
            parameter.variableRole = "parameter";
            result.push(parameter);

            if (this.isSymbol(",")) {
                this.take();
                continue;
            }

            if (this.isVariableDeclaratorStart()) {
                this.missing(
                    "missing-comma",
                    "Между параметрами пропущена ','",
                    this.current().start
                );
                continue;
            }

            break;
        }

        let end = this.current().start;

        if (this.isSymbol(")")) {
            end = this.take().end;
        } else {
            this.missing(
                "missing-closing-parenthesis",
                "В списке параметров пропущена ')'",
                this.current().start
            );
        }

        return {
            nodes: result,
            start: startToken.start,
            end
        };
    }

    private consumeStatementSeparator(
        statement: IRslSyntaxNode,
        stop: Set<string>
    ): void {
        if (this.isSymbol(";")) {
            this.take();
            return;
        }

        const word = this.word();

        /* По правилам RSL перед ELIF, ELSE и END ';' необязательна. */
        if (stop.has(word) || BLOCK_BOUNDARIES.has(word) || this.atEnd()) {
            return;
        }

        if (this.canStartStatement()) {
            statement.missingSemicolon = true;
            this.missing(
                "missing-semicolon",
                "После инструкции пропущена ';'",
                this.current().start
            );
        }
    }

    private consumeExpression(
        symbolStops: Set<string>,
        wordStops: Set<string>
    ): IRslToken[] {
        const result: IRslToken[] = [];
        let parenthesisDepth = 0;
        let bracketDepth = 0;

        while (!this.atEnd()) {
            const token = this.current();

            if (token.kind === "symbol") {
                if (token.raw === "(") {
                    parenthesisDepth++;
                } else if (token.raw === ")") {
                    if (parenthesisDepth === 0) {
                        break;
                    }
                    parenthesisDepth--;
                } else if (token.raw === "[") {
                    bracketDepth++;
                } else if (token.raw === "]") {
                    if (bracketDepth === 0) {
                        break;
                    }
                    bracketDepth--;
                }

                if (
                    parenthesisDepth === 0 &&
                    bracketDepth === 0 &&
                    symbolStops.has(token.raw)
                ) {
                    break;
                }
            }

            if (
                parenthesisDepth === 0 &&
                bracketDepth === 0 &&
                token.kind === "identifier" &&
                wordStops.has(this.word())
            ) {
                break;
            }

            if (
                parenthesisDepth === 0 &&
                bracketDepth === 0 &&
                result.length > 0 &&
                this.isLikelyNewStatement(token, result[result.length - 1])
            ) {
                break;
            }

            result.push(this.take());
        }

        return result;
    }

    /**
     * Перевод строки не является разделителем RSL. Новую инструкцию можно
     * предположить только когда предыдущий токен действительно завершает
     * выражение. После '+', '=', AND, OR, NOT, точки, запятой и открывающей
     * скобки выражение обязано продолжаться на следующей строке.
     */
    private isLikelyNewStatement(
        token: IRslToken,
        previous: IRslToken
    ): boolean {
        if (token.line === previous.endLine) {
            return false;
        }

        if (!this.canEndExpression(previous)) {
            return false;
        }

        if (this.isExpressionContinuation(token)) {
            return false;
        }

        return this.canStartExpression(token);
    }

    private canEndExpression(token: IRslToken): boolean {
        if (
            token.kind === "number" ||
            token.kind === "string" ||
            token.kind === "square"
        ) {
            return true;
        }

        if (token.kind === "identifier") {
            return !WORD_OPERATORS.has(normalizeIdentifier(token.value));
        }

        return token.kind === "symbol" &&
            (token.raw === ")" || token.raw === "]" || token.raw === "}");
    }

    private isExpressionContinuation(token: IRslToken): boolean {
        if (token.kind === "identifier") {
            return WORD_OPERATORS.has(normalizeIdentifier(token.value));
        }

        return token.kind === "symbol" && SYMBOL_OPERATORS.has(token.raw);
    }

    private canStartExpression(token: IRslToken): boolean {
        if (
            token.kind === "number" ||
            token.kind === "string" ||
            token.kind === "square"
        ) {
            return true;
        }

        if (token.kind !== "identifier") {
            return false;
        }

        const word = normalizeIdentifier(token.value);
        return !WORD_OPERATORS.has(word) || STATEMENT_KEYWORDS.has(word);
    }

    private parseRequiredCondition(
        used: IRslToken[],
        owner: string
    ): void {
        if (!this.isSymbol("(")) {
            this.missing(
                "missing-opening-parenthesis",
                `После ${owner} пропущена '('`,
                this.current().start
            );
            return;
        }

        this.consumeBalanced("(", ")", used);
    }

    private consumeBalanced(
        open: string,
        close: string,
        used: IRslToken[]
    ): IRslToken[] {
        const consumed: IRslToken[] = [];
        let depth = 0;

        while (!this.atEnd()) {
            const token = this.take();
            used.push(token);
            consumed.push(token);

            if (token.kind !== "symbol") {
                continue;
            }

            if (token.raw === open) {
                depth++;
            } else if (token.raw === close) {
                depth--;

                if (depth === 0) {
                    return consumed;
                }
            }
        }

        this.missing(
            "missing-closing-parenthesis",
            `Для '${open}' не найдена '${close}'`,
            this.lastEnd(0)
        );
        return consumed;
    }

    private validateForHeader(tokens: IRslToken[]): void {
        let depth = 0;
        let commas = 0;

        for (const token of tokens) {
            if (token.kind !== "symbol") {
                continue;
            }

            if (token.raw === "(") {
                depth++;
            } else if (token.raw === ")") {
                depth--;
            } else if (token.raw === "," && depth === 1) {
                commas++;
            }
        }

        if (commas > 3) {
            const token = tokens.find(item =>
                item.kind === "symbol" && item.raw === ","
            ) || tokens[0];

            if (token) {
                this.error(
                    "invalid-for-header",
                    "В заголовке FOR слишком много параметров",
                    token
                );
            }
        }
    }

    private expectIdentifier(message: string): IRslToken | undefined {
        const token = this.current();

        if (
            token.kind === "identifier" &&
            !RESERVED.has(this.word())
        ) {
            return this.take();
        }

        this.error("expected-identifier", message, token);
        return undefined;
    }

    private expectWord(
        value: string,
        message: string
    ): IRslToken | undefined {
        if (this.word() === value) {
            return this.take();
        }

        this.missing("missing-end", message, this.current().start);
        return undefined;
    }

    private isVariableDeclaratorStart(): boolean {
        return this.current().kind === "identifier" &&
            !RESERVED.has(this.word());
    }

    private canStartStatement(): boolean {
        const token = this.current();

        if (
            token.kind === "square" ||
            token.kind === "string" ||
            token.kind === "number"
        ) {
            return true;
        }

        return token.kind === "identifier";
    }

    private modifierOf(
        token?: IRslToken
    ): RslDeclarationModifier | undefined {
        if (!token || token.kind !== "identifier") {
            return undefined;
        }

        const value = normalizeIdentifier(token.value);
        return value === "local" || value === "private"
            ? value
            : undefined;
    }

    private node(
        kind: RslSyntaxKind,
        start: number,
        end: number,
        children: IRslSyntaxNode[],
        tokens: IRslToken[],
        name?: string
    ): IRslSyntaxNode {
        return {
            kind,
            start,
            end,
            children,
            tokens,
            name
        };
    }

    private error(
        code: string,
        message: string,
        token: IRslToken
    ): void {
        this.diagnostics.push({
            code,
            message,
            start: token.start,
            end: Math.max(token.end, token.start + 1)
        });
    }

    private missing(
        code: string,
        message: string,
        position: number
    ): void {
        this.diagnostics.push({
            code,
            message,
            start: position,
            end: position + 1
        });
    }

    private word(): string {
        const token = this.current();
        return token.kind === "identifier"
            ? normalizeIdentifier(token.value)
            : "";
    }

    private isSymbol(value: string): boolean {
        const token = this.current();
        return token.kind === "symbol" && token.raw === value;
    }

    private current(): IRslToken {
        return this.tokens[this.index] || {
            kind: "symbol",
            raw: "",
            value: "",
            start: this.source.length,
            end: this.source.length,
            line: this.lex.lineStarts.length - 1,
            character: 0,
            endLine: this.lex.lineStarts.length - 1,
            endCharacter: 0
        };
    }

    private take(): IRslToken {
        return this.tokens[this.index++] || this.current();
    }

    private atEnd(): boolean {
        return this.index >= this.tokens.length;
    }

    private lastEnd(fallback: number): number {
        return this.index > 0
            ? this.tokens[this.index - 1].end
            : fallback;
    }
}

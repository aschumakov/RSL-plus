import { IRslToken, lexRsl, normalizeIdentifier } from "./lexer";

export type RslSyntaxKind =
    | "CompilationUnit" | "ImportDeclaration" | "VariableDeclaration"
    | "VariableDeclarator" | "MacroDeclaration" | "ClassDeclaration"
    | "Parameter" | "IfStatement" | "ElseIfClause" | "ElseClause"
    | "WhileStatement" | "ForStatement" | "OnErrorClause"
    | "ReturnStatement" | "BreakStatement" | "ContinueStatement"
    | "ExpressionStatement" | "EmptyStatement" | "UnknownStatement";

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
    missingSemicolon?: boolean;
}

export interface IRslParseResult {
    root: IRslSyntaxNode;
    diagnostics: IRslSyntaxDiagnostic[];
    tokens: IRslToken[];
}

const RESERVED = new Set([
    "and", "if", "record", "array", "import", "return", "const", "macro",
    "this", "class", "not", "true", "elif", "null", "var", "end",
    "onerror", "with", "false", "or", "while", "file", "local", "private",
    "break", "continue"
]);

const BLOCK_BOUNDARIES = new Set(["end", "elif", "else", "onerror"]);
const STATEMENT_START = new Set([
    "import", "var", "const", "macro", "class", "if", "while", "for",
    "return", "break", "continue", "local", "private"
]);

export function parseRslSyntax(source: string): IRslParseResult {
    const lex = lexRsl(source || "");
    const tokens = lex.tokens.filter(token =>
        token.kind !== "whitespace" && token.kind !== "newline" &&
        token.kind !== "comment" && token.kind !== "bom"
    );
    const parser = new Parser(tokens, source || "");
    return parser.parse();
}

class Parser {
    private index = 0;
    private diagnostics: IRslSyntaxDiagnostic[] = [];

    constructor(private tokens: IRslToken[], private source: string) {}

    parse(): IRslParseResult {
        const children = this.parseStatementList(new Set<string>());
        const end = children.length ? children[children.length - 1].end : 0;
        return {
            root: { kind: "CompilationUnit", start: 0, end: Math.max(end, this.source.length), children, tokens: [] },
            diagnostics: this.diagnostics,
            tokens: this.tokens
        };
    }

    private parseStatementList(stop: Set<string>): IRslSyntaxNode[] {
        const result: IRslSyntaxNode[] = [];
        while (!this.atEnd()) {
            const word = this.word();
            if (stop.has(word)) break;
            if (this.isSymbol(";")) {
                const token = this.take();
                result.push(this.node("EmptyStatement", token.start, token.end, [], [token]));
                continue;
            }
            const before = this.index;
            const statement = this.parseStatement();
            result.push(statement);
            if (this.index === before) this.index++;
            this.consumeStatementSeparator(statement, stop);
        }
        return result;
    }

    private parseStatement(): IRslSyntaxNode {
        let modifier: IRslToken | undefined;
        if (this.word() === "local" || this.word() === "private") modifier = this.take();
        const word = this.word();
        switch (word) {
            case "import": return this.parseImport(modifier);
            case "var": return this.parseVariables(modifier, false);
            case "const": return this.parseVariables(modifier, true);
            case "macro": return this.parseMacro(modifier);
            case "class": return this.parseClass(modifier);
            case "if": return this.parseIf();
            case "while": return this.parseWhile();
            case "for": return this.parseFor();
            case "return": return this.parseSimpleKeyword("ReturnStatement");
            case "break": return this.parseSimpleKeyword("BreakStatement");
            case "continue": return this.parseSimpleKeyword("ContinueStatement");
            default:
                if (modifier) {
                    this.error("unexpected-modifier", `После ${modifier.raw.toUpperCase()} ожидается VAR, CONST, MACRO или CLASS`, modifier);
                }
                return this.parseExpressionStatement(modifier);
        }
    }

    private parseImport(modifier?: IRslToken): IRslSyntaxNode {
        const start = modifier ? modifier.start : this.current().start;
        const items: IRslSyntaxNode[] = [];
        const used: IRslToken[] = modifier ? [modifier] : [];
        used.push(this.take());
        while (!this.atEnd() && !this.isSymbol(";") && !BLOCK_BOUNDARIES.has(this.word())) {
            const token = this.current();
            if (token.kind !== "identifier" && token.kind !== "string") {
                this.error("expected-import-name", "Ожидается имя импортируемого модуля", token);
                this.take();
                continue;
            }
            const name = this.take();
            used.push(name);
            items.push(this.node("UnknownStatement", name.start, name.end, [], [name], name.value));
            if (this.isSymbol(",")) { used.push(this.take()); continue; }
            if (this.current().kind === "identifier" || this.current().kind === "string") {
                this.missing(
                    "missing-comma",
                    "Между импортируемыми модулями пропущена \",\"",
                    this.current().start
                );
                continue;
            }
            break;
        }
        const end = used.length ? used[used.length - 1].end : start;
        return this.node("ImportDeclaration", start, end, items, used);
    }

    private parseVariables(modifier: IRslToken | undefined, isConst: boolean): IRslSyntaxNode {
        const start = modifier ? modifier.start : this.current().start;
        const used: IRslToken[] = modifier ? [modifier] : [];
        used.push(this.take());
        const children: IRslSyntaxNode[] = [];
        while (!this.atEnd() && !this.isSymbol(";") && !BLOCK_BOUNDARIES.has(this.word())) {
            const name = this.current();
            if (name.kind !== "identifier" || RESERVED.has(normalizeIdentifier(name.value))) {
                this.error("expected-variable-name", "Ожидается имя переменной", name);
                break;
            }
            this.take(); used.push(name);
            const declTokens: IRslToken[] = [name];
            if (this.isSymbol(":")) {
                declTokens.push(this.take());
                if (this.current().kind === "identifier" || this.isSymbol("@")) {
                    if (this.isSymbol("@")) declTokens.push(this.take());
                    if (this.current().kind === "identifier") declTokens.push(this.take());
                } else this.error("expected-type", "После ':' ожидается имя типа", this.current());
            }
            if (this.isSymbol("=")) {
                declTokens.push(this.take());
                declTokens.push(...this.consumeExpression(new Set([",", ";"]), BLOCK_BOUNDARIES));
            }
            const end = declTokens[declTokens.length - 1].end;
            children.push(this.node("VariableDeclarator", name.start, end, [], declTokens, name.value));
            used.push(...declTokens.slice(1));
            if (this.isSymbol(",")) { used.push(this.take()); continue; }
            if (this.current().kind === "identifier" && !BLOCK_BOUNDARIES.has(this.word())) {
                this.missing("missing-comma", "Между объявлениями переменных пропущена ','", this.current().start);
                continue;
            }
            break;
        }
        return this.node("VariableDeclaration", start, used[used.length - 1].end, children, used, isConst ? "const" : "var");
    }

    private parseMacro(modifier?: IRslToken): IRslSyntaxNode {
        const start = modifier ? modifier.start : this.current().start;
        const used = modifier ? [modifier, this.take()] : [this.take()];
        const name = this.expectIdentifier("Ожидается имя MACRO");
        if (name) used.push(name);
        const parameters = this.parseParameterList();
        if (this.isSymbol(":")) {
            used.push(this.take());
            if (this.current().kind === "identifier") used.push(this.take());
            else this.error("expected-return-type", "После ':' ожидается возвращаемый тип", this.current());
        }
        const body = this.parseStatementList(new Set(["onerror", "end"]));
        const children = [...parameters, ...body];
        if (this.word() === "onerror") children.push(this.parseOnError());
        const endToken = this.expectWord("end", "Для MACRO не найден END");
        if (endToken) used.push(endToken);
        return this.node("MacroDeclaration", start, endToken ? endToken.end : this.lastEnd(start), children, used, name && name.value);
    }

    private parseClass(modifier?: IRslToken): IRslSyntaxNode {
        const start = modifier ? modifier.start : this.current().start;
        const used = modifier ? [modifier, this.take()] : [this.take()];
        if (this.isSymbol("(")) this.consumeBalanced("(", ")", used);
        const name = this.expectIdentifier("Ожидается имя CLASS");
        if (name) used.push(name);
        const parameters = this.parseParameterList();
        const body = this.parseStatementList(new Set(["end"]));
        const endToken = this.expectWord("end", "Для CLASS не найден END");
        if (endToken) used.push(endToken);
        return this.node("ClassDeclaration", start, endToken ? endToken.end : this.lastEnd(start), [...parameters, ...body], used, name && name.value);
    }

    private parseIf(): IRslSyntaxNode {
        const keyword = this.take();
        const used = [keyword];
        this.parseRequiredCondition(used, "IF");
        const children = this.parseStatementList(new Set(["elif", "else", "end"]));
        while (this.word() === "elif") {
            const start = this.current().start;
            const clauseTokens = [this.take()];
            this.parseRequiredCondition(clauseTokens, "ELIF");
            const body = this.parseStatementList(new Set(["elif", "else", "end"]));
            children.push(this.node("ElseIfClause", start, this.lastEnd(start), body, clauseTokens));
        }
        if (this.word() === "else") {
            const token = this.take();
            const body = this.parseStatementList(new Set(["end"]));
            children.push(this.node("ElseClause", token.start, this.lastEnd(token.end), body, [token]));
        }
        const endToken = this.expectWord("end", "Для IF не найден END");
        if (endToken) used.push(endToken);
        return this.node("IfStatement", keyword.start, endToken ? endToken.end : this.lastEnd(keyword.end), children, used);
    }

    private parseWhile(): IRslSyntaxNode {
        const keyword = this.take();
        const used = [keyword];
        this.parseRequiredCondition(used, "WHILE");
        const body = this.parseStatementList(new Set(["end"]));
        const endToken = this.expectWord("end", "Для WHILE не найден END");
        if (endToken) used.push(endToken);
        return this.node("WhileStatement", keyword.start, endToken ? endToken.end : this.lastEnd(keyword.end), body, used);
    }

    private parseFor(): IRslSyntaxNode {
        const keyword = this.take();
        const used = [keyword];
        if (this.isSymbol("(")) {
            const headerStart = this.index;
            this.consumeBalanced("(", ")", used);
            const header = this.tokens.slice(headerStart, this.index);
            this.validateForHeader(header);
        }
        const body = this.parseStatementList(new Set(["end"]));
        const endToken = this.expectWord("end", "Для FOR не найден END");
        if (endToken) used.push(endToken);
        return this.node("ForStatement", keyword.start, endToken ? endToken.end : this.lastEnd(keyword.end), body, used);
    }

    private parseOnError(): IRslSyntaxNode {
        const keyword = this.take();
        const used = [keyword];
        const children: IRslSyntaxNode[] = [];
        if (this.isSymbol("(")) {
            used.push(this.take());
            const name = this.expectIdentifier("В ONERROR ожидается имя переменной ошибки");
            if (name) {
                used.push(name);
                children.push(this.node("VariableDeclarator", name.start, name.end, [], [name], name.value));
            }
            if (this.isSymbol(")")) used.push(this.take());
            else this.missing("missing-closing-parenthesis", "В ONERROR пропущена ')'", this.current().start);
        }
        children.push(...this.parseStatementList(new Set(["end"])));
        return this.node("OnErrorClause", keyword.start, this.lastEnd(keyword.end), children, used);
    }

    private parseSimpleKeyword(kind: "ReturnStatement" | "BreakStatement" | "ContinueStatement"): IRslSyntaxNode {
        const keyword = this.take();
        const used = [keyword];
        if (kind === "ReturnStatement") used.push(...this.consumeExpression(new Set([";"]), BLOCK_BOUNDARIES));
        return this.node(kind, keyword.start, used[used.length - 1].end, [], used);
    }

    private parseExpressionStatement(prefix?: IRslToken): IRslSyntaxNode {
        const used = prefix ? [prefix] : [];
        const start = prefix ? prefix.start : this.current().start;
        used.push(...this.consumeExpression(new Set([";"]), BLOCK_BOUNDARIES));
        if (!used.length) used.push(this.take());
        return this.node("ExpressionStatement", start, used[used.length - 1].end, [], used);
    }

    private parseParameterList(): IRslSyntaxNode[] {
        if (!this.isSymbol("(")) return [];
        this.take();
        const result: IRslSyntaxNode[] = [];
        while (!this.atEnd() && !this.isSymbol(")")) {
            const name = this.current();
            if (name.kind !== "identifier" || RESERVED.has(this.word())) {
                this.error("expected-parameter", "Ожидается имя параметра", name);
                this.take();
                continue;
            }
            this.take();
            const used = [name];
            if (this.isSymbol(":")) {
                used.push(this.take());
                if (this.isSymbol("@")) used.push(this.take());
                if (this.current().kind === "identifier") used.push(this.take());
                else this.error("expected-type", "Ожидается тип параметра", this.current());
            }
            result.push(this.node("Parameter", name.start, used[used.length - 1].end, [], used, name.value));
            if (this.isSymbol(",")) { this.take(); continue; }
            if (this.current().kind === "identifier") {
                this.missing("missing-comma", "Между параметрами пропущена ','", this.current().start);
                continue;
            }
            break;
        }
        if (this.isSymbol(")")) this.take();
        else this.missing("missing-closing-parenthesis", "В списке параметров пропущена ')'", this.current().start);
        return result;
    }

    private consumeStatementSeparator(statement: IRslSyntaxNode, stop: Set<string>): void {
        if (this.isSymbol(";")) { this.take(); return; }
        const word = this.word();
        if (stop.has(word) || BLOCK_BOUNDARIES.has(word) || this.atEnd()) return;
        if (this.canStartStatement()) {
            statement.missingSemicolon = true;
            this.missing("missing-semicolon", "После инструкции пропущена ';'", this.current().start);
        }
    }

    private consumeExpression(symbolStops: Set<string>, wordStops: Set<string>): IRslToken[] {
        const result: IRslToken[] = [];
        let paren = 0;
        let bracket = 0;
        while (!this.atEnd()) {
            const token = this.current();
            if (token.kind === "symbol") {
                if (token.raw === "(") paren++;
                else if (token.raw === ")") { if (paren === 0) break; paren--; }
                else if (token.raw === "[") bracket++;
                else if (token.raw === "]") { if (bracket === 0) break; bracket--; }
                if (paren === 0 && bracket === 0 && symbolStops.has(token.raw)) break;
            }
            if (paren === 0 && bracket === 0 && token.kind === "identifier" && wordStops.has(this.word())) break;
            if (paren === 0 && bracket === 0 && result.length > 0 && this.isLikelyNewStatement(token, result[result.length - 1])) break;
            result.push(this.take());
        }
        return result;
    }

    private isLikelyNewStatement(token: IRslToken, previous: IRslToken): boolean {
        if (token.line === previous.endLine) return false;
        const word = normalizeIdentifier(token.value);
        return token.kind === "identifier" && (STATEMENT_START.has(word) || this.looksLikeCallStart());
    }

    private looksLikeCallStart(): boolean {
        const next = this.tokens[this.index + 1];
        return this.current().kind === "identifier" && !!next &&
            (next.kind === "identifier" || (next.kind === "symbol" && (next.raw === "(" || next.raw === "." || next.raw === "=")));
    }

    private parseRequiredCondition(used: IRslToken[], owner: string): void {
        if (!this.isSymbol("(")) {
            this.missing("missing-opening-parenthesis", `После ${owner} пропущена '('`, this.current().start);
            return;
        }
        this.consumeBalanced("(", ")", used);
    }

    private consumeBalanced(open: string, close: string, used: IRslToken[]): void {
        let depth = 0;
        while (!this.atEnd()) {
            const token = this.take(); used.push(token);
            if (token.kind !== "symbol") continue;
            if (token.raw === open) depth++;
            else if (token.raw === close) {
                depth--;
                if (depth === 0) return;
            }
        }
        this.missing("missing-closing-parenthesis", `Для '${open}' не найдена '${close}'`, this.lastEnd(0));
    }

    private validateForHeader(tokens: IRslToken[]): void {
        let depth = 0;
        let commas = 0;
        for (const token of tokens) {
            if (token.kind !== "symbol") continue;
            if (token.raw === "(") depth++;
            else if (token.raw === ")") depth--;
            else if (token.raw === "," && depth === 1) commas++;
        }
        if (commas > 3) {
            const token = tokens.find(item => item.kind === "symbol" && item.raw === ",") || tokens[0];
            this.error("invalid-for-header", "В заголовке FOR слишком много параметров", token);
        }
    }

    private expectIdentifier(message: string): IRslToken | undefined {
        const token = this.current();
        if (token.kind === "identifier" && !RESERVED.has(this.word())) return this.take();
        this.error("expected-identifier", message, token);
        return undefined;
    }

    private expectWord(value: string, message: string): IRslToken | undefined {
        if (this.word() === value) return this.take();
        this.missing("missing-end", message, this.current().start);
        return undefined;
    }

    private canStartStatement(): boolean {
        const token = this.current();
        if (token.kind === "square" || token.kind === "string") return true;
        if (token.kind !== "identifier") return false;
        return true;
    }

    private node(kind: RslSyntaxKind, start: number, end: number, children: IRslSyntaxNode[], tokens: IRslToken[], name?: string): IRslSyntaxNode {
        return { kind, start, end, children, tokens, name };
    }

    private error(code: string, message: string, token: IRslToken): void {
        this.diagnostics.push({ code, message, start: token.start, end: Math.max(token.end, token.start + 1) });
    }

    private missing(code: string, message: string, position: number): void {
        this.diagnostics.push({ code, message, start: position, end: position + 1 });
    }

    private word(): string {
        const token = this.current();
        return token.kind === "identifier" ? normalizeIdentifier(token.value) : "";
    }

    private isSymbol(value: string): boolean {
        const token = this.current();
        return token.kind === "symbol" && token.raw === value;
    }

    private current(): IRslToken {
        return this.tokens[this.index] || {
            kind: "symbol", raw: "", value: "", start: this.source.length,
            end: this.source.length, line: 0, character: 0, endLine: 0, endCharacter: 0
        };
    }

    private take(): IRslToken { return this.tokens[this.index++] || this.current(); }
    private atEnd(): boolean { return this.index >= this.tokens.length; }
    private lastEnd(fallback: number): number { return this.index > 0 ? this.tokens[this.index - 1].end : fallback; }
}

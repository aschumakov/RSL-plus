import {
    CompletionItem,
    CompletionItemKind
} from "vscode-languageserver";

import { RslSymbol } from "./symbols/rslSymbol";
import {
    IRslToken,
    tokenAtOffset,
    normalizeIdentifier,
    normalizeReferenceIdentifier
} from "./lexer";
import {
    IIndexedModule,
    IIndexedSymbol,
    WorkspaceIndex
} from "./workspaceIndex";
import { getDefaults } from "./defaults";
import type { BuiltinCatalog } from "./builtins/builtinSymbol";
import type {
    PlatformModuleCatalog
} from "./builtins/platformModuleCatalog";

export const RSL_BUILTIN_URI = "rsl-builtin:/standard-library";

export interface IResolvedSymbol {
    uri: string;
    symbol: RslSymbol;
    token: IRslToken;
}

interface IResolutionCache {
    closureKey: string;
    byTokenStart: Map<number, IResolvedSymbol | null>;
}

interface IConstructorAssignment {
    offset: number;
    /** Тип для прямого вызова: конструктор класса или процедура. */
    typeName: string;
    /**
     * Вызов метода получателя: `rs = cmd.Execute()`.
     *
     * Тип здесь нельзя посчитать на этапе разбора токенов: сначала нужно
     * выяснить класс получателя, а это уже разрешение имён. Поэтому имена
     * запоминаются, а тип берётся при выводе (см. inferAssignedType).
     */
    member?: {
        receiver: string;
        method: string;
    };
}

/*
 * RslSymbol после построения syntax tree фактически неизменяем. Кэши WeakMap
 * не удерживают старые деревья после обновления документа.
 */
const objectChildrenCache = new WeakMap<RslSymbol, RslSymbol[]>();
const childrenByNameCache = new WeakMap<RslSymbol, Map<string, RslSymbol[]>>();

/**
 * Разрешает имена с учётом областей видимости RSL.
 *
 * Горячий путь используется semantic tokens для каждого идентификатора,
 * поэтому здесь нельзя заново фильтровать весь token stream или линейно
 * перебирать все объявления scope при каждом вызове.
 */
export class RslScopeResolver {
    private tokensByModule = new WeakMap<IIndexedModule, IRslToken[]>();
    private resolutionByModule = new WeakMap<IIndexedModule, IResolutionCache>();
    private constructorAssignmentsByModule = new WeakMap<
        IIndexedModule,
        Map<string, IConstructorAssignment[]>
    >();
    private resolutionCacheHits = 0;
    private resolutionCacheMisses = 0;
    /** Присваивания, тип которых сейчас вычисляется: защита от цикла. */
    private memberTypeGuard = new Set<IConstructorAssignment>();
    /*
     * Видимые прикладные модули на документ.
     *
     * Считаются по Import и сбрасываются по номеру ревизии индекса: набор
     * зависит и от текста файла, и от того, какие импортированные модули уже
     * разобраны. Кэш нужен потому, что обход вызывается из Completion, а тот
     * срабатывает на каждое нажатие.
     */
    private visibleModulesByUri = new Map<
        string,
        { revision: number; modules: readonly string[] }
    >();

    constructor(
        private index: WorkspaceIndex,
        private builtins: BuiltinCatalog = getDefaults(),
        private platformModules?: PlatformModuleCatalog
    ) {}

    resolveAt(
        uri: string,
        tree: RslSymbol,
        offset: number
    ): IResolvedSymbol | undefined {
        const module = this.index.getModule(uri);

        if (!module) {
            return undefined;
        }

        const tokens = this.getTokens(module);
        let token = tokenAtOffset(tokens, offset, true);

        /*
         * По грамматике @ — отдельный унарный оператор, а не часть NAME.
         * При переходе с самого символа @ всё равно разрешаем следующий
         * идентификатор, чтобы навигация по ссылочному аргументу не ухудшилась.
         */
        if (token?.kind === "symbol" && token.raw === "@") {
            const operatorIndex = findTokenIndex(tokens, token);
            const operand = tokens[operatorIndex + 1];

            if (operand?.kind === "identifier") {
                token = operand;
            }
        }

        if (!token || token.kind !== "identifier") {
            return undefined;
        }

        const closureKey = this.index.getImportClosureKey(uri);
        let cache = this.resolutionByModule.get(module);

        if (!cache || cache.closureKey !== closureKey) {
            cache = {
                closureKey,
                byTokenStart: new Map<number, IResolvedSymbol | null>()
            };
            this.resolutionByModule.set(module, cache);
        }

        if (cache.byTokenStart.has(token.start)) {
            this.resolutionCacheHits++;
            return cache.byTokenStart.get(token.start) || undefined;
        }

        this.resolutionCacheMisses++;
        const resolved = this.resolveTokenAt(
            uri,
            tree,
            offset,
            token,
            tokens
        );
        cache.byTokenStart.set(token.start, resolved || null);
        return resolved;
    }

    getCacheStats(): { hits: number; misses: number } {
        return {
            hits: this.resolutionCacheHits,
            misses: this.resolutionCacheMisses
        };
    }

    /** Разрешает имя в позиции типа, не позволяя переменной затенить CLASS. */
    resolveTypeName(
        uri: string,
        tree: RslSymbol,
        name: string
    ): IIndexedSymbol | undefined {
        return this.findClassSymbol(uri, tree, name);
    }

    /**
     * Разрешает имя метода, переданное строкой в R2M(object, "Method").
     * Обычный resolveAt здесь неприменим: строковый token не является NAME,
     * но тип receiver определяется тем же способом, что для object.Method().
     */
    resolveMemberReference(
        uri: string,
        tree: RslSymbol,
        receiverOffset: number,
        memberName: string
    ): IIndexedSymbol | undefined {
        const module = this.index.getModule(uri);
        if (!module) {
            return undefined;
        }

        const receiver = tokenAtOffset(
            this.getTokens(module),
            receiverOffset,
            true
        );
        if (!receiver || receiver.kind !== "identifier") {
            return undefined;
        }

        return this.resolveMember(
            uri,
            tree,
            receiverOffset,
            receiver,
            memberName
        );
    }

    private resolveTokenAt(
        uri: string,
        tree: RslSymbol,
        offset: number,
        token: IRslToken,
        tokens: IRslToken[]
    ): IResolvedSymbol | undefined {
        const tokenIndex = findTokenIndex(tokens, token);
        const receiver = this.getReceiverToken(tokens, tokenIndex);
        const referenceName = normalizeReferenceIdentifier(token.value);

        if (receiver) {
            const member = this.resolveMember(
                uri,
                tree,
                offset,
                receiver,
                token.value
            );

            return member
                ? {
                    uri: member.uri,
                    symbol: member.symbol,
                    token
                }
                : undefined;
        }

        const local = this.resolveInScopeChain(
            tree,
            referenceName,
            offset
        );

        if (local) {
            return { uri, symbol: local, token };
        }

        const imported = this.index.findImportedSymbols(
            uri,
            referenceName
        )[0];

        if (imported) {
            return {
                uri: imported.uri,
                symbol: imported.symbol,
                token
            };
        }

        const builtin = this.builtins.findSymbol(referenceName);

        if (builtin) {
            return {
                uri: RSL_BUILTIN_URI,
                symbol: builtin,
                token
            };
        }

        /*
         * Символ импортированного прикладного модуля — последним, после
         * объявлений файла, импортированных модулей проекта и стандартной
         * библиотеки: он доступен только через Import и не должен перекрывать
         * одноимённое объявление, которое ближе к пользователю.
         */
        const platform = this.platformModules?.findSymbol(
            this.visiblePlatformModules(uri),
            referenceName
        );

        return platform
            ? {
                uri: RSL_BUILTIN_URI,
                symbol: platform,
                token
            }
            : undefined;
    }

    getCompletions(
        uri: string,
        tree: RslSymbol,
        offset: number
    ): CompletionItem[] {
        const module = this.index.getModule(uri);

        if (!module) {
            return [];
        }

        const tokens = this.getTokens(module);
        const dotIndex = this.getDotIndexBeforeOffset(tokens, offset);

        if (dotIndex >= 0) {
            const receiver = this.getPreviousIdentifier(tokens, dotIndex);

            if (receiver) {
                const classObject = this.resolveReceiverClass(
                    uri,
                    tree,
                    offset,
                    receiver
                );

                if (classObject) {
                    return deduplicateCompletionItems(
                        this.collectMembersInHierarchy(
                            uri,
                            tree,
                            offset,
                            classObject
                        ).map(child => withCompletionPriority(
                            child.completionItem,
                            "0"
                        ))
                    );
                }
            }
        }

        const result: CompletionItem[] = [];
        const scopes = getScopeChain(tree, offset).reverse();

        for (let scopeIndex = 0; scopeIndex < scopes.length; scopeIndex++) {
            const scope = scopes[scopeIndex];
            const priority = scopeIndex === 0
                ? "0"
                : scope === tree
                    ? "2"
                    : "1";
            for (const child of scope.children) {
                if (!isVisibleAt(child, offset)) {
                    continue;
                }

                result.push(withCompletionPriority(
                    child.completionItem,
                    priority
                ));
            }
        }

        result.push(...this.index.getImportedCompletionItems(uri));

        /*
         * Классы прикладных модулей — только тех, что импортированы. Данные к
         * этому моменту уже прочитаны (ensureLoaded вызывается по готовности
         * списка Import), поэтому здесь остаётся чтение готовых map.
         */
        if (this.platformModules) {
            result.push(...this.platformModules.completionItems(
                this.visiblePlatformModules(uri)
            ));
        }

        return deduplicateCompletionItems(result);
    }

    resolveInScopeChain(
        tree: RslSymbol,
        name: string,
        offset: number
    ): RslSymbol | undefined {
        const normalized = normalizeIdentifier(name);
        const scopes = getScopeChain(tree, offset).reverse();

        for (const scope of scopes) {
            const candidates = getChildrenByName(scope).get(normalized);

            if (!candidates || candidates.length === 0) {
                continue;
            }

            const selected = selectBestVisibleCandidate(candidates, offset);

            if (selected) {
                return selected;
            }
        }

        return undefined;
    }

    private getTokens(module: IIndexedModule): IRslToken[] {
        let result = this.tokensByModule.get(module);

        if (!result) {
            /* syntax.tokens уже не содержит trivia/comments. */
            result = module.syntax.tokens.filter(token =>
                token.kind !== "square"
            );
            this.tokensByModule.set(module, result);
        }

        return result;
    }

    /**
     * Прикладные модули, чьи классы видны в этом документе.
     *
     * Только по Import — как прямым, так и через уже разобранные
     * импортированные файлы: модуль, импортированный внутри импортированного
     * файла, тоже доступен. Транзитивный обход идёт ИСКЛЮЧИТЕЛЬНО по модулям,
     * которые уже лежат в индексе: ни чтения файла, ни постановки в очередь
     * загрузки здесь не происходит. Иначе Ctrl+Space в файле с десятком Import
     * запускал бы обход проекта — ровно в тот момент, когда пользователь ждёт
     * ответа. Ещё не разобранный Import просто не даёт своих модулей, а
     * появятся они при следующем запросе, когда индекс их уже построит.
     */
    visiblePlatformModules(uri: string): readonly string[] {
        const catalog = this.platformModules;

        if (!catalog?.ready) {
            return [];
        }

        const cached = this.visibleModulesByUri.get(uri);
        const revision = this.index.revision;

        if (cached?.revision === revision) {
            return cached.modules;
        }

        const found = new Set<string>();
        const visitedUris = new Set<string>([uri]);
        const queue: readonly string[][] = [
            this.index.getModule(uri)?.imports || []
        ];

        for (const imports of queue) {
            for (const importName of imports) {
                if (catalog.knowsModule(importName)) {
                    found.add(importName);
                    continue;
                }

                /* Файл проекта: его собственные Import учитываются, если он уже разобран. */
                const resolution = this.index.resolveWorkspaceFile(importName);

                if (resolution.kind !== "resolved") {
                    continue;
                }

                const imported = this.index.getModule(resolution.value);

                if (!imported || visitedUris.has(imported.uri)) {
                    continue;
                }
                visitedUris.add(imported.uri);
                (queue as string[][]).push(imported.imports.slice());
            }
        }

        const modules = Object.freeze(Array.from(found));
        this.visibleModulesByUri.set(uri, { revision, modules });
        return modules;
    }

    /**
     * Базовый класс, разрешённый относительно модуля объявления.
     *
     * Имя базового класса ищется в том модуле, где объявлен текущий класс, а
     * не обязательно в исходном документе: Import у них разные. Для класса
     * стандартной библиотеки модуля нет, и имя разрешается от документа
     * запроса — оттуда поиск всё равно доходит до каталога встроенных классов.
     */
    private resolveBaseClass(
        requestUri: string,
        requestTree: RslSymbol,
        classSymbol: IIndexedSymbol
    ): IIndexedSymbol | undefined {
        const baseClassName = classSymbol.symbol.baseClassName;

        if (!baseClassName) {
            return undefined;
        }

        const classModule = classSymbol.uri === RSL_BUILTIN_URI
            ? undefined
            : this.index.getModule(classSymbol.uri);

        return classModule
            ? this.findClassSymbol(
                classSymbol.uri,
                classModule.symbolTree,
                baseClassName
            )
            : this.findClassSymbol(requestUri, requestTree, baseClassName);
    }

    /**
     * Члены класса вместе с унаследованными — для Ctrl+Space после точки.
     *
     * Разрешение одного члена цепочку наследования обходит (см.
     * resolveMemberInHierarchy), а список для автодополнения раньше брал
     * только собственных детей класса. Из-за этого переход по унаследованному
     * свойству работал, но в подсказке его не было — то есть найти его можно
     * было только зная, что оно существует.
     */
    private collectMembersInHierarchy(
        requestUri: string,
        requestTree: RslSymbol,
        offset: number,
        classSymbol: IIndexedSymbol
    ): RslSymbol[] {
        const result: RslSymbol[] = [];
        const taken = new Set<string>();
        const visited = new Set<string>();
        let current: IIndexedSymbol | undefined = classSymbol;

        while (current) {
            const classKey = `${current.uri}#${current.symbol.id}`;

            /* Та же защита от циклической цепочки, что и в разрешении члена. */
            if (visited.has(classKey)) {
                break;
            }
            visited.add(classKey);

            const allowPrivate = this.canAccessPrivateMembers(
                requestUri,
                requestTree,
                offset,
                current
            );

            for (const child of current.symbol.children) {
                if (!allowPrivate && child.isPrivate) {
                    continue;
                }

                const key = normalizeIdentifier(child.name);

                /* Член производного класса перекрывает член базового. */
                if (taken.has(key)) {
                    continue;
                }
                taken.add(key);
                result.push(child);
            }

            current = this.resolveBaseClass(requestUri, requestTree, current);
        }

        return result;
    }

    private resolveMemberInHierarchy(
        requestUri: string,
        requestTree: RslSymbol,
        offset: number,
        classSymbol: IIndexedSymbol,
        memberName: string,
        visited: Set<string>
    ): IIndexedSymbol | undefined {
        const classKey = `${classSymbol.uri}#${classSymbol.symbol.id}`;

        /*
        * Защита от ошибочной циклической цепочки наследования:
        *
        *     Class A(B)
        *     Class B(A)
        */
        if (visited.has(classKey)) {
            return undefined;
        }

        visited.add(classKey);

        const normalizedName = normalizeIdentifier(memberName);
        const allowPrivate = this.canAccessPrivateMembers(
            requestUri,
            requestTree,
            offset,
            classSymbol
        );

        const directCandidates = getChildrenByName(classSymbol.symbol).get(
            normalizedName
        );

        const directMember = directCandidates?.find(
            child => allowPrivate || !child.isPrivate
        );

        /*
        * Член производного класса перекрывает одноимённый член базового.
        */
        if (directMember) {
            return {
                uri: classSymbol.uri,
                symbolId: directMember.id,
                symbol: directMember
            };
        }

        const baseClass = this.resolveBaseClass(
            requestUri,
            requestTree,
            classSymbol
        );

        if (!baseClass) {
            return undefined;
        }

        return this.resolveMemberInHierarchy(
            requestUri,
            requestTree,
            offset,
            baseClass,
            memberName,
            visited
        );
    }

    private resolveMember(
        uri: string,
        tree: RslSymbol,
        offset: number,
        receiver: IRslToken,
        memberName: string
    ): IIndexedSymbol | undefined {
        const receiverClass = this.resolveReceiverClass(
            uri,
            tree,
            offset,
            receiver
        );

        if (!receiverClass) {
            return undefined;
        }

        return this.resolveMemberInHierarchy(
            uri,
            tree,
            offset,
            receiverClass,
            memberName,
            new Set<string>()
        );
    }

    private resolveReceiverClass(
        uri: string,
        tree: RslSymbol,
        offset: number,
        receiver: IRslToken
    ): IIndexedSymbol | undefined {
        const receiverName = normalizeIdentifier(receiver.value);

        if (receiverName === "this") {
            const currentClass = getScopeChain(tree, offset)
                .reverse()
                .find(scope =>
                    scope.kind === CompletionItemKind.Class
                );

            return currentClass
                ? { uri, symbolId: currentClass.id, symbol: currentClass }
                : undefined;
        }

        const receiverObject = this.resolveInScopeChain(
            tree,
            receiver.value,
            offset
        );
        const module = this.index.getModule(uri);

        /*
         * Отсутствие объявления не повод сдаваться: в RSL переменная возникает
         * и просто от присваивания. Код вида
         *
         *     rs = ExecSQLselect (sql, ..., true);
         *     while (rs.movenext ())
         *
         * не содержит Var, поэтому rs нет в дереве символов — а тип у него
         * тем не менее известен из присваивания.
         */
        if (!receiverObject && !module) {
            return undefined;
        }

        let typeName = receiverObject
            ? normalizeIdentifier(receiverObject.typeName)
            : "";

        if (module && (!typeName || typeName === "variant")) {
            if (receiverObject) {
                typeName = inferDeclaredType(
                    this.getTokens(module),
                    receiverObject
                );
            }

            if (!typeName || typeName === "variant") {
                typeName = this.inferAssignedType(
                    module,
                    tree,
                    receiver.value,
                    offset,
                    receiverObject?.range.start ?? 0
                );
            }
        }

        if (!typeName || typeName === "variant") {
            return undefined;
        }

        return this.findClassSymbol(uri, tree, typeName);
    }

    private findClassSymbol(
        uri: string,
        tree: RslSymbol,
        typeName: string
    ): IIndexedSymbol | undefined {
        const normalizedType = normalizeIdentifier(typeName);
        const localClass = (getChildrenByName(tree).get(normalizedType) || [])
            .find(child =>
                child.kind === CompletionItemKind.Class
            );

        if (localClass) {
            return { uri, symbolId: localClass.id, symbol: localClass };
        }

        const imported = this.index.findImportedSymbols(uri, normalizedType)
            .find(symbol =>
                symbol.symbol.kind === CompletionItemKind.Class
            );

        if (imported) {
            return imported;
        }

        const workspace = this.index.findSymbols(normalizedType)
            .find(symbol =>
                symbol.symbol.kind === CompletionItemKind.Class
            );
        if (workspace) {
            return workspace;
        }

        const builtin = this.builtins.findClass(normalizedType);
        if (builtin) {
            return {
                uri: RSL_BUILTIN_URI,
                symbolId: builtin.id,
                symbol: builtin
            };
        }

        /*
         * Класс прикладного модуля — последним: он доступен только через
         * Import, поэтому не должен перекрывать ни файл проекта, ни встроенный
         * класс с тем же именем.
         */
        const platform = this.platformModules?.findClass(
            this.visiblePlatformModules(uri),
            normalizedType
        );

        return platform
            ? {
                uri: RSL_BUILTIN_URI,
                symbolId: platform.id,
                symbol: platform
            }
            : undefined;
    }

    /**
     * Поддерживает распространённый RSL-шаблон:
     *     Var command;
     *     command = RsdCommand(...);
     *     command.Execute();
     *
     * Индекс присваиваний строится один раз на immutable module model, поэтому
     * Semantic Tokens не сканирует весь Macro заново для каждого вызова.
     */
    /**
     * Тип из ближайшего предшествующего присваивания.
     *
     * Имя, а не символ: переменная могла не объявляться через Var, и тогда её
     * в дереве символов нет, а присваивание есть. declaredAt отсекает
     * присваивания до объявления, если оно всё-таки было; для неявной
     * переменной достаточно границы текущей области.
     */
    private inferAssignedType(
        module: IIndexedModule,
        tree: RslSymbol,
        receiverName: string,
        offset: number,
        declaredAt: number
    ): string {
        const assignments = this.getConstructorAssignments(module).get(
            normalizeIdentifier(receiverName)
        );
        if (!assignments || assignments.length === 0) {
            return "";
        }

        const scopeChain = getScopeChain(tree, offset);
        const scope = scopeChain[scopeChain.length - 1] || tree;
        const lowerBound = Math.max(declaredAt, scope.range.start);
        let index = upperBoundAssignmentOffset(assignments, offset) - 1;

        while (index >= 0) {
            const assignment = assignments[index--];
            if (assignment.offset < lowerBound) {
                break;
            }
            return assignment.member
                ? this.memberResultType(module, tree, assignment)
                : assignment.typeName;
        }

        return "";
    }

    /**
     * Тип результата вызова метода получателя: `rs = cmd.Execute()`.
     *
     * Класс получателя ищется на позиции самого присваивания, а не запроса:
     * дальше по тексту переменной могли присвоить что-то другое.
     *
     * Защита от зацикливания обязательна: у кода вида `a = a.Next()` разрешение
     * получателя привело бы обратно к этому же присваиванию.
     */
    private memberResultType(
        module: IIndexedModule,
        tree: RslSymbol,
        assignment: IConstructorAssignment
    ): string {
        const member = assignment.member;

        if (!member || this.memberTypeGuard.has(assignment)) {
            return "";
        }

        this.memberTypeGuard.add(assignment);
        try {
            const receiverClass = this.resolveReceiverClass(
                module.uri,
                tree,
                assignment.offset,
                { value: member.receiver } as IRslToken
            );

            if (!receiverClass) {
                return "";
            }

            const resolved = this.resolveMemberInHierarchy(
                module.uri,
                tree,
                assignment.offset,
                receiverClass,
                member.method,
                new Set<string>()
            );

            const typeName = resolved?.symbol.typeName || "";
            return normalizeIdentifier(typeName) === "variant" ? "" : typeName;
        } finally {
            this.memberTypeGuard.delete(assignment);
        }
    }

    private getConstructorAssignments(
        module: IIndexedModule
    ): Map<string, IConstructorAssignment[]> {
        let result = this.constructorAssignmentsByModule.get(module);
        if (result) {
            return result;
        }

        result = new Map<string, IConstructorAssignment[]>();
        const tokens = this.getTokens(module);

        for (let index = 0; index + 3 < tokens.length; index++) {
            const target = tokens[index];
            const equals = tokens[index + 1];
            const callee = tokens[index + 2];
            const next = tokens[index + 3];

            if (
                target.kind !== "identifier" ||
                /* Слева от точки не цель присваивания, а получатель. */
                (index > 0 && tokens[index - 1].raw === ".") ||
                equals.kind !== "symbol" || equals.raw !== "=" ||
                callee.kind !== "identifier"
            ) {
                continue;
            }

            const name = normalizeIdentifier(target.value);
            const values = result.get(name) || [];

            if (next.kind === "symbol" && next.raw === "(") {
                /* Прямой вызов: конструктор класса или процедура. */
                values.push({
                    offset: target.start,
                    typeName: this.getCallableResultType(
                        module.uri,
                        callee.value
                    )
                });
            } else if (
                next.kind === "symbol" && next.raw === "." &&
                tokens[index + 4]?.kind === "identifier" &&
                tokens[index + 5]?.kind === "symbol" &&
                tokens[index + 5].raw === "("
            ) {
                /*
                 * Вызов метода: `rs = cmd.Execute()`. Тип результата у метода
                 * известен каталогу, но чтобы его взять, нужно сначала знать
                 * класс получателя — это делается при выводе, не здесь.
                 */
                values.push({
                    offset: target.start,
                    typeName: "",
                    member: {
                        receiver: callee.value,
                        method: tokens[index + 4].value
                    }
                });
            } else {
                continue;
            }

            result.set(name, values);
        }

        this.constructorAssignmentsByModule.set(module, result);
        return result;
    }

    /**
     * Тип значения, которое даёт вызов: класс — сам себя, процедура — свой
     * объявленный тип результата.
     *
     * Неизвестное имя возвращается как есть: тогда это скорее всего имя класса,
     * который просто ещё не загружен, и findClassSymbol попробует его найти.
     */
    private getCallableResultType(uri: string, name: string): string {
        const builtin = this.builtins.findSymbol(name);
        if (builtin) {
            return builtin.kind === CompletionItemKind.Class
                ? builtin.name
                : builtin.typeName;
        }

        const workspace = this.index.findSymbols(name).find(item =>
            item.symbol.kind === CompletionItemKind.Class ||
            item.symbol.kind === CompletionItemKind.Function ||
            item.symbol.kind === CompletionItemKind.Method
        );
        if (workspace) {
            return workspace.symbol.kind === CompletionItemKind.Class
                ? workspace.symbol.name
                : workspace.symbol.typeName;
        }

        /* Процедура импортированного прикладного модуля. */
        const platform = this.platformModules?.findResultType(
            this.visiblePlatformModules(uri),
            name
        );

        return platform || normalizeIdentifier(name);
    }

    private canAccessPrivateMembers(
        uri: string,
        tree: RslSymbol,
        offset: number,
        classSymbol: IIndexedSymbol
    ): boolean {
        if (classSymbol.uri !== uri) {
            return false;
        }

        const currentClass = getScopeChain(tree, offset)
            .reverse()
            .find(scope =>
                scope.kind === CompletionItemKind.Class
            );

        return currentClass === classSymbol.symbol;
    }

    private getReceiverToken(
        tokens: IRslToken[],
        tokenIndex: number
    ): IRslToken | undefined {
        if (tokenIndex < 2) {
            return undefined;
        }

        const dot = tokens[tokenIndex - 1];
        const receiver = tokens[tokenIndex - 2];

        return dot.kind === "symbol" &&
            dot.raw === "." &&
            receiver.kind === "identifier"
                ? receiver
                : undefined;
    }

    private getDotIndexBeforeOffset(
        tokens: IRslToken[],
        offset: number
    ): number {
        let candidateIndex = upperBoundByStart(tokens, offset) - 1;

        if (candidateIndex < 0) {
            return -1;
        }

        const candidate = tokens[candidateIndex];

        if (candidate.kind === "symbol" && candidate.raw === ".") {
            return candidateIndex;
        }

        if (candidate.kind === "identifier" && candidateIndex > 0) {
            const previous = tokens[candidateIndex - 1];

            if (previous.kind === "symbol" && previous.raw === ".") {
                return candidateIndex - 1;
            }
        }

        return -1;
    }

    private getPreviousIdentifier(
        tokens: IRslToken[],
        tokenIndex: number
    ): IRslToken | undefined {
        if (tokenIndex <= 0) {
            return undefined;
        }

        const previous = tokens[tokenIndex - 1];
        return previous.kind === "identifier"
            ? previous
            : undefined;
    }
}

function withCompletionPriority(
    item: CompletionItem,
    priority: string
): CompletionItem {
    return {
        ...item,
        sortText: `${priority}_${normalizeIdentifier(String(item.label))}`
    };
}

export function getScopeChain(
    root: RslSymbol,
    offset: number
): RslSymbol[] {
    const result: RslSymbol[] = [root];
    let current = root;

    while (true) {
        const nested = findContainingObject(
            getObjectChildren(current),
            offset
        );

        if (!nested) {
            break;
        }

        result.push(nested);
        current = nested;
    }

    return result;
}

function getObjectChildren(scope: RslSymbol): RslSymbol[] {
    let result = objectChildrenCache.get(scope);

    if (!result) {
        result = scope.children
            .filter(child => child.isContainer)
            .sort((left, right) =>
                left.range.start - right.range.start
            );
        objectChildrenCache.set(scope, result);
    }

    return result;
}


function findContainingObject(
    objects: RslSymbol[],
    offset: number
): RslSymbol | undefined {
    let left = 0;
    let right = objects.length - 1;
    let candidate = -1;

    while (left <= right) {
        const middle = (left + right) >>> 1;

        if (objects[middle].range.start <= offset) {
            candidate = middle;
            left = middle + 1;
        } else {
            right = middle - 1;
        }
    }

    if (candidate < 0) {
        return undefined;
    }

    const symbol = objects[candidate];
    return offset <= symbol.range.end ? symbol : undefined;
}

function getChildrenByName(scope: RslSymbol): Map<string, RslSymbol[]> {
    let result = childrenByNameCache.get(scope);

    if (!result) {
        result = new Map<string, RslSymbol[]>();

        for (const child of scope.children) {
            const name = normalizeIdentifier(child.name);
            let values = result.get(name);

            if (!values) {
                values = [];
                result.set(name, values);
            }

            values.push(child);
        }

        childrenByNameCache.set(scope, result);
    }

    return result;
}

function inferDeclaredType(
    tokens: IRslToken[],
    symbol: RslSymbol
): string {
    const nameIndex = lowerBoundByStart(tokens, symbol.range.start);

    if (
        nameIndex >= tokens.length ||
        tokens[nameIndex].start !== symbol.range.start
    ) {
        return "";
    }

    let depth = 0;

    for (let index = nameIndex + 1; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind !== "symbol") {
            continue;
        }

        if (token.raw === "(") {
            depth++;
            continue;
        }

        if (token.raw === ")" && depth > 0) {
            depth--;
            continue;
        }

        if (depth === 0 && (token.raw === ";" || token.raw === ",")) {
            break;
        }

        if (depth === 0 && token.raw === ":") {
            const typeToken = tokens[index + 1];
            return typeToken && typeToken.kind === "identifier"
                ? normalizeIdentifier(typeToken.value)
                : "";
        }

        /*
         * Присваивание здесь намеренно не разбирается.
         *
         * Раньше `Var x = Name(...)` давало тип "Name" — верно для
         * конструктора класса и неверно для процедуры: у
         * `Macro Get():RsdRecordset` типом становилось имя Get, класса с таким
         * именем нет, и подсказка по x пропадала совсем. Хуже того, непустой
         * результат отменял разбор присваивания ниже, который как раз умеет
         * посмотреть объявленный тип результата (см. getCallableResultType).
         */
        if (depth === 0 && token.raw === "=") {
            break;
        }
    }

    return "";
}

function isVisibleAt(symbol: RslSymbol, offset: number): boolean {
    if (
        symbol.kind === CompletionItemKind.Variable ||
        symbol.kind === CompletionItemKind.Constant ||
        symbol.kind === CompletionItemKind.Property ||
        symbol.kind === CompletionItemKind.Field
    ) {
        return symbol.range.start <= offset;
    }

    return true;
}

function selectBestVisibleCandidate(
    candidates: RslSymbol[],
    offset: number
): RslSymbol | undefined {
    let firstVisible: RslSymbol | undefined;
    let nearestPreceding: RslSymbol | undefined;

    for (const candidate of candidates) {
        if (!isVisibleAt(candidate, offset)) {
            continue;
        }

        if (!firstVisible) {
            firstVisible = candidate;
        }

        if (
            candidate.range.start <= offset &&
            (
                !nearestPreceding ||
                candidate.range.start > nearestPreceding.range.start
            )
        ) {
            nearestPreceding = candidate;
        }
    }

    return nearestPreceding || firstVisible;
}

function findTokenIndex(
    tokens: IRslToken[],
    token: IRslToken
): number {
    const index = lowerBoundByStart(tokens, token.start);

    for (let current = index; current < tokens.length; current++) {
        const candidate = tokens[current];

        if (candidate.start !== token.start) {
            break;
        }

        if (candidate === token || candidate.end === token.end) {
            return current;
        }
    }

    return -1;
}

function lowerBoundByStart(tokens: IRslToken[], start: number): number {
    let left = 0;
    let right = tokens.length;

    while (left < right) {
        const middle = (left + right) >>> 1;

        if (tokens[middle].start < start) {
            left = middle + 1;
        } else {
            right = middle;
        }
    }

    return left;
}

function upperBoundByStart(tokens: IRslToken[], start: number): number {
    let left = 0;
    let right = tokens.length;

    while (left < right) {
        const middle = (left + right) >>> 1;

        if (tokens[middle].start <= start) {
            left = middle + 1;
        } else {
            right = middle;
        }
    }

    return left;
}

function upperBoundAssignmentOffset(
    assignments: readonly IConstructorAssignment[],
    offset: number
): number {
    let left = 0;
    let right = assignments.length;

    while (left < right) {
        const middle = (left + right) >>> 1;

        if (assignments[middle].offset <= offset) {
            left = middle + 1;
        } else {
            right = middle;
        }
    }

    return left;
}

function deduplicateCompletionItems(
    items: CompletionItem[]
): CompletionItem[] {
    const result: CompletionItem[] = [];
    const seen = new Set<string>();

    for (const item of items) {
        const key = normalizeIdentifier(String(item.label));

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(item);
    }

    return result;
}

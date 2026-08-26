import {
    GetImportDefinitionTargetsFromTokens
} from "../execMacroDefinition";
import {
    IRslDiagnosticSettings
} from "../interfaces";
import {
    cachedSignificantTokens,
    IRslToken,
    normalizeIdentifier,
    normalizeReferenceIdentifier
} from "../lexer";
import {
    getScopeChain,
    RslScopeResolver
} from "../scopeResolver";
import {
    RslSymbol
} from "../symbols/rslSymbol";
import {
    isRslSpecialVariableReference,
    isRslSystemSpecialVariableName
} from "../systemSpecialVariables";
import {
    IIndexedModule,
    WorkspaceIndex
} from "../workspaceIndex";
import {
    createRslAssignmentCheckFacts,
    type IRslAssignmentCheckFacts
} from "./nameCheckScopes";
import {
    checkRslUndeclaredAssignment,
    createUndeclaredAssignmentDiagnostic,
    hasPendingRslImports,
    isRslUndeclaredAssignmentCandidate
} from "./undeclaredAssignmentDiagnostics";
import {
    CompletionItemKind,
    Diagnostic,
    DiagnosticSeverity
} from "vscode-languageserver";
import {
    collectAllObjectRanges,
    collectMemberNameStarts,
    createOffsetDiagnostic,
    createTokenDiagnostic,
    findObjectNameRange,
    findSignatureRange,
    formatModuleName,
    isReservedIdentifier,
    lowerBoundTokenStart,
    offsetRangeKey,
    someTokenInRange,
    walkScopes
} from "./diagnosticFactory";
import {
    collectSetParmContracts,
    isFilledBySetParm
} from "./setParmChecks";
import {
    type IRslDiagnosticStage,
    createResolverScanStage,
    createScopeScanStage
} from "./stages";

/*
 * Объявления и их использование.
 *
 * Неиспользуемые объявления, использование до объявления, дубликаты имён,
 * присваивание константе, необъявленной переменной и невидимому имени,
 * неоднозначные ссылки.
 */

export interface IDeclarationInfo {
    symbol: RslSymbol;
    scope: RslSymbol;
    parameter: boolean;
}

export interface ILocalDiagnosticFacts {
    declarations: IDeclarationInfo[];
    identifierIndex: Map<string, IRslToken[]>;
    declarationRangeKeys: Set<string>;
}

export const VARIABLE_KINDS = new Set<number>([
    CompletionItemKind.Variable,
    CompletionItemKind.Constant
]);

/**
 * Проверка присваивания константам — возобновляемым этапом.
 *
 * Проверка спрашивает у resolver каждое присваивание в файле, и на модуле в
 * 700 КБ это был самый долгий этап расчёта: около 30 мс непрерывной занятости
 * потока.
 */
export function createConstantAssignmentStage(
    module: IIndexedModule,
    getResolver: () => RslScopeResolver,
    result: Diagnostic[]
): IRslDiagnosticStage {
    /* Общее для всех порций считается один раз — на первой из них. */
    let declarationStarts = new Set<number>();

    return createResolverScanStage(
        () => cachedSignificantTokens(module.lex.tokens),
        (tokens, index) => index + 1 < tokens.length &&
            isConstantAssignmentCandidate(
                declarationStarts,
                tokens[index],
                tokens[index + 1]
            ),
        (tokens, index) => addConstantAssignmentDiagnostic(
            module,
            getResolver(),
            tokens[index],
            result
        ),
        () => {
            const starts = new Set<number>();
            walkScopes(module.symbolTree, scope => {
                for (const child of scope.children) {
                    if (child.kind === CompletionItemKind.Constant) {
                        starts.add(findObjectNameRange(module, child).start);
                    }
                }
            });
            declarationStarts = starts;

            return true;
        }
    );
}

/**
 * Этап проверки необъявленных переменных.
 *
 * Возобновляемый обход с отбором кандидатов до резолвера: целей
 * присваивания в файле на порядок меньше, чем идентификаторов, и
 * разрешение имени платится только за них.
 */
export function createUndeclaredAssignmentStage(
    module: IIndexedModule,
    getResolver: () => RslScopeResolver,
    options: Required<IRslDiagnosticSettings>,
    result: Diagnostic[],
    tokens: () => readonly IRslToken[],
    onComplete: () => void
): IRslDiagnosticStage {
    let facts: IRslAssignmentCheckFacts | undefined;

    return createResolverScanStage(
        tokens,
        (tokens, index) => !!facts &&
            isRslUndeclaredAssignmentCandidate(tokens, index, facts),
        (tokens, index) => {
            if (result.length >= options.maxProblems) {
                return;
            }

            const finding = checkRslUndeclaredAssignment(
                module,
                getResolver(),
                tokens[index],
                facts
            );

            if (finding) {
                result.push(
                    createUndeclaredAssignmentDiagnostic(finding)
                );
            }
        },
        () => {
            /*
             * Чтение импортированного модуля не закончено: переменную
             * может объявлять он. Публиковать сейчас — значит показать
             * ошибку, зависящую от момента загрузки; пересчёт после
             * загрузки обеспечен ключом локальной фазы.
             */
            if (hasPendingRslImports(getResolver(), module.uri)) {
                return false;
            }

            facts = createRslAssignmentCheckFacts(
                module,
                options.unknownVariablesKnownGlobalsFile
            );

            /*
             * Ни одного VAR в файле — проверять нечего, и это полный
             * проход: пустой результат можно запоминать.
             */
            if (facts.varScopes.length === 0) {
                onComplete();

                return false;
            }

            return true;
        },
        onComplete
    );
}

/** Похоже ли на присваивание константе: проверка без резолвера. */
export function isConstantAssignmentCandidate(
    declarationStarts: ReadonlySet<number>,
    token: IRslToken,
    next: IRslToken
): boolean {
    return token.kind === "identifier" &&
        next.kind === "symbol" &&
        next.raw === "=" &&
        !declarationStarts.has(token.start);
}

export function addConstantAssignmentDiagnostic(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    token: IRslToken,
    result: Diagnostic[]
): void {
    const resolved = resolver.resolveAt(
        module.uri,
        module.symbolTree,
        token.start
    );

    if (resolved?.symbol.kind !== CompletionItemKind.Constant) {
        return;
    }

    result.push(createTokenDiagnostic(
        token,
        DiagnosticSeverity.Error,
        `Константе ${token.value} нельзя присваивать новое значение`,
        "assignment-to-constant"
    ));
}

/*
 * LOCAL модуля виден только процедуре инициализации модуля и local-процедурам
 * этого же модуля (стр. 43-44 руководства); LOCAL свойство класса видно
 * только конструктору класса и local-методам того же класса. Обращение из
 * любой другой (не-local) процедуры/метода того же файла — ошибка.
 * Кросс-модульная видимость LOCAL уже исключена отдельно (RslSymbol.isPrivate
 * фильтрует local наравне с private при экспорте/поиске из других файлов) —
 * эта проверка касается только ссылок внутри одного файла.
 */
export function createLocalVisibilityStage(
    module: IIndexedModule,
    getResolver: () => RslScopeResolver,
    result: Diagnostic[]
): IRslDiagnosticStage {
    const ownerOf = new Map<RslSymbol, RslSymbol>();
    const localDeclarations = new Set<RslSymbol>();
    const declarationStarts = new Set<number>();

    return createResolverScanStage(
        () => cachedSignificantTokens(module.lex.tokens),
        (tokens, index) => tokens[index].kind === "identifier" &&
            !declarationStarts.has(tokens[index].start),
        (tokens, index) => addLocalVisibilityDiagnostic(
            module,
            getResolver(),
            { ownerOf, localDeclarations },
            tokens[index],
            result
        ),
        () => {
            prepareLocalVisibility(
                module,
                ownerOf,
                localDeclarations,
                declarationStarts
            );

            /* Нет local-объявлений — нет и проверки: обходить нечего. */
            return localDeclarations.size > 0;
        }
    );
}

/** Владельцы объявлений и позиции их имён: считается один раз на файл. */
export function prepareLocalVisibility(
    module: IIndexedModule,
    ownerOf: Map<RslSymbol, RslSymbol>,
    localDeclarations: Set<RslSymbol>,
    declarationStarts: Set<number>
): void {
    walkScopes(module.symbolTree, scope => {
        for (const child of scope.children) {
            ownerOf.set(child, scope);
        }
    });

    /*
     * visibility === "local" также используется отдельно для параметров
     * (не имеет отношения к модификатору LOCAL) — у них владелец всегда
     * MACRO/METHOD. Модификатор LOCAL по документации применим только на
     * уровне модуля или конструктора класса, поэтому здесь учитываются
     * только "local"-символы, чей владелец — Unit (модуль) или Class.
     *
     * Набор символов собирается наравне с их позициями и проверяется потом на
     * каждой ссылке. Одного visibility там недостаточно: параметр Macro,
     * использованный во вложенном в этот Macro Macro, имеет ровно ту же
     * visibility, и правило про LOCAL модуля объявляло его недоступным —
     * сообщением про процедуру инициализации модуля, к которой он не имеет
     * отношения.
     */
    for (const [symbol, owner] of ownerOf) {
        if (
            symbol.visibility === "local" &&
            (owner.kind === CompletionItemKind.Unit ||
                owner.kind === CompletionItemKind.Class)
        ) {
            localDeclarations.add(symbol);
            declarationStarts.add(findObjectNameRange(module, symbol).start);
        }
    }
}

/** Одна ссылка: доступен ли ей local-объект, на который она указывает. */
export function addLocalVisibilityDiagnostic(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    facts: {
        ownerOf: Map<RslSymbol, RslSymbol>;
        localDeclarations: Set<RslSymbol>;
    },
    token: IRslToken,
    result: Diagnostic[]
): void {
    {
        const resolved = resolver.resolveAt(
            module.uri,
            module.symbolTree,
            token.start
        );

        if (!resolved || !facts.localDeclarations.has(resolved.symbol)) {
            return;
        }

        const owner = facts.ownerOf.get(resolved.symbol);

        if (!owner) {
            return;
        }

        const refChain = getScopeChain(module.symbolTree, token.start);
        const ownerIndex = refChain.indexOf(owner);
        const allowed = ownerIndex !== -1 && (
            refChain.length === ownerIndex + 1 ||
            (
                refChain.length === ownerIndex + 2 &&
                refChain[ownerIndex + 1].visibility === "local"
            )
        );

        if (allowed) {
            return;
        }

        const ownerLabel = owner.kind === CompletionItemKind.Class
            ? `конструктора класса ${owner.name}`
            : "процедуры инициализации модуля";
        result.push(createTokenDiagnostic(
            token,
            DiagnosticSeverity.Error,
            `${resolved.symbol.name} — локальный объект ${ownerLabel}; ` +
                "доступен только внутри неё и local-процедур того же уровня",
            "local-visibility-violation"
        ));
    }
}

export function addUnusedDeclarationDiagnostics(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    facts: ILocalDiagnosticFacts,
    result: Diagnostic[],
    maxProblems: number
): void {
    const setParm = collectSetParmContracts(module, resolver, facts);

    for (const declaration of facts.declarations) {
        if (result.length >= maxProblems) {
            break;
        }

        const symbol = declaration.symbol;
        const scope = declaration.scope;

        /*
         * Параметр, который процедура заполняет через SetParm, — часть её
         * выходного контракта: имя в тексте не встречается, а значение
         * возвращается вызывающему.
         */
        if (
            declaration.parameter &&
            isFilledBySetParm(setParm, declaration)
        ) {
            continue;
        }
        const isLocal = scope.kind === CompletionItemKind.Function ||
            scope.kind === CompletionItemKind.Method;
        const isPrivateModuleDeclaration =
            scope.kind === CompletionItemKind.Unit && symbol.isPrivate;

        /*
         * Публичные глобальные объекты и свойства класса могут использоваться
         * внешней средой или импортирующими файлами.
         */
        if (!isLocal && !isPrivateModuleDeclaration) {
            continue;
        }

        const name = normalizeIdentifier(symbol.name);
        const occurrences = facts.identifierIndex.get(name) || [];
        const used = someTokenInRange(
            occurrences,
            scope.range.start,
            scope.range.end,
            token => {
                if (
                    token.end > scope.range.end ||
                    facts.declarationRangeKeys.has(offsetRangeKey(
                        token.start,
                        token.end
                    ))
                ) {
                    return false;
                }

                const resolved = resolver.resolveAt(
                    module.uri,
                    module.symbolTree,
                    token.start
                );

                return !!resolved &&
                    resolved.uri === module.uri &&
                    resolved.symbol === symbol;
            }
        );

        if (used) {
            continue;
        }

        const kind = declaration.parameter
            ? "Параметр"
            : symbol.kind === CompletionItemKind.Constant
                ? "Константа"
                : "Переменная";
        const declared = kind === "Параметр" ? "объявлен" : "объявлена";
        const range = findObjectNameRange(module, symbol);

        result.push(createOffsetDiagnostic(
            module,
            range.start,
            range.end,
            DiagnosticSeverity.Warning,
            `${kind} ${symbol.name} ${declared}, но не используется`,
            "unused-declaration",
            true,
            {
                start: range.start,
                end: range.end,
                name: symbol.name,
                parameter: declaration.parameter
            }
        ));
    }
}

/*
 * Сколько вхождений имени просматривать между сверками с бюджетом.
 *
 * Резать пришлось именно по вхождениям, а не по объявлениям: на файле 700 КБ
 * все 25 мс этапа уходили на ОДНО объявление, имя которого встречается в модуле
 * тысячи раз, — по числу объявлений такой этап не делится вовсе.
 */
export const USE_BEFORE_DECLARATION_CHUNK = 16;

/**
 * Использование до объявления — возобновляемым этапом.
 *
 * Для каждого объявления проверка обходит вхождения его имени выше по тексту и
 * на сомнительных спрашивает resolver. На большом модуле это был самый долгий
 * этап расчёта.
 */
export function createUseBeforeDeclarationStage(
    module: IIndexedModule,
    getResolver: () => RslScopeResolver,
    getLocalFacts: () => ILocalDiagnosticFacts,
    result: Diagnostic[],
    maxProblems: number
): IRslDiagnosticStage {
    /* Оба справочника переживают порции: считать их заново незачем. */
    let memberNameStarts: Set<number> | undefined;
    const nestedScopesByScope = new Map<RslSymbol, RslSymbol[]>();
    let declarationIndex = 0;
    /* Сколько вхождений текущего объявления уже просмотрено. */
    let occurrenceIndex = 0;

    return (_isCancelled, shouldYield) => {
        if (shouldYield?.() === true) {
            return true;
        }

        const facts = getLocalFacts();
        const resolver = getResolver();

        if (!memberNameStarts) {
            memberNameStarts = collectMemberNameStarts(module.syntax.tokens);
        }

        while (declarationIndex < facts.declarations.length) {
            if (result.length >= maxProblems) {
                return false;
            }

            /*
             * Бюджет сверяется между порциями вхождений: одно объявление с
             * тысячами вхождений иначе прошло бы целиком за один вызов.
             */
            if (shouldYield?.()) {
                return true;
            }

            const step = addUseBeforeDeclarationDiagnostic(
                module,
                resolver,
                facts,
                memberNameStarts,
                nestedScopesByScope,
                facts.declarations[declarationIndex],
                occurrenceIndex,
                USE_BEFORE_DECLARATION_CHUNK,
                result
            );

            if (step.finished) {
                declarationIndex++;
                occurrenceIndex = 0;
            } else {
                occurrenceIndex = step.nextOccurrence;
            }
        }

        return false;
    };
}

/** Сколько вхождений просмотрено и дошло ли дело до конца объявления. */
export interface IUseBeforeDeclarationStep {
    examined: number;
    finished: boolean;
    nextOccurrence: number;
}

export function addUseBeforeDeclarationDiagnostic(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    facts: ILocalDiagnosticFacts,
    memberNameStarts: ReadonlySet<number>,
    nestedScopesByScope: Map<RslSymbol, RslSymbol[]>,
    declaration: IDeclarationInfo,
    /* С какого вхождения продолжать: предыдущая порция кончилась на нём. */
    fromOccurrence: number,
    budget: number,
    result: Diagnostic[]
): IUseBeforeDeclarationStep {
    const done: IUseBeforeDeclarationStep = {
        examined: 1,
        finished: true,
        nextOccurrence: 0
    };
    const scope = declaration.scope;

    if (
        declaration.parameter ||
        (
            scope.kind !== CompletionItemKind.Function &&
            scope.kind !== CompletionItemKind.Method
        )
    ) {
        return done;
    }

    const symbol = declaration.symbol;

    /*
     * Повреждённое или неоднозначное дерево не должно превращать
     * служебные слова RSL (IF, VAR и т. п.) в объявления переменных.
     */
    if (isReservedIdentifier(symbol.name)) {
        return done;
    }

    const name = normalizeIdentifier(symbol.name);
    let nestedScopes = nestedScopesByScope.get(scope);

    if (!nestedScopes) {
        nestedScopes = scope.children
            .filter(child => child.isContainer);
        nestedScopesByScope.set(scope, nestedScopes);
    }

    const occurrences = facts.identifierIndex.get(name) || [];
    const first = Math.max(
        fromOccurrence,
        lowerBoundTokenStart(occurrences, scope.range.start)
    );
    const limit = Math.min(occurrences.length, first + budget);
    let index = first;

    for (; index < limit; index++) {
        const token = occurrences[index];

        if (token.start >= symbol.range.start) {
            /* Вхождения дальше объявления к «до объявления» не относятся. */
            break;
        }

        if (
            facts.declarationRangeKeys.has(offsetRangeKey(
                token.start,
                token.end
            )) ||
            memberNameStarts.has(token.start) ||
            nestedScopes.some(child =>
                child !== scope &&
                child.range.start <= token.start &&
                token.end <= child.range.end
            )
        ) {
            continue;
        }

        if (resolver.resolveAt(module.uri, module.symbolTree, token.start)) {
            continue;
        }

        result.push(createTokenDiagnostic(
            token,
            DiagnosticSeverity.Error,
            `Переменная ${symbol.name} используется до объявления`,
            "use-before-declaration",
            false,
            {
                start: token.start,
                end: token.end,
                name: symbol.name
            }
        ));

        /* Сообщение на объявление одно: первое использование и есть ответ. */
        return { examined: index - first + 1, finished: true, nextOccurrence: 0 };
    }

    const examined = Math.max(1, index - first);
    /* Дошли до предела бюджета, а не до конца — продолжим со следующей порции. */
    const finished = index >= occurrences.length ||
        occurrences[index].start >= symbol.range.start;

    return {
        examined,
        finished,
        nextOccurrence: finished ? 0 : index
    };
}

/** Повторные имена внутри одной области видимости. */
export function addDuplicateDeclarationDiagnostics(
    module: IIndexedModule,
    scope: RslSymbol,
    result: Diagnostic[]
): void {
    const byName = new Map<string, RslSymbol[]>();

    for (const child of scope.children) {
        const name = normalizeIdentifier(child.name);

        if (!name) {
            continue;
        }

        const list = byName.get(name) || [];
        list.push(child);
        byName.set(name, list);
    }

    byName.forEach(items => {
        if (items.length < 2) {
            return;
        }

        items.slice(1).forEach(item => {
            const nameRange = findObjectNameRange(module, item);
            result.push(createOffsetDiagnostic(
                module,
                nameRange.start,
                nameRange.end,
                DiagnosticSeverity.Warning,
                `Имя ${item.name} повторно объявлено в той же области видимости`,
                "duplicate-declaration"
            ));
        });
    });
}

export function addAmbiguousReferenceDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    result: Diagnostic[]
): void {
    const importedModules = index.getImportedModules(module.uri);
    const byName = new Map<string, Array<{ uri: string; symbol: RslSymbol }>>();

    importedModules.forEach(imported => {
        imported.symbolTree.children
            .filter(child => !child.isPrivate)
            .forEach(child => {
                const name = normalizeIdentifier(child.name);
                const list = byName.get(name) || [];

                if (!list.some(item =>
                    item.uri === imported.uri && item.symbol === child
                )) {
                    list.push({
                        uri: imported.uri,
                        symbol: child
                    });
                }

                byName.set(name, list);
            });
    });

    const ambiguous = new Map<string, Array<{ uri: string; symbol: RslSymbol }>>();
    byName.forEach((items, name) => {
        if (items.length > 1) {
            ambiguous.set(name, items);
        }
    });

    if (ambiguous.size === 0) {
        return;
    }

    const code = module.syntax.tokens;
    const resolver = new RslScopeResolver(index);
    const importReferences = GetImportDefinitionTargetsFromTokens(module.lex.tokens);
    const declarationRangeKeys = new Set(
        collectAllObjectRanges(module.symbolTree).map(range =>
            offsetRangeKey(range.start, range.end)
        )
    );
    const memberNameStarts = collectMemberNameStarts(code);

    for (let tokenIndex = 0; tokenIndex < code.length; tokenIndex++) {
        const token = code[tokenIndex];

        if (token.kind !== "identifier") {
            continue;
        }

        const name = normalizeIdentifier(token.value);
        const candidates = ambiguous.get(name);

        if (
            !candidates ||
            isReservedIdentifier(name) ||
            isRslSystemSpecialVariableReference(code, tokenIndex) ||
            declarationRangeKeys.has(offsetRangeKey(
                token.start,
                token.end
            )) ||
            importReferences.some(reference =>
                reference.start <= token.start && token.end <= reference.end
            ) ||
            memberNameStarts.has(token.start) ||
            resolver.resolveInScopeChain(
                module.symbolTree,
                token.value,
                token.start
            )
        ) {
            continue;
        }

        const moduleNames = candidates
            .map(candidate => formatModuleName(candidate.uri))
            .filter((value, position, all) => all.indexOf(value) === position)
            .sort();

        result.push(createTokenDiagnostic(
            token,
            DiagnosticSeverity.Error,
            `Ссылка ${token.value} неоднозначна: ` +
                `символ объявлен в ${moduleNames.join(", ")}`,
            "ambiguous-reference",
            false,
            {
                start: token.start,
                end: token.end,
                name: token.value
            }
        ));
    }
}

export function collectDeclarations(
    module: IIndexedModule,
    codeTokens: IRslToken[]
): IDeclarationInfo[] {
    const result: IDeclarationInfo[] = [];
    const signatureRanges = new Map<
        RslSymbol,
        { start: number; end: number } | undefined
    >();

    walkScopes(module.symbolTree, scope => {
        collectScopeDeclarations(
            codeTokens,
            scope,
            signatureRanges,
            result
        );
    });

    return result;
}

/** Объявления одной области: единица работы порционного сбора. */
export function collectScopeDeclarations(
    codeTokens: IRslToken[],
    scope: RslSymbol,
    signatureRanges: Map<RslSymbol, { start: number; end: number } | undefined>,
    result: IDeclarationInfo[]
): void {
    if (
        scope.kind === CompletionItemKind.Function ||
        scope.kind === CompletionItemKind.Method
    ) {
        signatureRanges.set(scope, findSignatureRange(codeTokens, scope));
    }

    for (const child of scope.children) {
        if (
            !VARIABLE_KINDS.has(child.kind) ||
            isReservedIdentifier(child.name)
        ) {
            continue;
        }

        const signature = signatureRanges.get(scope);

        result.push({
            symbol: child,
            scope,
            parameter: !!signature &&
                signature.start < child.range.start &&
                child.range.end <= signature.end
        });
    }
}

/**
 * Справочник объявлений порциями.
 *
 * Раньше он собирался одним куском: обход дерева с поиском границ сигнатуры у
 * каждой процедуры — это в сумме проход по всему файлу, и на модуле 470 КБ он
 * занимал поток на тринадцать миллисекунд подряд. Область — естественная
 * единица работы: её сигнатура ищется целиком, между областями состояние
 * хранить не нужно.
 */
export function createDeclarationFactsStage(
    module: IIndexedModule,
    finished: (declarations: IDeclarationInfo[]) => void
): IRslDiagnosticStage {
    const result: IDeclarationInfo[] = [];
    const signatureRanges = new Map<
        RslSymbol,
        { start: number; end: number } | undefined
    >();

    return createScopeScanStage(
        module.symbolTree,
        scope => collectScopeDeclarations(
            module.syntax.tokens,
            scope,
            signatureRanges,
            result
        ),
        () => finished(result)
    );
}

/**
 * Добавляет один токен в индекс вхождений имён.
 *
 * Индекс наполняется порциями, поэтому он передаётся снаружи, а не создаётся
 * здесь: между порциями расчёт возвращает управление редактору, и накопленное
 * обязано сохраниться.
 */
export function addToIdentifierIndex(
    index: Map<string, IRslToken[]>,
    token: IRslToken
): void {
    if (token.kind !== "identifier") {
        return;
    }

    const name = normalizeReferenceIdentifier(token.value);

    if (isReservedIdentifier(name)) {
        return;
    }

    const list = index.get(name);

    if (list) {
        list.push(token);
    } else {
        index.set(name, [token]);
    }
}

export function isRslSystemSpecialVariableReference(
    tokens: IRslToken[],
    index: number
): boolean {
    const token = tokens[index];
    const previous = tokens[index - 1];
    const next = tokens[index + 1];

    /*
     * Скобки делают именем всё, что внутри: одноимённая переменная модуля к
     * {oper} отношения не имеет, каким бы ни было имя в скобках.
     */
    return token?.kind === "identifier" &&
        (
            isRslSpecialVariableReference(token.raw) ||
            (
                isRslSystemSpecialVariableName(token.value) &&
                previous?.kind === "symbol" &&
                previous.raw === "{" &&
                next?.kind === "symbol" &&
                next.raw === "}"
            )
        );
}

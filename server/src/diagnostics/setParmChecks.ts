import {
    IRslToken
} from "../lexer";
import {
    RSL_BUILTIN_URI,
    RslScopeResolver
} from "../scopeResolver";
import {
    RslSymbol
} from "../symbols/rslSymbol";
import {
    IIndexedModule
} from "../workspaceIndex";
import {
    type IDeclarationInfo,
    type ILocalDiagnosticFacts
} from "./declarationChecks";
import {
    isCodeToken,
    nextCodeTokenIndex,
    tokenIndexAt
} from "./diagnosticFactory";

/*
 * Контракты SetParm.
 *
 * SetParm заполняет параметр по номеру, и проверка неиспользуемых
 * объявлений обязана это учитывать: параметр, заполненный SetParm,
 * используется, хотя его имя в тексте не встречается.
 */

/**
 * Что процедура отдаёт наружу через SetParm.
 *
 * `SetParm(2, значение)` записывает значение в третий параметр вызова.
 * Проверяется именно ВСТРОЕННАЯ SetParm: одноимённая процедура файла,
 * импортированная процедура и метод класса к параметрам отношения не
 * имеют, и разрешает имя общий resolver, а не совпадение текста.
 *
 * Вхождения берутся из готового индекса имён — отдельного прохода по
 * файлу не появляется, — а объемлющая процедура ищется двоичным поиском
 * по отсортированным диапазонам.
 */
export interface ISetParmContract {
    /** Позиции параметров, которые заполняет SetParm. */
    positions: Set<number>;
    /**
     * Номер параметра посчитан во время исполнения.
     *
     * Какой именно заполняется — неизвестно, поэтому по параметрам этой
     * процедуры не предупреждаем вовсе.
     */
    any: boolean;
}

export interface ISetParmScopes {
    contracts: Map<RslSymbol, ISetParmContract>;
    positions: Map<RslSymbol, number>;
}

export function collectSetParmContracts(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    facts: ILocalDiagnosticFacts
): ISetParmScopes {
    const positions = collectParameterPositions(facts);
    const calls = facts.identifierIndex.get("setparm") || [];
    const contracts = new Map<RslSymbol, ISetParmContract>();

    if (calls.length === 0) {
        return { contracts, positions };
    }

    const scopes = collectParameterScopes(facts);

    if (scopes.length === 0) {
        return { contracts, positions };
    }

    /*
     * Вызовы и области сопоставляются одним проходом.
     *
     * Оба списка отсортированы по началу, поэтому достаточно двигать один
     * указатель по областям и держать стек открытых: вершина стека и есть
     * ближайшая объемлющая процедура. Поиск на каждый вызов — даже
     * двоичный — оборачивался обратным обходом всех предыдущих процедур,
     * когда вызов стоит вне процедуры или между ними: на файле с
     * шестнадцатью тысячами верхнеуровневых вызовов это 652 мс вместо 227.
     */
    const sortedCalls = [...calls].sort((left, right) =>
        left.start - right.start
    );
    const open: IParameterScope[] = [];
    let scopeIndex = 0;

    for (const call of sortedCalls) {
        while (
            scopeIndex < scopes.length &&
            scopes[scopeIndex].start <= call.start
        ) {
            open.push(scopes[scopeIndex]);
            scopeIndex++;
        }

        while (open.length > 0 && open[open.length - 1].end < call.start) {
            open.pop();
        }

        const owner = open[open.length - 1];

        if (!owner) {
            continue;
        }

        const resolved = resolver.resolveAt(
            module.uri,
            module.symbolTree,
            call.start
        );

        /* Не встроенная SetParm — не наш случай. */
        if (!resolved || resolved.uri !== RSL_BUILTIN_URI) {
            continue;
        }

        const argument = readSetParmIndex(
            module.lex.tokens,
            call.start,
            owner.parameters.length
        );

        if (argument.kind === "none") {
            continue;
        }

        const contract = contracts.get(owner.scope) ||
            { positions: new Set<number>(), any: false };

        if (argument.kind === "any") {
            contract.any = true;
        } else {
            contract.positions.add(argument.position);
        }

        contracts.set(owner.scope, contract);
    }

    return { contracts, positions };
}

export function isFilledBySetParm(
    setParm: ISetParmScopes,
    declaration: IDeclarationInfo
): boolean {
    const contract = setParm.contracts.get(declaration.scope);

    if (!contract) {
        return false;
    }

    if (contract.any) {
        return true;
    }

    const position = setParm.positions.get(declaration.symbol);

    return position !== undefined && contract.positions.has(position);
}

/** Номер параметра в списке своей процедуры. */
export function collectParameterPositions(
    facts: ILocalDiagnosticFacts
): Map<RslSymbol, number> {
    const byScope = new Map<RslSymbol, IDeclarationInfo[]>();

    for (const declaration of facts.declarations) {
        if (!declaration.parameter) {
            continue;
        }

        const list = byScope.get(declaration.scope);

        if (list) {
            list.push(declaration);
        } else {
            byScope.set(declaration.scope, [declaration]);
        }
    }

    const result = new Map<RslSymbol, number>();

    for (const list of byScope.values()) {
        list
            .slice()
            .sort((left, right) =>
                left.symbol.selectionRange.start -
                    right.symbol.selectionRange.start
            )
            .forEach((declaration, position) => {
                result.set(declaration.symbol, position);
            });
    }

    return result;
}

export interface IParameterScope {
    scope: RslSymbol;
    start: number;
    end: number;
    parameters: readonly IDeclarationInfo[];
}

/** Процедуры с параметрами, отсортированные по началу. */
export function collectParameterScopes(
    facts: ILocalDiagnosticFacts
): readonly IParameterScope[] {
    const byScope = new Map<RslSymbol, IDeclarationInfo[]>();

    for (const declaration of facts.declarations) {
        if (!declaration.parameter) {
            continue;
        }

        const list = byScope.get(declaration.scope);

        if (list) {
            list.push(declaration);
        } else {
            byScope.set(declaration.scope, [declaration]);
        }
    }

    return [...byScope.entries()]
        .map(([scope, parameters]) => ({
            scope,
            start: scope.range.start,
            end: scope.range.end,
            parameters
        }))
        .sort((left, right) => left.start - right.start);
}

export type ISetParmArgument =
    | { kind: "none" }
    | { kind: "any" }
    | { kind: "position"; position: number };

/**
 * Первый аргумент SetParm: номер параметра.
 *
 * Один целый литерал и запятая — этот параметр. Полноценное выражение и
 * запятая — номер известен только во время исполнения. Пустой,
 * незавершённый, отрицательный вызов и номер за пределами списка
 * параметров не подавляют ничего: неполный текст не имеет права снимать
 * диагностику.
 */
export function readSetParmIndex(
    tokens: IRslToken[],
    nameStart: number,
    parameterCount: number
): ISetParmArgument {
    let index = tokenIndexAt(tokens, nameStart);

    if (index < 0) {
        return { kind: "none" };
    }

    index = nextCodeTokenIndex(tokens, index);

    if (
        index < 0 ||
        tokens[index].kind !== "symbol" ||
        tokens[index].raw !== "("
    ) {
        return { kind: "none" };
    }

    const argument: IRslToken[] = [];
    let depth = 0;

    for (let at = index; at < tokens.length; at++) {
        const token = tokens[at];

        if (token.kind === "symbol") {
            if (token.raw === "(") {
                depth++;

                if (depth === 1) {
                    continue;
                }
            } else if (token.raw === ")") {
                depth--;

                if (depth === 0) {
                    /* Запятой не было: второго аргумента нет. */
                    return { kind: "none" };
                }
            } else if (token.raw === ";") {
                /* Вызов не закрыт: текст ещё набирают. */
                return { kind: "none" };
            } else if (token.raw === "," && depth === 1) {
                return classifySetParmArgument(argument, parameterCount);
            }
        }

        if (depth >= 1 && isCodeToken(token)) {
            argument.push(token);
        }
    }

    return { kind: "none" };
}

export function classifySetParmArgument(
    argument: readonly IRslToken[],
    parameterCount: number
): ISetParmArgument {
    if (argument.length === 0) {
        return { kind: "none" };
    }

    /*
     * Знак и число — это тоже литерал, а не выражение: `SetParm(-1, ...)`
     * номером параметра быть не может, и подавлять по нему нечего.
     */
    const signed = argument.length === 2 &&
        argument[0].kind === "symbol" &&
        (argument[0].raw === "-" || argument[0].raw === "+") &&
        argument[1].kind === "number";

    if (argument.length > 1 && !signed) {
        /* Выражение: номер станет известен только при исполнении. */
        return { kind: "any" };
    }

    const only = argument[argument.length - 1];

    if (only.kind !== "number") {
        return { kind: "any" };
    }

    const sign = signed && argument[0].raw === "-" ? -1 : 1;
    const position = sign * Number(only.value);

    return Number.isInteger(position) &&
        position >= 0 &&
        position < parameterCount
        ? { kind: "position", position }
        : { kind: "none" };
}

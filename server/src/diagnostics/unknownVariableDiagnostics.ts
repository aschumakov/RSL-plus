import * as fs from "fs";

import {
    Diagnostic,
    DiagnosticSeverity
} from "vscode-languageserver";

import {
    isFullyKnownImportContext,
    type RslImportContextCompleteness
} from "../analysis/importContextState";
import {
    isRslKeyword,
    isRslSystemConstant,
    isRslType
} from "../language/rslLanguageReference";
import { normalizeIdentifier, type IRslToken } from "../lexer";
import type { RslScopeResolver } from "../scopeResolver";
import { isRslSystemSpecialVariableName } from "../systemSpecialVariables";
import type { IIndexedModule } from "../workspaceIndex";

/**
 * Необъявленные переменные.
 *
 * Правило по умолчанию ВЫКЛЮЧЕНО, и это не осторожность ради осторожности:
 * компилятор RSL разрешает имена ещё и из RSM, DLM, встроенных модулей и
 * собственного контекста сборки, которых в workspace нет вообще. Отсутствие
 * объявления в проекте не означает, что имени не существует.
 *
 *   off    — не проверять;
 *   safe   — только когда контекст доказуемо полон (см. условия ниже);
 *   strict — пользователь берёт неполный контекст на себя.
 *
 * Режим audit не публикует Problems, а собирает отчёт: на реальном репозитории
 * макросов правило надо сначала прогнать и посмотреть на ложные срабатывания, а
 * не включать по умолчанию.
 */
export type RslUnknownVariablesMode = "off" | "safe" | "strict";

export interface IRslUnknownVariableOptions {
    mode: RslUnknownVariablesMode;
    /**
     * Файл со списком известных глобальных переменных, процедур и классов.
     *
     * Одно имя на строку; `#` начинает комментарий. Такой файл — единственный
     * способ рассказать расширению про имена, которые компилятор берёт извне
     * workspace: без него правило в strict неизбежно ругается на них.
     */
    knownGlobalsFile?: string;
}

/** Причина, по которой имя признано неразрешённым. */
export type RslUnknownVariableReason =
    | "no-declaration"
    | "incomplete-context";

export interface IRslUnknownVariableFinding {
    uri: string;
    name: string;
    start: number;
    end: number;
    line: number;
    character: number;
    /** Имя ближайшей области: Macro, метод или класс; пусто для модуля. */
    scope: string;
    /** Есть ли в этом файле хотя бы одно явное VAR. */
    hasExplicitVar: boolean;
    importContext: RslImportContextCompleteness;
    reason: RslUnknownVariableReason;
}

export function normalizeUnknownVariablesMode(
    value: unknown
): RslUnknownVariablesMode {
    return value === "safe" || value === "strict" ? value : "off";
}

/**
 * Кандидаты на «необъявленную переменную» — без публикации.
 *
 * Один и тот же обход используют и диагностика, и audit-отчёт: иначе отчёт
 * описывал бы не то правило, которое потом включат.
 */
export function collectUnknownVariables(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    options: IRslUnknownVariableOptions
): IRslUnknownVariableFinding[] {
    if (options.mode === "off") {
        return [];
    }

    const state = resolver.getImportContextState(module.uri);

    /*
     * Условие полноты контекста. В safe оно обязательно: пока не видно всех
     * транзитивных .mac и всего состава прикладных модулей, «не нашли» и «нет» —
     * разные утверждения, и вторым из них пугать пользователя нельзя.
     */
    if (options.mode === "safe" && !isFullyKnownImportContext(state)) {
        return [];
    }

    const tokens = module.syntax.tokens;
    /*
     * Явный VAR в файле обязателен: файл без единого объявления написан в стиле,
     * где переменные вообще не объявляют, и предупреждать там не о чем.
     */
    const hasExplicitVar = hasExplicitVarDeclaration(tokens);

    if (!hasExplicitVar) {
        return [];
    }

    const known = readKnownGlobals(options.knownGlobalsFile);
    const declarationStarts = collectDeclarationStarts(module);
    const importRanges = collectImportRanges(module);
    const result: IRslUnknownVariableFinding[] = [];
    const reason: RslUnknownVariableReason = isFullyKnownImportContext(state)
        ? "no-declaration"
        : "incomplete-context";

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (
            token.kind !== "identifier" ||
            !isExpressionIdentifier(
                tokens,
                index,
                declarationStarts,
                importRanges
            ) ||
            known.has(normalizeIdentifier(token.value))
        ) {
            continue;
        }

        if (resolver.resolveAt(module.uri, module.symbolTree, token.start)) {
            continue;
        }

        result.push({
            uri: module.uri,
            name: token.value,
            start: token.start,
            end: token.end,
            line: token.line,
            character: token.character,
            scope: scopeNameAt(module, token.start),
            hasExplicitVar,
            importContext: state.completeness,
            reason
        });
    }

    return result;
}

export function buildUnknownVariableDiagnostics(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    options: IRslUnknownVariableOptions
): Diagnostic[] {
    return collectUnknownVariables(module, resolver, options).map(finding => ({
        severity: DiagnosticSeverity.Warning,
        range: {
            start: { line: finding.line, character: finding.character },
            end: {
                line: finding.line,
                character: finding.character + (finding.end - finding.start)
            }
        },
        message: `Переменная ${finding.name} нигде не объявлена`,
        source: "RSL parser",
        code: "unknown-variable",
        data: {
            start: finding.start,
            end: finding.end,
            name: finding.name
        }
    }));
}

/**
 * Идентификатор в позиции выражения.
 *
 * Исключается всё, что выражением не является: имя объявления, тип после ':',
 * имя после точки, имя внутри Import, ключевое слово, системная константа и
 * общесистемная спецпеременная.
 */
function isExpressionIdentifier(
    tokens: readonly IRslToken[],
    index: number,
    declarationStarts: ReadonlySet<number>,
    importRanges: readonly { start: number; end: number }[]
): boolean {
    const token = tokens[index];
    const word = normalizeIdentifier(token.value);

    if (
        isRslKeyword(word) ||
        isRslType(word) ||
        isRslSystemConstant(word) ||
        isRslSystemSpecialVariableName(token.value)
    ) {
        return false;
    }

    /* Имя объявления: сам VAR его и объявляет. */
    if (declarationStarts.has(token.start)) {
        return false;
    }

    if (importRanges.some(range =>
        range.start <= token.start && token.end <= range.end
    )) {
        return false;
    }

    const previous = previousCode(tokens, index);

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

function isDeclarationIntroducer(value: string): boolean {
    const word = normalizeIdentifier(value);
    return word === "var" || word === "const" || word === "array" ||
        word === "file" || word === "record" || word === "macro" ||
        word === "class";
}

function previousCode(
    tokens: readonly IRslToken[],
    index: number
): IRslToken | undefined {
    for (let current = index - 1; current >= 0; current--) {
        const token = tokens[current];

        if (
            token.kind !== "comment" &&
            token.kind !== "whitespace" &&
            token.kind !== "newline" &&
            token.kind !== "bom"
        ) {
            return token;
        }
    }

    return undefined;
}

function hasExplicitVarDeclaration(tokens: readonly IRslToken[]): boolean {
    return tokens.some(token =>
        token.kind === "identifier" &&
        normalizeIdentifier(token.value) === "var"
    );
}

/**
 * Начала имён всех объявлений документа.
 *
 * Только selectionRange: там и стоит имя. range у Macro начинается на ключевом
 * слове, и добавлять его значило бы глушить проверку по случайному совпадению
 * позиций.
 */
function collectDeclarationStarts(
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

function collectImportRanges(
    module: IIndexedModule
): readonly { start: number; end: number }[] {
    return module.syntax.root.children
        .filter(node => node.kind === "ImportDeclaration")
        .map(node => ({ start: node.start, end: node.end }));
}

function scopeNameAt(module: IIndexedModule, offset: number): string {
    let name = "";
    let current = module.symbolTree;

    for (;;) {
        const nested = current.children.find(child =>
            child.isContainer &&
            child.range.start <= offset &&
            offset <= child.range.end
        );

        if (!nested) {
            return name;
        }
        name = name ? `${name}.${nested.name}` : nested.name;
        current = nested;
    }
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

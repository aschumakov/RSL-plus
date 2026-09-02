import { CompletionItemKind } from "vscode-languageserver";

import { canonicalTypeName } from "../language/rslLanguageReference";
import {
    extractParameterLabels,
    findRslCallContext
} from "../features/signatureHelpProvider";
import type { IIndexedModule, IIndexedSymbol } from "../workspaceIndex";
import { normalizeIdentifier, type IRslToken } from "../lexer";
import type { RslScopeResolver } from "../scopeResolver";
import type { RslSymbol } from "../symbols/rslSymbol";
import type { WorkspaceIndex } from "../workspaceIndex";

/**
 * Семантика выражений: типы отдельно от разрешения имён.
 *
 * Resolver отвечает на вопрос «какой символ здесь имеется в виду» — области
 * видимости, Import, наследование. Всё, что про ТИПЫ, накапливалось там же и
 * растворялось среди правил видимости. Здесь оно собрано отдельно и работает
 * поверх resolver, а не вместо него.
 *
 * Слой ленивый по устройству. Он ничего не считает заранее, не запускает
 * анализ проекта и не держит второй копии дерева или текста: всё берётся у
 * индекса и resolver в момент вопроса. Ответы запоминаются на текущую версию
 * документа и выбрасываются вместе с ней.
 *
 * Чего он НЕ делает — не задерживает интерактивные ответы. Подсказка, которой
 * тип ещё не известен, обязана ответить без него: см. rankByExpectedType.
 */
export interface IRslCallTargetInfo {
    uri: string;
    symbol: RslSymbol;
    /** Номер аргумента под курсором, если вопрос был про место в вызове. */
    argumentIndex?: number;
}

export class RslTypeEngine {
    /**
     * Ответы на текущую версию документа.
     *
     * Ключ — сам объект модуля: он меняется вместе с текстом, и устаревшая
     * запись просто перестаёт находиться. Отдельной проверки версии не нужно.
     */
    private readonly byModule = new WeakMap<
        IIndexedModule,
        Map<string, string | undefined>
    >();

    constructor(
        private readonly index: WorkspaceIndex,
        private readonly resolver: RslScopeResolver
    ) {}

    /**
     * Тип объявления.
     *
     * У переменной это записанный или выведенный тип, у процедуры — тип
     * результата. Приводится к каноническому виду, чтобы `STRING` и `String`
     * не считались разными.
     */
    typeOfSymbol(symbol: RslSymbol | undefined): string {
        if (!symbol) {
            return "";
        }

        if (isCallableKind(symbol.kind)) {
            return canonicalTypeName(symbol.typeName || "");
        }

        if (symbol.kind === CompletionItemKind.Class) {
            /* Имя класса — это и есть тип его экземпляров. */
            return canonicalTypeName(symbol.name);
        }

        return canonicalTypeName(symbol.typeName || "");
    }

    /** Тип символа, на котором стоит курсор. */
    typeOfSymbolAt(uri: string, offset: number): string {
        return this.cached(uri, "symbol:" + offset, () => {
            const module = this.index.getModule(uri);

            if (!module) {
                return "";
            }

            const resolved = this.resolver.resolveAt(
                uri,
                module.symbolTree,
                offset
            );

            return this.typeOfSymbol(resolved?.symbol);
        });
    }

    /**
     * Тип выражения.
     *
     * Пока распознаётся то, что распознаётся дёшево и без догадок: имя,
     * обращение к члену и вызов. Всё остальное — пусто, и это честный ответ:
     * «не знаю» лучше выдуманного типа.
     */
    typeOfExpression(uri: string, start: number, end: number): string {
        return this.cached(uri, "expr:" + start + ":" + end, () => {
            const module = this.index.getModule(uri);

            if (!module) {
                return "";
            }

            const tokens = significantTokensWithin(module, start, end);

            if (tokens.length === 0) {
                return "";
            }

            /* Вызов: тип — это тип результата вызываемого. */
            const last = tokens[tokens.length - 1];

            if (last.kind === "symbol" && last.raw === ")") {
                const call = this.resolveCall(uri, last.start);

                return call ? this.typeOfSymbol(call.symbol) : "";
            }

            return this.typeOfSymbolAt(uri, tokens[tokens.length - 1].start);
        });
    }

    /**
     * Какое объявление вызывается в этом месте.
     *
     * Место может быть и внутри списка аргументов: тогда возвращается ещё и
     * номер аргумента, на котором стоит курсор.
     */
    resolveCall(uri: string, offset: number): IRslCallTargetInfo | undefined {
        const module = this.index.getModule(uri);

        if (!module) {
            return undefined;
        }

        const context = findRslCallContext(module.syntax.tokens, offset);

        if (!context) {
            return undefined;
        }

        const resolved = this.resolver.resolveAt(
            uri,
            module.symbolTree,
            context.callee.start
        );

        if (!resolved || !isCallableKind(resolved.symbol.kind)) {
            return undefined;
        }

        return {
            uri: resolved.uri,
            symbol: resolved.symbol,
            argumentIndex: context.activeParameter
        };
    }

    /** Тип результата вызова в этом месте. */
    returnTypeOfCall(uri: string, offset: number): string {
        const call = this.resolveCall(uri, offset);

        return call ? this.typeOfSymbol(call.symbol) : "";
    }

    /** Член получателя: делегируется resolver, где живёт наследование. */
    resolveMember(
        uri: string,
        receiverOffset: number,
        memberName: string
    ): IIndexedSymbol | undefined {
        const module = this.index.getModule(uri);

        if (!module) {
            return undefined;
        }

        return this.resolver.resolveMemberReference(
            uri,
            module.symbolTree,
            receiverOffset,
            memberName
        );
    }

    /**
     * Какой тип здесь уместен.
     *
     * Два случая, оба дешёвые и оба без догадок: справа от присваивания
     * переменной с известным типом и на месте аргумента вызова, у параметра
     * которого тип написан. Всё прочее — пусто.
     */
    expectedTypeAt(uri: string, offset: number): string {
        return this.cached(uri, "expected:" + offset, () => {
            const module = this.index.getModule(uri);

            if (!module) {
                return "";
            }

            const call = this.resolveCall(uri, offset);

            if (call && call.argumentIndex !== undefined) {
                const written = parameterTypeAt(
                    call.symbol,
                    call.argumentIndex
                );

                if (written) {
                    return written;
                }
            }

            return this.assignmentTargetType(module, offset);
        });
    }

    /** Тип переменной слева от присваивания, если курсор справа от него. */
    private assignmentTargetType(
        module: IIndexedModule,
        offset: number
    ): string {
        const tokens = module.syntax.tokens;
        let index = lastSignificantBefore(tokens, offset);

        /*
         * Между `=` и курсором может стоять уже набранное начало имени:
         * `doc = Get|`. Оно пропускается, дальше проверяется само `=`.
         */
        if (index >= 0 && tokens[index].kind === "identifier") {
            index--;
        }

        const operator = index >= 0 ? tokens[index] : undefined;

        if (
            !operator ||
            operator.kind !== "symbol" ||
            operator.raw !== "="
        ) {
            return "";
        }

        const target = previousSignificant(tokens, index);

        return target && target.kind === "identifier"
            ? this.typeOfSymbolAt(module.uri, target.start)
            : "";
    }

    private cached(
        uri: string,
        key: string,
        compute: () => string
    ): string {
        const module = this.index.getModule(uri);

        if (!module) {
            return "";
        }

        let byKey = this.byModule.get(module);

        if (!byKey) {
            byKey = new Map();
            this.byModule.set(module, byKey);
        }

        const known = byKey.get(key);

        if (known !== undefined) {
            return known;
        }

        const value = compute();

        byKey.set(key, value);

        return value;
    }
}

/** Тип параметра под этим номером, если он написан. */
export function parameterTypeAt(
    symbol: RslSymbol,
    argumentIndex: number
): string {
    const labels = extractParameterLabels(symbol);
    const label = labels[argumentIndex];

    if (!label) {
        return "";
    }

    const colon = label.indexOf(":");

    return colon < 0
        ? ""
        : canonicalTypeName(label.substring(colon + 1).trim());
}

function isCallableKind(kind: CompletionItemKind): boolean {
    return kind === CompletionItemKind.Function ||
        kind === CompletionItemKind.Method ||
        kind === CompletionItemKind.Constructor;
}

function isMeaningful(token: IRslToken): boolean {
    return token.kind !== "whitespace" &&
        token.kind !== "newline" &&
        token.kind !== "comment" &&
        token.kind !== "bom";
}

function significantTokensWithin(
    module: IIndexedModule,
    start: number,
    end: number
): IRslToken[] {
    const result: IRslToken[] = [];

    for (const token of module.syntax.tokens) {
        if (token.end <= start) {
            continue;
        }

        if (token.start >= end) {
            break;
        }

        if (isMeaningful(token)) {
            result.push(token);
        }
    }

    return result;
}

function lastSignificantBefore(
    tokens: readonly IRslToken[],
    offset: number
): number {
    for (let index = tokens.length - 1; index >= 0; index--) {
        const token = tokens[index];

        if (token.end <= offset && isMeaningful(token)) {
            return index;
        }
    }

    return -1;
}

function previousSignificant(
    tokens: readonly IRslToken[],
    index: number
): IRslToken | undefined {
    for (let at = index - 1; at >= 0; at--) {
        if (isMeaningful(tokens[at])) {
            return tokens[at];
        }
    }

    return undefined;
}

/** Нормализованное имя типа: для сравнения, а не для показа. */
export function sameRslType(left: string, right: string): boolean {
    return !!left && !!right &&
        normalizeIdentifier(left) === normalizeIdentifier(right);
}

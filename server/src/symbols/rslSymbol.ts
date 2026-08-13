import {
    CompletionItem,
    CompletionItemKind,
    InsertTextFormat
} from "vscode-languageserver";

import type { IRange } from "../interfaces";
import { normalizeIdentifier } from "../lexer";

/** Стабильный идентификатор символа внутри модуля. */
export type SymbolId = string & { readonly __symbolId: unique symbol };

export type RslSymbolVisibility = "public" | "private" | "local";

export interface IRslSymbolInit {
    id: SymbolId;
    name: string;
    kind: CompletionItemKind;
    visibility?: RslSymbolVisibility;
    range: IRange;
    selectionRange?: IRange;
    typeName?: string;
    /**
     * Переменная имеет тип Variant, то есть может содержать значение любого
     * типа, а typeName описывает лишь то, что в ней сейчас.
     *
     * Различие содержательное, а не косметическое. `Var sql: String` — это
     * приведение: переменная останется строкой, чем бы её потом ни присваивали.
     * `Var sql = "aaa"` объявляет Variant, который сейчас содержит строку, и
     * следующее присваивание сменит его тип. В typeName и то и другое выглядит
     * как "string", поэтому без этого признака отличить их невозможно.
     *
     * Ставится Variant-ом и явное `Var sql: Variant`, и его отсутствие:
     * руководство приравнивает переменную без декларации к Variant, и вести
     * себя они обязаны одинаково.
     *
     * Если не задано, выводится из typeName — так поведение мест, которые об
     * этом признаке не знают, остаётся прежним.
     */
    typeVariant?: boolean;
    value?: string;
    documentation?: string;
    builtin?: boolean;
    parameterText?: string;
    baseClassName?: string;
    children?: RslSymbol[];
}

/**
 * Семантический символ RSL.
 *
 * Класс не знает о parser-е, workspace и LSP transport. Он содержит только
 * данные объявления и навигационные связи, поэтому одинаково используется
 * открытыми документами и компактными external summary.
 */
export class RslSymbol {
    readonly id: SymbolId;
    readonly name: string;
    readonly kind: CompletionItemKind;
    readonly visibility: RslSymbolVisibility;
    readonly range: IRange;
    readonly selectionRange: IRange;
    readonly typeName: string;
    /** См. IRslSymbolInit.typeVariant. */
    readonly isTypeVariant: boolean;
    readonly value: string;
    readonly documentation: string;
    readonly isBuiltin: boolean;
    readonly parameterText: string;
    readonly baseClassName: string;
    readonly children: readonly RslSymbol[];

    constructor(init: IRslSymbolInit) {
        this.id = init.id;
        this.name = init.name;
        this.kind = init.kind;
        this.visibility = init.visibility || "public";
        this.range = Object.freeze({ ...init.range });
        this.selectionRange = Object.freeze({
            ...(init.selectionRange || init.range)
        });
        this.typeName = init.typeName || "variant";
        this.isTypeVariant = init.typeVariant ??
            normalizeIdentifier(this.typeName) === "variant";
        this.value = init.value || "";
        this.documentation = init.documentation || "";
        this.isBuiltin = init.builtin === true;
        this.parameterText = init.parameterText || "";
        this.baseClassName = init.baseClassName || "";
        this.children = Object.freeze([...(init.children || [])]);
        Object.freeze(this);
    }

    get isPrivate(): boolean {
        return this.visibility !== "public";
    }

    get isContainer(): boolean {
        return this.kind === CompletionItemKind.Unit ||
            this.kind === CompletionItemKind.Class ||
            this.kind === CompletionItemKind.Function ||
            this.kind === CompletionItemKind.Method;
    }

    contains(offset: number): boolean {
        return this.range.start <= offset && offset <= this.range.end;
    }

    find(name: string): RslSymbol | undefined {
        const normalizedName = normalizeIdentifier(name);
        const queue = [...this.children];

        while (queue.length > 0) {
            const symbol = queue.shift()!;
            if (normalizeIdentifier(symbol.name) === normalizedName) {
                return symbol;
            }
            if (symbol.isContainer) {
                queue.unshift(...symbol.children);
            }
        }
        return undefined;
    }

    get completionItem(): CompletionItem {
        const kindName = completionKindName(this.kind);
        let detail: string;

        if (
            this.kind === CompletionItemKind.Function ||
            this.kind === CompletionItemKind.Method
        ) {
            detail = `${kindName}: ${this.name}${this.parameterText}.\n` +
                `Возвращаемый тип: ${this.typeName}`;
        } else if (this.kind === CompletionItemKind.Constant) {
            detail = `${kindName}: ${this.name}` +
                (this.value ? ` = ${this.value}` : "") +
                `,\nтип ${this.typeName}`;
        } else {
            detail = `${kindName}: ${this.name}`;
            if (
                this.kind === CompletionItemKind.Variable ||
                this.kind === CompletionItemKind.Property ||
                this.kind === CompletionItemKind.Field
            ) {
                detail += `,\nтип ${this.typeName}`;
            }
        }

        const callable = this.kind === CompletionItemKind.Function ||
            this.kind === CompletionItemKind.Method;
        return {
            label: this.name,
            documentation: this.documentation,
            insertTextFormat: InsertTextFormat.PlainText,
            kind: this.kind,
            detail,
            insertText: callable ? `${this.name}()` : this.name,
            data: { symbolId: this.id }
        };
    }
}

export function createSymbolId(
    parentId: SymbolId | undefined,
    kind: CompletionItemKind,
    name: string,
    occurrence: number = 0
): SymbolId {
    const segment = `${kind}:${normalizeIdentifier(name) || "<anonymous>"}` +
        (occurrence > 0 ? `#${occurrence}` : "");
    return `${parentId ? `${parentId}/` : ""}${segment}` as SymbolId;
}

export function moduleSymbolId(): SymbolId {
    return "module" as SymbolId;
}

function completionKindName(kind: CompletionItemKind): string {
    switch (kind) {
        case CompletionItemKind.Method: return "Метод";
        case CompletionItemKind.Function: return "Функция";
        case CompletionItemKind.Variable: return "Переменная";
        case CompletionItemKind.Property: return "Свойство";
        case CompletionItemKind.Constant: return "Константа";
        case CompletionItemKind.Class: return "Класс";
        case CompletionItemKind.Struct: return "Структура";
        case CompletionItemKind.File: return "Файл";
        default: return "Символ";
    }
}

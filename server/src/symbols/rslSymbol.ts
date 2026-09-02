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

    /**
     * Тип, которым это объявление годится в выражение.
     *
     * У переменной — её тип, у процедуры — тип результата, у класса —
     * его собственное имя: `TBFile()` даёт TBFile.
     */
    get completionType(): string {
        if (this.kind === CompletionItemKind.Class) {
            return normalizeIdentifier(this.name);
        }

        return normalizeIdentifier(this.typeName || "");
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
        /*
         * У вызова с известной подписью параметры вставляются заготовками:
         * `Send(${1:document}, ${2:silent})`, и Tab переводит между ними.
         * Прежде вставлялось `Send()` — имена параметров приходилось
         * подсматривать в подсказке и набирать вручную.
         */
        const snippet = callable ? callSnippet(this.name, this.parameterText) : "";

        return {
            label: this.name,
            documentation: this.documentation,
            insertTextFormat: snippet
                ? InsertTextFormat.Snippet
                : InsertTextFormat.PlainText,
            kind: this.kind,
            detail,
            insertText: snippet || (callable ? `${this.name}()` : this.name),
            /*
             * Тип кандидата нужен ранжированию по ожидаемому типу.
             * У процедуры это тип результата, у класса — он сам.
             */
            data: { symbolId: this.id, rslType: this.completionType }
        };
    }
}

/**
 * Вызов с заготовками параметров.
 *
 * Пусто, если параметров нет или подпись неизвестна: тогда вставляется
 * обычный текст, и лишнего режима правки у пользователя не появляется.
 */
function callSnippet(name: string, parameterText: string): string {
    const inside = parameterText.trim();
    const open = inside.indexOf("(");
    const close = inside.lastIndexOf(")");

    if (open < 0 || close <= open) {
        return "";
    }

    const parameters = splitCallParameters(inside.substring(open + 1, close))
        .map(parameterPlaceholderName)
        .filter(value => !!value);

    if (parameters.length === 0) {
        return "";
    }

    const body = parameters
        .map((value, at) => "${" + (at + 1) + ":" + escapeSnippet(value) + "}")
        .join(", ");

    return escapeSnippet(name) + "(" + body + ")";
}

/** Имя параметра без типа, без ссылки и без значения по умолчанию. */
function parameterPlaceholderName(text: string): string {
    let value = text.trim();
    const colon = value.indexOf(":");

    if (colon >= 0) {
        value = value.substring(0, colon);
    }

    const assign = value.indexOf("=");

    if (assign >= 0) {
        value = value.substring(0, assign);
    }

    /* Передача по ссылке пишется как @имя: сама собака в имя не входит. */
    return value.replace(/^@/u, "").trim();
}

/** Разделение по запятым верхнего уровня. */
function splitCallParameters(value: string): string[] {
    const result: string[] = [];
    let current = "";
    let depth = 0;

    for (const character of value) {
        if (character === "(" || character === "[") {
            depth++;
        } else if (character === ")" || character === "]") {
            depth = Math.max(0, depth - 1);
        }

        if (character === "," && depth === 0) {
            result.push(current);
            current = "";
            continue;
        }

        current += character;
    }

    if (current.trim()) {
        result.push(current);
    }

    return result;
}

/**
 * Экранирование для заготовки.
 *
 * `$`, `}` и обратная косая в тексте заготовки значат не то, что написано:
 * без экранирования имя параметра со скобкой ломало бы вставку.
 */
function escapeSnippet(value: string): string {
    return value.replace(/[\\$}]/gu, match => "\\" + match);
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

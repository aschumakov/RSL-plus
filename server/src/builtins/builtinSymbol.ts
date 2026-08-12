import {
    CompletionItemKind,
    InsertTextFormat,
    MarkupKind,
    type CompletionItem
} from "vscode-languageserver";

import { normalizeIdentifier } from "../lexer";
import {
    createSymbolId,
    RslSymbol,
    type SymbolId
} from "../symbols/rslSymbol";
import type { IRslBuiltinDefinition } from "./standardLibraryData";

/** Семантический символ стандартной библиотеки, не связанный с файлом. */
export class BuiltinSymbol {
    readonly name: string;
    readonly typeName: string;
    readonly kind: CompletionItemKind;
    readonly signature: string;
    readonly summary: string;
    readonly insertText: string;
    /** Имя базового класса; пусто, если класс ничего не наследует. */
    readonly base: string;
    readonly children: readonly BuiltinSymbol[];

    constructor(definition: IRslBuiltinDefinition) {
        this.name = definition.name;
        this.typeName = definition.typeName || "Variant";
        this.kind = definition.kind;
        this.signature = definition.signature || definition.name;
        this.summary = definition.summary || "";
        this.insertText = definition.insertText || "";
        this.base = definition.base || "";
        this.children = Object.freeze(
            (definition.children || []).map(item => new BuiltinSymbol(item))
        );
        Object.freeze(this);
    }

    get completionItem(): CompletionItem {
        const callable = this.kind === CompletionItemKind.Function ||
            this.kind === CompletionItemKind.Method ||
            this.kind === CompletionItemKind.Class;
        return {
            label: this.name,
            documentation: this.summary
                ? { kind: MarkupKind.Markdown, value: this.summary }
                : undefined,
            insertTextFormat: callable
                ? InsertTextFormat.Snippet
                : InsertTextFormat.PlainText,
            kind: this.kind,
            detail: this.detail,
            insertText: this.insertText ||
                (callable && this.signature.includes("(")
                    ? `${this.name}($0)`
                    : this.name),
            data: { rslBuiltin: true }
        };
    }

    get detail(): string {
        if (
            this.kind === CompletionItemKind.Function ||
            this.kind === CompletionItemKind.Method
        ) {
            const suffix = /\)\s*:\s*\w+\s*$/u.test(this.signature)
                ? ""
                : `: ${this.typeName}`;
            return `${this.signature}${suffix}`;
        }
        return this.kind === CompletionItemKind.Class
            ? `Class ${this.name}`
            : `${this.name}: ${this.typeName}`;
    }

    toRslSymbol(parentId?: SymbolId): RslSymbol {
        const id = createSymbolId(parentId, this.kind, this.name);
        return new RslSymbol({
            id,
            name: this.name,
            kind: this.kind,
            range: { start: 0, end: 0 },
            selectionRange: { start: 0, end: 0 },
            typeName: this.typeName,
            parameterText: parameterText(this.signature, this.name),
            documentation: this.summary,
            builtin: true,
            /*
             * Имя базового класса передаётся как есть: разрешать его здесь
             * нельзя, каталог ещё строится. Цепочку обходит scopeResolver — он
             * же обрабатывает наследование классов пользователя.
             */
            baseClassName: this.base || undefined,
            children: this.children.map(child => child.toRslSymbol(id))
        });
    }
}

/** Неизменяемый O(1)-индекс стандартных символов. */
export class BuiltinCatalog {
    private readonly items: readonly BuiltinSymbol[];
    private readonly byName: ReadonlyMap<string, BuiltinSymbol>;
    private readonly semanticByName: ReadonlyMap<string, RslSymbol>;
    private readonly completionCache: readonly CompletionItem[];

    constructor(definitions: readonly IRslBuiltinDefinition[]) {
        this.items = Object.freeze(definitions.map(item => new BuiltinSymbol(item)));
        const byName = new Map<string, BuiltinSymbol>();
        const semantic = new Map<string, RslSymbol>();
        for (const item of this.items) {
            const key = normalizeIdentifier(item.name);
            byName.set(key, item);
            semantic.set(key, item.toRslSymbol());
        }
        this.byName = byName;
        this.semanticByName = semantic;
        this.completionCache = Object.freeze(
            this.items.map(item => Object.freeze(item.completionItem))
        );
    }

    find(name: string): BuiltinSymbol | undefined {
        return this.byName.get(normalizeIdentifier(name));
    }

    findSymbol(name: string): RslSymbol | undefined {
        return this.semanticByName.get(normalizeIdentifier(name));
    }

    findClass(name: string): RslSymbol | undefined {
        const symbol = this.findSymbol(name);
        return symbol?.kind === CompletionItemKind.Class ? symbol : undefined;
    }

    get completionItems(): readonly CompletionItem[] {
        return this.completionCache;
    }

    get size(): number {
        return this.items.length;
    }
}

function parameterText(signature: string, name: string): string {
    const nameIndex = signature.toLowerCase().indexOf(name.toLowerCase());
    const open = signature.indexOf("(", nameIndex + name.length);
    if (open < 0) return "()";
    let depth = 0;
    for (let index = open; index < signature.length; index++) {
        const character = signature.charAt(index);
        if (character === "(") depth++;
        else if (character === ")" && --depth === 0) {
            return signature.substring(open, index + 1);
        }
    }
    return signature.substring(open);
}

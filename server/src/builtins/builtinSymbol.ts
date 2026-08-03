import {
    CompletionItemKind,
    InsertTextFormat,
    type CompletionItem,
    type MarkupContent
} from "vscode-languageserver";

import type { ObjInfo } from "../enums";

/** Описание встроенного символа, не привязанного к исходному RSL-файлу. */
export class BuiltinSymbol {
    readonly children: BuiltinSymbol[] = [];

    constructor(
        readonly name: string,
        readonly typeName: string,
        readonly detail: string,
        readonly documentation: MarkupContent,
        readonly insertText: string,
        readonly insertTextFormat: InsertTextFormat = InsertTextFormat.Snippet,
        readonly kind: CompletionItemKind = CompletionItemKind.Variable
    ) {}

    addChild(symbol: BuiltinSymbol): void {
        this.children.push(symbol);
    }

    get info(): ObjInfo {
        return { name: this.name, valueType: this.typeName };
    }

    get completionItem(): CompletionItem {
        return {
            label: this.name,
            documentation: this.documentation,
            insertTextFormat: this.insertTextFormat,
            kind: this.kind,
            detail: this.detail,
            insertText: this.insertText
        };
    }

    get childCompletionItems(): CompletionItem[] {
        return this.children.map(child => child.completionItem);
    }
}

export class BuiltinFunctionSymbol extends BuiltinSymbol {
    constructor(
        name: string,
        typeName: string,
        detail: string,
        documentation: MarkupContent,
        insertText: string,
        insertTextFormat: InsertTextFormat = InsertTextFormat.Snippet,
        kind: CompletionItemKind = CompletionItemKind.Function
    ) {
        super(
            name,
            typeName,
            detail,
            documentation,
            insertText,
            insertTextFormat,
            kind
        );
    }
}

export class BuiltinClassSymbol extends BuiltinSymbol {
    constructor(
        name: string,
        typeName: string,
        detail: string,
        documentation: MarkupContent,
        insertText: string,
        insertTextFormat: InsertTextFormat = InsertTextFormat.Snippet
    ) {
        super(
            name,
            typeName,
            detail,
            documentation,
            insertText,
            insertTextFormat,
            CompletionItemKind.Class
        );
    }
}

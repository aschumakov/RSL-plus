import * as path from "path";
import { fileURLToPath } from "url";

import {
    CompletionItemKind,
    MarkupContent,
    MarkupKind
} from "vscode-languageserver/node";

import type { RslSymbol } from "../symbols/rslSymbol";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

export function buildRslHoverContent(
    index: WorkspaceIndex,
    uri: string,
    symbol: RslSymbol
): MarkupContent {
    const module = index.getModule(uri);
    const parent = module ? findParent(module.symbolTree, symbol) : undefined;
    const parameter = module ? isParameterNode(module, symbol) : false;
    const lines: string[] = [];
    const declaration = buildDeclaration(symbol, parameter);

    lines.push("```rsl", declaration, "```");

    if (symbol.isPrivate && !parameter) {
        lines.push("", "**Видимость:** Private");
    }

    if (parent && parent.name) {
        lines.push("", `**Контейнер:** ${escapeMarkdown(parent.name)}`);
    }

    if (symbol.kind === CompletionItemKind.Class) {
        const parentName = symbol.baseClassName;
        if (parentName) {
            lines.push("", `**Базовый класс:** ${escapeMarkdown(parentName)}`);
        }
    }

    lines.push("", `**Файл:** ${escapeMarkdown(displayFile(uri))}`);
    const line = declarationLine(index, module, uri, symbol);
    if (line !== undefined) {
        lines.push(`**Строка:** ${line + 1}`);
    }

    const documentation = normalizeDocumentation(symbol.completionItem.documentation);
    if (documentation) {
        lines.push("", documentation);
    }

    return {
        kind: MarkupKind.Markdown,
        value: lines.join("  \n")
    };
}

function buildDeclaration(
    symbol: RslSymbol,
    parameter: boolean
): string {
    const visibility = symbol.isPrivate ? "Private " : "";
    const kind = symbol.kind;

    if (
        kind === CompletionItemKind.Function ||
        kind === CompletionItemKind.Method
    ) {
        const signature = extractSignature(symbol);
        const returnType = symbol.typeName && symbol.typeName.toLowerCase() !== "variant"
            ? `: ${symbol.typeName}`
            : "";
        return `${visibility}Macro ${symbol.name}${signature}${returnType}`;
    }

    if (kind === CompletionItemKind.Class) {
        const base = symbol.baseClassName;
        return `${visibility}Class ${base ? `(${base}) ` : ""}${symbol.name}`;
    }

    if (parameter) {
        return `${symbol.name}: ${symbol.typeName || "variant"}`;
    }

    if (kind === CompletionItemKind.Constant) {
        const value = symbol.value;
        return value
            ? `${visibility}Const ${symbol.name} = ${value}`
            : `${visibility}Const ${symbol.name}: ${symbol.typeName || "variant"}`;
    }

    const keyword = "Var";
    return `${visibility}${keyword} ${symbol.name}: ${symbol.typeName || "variant"}`;
}

function extractSignature(symbol: RslSymbol): string {
    const detail = String(symbol.completionItem.detail || "");
    const nameIndex = detail.toLowerCase().indexOf(symbol.name.toLowerCase());
    if (nameIndex < 0) {
        return "()";
    }

    const open = detail.indexOf("(", nameIndex + symbol.name.length);
    if (open < 0) {
        return "()";
    }

    let depth = 0;
    for (let index = open; index < detail.length; index++) {
        if (detail.charAt(index) === "(") {
            depth++;
        } else if (detail.charAt(index) === ")") {
            depth--;
            if (depth === 0) {
                return detail.substring(open, index + 1);
            }
        }
    }

    return "()";
}

function isParameterNode(
    module: IIndexedModule,
    symbol: RslSymbol
): boolean {
    const visit = (node: IIndexedModule["syntax"]["root"]): boolean => {
        if (
            node.kind === "Parameter" &&
            node.start === symbol.range.start &&
            node.name?.toLowerCase() === symbol.name.toLowerCase()
        ) {
            return true;
        }
        return node.children.some(visit);
    };

    return visit(module.syntax.root);
}

function findParent(root: RslSymbol, target: RslSymbol): RslSymbol | undefined {
    for (const child of root.children) {
        if (child === target) {
            return root;
        }
        if (child.isContainer) {
            const nested = findParent(child, target);
            if (nested) {
                return nested;
            }
        }
    }
    return undefined;
}

function declarationLine(
    index: WorkspaceIndex,
    module: IIndexedModule | undefined,
    uri: string,
    symbol: RslSymbol
): number | undefined {
    const external = index.getDefinitionRange(uri, symbol);
    if (external) {
        return external.start.line;
    }
    if (!module || module.lex.lineStarts.length === 0) {
        return undefined;
    }

    const offset = symbol.range.start;
    let left = 0;
    let right = module.lex.lineStarts.length - 1;
    let line = 0;
    while (left <= right) {
        const middle = (left + right) >>> 1;
        if (module.lex.lineStarts[middle] <= offset) {
            line = middle;
            left = middle + 1;
        } else {
            right = middle - 1;
        }
    }
    return line;
}

function displayFile(uri: string): string {
    try {
        return path.basename(fileURLToPath(uri));
    } catch (_error) {
        return path.basename(decodeURIComponent(uri).replace(/\\/g, "/"));
    }
}

function normalizeDocumentation(value: unknown): string {
    if (!value) {
        return "";
    }
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "object" && "value" in (value as object)) {
        return String((value as { value?: unknown }).value || "");
    }
    return String(value);
}

function escapeMarkdown(value: string): string {
    return value.replace(/([\\`*_{}\[\]()#+\-.!])/g, "\\$1");
}

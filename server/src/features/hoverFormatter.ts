import * as path from "path";
import { fileURLToPath } from "url";

import {
    CompletionItemKind,
    MarkupContent,
    MarkupKind
} from "vscode-languageserver/node";

import type { CBase } from "../common";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

interface IClassLike {
    getParentName?(): string;
}

export function buildRslHoverContent(
    index: WorkspaceIndex,
    uri: string,
    object: CBase
): MarkupContent {
    const module = index.getModule(uri);
    const parent = module ? findParent(module.object, object) : undefined;
    const parameter = module ? isParameterNode(module, object) : false;
    const lines: string[] = [];
    const declaration = buildDeclaration(object, parent, parameter);

    lines.push("```rsl", declaration, "```");

    if (object.Private && !parameter) {
        lines.push("", "**Видимость:** Private");
    }

    if (parent && parent.Name) {
        lines.push("", `**Контейнер:** ${escapeMarkdown(parent.Name)}`);
    }

    if (object.ObjKind === CompletionItemKind.Class) {
        const parentName = (object as unknown as IClassLike).getParentName?.();
        if (parentName) {
            lines.push("", `**Базовый класс:** ${escapeMarkdown(parentName)}`);
        }
    }

    lines.push("", `**Файл:** ${escapeMarkdown(displayFile(uri))}`);
    const line = declarationLine(index, module, uri, object);
    if (line !== undefined) {
        lines.push(`**Строка:** ${line + 1}`);
    }

    const documentation = normalizeDocumentation(object.CIInfo.documentation);
    if (documentation) {
        lines.push("", documentation);
    }

    return {
        kind: MarkupKind.Markdown,
        value: lines.join("  \n")
    };
}

function buildDeclaration(
    object: CBase,
    parent: CBase | undefined,
    parameter: boolean
): string {
    const visibility = object.Private ? "Private " : "";
    const kind = object.ObjKind;

    if (
        kind === CompletionItemKind.Function ||
        kind === CompletionItemKind.Method
    ) {
        const signature = extractSignature(object);
        const returnType = object.Type && object.Type.toLowerCase() !== "variant"
            ? `: ${object.Type}`
            : "";
        return `${visibility}Macro ${object.Name}${signature}${returnType}`;
    }

    if (kind === CompletionItemKind.Class) {
        const base = (object as unknown as IClassLike).getParentName?.();
        return `${visibility}Class ${base ? `(${base}) ` : ""}${object.Name}`;
    }

    if (parameter) {
        return `${object.Name}: ${object.Type || "variant"}`;
    }

    const keyword = kind === CompletionItemKind.Constant ? "Const" : "Var";
    return `${visibility}${keyword} ${object.Name}: ${object.Type || "variant"}`;
}

function extractSignature(object: CBase): string {
    const detail = String(object.CIInfo.detail || "");
    const nameIndex = detail.toLowerCase().indexOf(object.Name.toLowerCase());
    if (nameIndex < 0) {
        return "()";
    }

    const open = detail.indexOf("(", nameIndex + object.Name.length);
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
    object: CBase
): boolean {
    const visit = (node: IIndexedModule["syntax"]["root"]): boolean => {
        if (
            node.kind === "Parameter" &&
            node.start === object.Range.start &&
            node.name?.toLowerCase() === object.Name.toLowerCase()
        ) {
            return true;
        }
        return node.children.some(visit);
    };

    return visit(module.syntax.root);
}

function findParent(root: CBase, target: CBase): CBase | undefined {
    for (const child of root.getChilds()) {
        if (child === target) {
            return root;
        }
        if (child.isObject()) {
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
    object: CBase
): number | undefined {
    const external = index.getDefinitionRange(uri, object);
    if (external) {
        return external.start.line;
    }
    if (!module || module.lex.lineStarts.length === 0) {
        return undefined;
    }

    const offset = object.Range.start;
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

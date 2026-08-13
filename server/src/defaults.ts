import { CompletionItemKind } from "vscode-languageserver";

import { BuiltinCatalog } from "./builtins/builtinSymbol";
import {
    RSL_STANDARD_LIBRARY,
    type IRslBuiltinDefinition
} from "./builtins/standardLibraryData";
import { VALUE_TYPE_CONSTANTS } from "./language/rslLanguageReference";
import { RSL_SYSTEM_SPECIAL_VARIABLES } from "./systemSpecialVariables";

const SPECIAL_VARIABLES: IRslBuiltinDefinition[] =
    RSL_SYSTEM_SPECIAL_VARIABLES.map(variable => ({
        name: `{${variable.name}}`,
        kind: CompletionItemKind.Variable,
        typeName: variable.type,
        summary: shortSummary(variable.description),
        insertText: `{${variable.name}}`
    }));

const TYPE_CONSTANTS: IRslBuiltinDefinition[] = VALUE_TYPE_CONSTANTS.map(
    name => ({
        name,
        kind: CompletionItemKind.Constant,
        typeName: "Integer",
        summary: "Код типа значения RSL."
    })
);

const DEFAULTS = new BuiltinCatalog([
    ...RSL_STANDARD_LIBRARY,
    ...TYPE_CONSTANTS,
    ...SPECIAL_VARIABLES
]);

/** Возвращает общий неизменяемый каталог стандартной библиотеки. */
export function getDefaults(): BuiltinCatalog {
    return DEFAULTS;
}

function shortSummary(value: string): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length <= 110) return normalized;
    return `${normalized.slice(0, 107).replace(/\s+\S*$/u, "")}...`;
}

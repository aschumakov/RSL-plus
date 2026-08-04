import type { Range, WorkspaceEdit } from "vscode-languageserver";

import { findRslReferencesInWorkspace } from "../analysis/references";
import type { ReferenceIndex } from "../analysis/referenceIndex";
import { RSL_BUILTIN_URI, type RslScopeResolver } from "../scopeResolver";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

export interface IRslPrepareRenameResult {
    range: Range;
    placeholder: string;
}

export function prepareRslRename(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    offset: number
): IRslPrepareRenameResult | null {
    const resolved = resolver.resolveAt(module.uri, module.symbolTree, offset);
    if (!resolved || resolved.uri === RSL_BUILTIN_URI) {
        return null;
    }
    return {
        range: {
            start: {
                line: resolved.token.line,
                character: resolved.token.character
            },
            end: {
                line: resolved.token.endLine,
                character: resolved.token.endCharacter
            }
        },
        placeholder: resolved.token.value
    };
}

export async function buildRslRenameEdit(
    module: IIndexedModule,
    index: WorkspaceIndex,
    resolver: RslScopeResolver,
    referenceIndex: ReferenceIndex,
    offset: number,
    newName: string,
    isCancelled: () => boolean = () => false
): Promise<WorkspaceEdit | null> {
    const target = resolver.resolveAt(module.uri, module.symbolTree, offset);
    if (
        !target ||
        target.uri === RSL_BUILTIN_URI ||
        !isValidRename(target.symbol.name, newName)
    ) {
        return null;
    }
    const locations = await findRslReferencesInWorkspace(
        index,
        resolver,
        referenceIndex,
        module.uri,
        offset,
        true,
        isCancelled
    );
    if (isCancelled() || locations.length === 0) {
        return null;
    }
    const changes: NonNullable<WorkspaceEdit["changes"]> = {};
    for (const location of locations) {
        (changes[location.uri] ||= []).push({
            range: location.range,
            newText: newName
        });
    }
    return { changes };
}

export function isValidRslIdentifier(value: string): boolean {
    return /^\{[^}\r\n]+\}$/u.test(value) ||
        /^[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]{0,79}$/u.test(value);
}

function isValidRename(oldName: string, newName: string): boolean {
    if (!isValidRslIdentifier(newName)) {
        return false;
    }
    /* Смена семейства сделала бы локальное имя глобальным SPNAME и наоборот. */
    return oldName.startsWith("{") === newName.startsWith("{");
}

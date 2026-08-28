import type { Range, WorkspaceEdit } from "vscode-languageserver";

import { findRslReferencesInWorkspace } from "../analysis/references";
import type { ReferenceIndex } from "../analysis/referenceIndex";
import type {
    RslReferenceShardStore
} from "../analysis/referenceShards";
import { isReservedWord } from "../language/rslLanguageReference";
import { RSL_BUILTIN_URI, type RslScopeResolver } from "../scopeResolver";
import type { RslSymbol } from "../symbols/rslSymbol";
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
    isCancelled: () => boolean = () => false,
    /* Постоянные записи о ссылках, если сервер их ведёт. */
    referenceShards?: RslReferenceShardStore
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
        isCancelled,
        referenceShards
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

/**
 * Причина, по которой переименование выполнять нельзя, или undefined.
 *
 * Проверяется ДО правок: Rename меняет файлы, и обнаружить конфликт после — это
 * уже испорченный код. Проверка та же, что у диагностики повторных объявлений:
 * конфликтом считается имя, занятое в ТОЙ ЖЕ области. Одноимённые объявления в
 * разных Macro и пара глобальное/локальное конфликтом не являются — RSL их
 * допускает, и запрещать их здесь значило бы запрещать больше, чем язык.
 *
 * Имя из импортированного модуля здесь не проверяется намеренно: оно даёт не
 * ошибку, а неоднозначную ссылку, о которой отдельно сообщает ambiguous-reference
 * — решение остаётся за автором.
 */
export function findRslRenameConflict(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    offset: number,
    newName: string
): string | undefined {
    if (!isValidRslIdentifier(newName)) {
        return `«${newName}» не является допустимым именем RSL`;
    }

    if (isReservedWord(newName)) {
        return `«${newName}» — зарезервированное слово RSL`;
    }

    const target = resolver.resolveAt(module.uri, module.symbolTree, offset);

    if (!target || target.uri === RSL_BUILTIN_URI) {
        return undefined;
    }

    if (!isValidRename(target.symbol.name, newName)) {
        return target.symbol.name.startsWith("{")
            ? "Общесистемная спецпеременная не может стать обычным именем"
            : "Обычное имя не может стать общесистемной спецпеременной";
    }

    const scope = findDeclaringScope(module.symbolTree, target.symbol);
    const normalized = newName.toLowerCase();
    const taken = (scope || module.symbolTree).children.find(child =>
        child !== target.symbol &&
        child.name.toLowerCase() === normalized
    );

    return taken
        ? `В этой же области уже объявлено имя ${taken.name}`
        : undefined;
}

/** Область, в которой символ объявлен непосредственно. */
function findDeclaringScope(
    scope: RslSymbol,
    target: RslSymbol
): RslSymbol | undefined {
    if (scope.children.includes(target)) {
        return scope;
    }

    for (const child of scope.children) {
        if (child.isContainer) {
            const found = findDeclaringScope(child, target);

            if (found) {
                return found;
            }
        }
    }

    return undefined;
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

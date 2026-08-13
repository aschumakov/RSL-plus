import {
    Diagnostic,
    DiagnosticSeverity,
    DiagnosticTag
} from "vscode-languageserver";

import {
    isFullyKnownImportContext
} from "../analysis/importContextState";
import { positionAtOffset } from "../core/documentPosition";
import { GetImportDefinitionTargetsFromTokens } from "../execMacroDefinition";
import type { RslScopeResolver } from "../scopeResolver";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";

/**
 * Import модуля, который уже приходит через другой Import этого файла.
 *
 * Символы в RSL видны по всему Import-замыканию, поэтому такой Import ничего не
 * добавляет. Но проверка по умолчанию ВЫКЛЮЧЕНА, и это не осторожность ради
 * осторожности: явный Import — это ещё и защита. Если соседний модуль перестанет
 * импортировать общий, файл сломается, а его собственный Import об этом сказать
 * не даст. Решение, держать ли такую страховку, принимает автор кода.
 *
 * Проверка выполняется только при полном Import-контексте. При неполном ответ
 * был бы просто неверным: пока файл соседнего модуля не проиндексирован, его
 * собственные Import неизвестны, и «уже импортирован через» — утверждение ни на
 * чём.
 */
export function buildRedundantImportDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    resolver: RslScopeResolver
): Diagnostic[] {
    if (!isFullyKnownImportContext(
        resolver.getImportContextState(module.uri)
    )) {
        return [];
    }

    const references = GetImportDefinitionTargetsFromTokens(module.lex.tokens);
    const direct: Array<{
        reference: (typeof references)[number];
        uri: string;
    }> = [];

    for (const reference of references) {
        const imported = index.findModuleByName(reference.moduleName);

        if (imported && imported.uri !== module.uri) {
            direct.push({ reference, uri: imported.uri });
        }
    }

    if (direct.length < 2) {
        return [];
    }

    /*
     * Замыкание каждого прямого Import считается один раз. Текущий файл из него
     * исключается: он в собственном замыкании не участвует.
     */
    const reachable = new Map<string, ReadonlySet<string>>();

    for (const item of direct) {
        if (!reachable.has(item.uri)) {
            reachable.set(
                item.uri,
                closureOf(index, item.uri, module.uri)
            );
        }
    }

    const result: Diagnostic[] = [];

    for (const item of direct) {
        const provider = direct.find(other =>
            other.uri !== item.uri &&
            reachable.get(other.uri)?.has(item.uri) === true &&
            /*
             * Взаимная зависимость — это цикл, о нём сообщает cyclic-import.
             * Назвать здесь лишними ОБА Import значило бы посоветовать убрать
             * всё и остаться ни с чем.
             */
            reachable.get(item.uri)?.has(other.uri) !== true
        );

        if (!provider) {
            continue;
        }

        result.push({
            severity: DiagnosticSeverity.Information,
            range: {
                start: positionAtOffset(
                    module.lex.lineStarts,
                    item.reference.start
                ),
                end: positionAtOffset(
                    module.lex.lineStarts,
                    item.reference.end
                )
            },
            message:
                `Модуль ${item.reference.moduleName} уже импортирован через ` +
                `${provider.reference.moduleName}`,
            source: "RSL parser",
            code: "redundant-import",
            tags: [DiagnosticTag.Unnecessary],
            data: {
                start: item.reference.start,
                end: item.reference.end,
                moduleName: item.reference.moduleName
            }
        });
    }

    return result;
}

/**
 * Модули, доступные из uri по его собственным Import, транзитивно.
 *
 * Обход идёт по уже проиндексированным модулям: Import-контекст к этому моменту
 * проверен на полноту, поэтому непроиндексированного файла в замыкании быть не
 * может.
 */
function closureOf(
    index: WorkspaceIndex,
    uri: string,
    excludedUri: string
): ReadonlySet<string> {
    const visited = new Set<string>([uri, excludedUri]);
    const result = new Set<string>();
    const queue = [uri];

    for (let position = 0; position < queue.length; position++) {
        const current = index.getModule(queue[position]);

        if (!current) {
            continue;
        }

        for (const name of current.imports) {
            const imported = index.findModuleByName(name);

            if (!imported || visited.has(imported.uri)) {
                continue;
            }
            visited.add(imported.uri);
            result.add(imported.uri);
            queue.push(imported.uri);
        }
    }

    return result;
}

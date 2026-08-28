import {
    CompletionItemKind,
    DiagnosticSeverity,
    type Diagnostic
} from "vscode-languageserver";

import { normalizeIdentifier } from "../lexer";
import type { RslSymbol } from "../symbols/rslSymbol";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";
import {
    createOffsetDiagnostic,
    findObjectNameRange
} from "./diagnosticFactory";
import { type IRslDiagnosticStage, createScopeScanStage } from "./stages";

/**
 * Объявление закрывает собой другое, видимое в том же месте.
 *
 * Код при этом работает — просто не с тем именем, о котором думает читатель.
 * Метод, объявивший `Var caption` при поле класса `caption`, правит свою
 * переменную, а поле остаётся прежним; понять это по одной строке нельзя.
 *
 * Правило выключено по умолчанию и говорит подсказкой, а не предупреждением.
 * Затенение — приём законный: им пользуются намеренно, и на чужом коде поток
 * таких сообщений мешал бы больше, чем помогал.
 *
 * Проверяются два случая:
 *
 *   объявление в методе закрывает поле своего класса;
 *   объявление в процедуре закрывает процедуру, класс или константу из
 *   подключённого модуля — см. HIDDEN_KINDS о том, почему не переменную.
 *
 * Третий случай — переменная поверх параметра той же процедуры — сюда не
 * входит: отдельной области у параметров в RSL нет, и такое объявление уже
 * разбирает duplicate-declaration, сообщая о повторном имени в одной области.
 */

const DECLARATION_KINDS = new Set<number>([
    CompletionItemKind.Variable,
    CompletionItemKind.Constant
]);

/**
 * Чем бывает поле класса.
 *
 * Объявленное `Var` внутри класса и параметр конструктора приходят разными
 * видами — Property и Field рядом с Variable, — а закрывает их одинаково.
 */
const FIELD_KINDS = new Set<number>([
    ...DECLARATION_KINDS,
    CompletionItemKind.Property,
    CompletionItemKind.Field
]);

const PROCEDURE_KINDS = new Set<number>([
    CompletionItemKind.Function,
    CompletionItemKind.Method
]);

/**
 * Что из подключённого модуля стоит считать закрытым.
 *
 * Глобальной переменной модуля здесь нет, и это решено замером. Из 679 таких
 * находок на 868 файлах проекта 624 закрывали именно глобальную переменную, а
 * 379 — одно имя SQL: объявить у себя `Var SQL` при глобальном SQL в
 * подключённом модуле в этом проекте обычное дело, и говорить об этом значит
 * говорить впустую. Закрытое имя процедуры, класса или константы — другое
 * дело: оно меняет смысл имени, а таких находок 55.
 */
const HIDDEN_KINDS = new Set<number>([
    CompletionItemKind.Function,
    CompletionItemKind.Method,
    CompletionItemKind.Class,
    CompletionItemKind.Constant
]);

/** Класс, внутри которого лежит область; undefined — область не в классе. */
function owningClass(
    scope: RslSymbol,
    owners: Map<RslSymbol, RslSymbol>
): RslSymbol | undefined {
    let current = owners.get(scope);

    while (current) {
        if (current.kind === CompletionItemKind.Class) {
            return current;
        }

        current = owners.get(current);
    }

    return undefined;
}

/** Поля класса по нормализованному имени. */
function fieldsOf(owner: RslSymbol): Map<string, RslSymbol> {
    const fields = new Map<string, RslSymbol>();

    for (const child of owner.children) {
        if (FIELD_KINDS.has(child.kind)) {
            fields.set(normalizeIdentifier(child.name), child);
        }
    }

    return fields;
}

export function createShadowingStage(
    module: IIndexedModule,
    index: WorkspaceIndex,
    result: Diagnostic[]
): IRslDiagnosticStage {
    /* Родители, поля и имена модулей считаются лениво: обычно они не нужны. */
    let owners: Map<RslSymbol, RslSymbol> | undefined;
    let fieldsByClass: Map<RslSymbol, Map<string, RslSymbol>> | undefined;
    let imported: Map<string, string> | undefined;

    const parents = (): Map<RslSymbol, RslSymbol> => {
        if (!owners) {
            owners = new Map<RslSymbol, RslSymbol>();

            const visit = (symbol: RslSymbol): void => {
                for (const child of symbol.children) {
                    owners?.set(child, symbol);
                    visit(child);
                }
            };

            visit(module.symbolTree);
        }

        return owners;
    };
    const fields = (owner: RslSymbol): Map<string, RslSymbol> => {
        fieldsByClass = fieldsByClass ||
            new Map<RslSymbol, Map<string, RslSymbol>>();

        let known = fieldsByClass.get(owner);

        if (!known) {
            known = fieldsOf(owner);
            fieldsByClass.set(owner, known);
        }

        return known;
    };
    /**
     * Публичные имена верхнего уровня подключённых модулей.
     *
     * Имя -> модуль, где оно объявлено. Неоднозначные имена — те, что лежат в
     * нескольких модулях сразу, — сюда не попадают: про них говорит своя
     * проверка, и называть в подсказке один модуль из нескольких значит
     * показать пальцем не туда.
     */
    const importedNames = (): Map<string, string> => {
        if (imported) {
            return imported;
        }

        const found = new Map<string, string>();
        const ambiguous = new Set<string>();

        for (const dependency of index.getImportedModules(module.uri)) {
            for (const child of dependency.symbolTree.children) {
                if (child.isPrivate || !HIDDEN_KINDS.has(child.kind)) {
                    continue;
                }

                const name = normalizeIdentifier(child.name);
                const previous = found.get(name);

                if (previous === undefined) {
                    found.set(name, dependency.uri);
                } else if (previous !== dependency.uri) {
                    ambiguous.add(name);
                }
            }
        }

        for (const name of ambiguous) {
            found.delete(name);
        }

        imported = found;

        return imported;
    };

    return createScopeScanStage(module.symbolTree, scope => {
        if (!PROCEDURE_KINDS.has(scope.kind)) {
            return;
        }

        const owner = owningClass(scope, parents());
        const classFields = owner ? fields(owner) : undefined;
        const names = importedNames();

        if ((!classFields || classFields.size === 0) && names.size === 0) {
            return;
        }

        for (const child of scope.children) {
            if (!DECLARATION_KINDS.has(child.kind)) {
                continue;
            }

            const name = normalizeIdentifier(child.name);
            const field = classFields?.get(name);

            if (field && owner) {
                report(
                    module,
                    child,
                    child.name + " закрывает собой поле класса " + owner.name,
                    result
                );

                continue;
            }

            const dependency = names.get(name);

            if (dependency !== undefined) {
                report(
                    module,
                    child,
                    child.name + " закрывает собой имя из модуля " +
                        moduleName(dependency),
                    result
                );
            }
        }
    });
}

/** Имя модуля так, как оно пишется в Import. */
function moduleName(uri: string): string {
    const last = uri.slice(uri.lastIndexOf("/") + 1);

    return last.replace(/\.mac$/iu, "");
}

function report(
    module: IIndexedModule,
    symbol: RslSymbol,
    message: string,
    result: Diagnostic[]
): void {
    const range = findObjectNameRange(module, symbol);

    result.push(createOffsetDiagnostic(
        module,
        range.start,
        range.end,
        DiagnosticSeverity.Information,
        message,
        "shadowed-declaration"
    ));
}

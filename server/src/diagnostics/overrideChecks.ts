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
import { referenceParameterIndexes } from "./syntaxChecks";

/**
 * Метод класса-наследника не совпадает по сигнатуре с методом базового класса.
 *
 * Наследник, объявивший метод с другим числом параметров, компилятор не
 * остановит: вызов через базовый тип просто передаст не то. Найти это глазами
 * трудно — базовый класс обычно в другом файле, — а обнаруживается оно на
 * рабочем месте.
 *
 * Правило молчит везде, где вывод недоказуем: базовый класс не разрешился
 * однозначно, его подробная модель не загружена, у метода нет списка
 * параметров. Одноимённых классов в проверенном проекте хватает, и увести
 * сравнение к чужому классу хуже, чем ничего не сказать.
 */

/** Сколько параметров в списке; -1 — разобрать не удалось. */
function countParameters(parameterText: string): number {
    const body = parameterText
        .trim()
        .replace(/^\(/u, "")
        .replace(/\)$/u, "")
        .replace(/\/\*[\s\S]*?\*\//gu, " ")
        .trim();

    if (!body) {
        return 0;
    }

    let depth = 0;
    let count = 1;

    for (const character of body) {
        if (character === "(" || character === "[") {
            depth++;
        } else if (character === ")" || character === "]") {
            depth--;
        } else if (character === "," && depth === 0) {
            count++;
        }
    }

    return count;
}

/** Методы символа класса по нормализованному имени. */
function methodsOf(owner: RslSymbol): Map<string, RslSymbol> {
    const result = new Map<string, RslSymbol>();

    for (const child of owner.children) {
        if (
            child.kind === CompletionItemKind.Method ||
            child.kind === CompletionItemKind.Function
        ) {
            result.set(normalizeIdentifier(child.name), child);
        }
    }

    return result;
}

/** Класс с этим именем в подробной модели файла. */
function classIn(
    module: IIndexedModule | undefined,
    className: string
): RslSymbol | undefined {
    if (!module) {
        return undefined;
    }

    const wanted = normalizeIdentifier(className);

    return module.symbolTree.children.find(child =>
        child.kind === CompletionItemKind.Class &&
        normalizeIdentifier(child.name) === wanted);
}

/** Одинаковы ли множества параметров, передаваемых по ссылке. */
function sameReferenceParameters(left: string, right: string): boolean {
    const first = referenceParameterIndexes(left);
    const second = referenceParameterIndexes(right);

    if (first.size !== second.size) {
        return false;
    }

    for (const index of first) {
        if (!second.has(index)) {
            return false;
        }
    }

    return true;
}

export function addOverrideDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    result: Diagnostic[]
): void {
    for (const derived of module.symbolTree.children) {
        if (
            derived.kind !== CompletionItemKind.Class ||
            !derived.baseClassName
        ) {
            continue;
        }

        /*
         * Базовый класс обязан определиться однозначно. Имя `Base` в проекте
         * встречается в нескольких файлах, и сравнение с чужим классом дало бы
         * уверенную неправду.
         */
        const baseUri = index.catalog.classDeclaringUri(
            module.uri,
            derived.baseClassName
        );

        if (!baseUri) {
            continue;
        }

        const base = classIn(
            baseUri === module.uri ? module : index.getModule(baseUri),
            derived.baseClassName
        );

        if (!base) {
            /* Подробной модели базового класса нет: сравнивать не с чем. */
            continue;
        }

        const inherited = methodsOf(base);

        for (const method of derived.children) {
            if (
                method.kind !== CompletionItemKind.Method &&
                method.kind !== CompletionItemKind.Function
            ) {
                continue;
            }

            const parent = inherited.get(normalizeIdentifier(method.name));

            if (!parent) {
                continue;
            }

            const own = method.parameterText || "";
            const theirs = parent.parameterText || "";

            if (!own.trim() && !theirs.trim()) {
                continue;
            }

            const ownCount = countParameters(own);
            const parentCount = countParameters(theirs);

            if (ownCount !== parentCount) {
                result.push(methodDiagnostic(
                    module,
                    method,
                    "Метод " + method.name + " переопределяет метод класса " +
                        base.name + " с другим числом параметров: " +
                        ownCount + " против " + parentCount
                ));

                continue;
            }

            if (!sameReferenceParameters(own, theirs)) {
                result.push(methodDiagnostic(
                    module,
                    method,
                    "Метод " + method.name + " переопределяет метод класса " +
                        base.name + " с другой передачей параметров по ссылке"
                ));
            }
        }
    }
}

/** Сообщение на имени метода: подчёркивается объявление, а не всё тело. */
function methodDiagnostic(
    module: IIndexedModule,
    method: RslSymbol,
    message: string
): Diagnostic {
    const range = findObjectNameRange(module, method);

    return createOffsetDiagnostic(
        module,
        range.start,
        range.end,
        DiagnosticSeverity.Warning,
        message,
        "incompatible-override"
    );
}

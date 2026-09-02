import { CompletionItemKind } from "vscode-languageserver";

import { collectRslImportClosure } from "../indexing/importClosure";
import { computeRslModuleInterface } from "../indexing/moduleInterface";
import type { IIndexedModule } from "../workspaceIndex";
import { positionInModule } from "../core/documentPosition";
import type { RslScopeResolver } from "../scopeResolver";
import type { RslSymbol } from "../symbols/rslSymbol";
import type { RslTypeEngine } from "../analysis/typeEngine";
import type { WorkspaceIndex } from "../workspaceIndex";

/**
 * Отчёты для разбора работы сервера.
 *
 * После появления интерфейса модуля и слоя типов ответить на вопрос «почему
 * это имя разрешилось сюда» стало заметно труднее: между текстом и ответом
 * лежат Import-замыкание, ревизии, каталог и кэши. Отчёты показывают ровно то
 * состояние, по которому сервер отвечал.
 *
 * Считаются они ТОЛЬКО по запросу и на обычную работу не влияют: ни кэшей не
 * греют, ни индексации не запускают, ни моделей не строят — что в индексе
 * есть, то и показывают.
 */
export type RslInspectorKind =
    | "syntaxTree"
    | "symbolTree"
    | "moduleInterface"
    | "importClosure"
    | "explainSymbol"
    | "explainType";

export interface IRslInspectorRequest {
    kind: RslInspectorKind;
    uri: string;
    /** Смещение курсора; нужно только для двух последних отчётов. */
    offset?: number;
}

export interface IRslInspectorEnvironment {
    index: WorkspaceIndex;
    resolver: RslScopeResolver;
    types: RslTypeEngine;
}

/** Отчёт как обычный текст: его показывают в канале вывода. */
export function buildRslInspectorReport(
    environment: IRslInspectorEnvironment,
    request: IRslInspectorRequest
): string {
    const module = environment.index.getModule(request.uri);

    if (!module) {
        return "Модуль не загружен: " + request.uri;
    }

    switch (request.kind) {
        case "syntaxTree":
            return syntaxTreeReport(module);
        case "symbolTree":
            return symbolTreeReport(module);
        case "moduleInterface":
            return interfaceReport(environment.index, module);
        case "importClosure":
            return closureReport(environment.index, module);
        case "explainSymbol":
            return explainSymbol(environment, module, request.offset ?? 0);
        case "explainType":
            return explainType(environment, module, request.offset ?? 0);
        default:
            return "Неизвестный отчёт";
    }
}

function header(module: IIndexedModule, title: string): string[] {
    return [
        title,
        "  файл: " + module.uri,
        "  вид модели: " + (module.kind === "open" ? "полная" : "сводка") +
        ", версия " + module.version +
        ", ревизия интерфейса " + module.interfaceRevision,
        ""
    ];
}

function syntaxTreeReport(module: IIndexedModule): string {
    const lines = header(module, "Синтаксическое дерево");

    if (module.kind !== "open") {
        lines.push(
            "  Дерева нет: у сводки внешнего модуля разбора не хранится.",
            "  Откройте файл, чтобы увидеть дерево."
        );

        return lines.join("\n");
    }

    const walk = (nodes: readonly { kind: string; name?: string; start: number; end: number; children?: readonly unknown[] }[], depth: number): void => {
        for (const node of nodes) {
            lines.push(
                "  ".repeat(depth + 1) + node.kind +
                (node.name ? " " + node.name : "") +
                " [" + node.start + ".." + node.end + "]"
            );
            walk(
                (node.children || []) as typeof nodes,
                depth + 1
            );
        }
    };

    walk(module.syntax.root.children as never, 0);

    return lines.join("\n");
}

function symbolTreeReport(module: IIndexedModule): string {
    const lines = header(module, "Дерево символов");
    const walk = (symbol: RslSymbol, depth: number): void => {
        lines.push(
            "  ".repeat(depth + 1) + kindName(symbol.kind) + " " + symbol.name +
            (symbol.parameterText || "") +
            (symbol.typeName ? ": " + symbol.typeName : "") +
            "  [" + symbol.visibility + "]" +
            "  id=" + symbol.id
        );
        symbol.children.forEach(child => walk(child, depth + 1));
    };

    module.symbolTree.children.forEach(symbol => walk(symbol, 0));

    return lines.join("\n");
}

function interfaceReport(
    index: WorkspaceIndex,
    module: IIndexedModule
): string {
    const declared = computeRslModuleInterface(module);
    const lines = header(module, "Внешний интерфейс модуля");

    lines.push(
        "  отпечаток: " + declared.fingerprint,
        "  публичных объявлений: " + declared.declarationCount,
        "  совпадает с хранимым: " +
        (module.interfaceFingerprint === declared.fingerprint ? "да" : "НЕТ"),
        "",
        "  Import: " + (module.imports.join(", ") || "нет"),
        "",
        "  Видно снаружи:"
    );

    const walk = (symbol: RslSymbol, depth: number): void => {
        if (symbol.isPrivate) {
            return;
        }

        lines.push(
            "  ".repeat(depth + 2) + kindName(symbol.kind) + " " + symbol.name +
            (symbol.parameterText || "") +
            (symbol.typeName ? ": " + symbol.typeName : "") +
            (symbol.baseClassName ? "  базовый " + symbol.baseClassName : "")
        );

        if (!isCallable(symbol.kind)) {
            symbol.children.forEach(child => walk(child, depth + 1));
        }
    };

    module.symbolTree.children.forEach(symbol => walk(symbol, 0));

    /* Кто пострадает, если интерфейс изменится. */
    const dependents = index.getAffectedUris(module.uri)
        .filter(uri => uri !== module.uri);

    lines.push(
        "",
        "  Зависимых модулей: " + dependents.length
    );

    for (const uri of dependents.slice(0, 20)) {
        lines.push("    " + uri);
    }

    if (dependents.length > 20) {
        lines.push("    ... и ещё " + (dependents.length - 20));
    }

    return lines.join("\n");
}

function closureReport(
    index: WorkspaceIndex,
    module: IIndexedModule
): string {
    const closure = collectRslImportClosure(index, module.uri);
    const lines = header(module, "Транзитивное замыкание Import");

    lines.push("  Написано в файле: " + (module.imports.join(", ") || "нет"), "");
    lines.push("  Разрешилось (" + closure.modules.length + "):");

    for (const item of closure.modules) {
        lines.push(
            "    " + item.uri +
            "  ревизия интерфейса " + item.interfaceRevision
        );
    }

    if (closure.missing.length > 0) {
        lines.push("", "  Не найдено: " + closure.missing.join(", "));
    }

    if (closure.ambiguous.length > 0) {
        lines.push("  Неоднозначно: " + closure.ambiguous.join(", "));
    }

    if (closure.unloaded.length > 0) {
        lines.push("  Файл есть, но не прочитан: " + closure.unloaded.join(", "));
    }

    return lines.join("\n");
}

function explainSymbol(
    environment: IRslInspectorEnvironment,
    module: IIndexedModule,
    offset: number
): string {
    const lines = header(module, "Символ под курсором");
    const at = positionInModule(module, offset);

    lines.push("  позиция: строка " + (at.line + 1) + ", столбец " + (at.character + 1));

    const resolved = environment.resolver.resolveAt(
        module.uri,
        module.symbolTree,
        offset
    );

    if (!resolved) {
        lines.push(
            "",
            "  Имя не разрешилось.",
            "  Проверьте замыкание Import: RSL: Show Import Closure."
        );

        return lines.join("\n");
    }

    const target = environment.index.getModule(resolved.uri);
    const own = resolved.uri === module.uri;

    lines.push(
        "",
        "  Найден: " + kindName(resolved.symbol.kind) + " " + resolved.symbol.name,
        "  Где объявлен: " + resolved.uri + (own ? "  (этот же файл)" : ""),
        "  Идентификатор символа: " + resolved.symbol.id,
        "  Видимость: " + resolved.symbol.visibility,
        "  Тип: " + (environment.types.typeOfSymbol(resolved.symbol) || "неизвестен")
    );

    if (!own) {
        lines.push(
            "  Путь Import: " + importPath(environment.index, module, resolved.uri),
            "  Ревизия интерфейса объявляющего модуля: " +
            (target?.interfaceRevision ?? "модуль выгружен")
        );
    }

    lines.push(
        "  Ревизия окружения документа: " +
        environment.index.getSemanticRevision(module.uri)
    );

    return lines.join("\n");
}

function explainType(
    environment: IRslInspectorEnvironment,
    module: IIndexedModule,
    offset: number
): string {
    const lines = header(module, "Тип под курсором");
    const symbolType = environment.types.typeOfSymbolAt(module.uri, offset);
    const expected = environment.types.expectedTypeAt(module.uri, offset);
    const call = environment.types.resolveCall(module.uri, offset);

    lines.push(
        "  Тип имени под курсором: " + (symbolType || "неизвестен"),
        "  Ожидаемый здесь тип: " + (expected || "не выводится"),
        "  Внутри вызова: " + (call
            ? call.symbol.name + (call.symbol.parameterText || "") +
                ", аргумент " + ((call.argumentIndex ?? 0) + 1)
            : "нет"),
        "",
        "  Пусто — это честный ответ: тип выводится только там, где он",
        "  выводится дёшево и без догадок."
    );

    return lines.join("\n");
}

/** Как имя дошло до документа: прямой Import или через кого. */
function importPath(
    index: WorkspaceIndex,
    module: IIndexedModule,
    targetUri: string
): string {
    const direct = collectRslImportClosure(index, module.uri, {
        directOnly: true
    });

    if (direct.modules.some(item => item.uri === targetUri)) {
        return "прямой Import";
    }

    for (const item of direct.modules) {
        const nested = collectRslImportClosure(index, item.uri);

        if (nested.modules.some(inner => inner.uri === targetUri)) {
            return "через " + item.uri;
        }
    }

    return "не через Import: встроенное имя или каталог платформы";
}

function isCallable(kind: CompletionItemKind): boolean {
    return kind === CompletionItemKind.Function ||
        kind === CompletionItemKind.Method ||
        kind === CompletionItemKind.Constructor;
}

function kindName(kind: CompletionItemKind): string {
    switch (kind) {
        case CompletionItemKind.Function: return "Macro";
        case CompletionItemKind.Method: return "Метод";
        case CompletionItemKind.Class: return "Class";
        case CompletionItemKind.Constant: return "Const";
        case CompletionItemKind.Property: return "Свойство";
        case CompletionItemKind.Field: return "Поле";
        default: return "Var";
    }
}

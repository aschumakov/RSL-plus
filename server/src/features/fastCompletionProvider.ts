import { CompletionItem, CompletionItemKind } from "vscode-languageserver";

import {
    getFastDocumentDeclarations,
    type IFastDocumentSnapshot
} from "../services/fastDocumentSnapshot";
import type { IRslDeclarationDescriptor } from "../analysis/declarationExtractor";

/**
 * Объявления файла без ожидания полной модели.
 *
 * Нужны там, где ждать нечем: пользователь нажал Ctrl+Space или точку, а модель
 * этой версии ещё строится. Прежде в таком случае возвращался пустой список —
 * то есть подсказка выглядела так, будто в файле ничего нет.
 *
 * Это заведомо неполный ответ, и он таким и помечается: состав взят
 * сканированием токенов, без областей видимости и вывода типов. Локальных
 * переменных Macro здесь не будет вовсе — быстрый снимок их не извлекает, он
 * строится для Structure. Остаются классы, макропроцедуры, методы и параметры,
 * то есть ровно то, что чаще всего и вызывают. Как только модель готова, клиент
 * перезапрашивает список и получает точный.
 */
export function buildRslFastCompletions(
    snapshot: IFastDocumentSnapshot,
    offset: number
): CompletionItem[] {
    const declarations = getFastDocumentDeclarations(snapshot).declarations;
    const items = new Map<string, CompletionItem>();

    const add = (
        declaration: IRslDeclarationDescriptor,
        insideCurrentBlock: boolean
    ): void => {
        /*
         * Локальные переменные чужого Macro в подсказку не попадают: областей
         * видимости здесь нет, и предложить их значило бы предложить то, что
         * компилятор в этой позиции не увидит. Верхний уровень виден всегда.
         */
        if (!insideCurrentBlock && declaration.kind === "variable") {
            return;
        }

        const key = declaration.name.toLowerCase();

        if (!items.has(key)) {
            items.set(key, {
                label: declaration.name,
                kind: completionKind(declaration),
                detail: declaration.typeName || undefined,
                /*
                 * Сортировка ниже обычной: точный список придёт следом, и
                 * приблизительные имена не должны опережать его.
                 */
                sortText: `${declaration.name}`
            });
        }
    };

    const visit = (
        list: readonly IRslDeclarationDescriptor[],
        insideCurrentBlock: boolean
    ): void => {
        for (const declaration of list) {
            add(declaration, insideCurrentBlock);
            const inside = insideCurrentBlock ||
                (offset >= declaration.start && offset <= declaration.end);
            visit(declaration.children, inside);
        }
    };

    visit(declarations, false);
    return Array.from(items.values());
}

function completionKind(
    declaration: IRslDeclarationDescriptor
): CompletionItemKind {
    if (declaration.kind === "class") {
        return CompletionItemKind.Class;
    }

    if (declaration.kind === "macro") {
        return declaration.isMethod
            ? CompletionItemKind.Method
            : CompletionItemKind.Function;
    }

    if (declaration.isConstant) {
        return CompletionItemKind.Constant;
    }

    return declaration.isProperty
        ? CompletionItemKind.Property
        : CompletionItemKind.Variable;
}
